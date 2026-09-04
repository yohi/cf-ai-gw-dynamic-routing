import { createHash } from 'node:crypto';

const DEFAULT_SUBAGENT_TOOLS = new Set([
  'task',
  'background_task',
  'background_output',
  'task_output',
]);

const DEFAULT_OMO_TRUNCATABLE_TOOLS = new Set([
  'grep',
  'safe_grep',
  'glob',
  'safe_glob',
  'lsp_diagnostics',
  'interactive_bash',
  'skill_mcp',
  'webfetch',
]);

export function estimateTokens(value) {
  if (value === null || value === undefined) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return 0;
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4));
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');
}

export function parseMetadata(metadata) {
  if (!metadata) return {};
  if (typeof metadata === 'object' && !Array.isArray(metadata)) return metadata;
  if (typeof metadata !== 'string') return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function unwrapApiEnvelope(payload) {
  if (
    payload &&
    typeof payload === 'object' &&
    Object.prototype.hasOwnProperty.call(payload, 'result') &&
    (Object.prototype.hasOwnProperty.call(payload, 'success') || Object.prototype.hasOwnProperty.call(payload, 'errors'))
  ) {
    return payload.result;
  }
  return payload;
}

function scoreRequestBodyCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return -1;
  let score = 0;
  if (Array.isArray(value.messages)) score += 8;
  if (Array.isArray(value.input)) score += 6;
  if (Array.isArray(value.tools)) score += 5;
  if (typeof value.model === 'string') score += 3;
  if (value.max_tokens !== undefined || value.max_output_tokens !== undefined) score += 1;
  return score;
}

export function findRequestBody(rawPayload) {
  const root = unwrapApiEnvelope(rawPayload);
  if (!root || typeof root !== 'object') return root;

  let best = { value: root, score: scoreRequestBodyCandidate(root), depth: 0 };
  const queue = [{ value: root, depth: 0 }];
  const seen = new Set();

  while (queue.length) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 5) continue;
    seen.add(value);

    const score = scoreRequestBodyCandidate(value);
    if (score > best.score) best = { value, score, depth };

    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
    }
  }

  return best.value;
}

function normalizeToolName(name) {
  return typeof name === 'string' ? name.trim() : '';
}

function isSubagentTool(toolName, subagentTools) {
  const normalized = normalizeToolName(toolName).toLowerCase();
  if (!normalized) return false;
  return subagentTools.has(normalized);
}

function messageRole(item) {
  if (!item || typeof item !== 'object') return '';
  if (typeof item.role === 'string') return item.role.toLowerCase();
  if (item.type === 'message' && typeof item.role === 'string') return item.role.toLowerCase();
  if (item.type === 'function_call_output' || item.type === 'tool_result') return 'tool';
  if (item.type === 'function_call') return 'assistant';
  return '';
}

function flattenText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(flattenText).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    const preferred = ['text', 'content', 'output_text', 'input_text', 'output', 'result'];
    const chunks = [];
    for (const key of preferred) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const text = flattenText(value[key]);
        if (text) chunks.push(text);
      }
    }
    if (chunks.length) return chunks.join('\n');
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function collectMessages(body) {
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.messages)) return body.messages;
  if (Array.isArray(body.input)) return body.input;
  return [];
}

function collectTools(body) {
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.tools)) return body.tools;
  if (Array.isArray(body.functions)) return body.functions.map((fn) => ({ type: 'function', function: fn }));
  return [];
}

function buildToolCallMap(messages) {
  const map = new Map();
  for (const item of messages) {
    if (!item || typeof item !== 'object') continue;

    if (Array.isArray(item.tool_calls)) {
      for (const call of item.tool_calls) {
        const id = call?.id ?? call?.call_id;
        const name = call?.function?.name ?? call?.name;
        if (id && name) map.set(String(id), normalizeToolName(name));
      }
    }

    if (item.type === 'function_call') {
      const id = item.call_id ?? item.id;
      const name = item.name;
      if (id && name) map.set(String(id), normalizeToolName(name));
    }

    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'tool_use' || part.type === 'function_call') {
          const id = part.id ?? part.call_id;
          const name = part.name ?? part.function?.name;
          if (id && name) map.set(String(id), normalizeToolName(name));
        }
      }
    }
  }
  return map;
}

function resolveToolName(item, toolCallMap) {
  if (!item || typeof item !== 'object') return '';
  const direct = item.name ?? item.tool_name ?? item.tool?.name;
  if (direct) return normalizeToolName(direct);
  const callId = item.tool_call_id ?? item.call_id ?? item.id;
  if (callId && toolCallMap.has(String(callId))) return toolCallMap.get(String(callId));
  return '';
}

function cloneWithoutConversationAndTools(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const residual = {};
  for (const [key, value] of Object.entries(body)) {
    if (['messages', 'input', 'tools', 'functions'].includes(key)) continue;
    residual[key] = value;
  }
  return residual;
}

function artifact({ logId, sessionId, component, type, label, toolName = '', item, messageIndex, estimatedTokens }) {
  const canonical = stableStringify(item);
  return {
    log_id: logId,
    session_id: sessionId,
    component,
    artifact_type: type,
    artifact_label: label,
    tool_name: toolName || null,
    message_index: messageIndex ?? null,
    artifact_hash: sha256(canonical),
    estimated_tokens: estimatedTokens,
    allocated_tokens: 0,
  };
}

function extractFirstUserText(messages) {
  for (const item of messages) {
    if (messageRole(item) !== 'user') continue;
    const text = flattenText(item.content ?? item.input ?? item.text ?? item);
    if (text) return text;
  }
  return '';
}

export function inferSessionId({ metadata, metadataSessionKey = 'session', messages = [], body = {}, logId = '' }) {
  const candidateKeys = [metadataSessionKey, 'session_id', 'sessionID', 'session'];
  for (const key of candidateKeys) {
    const value = metadata?.[key];
    if (typeof value === 'string' && value.trim()) {
      return { sessionId: value.trim(), source: `metadata:${key}` };
    }
    if (typeof value === 'number') return { sessionId: String(value), source: `metadata:${key}` };
  }

  const firstUser = extractFirstUserText(messages);
  if (firstUser) {
    return {
      sessionId: `inferred:${sha256(firstUser).slice(0, 20)}`,
      source: 'inferred:first-user',
    };
  }

  const fallback = stableStringify({ model: body?.model ?? '', first: messages.slice(0, 2) });
  if (fallback && fallback !== '{}') {
    return { sessionId: `inferred:${sha256(fallback).slice(0, 20)}`, source: 'inferred:prefix' };
  }

  return { sessionId: `log:${logId}`, source: 'fallback:log-id' };
}

function recursivelyFindUsageObjects(root) {
  const usageObjects = [];
  const queue = [unwrapApiEnvelope(root)];
  const seen = new Set();
  let depth = 0;
  while (queue.length && depth < 10000) {
    depth += 1;
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (current.usage && typeof current.usage === 'object') usageObjects.push(current.usage);
    if (current.token_usage && typeof current.token_usage === 'object') usageObjects.push(current.token_usage);
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return usageObjects;
}

function numeric(obj, path) {
  let value = obj;
  for (const key of path) {
    if (!value || typeof value !== 'object') return null;
    value = value[key];
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function firstNumber(obj, paths) {
  for (const path of paths) {
    const value = numeric(obj, path);
    if (value !== null) return value;
  }
  return null;
}

export function extractProviderUsage(responsePayload) {
  const usageObjects = recursivelyFindUsageObjects(responsePayload);
  for (const usage of usageObjects) {
    const input = firstNumber(usage, [
      ['input_tokens'],
      ['prompt_tokens'],
      ['inputTokens'],
      ['promptTokens'],
    ]);
    const output = firstNumber(usage, [
      ['output_tokens'],
      ['completion_tokens'],
      ['outputTokens'],
      ['completionTokens'],
    ]);
    const cacheRead = firstNumber(usage, [
      ['cache_read_input_tokens'],
      ['cache_read_tokens'],
      ['cached_tokens'],
      ['prompt_tokens_details', 'cached_tokens'],
      ['input_tokens_details', 'cached_tokens'],
      ['promptTokensDetails', 'cachedTokens'],
    ]);
    const cacheWrite = firstNumber(usage, [
      ['cache_creation_input_tokens'],
      ['cache_write_input_tokens'],
      ['cache_write_tokens'],
      ['cache_creation_tokens'],
    ]);

    if ([input, output, cacheRead, cacheWrite].some((value) => value !== null)) {
      return {
        provider_input_tokens: input,
        provider_output_tokens: output,
        provider_cache_read_tokens: cacheRead,
        provider_cache_write_tokens: cacheWrite,
      };
    }
  }

  return {
    provider_input_tokens: null,
    provider_output_tokens: null,
    provider_cache_read_tokens: null,
    provider_cache_write_tokens: null,
  };
}

function allocateToActual(components, artifacts, actualTokensIn) {
  const totalEstimated = components.reduce((sum, row) => sum + row.estimated_tokens, 0);
  const actual = Number(actualTokensIn) || 0;
  const scale = actual > 0 && totalEstimated > 0 ? actual / totalEstimated : 1;

  for (const component of components) {
    component.allocated_tokens = Math.max(0, Math.round(component.estimated_tokens * scale));
  }

  if (actual > 0 && components.length) {
    const allocatedSum = components.reduce((sum, row) => sum + row.allocated_tokens, 0);
    const delta = actual - allocatedSum;
    const largest = components.reduce((best, row) => (row.allocated_tokens > best.allocated_tokens ? row : best), components[0]);
    largest.allocated_tokens = Math.max(0, largest.allocated_tokens + delta);
  }

  const allocatedByComponent = new Map(components.map((row) => [row.component, row]));
  const estimatedByComponent = new Map();
  for (const item of artifacts) {
    estimatedByComponent.set(item.component, (estimatedByComponent.get(item.component) ?? 0) + item.estimated_tokens);
  }

  for (const item of artifacts) {
    const component = allocatedByComponent.get(item.component);
    const componentEstimated = estimatedByComponent.get(item.component) ?? 0;
    item.allocated_tokens = component && componentEstimated > 0
      ? Math.max(0, Math.round(component.allocated_tokens * item.estimated_tokens / componentEstimated))
      : Math.max(0, Math.round(item.estimated_tokens * scale));
  }

  const totalAllocated = components.reduce((sum, row) => sum + row.allocated_tokens, 0) || 1;
  for (const component of components) {
    component.share = component.allocated_tokens / totalAllocated;
  }

  return scale;
}

export function analyzeLogRecord(log, requestPayload, responsePayload, options = {}) {
  const body = findRequestBody(requestPayload) ?? {};
  const messages = collectMessages(body);
  const tools = collectTools(body);
  const metadata = parseMetadata(log.metadata);
  const subagentTools = new Set(
    (options.subagentTools ?? [...DEFAULT_SUBAGENT_TOOLS]).map((name) => String(name).toLowerCase()),
  );
  const { sessionId, source: sessionSource } = inferSessionId({
    metadata,
    metadataSessionKey: options.metadataSessionKey ?? 'session',
    messages,
    body,
    logId: log.id,
  });

  const components = new Map();
  const artifacts = [];
  const addComponent = (name, estimated) => {
    const existing = components.get(name) ?? { component: name, estimated_tokens: 0, allocated_tokens: 0, share: 0 };
    existing.estimated_tokens += estimated;
    components.set(name, existing);
  };

  const toolCallMap = buildToolCallMap(messages);

  messages.forEach((item, index) => {
    const role = messageRole(item);
    const estimated = estimateTokens(item);
    let component = 'assistant_history';
    let type = `${role || 'unknown'}_message`;
    let label = `${role || 'unknown'}[${index}]`;
    let toolName = '';

    if (role === 'system' || role === 'developer') {
      component = 'system';
    } else if (role === 'user') {
      component = 'user_history';
    } else if (role === 'tool') {
      toolName = resolveToolName(item, toolCallMap);
      if (isSubagentTool(toolName, subagentTools)) {
        component = 'subagent_return';
        type = 'subagent_return';
      } else {
        component = 'tool_output';
        type = 'tool_output';
      }
      label = toolName ? `${toolName}:result` : `tool[${index}]`;
    } else if (role === 'assistant') {
      component = 'assistant_history';
    } else {
      component = 'protocol_overhead';
    }

    addComponent(component, estimated);
    artifacts.push(artifact({
      logId: log.id,
      sessionId,
      component,
      type,
      label,
      toolName,
      item,
      messageIndex: index,
      estimatedTokens: estimated,
    }));
  });

  tools.forEach((tool, index) => {
    const estimated = estimateTokens(tool);
    addComponent('tool_schema', estimated);
    const toolName = normalizeToolName(tool?.function?.name ?? tool?.name ?? `tool-${index}`);
    artifacts.push(artifact({
      logId: log.id,
      sessionId,
      component: 'tool_schema',
      type: 'tool_schema',
      label: toolName,
      toolName,
      item: tool,
      messageIndex: index,
      estimatedTokens: estimated,
    }));
  });

  const residual = cloneWithoutConversationAndTools(body);
  const residualEstimated = estimateTokens(residual);
  if (residualEstimated > 0 && stableStringify(residual) !== '{}') {
    addComponent('protocol_overhead', residualEstimated);
    artifacts.push(artifact({
      logId: log.id,
      sessionId,
      component: 'protocol_overhead',
      type: 'protocol',
      label: 'request-options',
      item: residual,
      estimatedTokens: residualEstimated,
    }));
  }

  if (components.size === 0) {
    const estimated = estimateTokens(body);
    addComponent('protocol_overhead', estimated);
  }

  const componentRows = [...components.values()].map((row) => ({
    log_id: log.id,
    session_id: sessionId,
    ...row,
  }));
  const scale = allocateToActual(componentRows, artifacts, log.tokens_in);
  const usage = extractProviderUsage(responsePayload);

  const requestRow = {
    log_id: log.id,
    created_at: log.created_at ?? null,
    provider: log.provider ?? null,
    model: log.model ?? null,
    request_path: log.path ?? null,
    success: Boolean(log.success),
    status_code: log.status_code ?? null,
    cached: Boolean(log.cached),
    tokens_in: Number(log.tokens_in) || 0,
    tokens_out: Number(log.tokens_out) || 0,
    cost: typeof log.cost === 'number' ? log.cost : null,
    duration: typeof log.duration === 'number' ? log.duration : null,
    session_id: sessionId,
    session_source: sessionSource,
    agent: metadata.agent ?? null,
    phase: metadata.phase ?? null,
    category: metadata.category ?? null,
    experiment: metadata.experiment ?? null,
    metadata_json: JSON.stringify(metadata),
    payload_available: requestPayload !== null && requestPayload !== undefined,
    token_scale: scale,
    ...usage,
  };

  return { request: requestRow, components: componentRows, artifacts };
}

export function buildSessionDeltas(requests) {
  const bySession = new Map();
  for (const request of requests) {
    if (!bySession.has(request.session_id)) bySession.set(request.session_id, []);
    bySession.get(request.session_id).push(request);
  }

  const rows = [];
  for (const [sessionId, items] of bySession) {
    items.sort((a, b) => new Date(a.created_at ?? 0) - new Date(b.created_at ?? 0));
    let previous = null;
    items.forEach((item, index) => {
      rows.push({
        log_id: item.log_id,
        session_id: sessionId,
        turn_index: index + 1,
        previous_log_id: previous?.log_id ?? null,
        tokens_in: item.tokens_in,
        delta_tokens_in: previous ? item.tokens_in - previous.tokens_in : null,
        previous_provider: previous?.provider ?? null,
        provider_switched: previous ? previous.provider !== item.provider : false,
        cache_read_ratio: item.provider_cache_read_tokens !== null && item.tokens_in > 0
          ? item.provider_cache_read_tokens / item.tokens_in
          : null,
      });
      previous = item;
    });
  }
  return rows;
}

export function buildAmplification(artifacts) {
  const groups = new Map();
  for (const row of artifacts) {
    const key = `${row.session_id}\u0000${row.artifact_hash}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        session_id: row.session_id,
        artifact_hash: row.artifact_hash,
        artifact_type: row.artifact_type,
        artifact_label: row.artifact_label,
        tool_name: row.tool_name,
        occurrence_count: 0,
        total_allocated_tokens: 0,
        first_allocated_tokens: null,
        reread_tokens: 0,
      };
      groups.set(key, group);
    }
    group.occurrence_count += 1;
    group.total_allocated_tokens += row.allocated_tokens;
    if (group.first_allocated_tokens === null) group.first_allocated_tokens = row.allocated_tokens;
  }

  const result = [];
  for (const group of groups.values()) {
    group.first_allocated_tokens ??= 0;
    group.reread_tokens = Math.max(0, group.total_allocated_tokens - group.first_allocated_tokens);
    result.push(group);
  }
  return result;
}

function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * q;
  const base = Math.floor(position);
  const rest = position - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

function sum(rows, field) {
  return rows.reduce((acc, row) => acc + (Number(row[field]) || 0), 0);
}

export function buildReportData(dataset, options = {}) {
  const { requests = [], components = [], artifacts = [], amplification = [] } = dataset;
  const sessionDeltas = dataset.sessionDeltas ?? dataset.session_deltas ?? [];
  const totalInput = sum(requests, 'tokens_in');
  const totalOutput = sum(requests, 'tokens_out');
  const componentTotals = new Map();
  for (const row of components) {
    componentTotals.set(row.component, (componentTotals.get(row.component) ?? 0) + row.allocated_tokens);
  }

  const componentSummary = [...componentTotals.entries()]
    .map(([component, tokens]) => ({ component, tokens, share: totalInput > 0 ? tokens / totalInput : 0 }))
    .sort((a, b) => b.tokens - a.tokens);

  const amplificationSummary = [...amplification]
    .filter((row) => row.occurrence_count > 1 && row.reread_tokens > 0)
    .sort((a, b) => b.reread_tokens - a.reread_tokens);

  const toolArtifacts = artifacts.filter((row) => ['tool_output', 'subagent_return'].includes(row.artifact_type));
  const toolGroups = new Map();
  for (const row of toolArtifacts) {
    const key = row.tool_name ?? '(unknown)';
    let group = toolGroups.get(key);
    if (!group) group = { tool_name: key, occurrences: 0, tokens: 0, max_tokens: 0 };
    group.occurrences += 1;
    group.tokens += row.allocated_tokens;
    group.max_tokens = Math.max(group.max_tokens, row.allocated_tokens);
    toolGroups.set(key, group);
  }
  const toolSummary = [...toolGroups.values()].sort((a, b) => b.tokens - a.tokens);

  const truncationThreshold = options.truncationThreshold ?? 50_000;
  const omoTruncatable = new Set(
    (options.omoTruncatableTools ?? [...DEFAULT_OMO_TRUNCATABLE_TOOLS]).map((name) => String(name).toLowerCase()),
  );
  const truncateCandidates = toolArtifacts
    .filter((row) => row.allocated_tokens >= truncationThreshold)
    .filter((row) => !omoTruncatable.has(String(row.tool_name ?? '').toLowerCase()))
    .sort((a, b) => b.allocated_tokens - a.allocated_tokens);

  const switched = sessionDeltas.filter((row) => row.previous_log_id && row.provider_switched);
  const sameProvider = sessionDeltas.filter((row) => row.previous_log_id && !row.provider_switched);
  const switchCache = switched.map((row) => row.cache_read_ratio).filter(Number.isFinite);
  const sameCache = sameProvider.map((row) => row.cache_read_ratio).filter(Number.isFinite);

  const growthDeltas = sessionDeltas
    .map((row) => row.delta_tokens_in)
    .filter((value) => Number.isFinite(value));

  const sessionIds = new Set(requests.map((row) => row.session_id));
  const inferredSessions = requests.filter((row) => row.session_source?.startsWith('inferred:')).length;

  const getShare = (name) => componentSummary.find((row) => row.component === name)?.share ?? 0;
  const subagentShare = getShare('subagent_return');
  const toolShare = getShare('tool_output');
  const fixedPrefixShare = getShare('system') + getShare('tool_schema');
  const historyShare = getShare('user_history') + getShare('assistant_history');
  const recommendations = [];

  if (subagentShare > 0.15) {
    recommendations.push('subagent_return が input の 15% を超えています。Superpowers の report-file handoff と parent への短い status/commit/test/concerns 返却を最優先で確認してください。');
  }
  if (toolShare > 0.30) {
    recommendations.push('通常 tool output が input の 30% を超えています。上位 tool と re-read amplification を確認し、必要部分だけ Read/Grep する運用を優先してください。');
  }
  if (truncateCandidates.length > 0) {
    recommendations.push(`OmO の標準 truncation whitelist 外で ${truncationThreshold.toLocaleString()} tokens 以上の単発 tool output が ${truncateCandidates.length} 件あります。truncate_all_tool_outputs=true の A/B 対象です。`);
  }
  if (fixedPrefixShare > 0.35) {
    recommendations.push('system + tool schema が input の 35% を超えています。削除より先に、provider/session の prompt-cache locality と static prefix の安定性を確認してください。');
  }
  if (historyShare > 0.40) {
    recommendations.push('user + assistant history が input の 40% を超えています。task boundary と session lifecycle、parent に残す会話情報を見直してください。');
  }
  const switchCacheMedian = quantile(switchCache, 0.5);
  const sameCacheMedian = quantile(sameCache, 0.5);
  if (switchCache.length >= 3 && sameCache.length >= 3 && sameCacheMedian > 0 && switchCacheMedian < sameCacheMedian * 0.7) {
    recommendations.push('provider switch 直後の prompt-cache read ratio が same-provider 時より明確に低下しています。Percentage より priority/fallback を優先する根拠になります。');
  }
  const growthMedian = quantile(growthDeltas, 0.5);
  if (growthMedian !== null && growthMedian > 5_000) {
    recommendations.push('session の tokens_in が turn あたり中央値 5k tokens 超で増加しています。parent context への artifact 滞留を重点確認してください。');
  }
  if (!recommendations.length) recommendations.push('暫定 threshold を超える単一の支配要因はありません。上位 amplification artifact と p95 request を個別確認してください。');

  return {
    generated_at: new Date().toISOString(),
    requests: requests.length,
    sessions: sessionIds.size,
    inferred_session_requests: inferredSessions,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    input_tokens_p50: quantile(requests.map((row) => row.tokens_in), 0.5),
    input_tokens_p95: quantile(requests.map((row) => row.tokens_in), 0.95),
    input_tokens_mean: requests.length ? totalInput / requests.length : null,
    growth_delta_p50: growthMedian,
    growth_delta_p95: quantile(growthDeltas, 0.95),
    provider_switches: switched.length,
    provider_transitions: switched.length + sameProvider.length,
    switch_cache_ratio_p50: switchCacheMedian,
    same_provider_cache_ratio_p50: sameCacheMedian,
    component_summary: componentSummary,
    top_amplifiers: amplificationSummary.slice(0, options.topN ?? 10),
    tool_summary: toolSummary.slice(0, options.topN ?? 10),
    truncate_candidates: truncateCandidates.slice(0, options.topN ?? 10),
    recommendations,
  };
}

function fmtNumber(value, digits = 0) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'N/A';
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: digits });
}

function fmtPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'N/A';
  return `${(Number(value) * 100).toFixed(1)}%`;
}

export function renderMarkdownReport(report) {
  const lines = [];
  lines.push('# Cloudflare AI Gateway Context / Token Analysis');
  lines.push('');
  lines.push(`Generated: ${report.generated_at}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | ---: |');
  lines.push(`| Requests | ${fmtNumber(report.requests)} |`);
  lines.push(`| Sessions | ${fmtNumber(report.sessions)} |`);
  lines.push(`| Requests using inferred session IDs | ${fmtNumber(report.inferred_session_requests)} |`);
  lines.push(`| Total input tokens | ${fmtNumber(report.total_input_tokens)} |`);
  lines.push(`| Total output tokens | ${fmtNumber(report.total_output_tokens)} |`);
  lines.push(`| Input tokens / request p50 | ${fmtNumber(report.input_tokens_p50)} |`);
  lines.push(`| Input tokens / request p95 | ${fmtNumber(report.input_tokens_p95)} |`);
  lines.push(`| Input tokens / request mean | ${fmtNumber(report.input_tokens_mean)} |`);
  lines.push(`| Session growth Δ tokens p50 | ${fmtNumber(report.growth_delta_p50)} |`);
  lines.push(`| Session growth Δ tokens p95 | ${fmtNumber(report.growth_delta_p95)} |`);
  lines.push('');

  lines.push('## Input component share');
  lines.push('');
  lines.push('| Component | Allocated tokens | Share |');
  lines.push('| --- | ---: | ---: |');
  for (const row of report.component_summary) {
    lines.push(`| ${row.component} | ${fmtNumber(row.tokens)} | ${fmtPercent(row.share)} |`);
  }
  lines.push('');

  lines.push('## Top re-read amplifiers');
  lines.push('');
  lines.push('`reread_tokens` は同じ artifact が同一 session の後続 request に再登場した推定 token 合計です。');
  lines.push('');
  lines.push('| Type | Label | Tool | Occurrences | Re-read tokens | Total resident tokens |');
  lines.push('| --- | --- | --- | ---: | ---: | ---: |');
  for (const row of report.top_amplifiers) {
    lines.push(`| ${row.artifact_type} | ${String(row.artifact_label).replaceAll('|', '\\|')} | ${row.tool_name ?? ''} | ${fmtNumber(row.occurrence_count)} | ${fmtNumber(row.reread_tokens)} | ${fmtNumber(row.total_allocated_tokens)} |`);
  }
  if (!report.top_amplifiers.length) lines.push('| - | - | - | 0 | 0 | 0 |');
  lines.push('');

  lines.push('## Tool / subagent footprint');
  lines.push('');
  lines.push('| Tool | Occurrences | Allocated tokens | Max single occurrence |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const row of report.tool_summary) {
    lines.push(`| ${String(row.tool_name).replaceAll('|', '\\|')} | ${fmtNumber(row.occurrences)} | ${fmtNumber(row.tokens)} | ${fmtNumber(row.max_tokens)} |`);
  }
  if (!report.tool_summary.length) lines.push('| - | 0 | 0 | 0 |');
  lines.push('');

  lines.push('## `truncate_all_tool_outputs` candidates');
  lines.push('');
  lines.push('OmO の標準 truncation whitelist 外かつ閾値以上だった単発 tool result。');
  lines.push('');
  lines.push('| Tool | Type | Estimated allocated tokens | Session |');
  lines.push('| --- | --- | ---: | --- |');
  for (const row of report.truncate_candidates) {
    lines.push(`| ${row.tool_name ?? '(unknown)'} | ${row.artifact_type} | ${fmtNumber(row.allocated_tokens)} | ${row.session_id} |`);
  }
  if (!report.truncate_candidates.length) lines.push('| - | - | 0 | - |');
  lines.push('');

  lines.push('## Provider cache locality');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | ---: |');
  lines.push(`| Provider switches | ${fmtNumber(report.provider_switches)} / ${fmtNumber(report.provider_transitions)} transitions |`);
  lines.push(`| Cache read ratio p50 after provider switch | ${fmtPercent(report.switch_cache_ratio_p50)} |`);
  lines.push(`| Cache read ratio p50 on same provider | ${fmtPercent(report.same_provider_cache_ratio_p50)} |`);
  lines.push('');

  lines.push('## Recommendations');
  lines.push('');
  for (const recommendation of report.recommendations) lines.push(`- ${recommendation}`);
  lines.push('');
  lines.push('## Interpretation notes');
  lines.push('');
  lines.push('- Cloudflare `tokens_in` を authoritative total とし、request payload 内の各 component は UTF-8 byte-based estimate を比率配分して合計が `tokens_in` と一致するよう正規化しています。provider tokenizer と完全一致する会計値ではなく、削減対象の相対診断用です。');
  lines.push('- `session_id` metadata がない request は最初の user message を fingerprint して推定します。正確な long-session 分析には `cf-aig-metadata` で stable session ID を付与してください。');
  lines.push('- Provider prompt-cache token が response payload に含まれない provider では cache ratio は `N/A` になります。Cloudflare response cache の `cached` とは別物です。');
  lines.push('- `truncate_all_tool_outputs` 候補判定の whitelist は OmO dev の既知 tool-output-truncator を初期値としており、OmO 更新時には再確認してください。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export const defaults = {
  subagentTools: [...DEFAULT_SUBAGENT_TOOLS],
  omoTruncatableTools: [...DEFAULT_OMO_TRUNCATABLE_TOOLS],
};
