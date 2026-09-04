#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, resolve, join } from 'node:path';
import process from 'node:process';

import {
  analyzeLogRecord,
  buildAmplification,
  buildReportData,
  buildSessionDeltas,
  defaults,
  renderMarkdownReport,
} from './lib/log-analysis.mjs';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

function usage() {
  console.log(`Usage:
  node scripts/analyze-logs.mjs [options]

Live Cloudflare mode (default):
  CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_GATEWAY_ID=... \\
    node scripts/analyze-logs.mjs --limit 500

Fixture/offline mode:
  node scripts/analyze-logs.mjs --fixture path/to/logs.json

Options:
  --limit N                    Number of matching logs to analyze (default: 300)
  --since ISO                  Stop once logs are older than this timestamp
  --until ISO                  Ignore logs newer than this timestamp
  --out-dir PATH               Output directory (default: data/ai-gateway)
  --db PATH                    DuckDB file (default: <out-dir>/analysis.duckdb)
  --report PATH                Markdown report (default: <out-dir>/report.md)
  --report-json PATH           JSON report (default: <out-dir>/report.json)
  --metadata-session-key KEY   Metadata key for stable session ID (default: session)
  --subagent-tools CSV         Tool names treated as subagent returns
  --payload-concurrency N      Concurrent request/response payload fetches (default: 4)
  --top N                      Rows shown in top tables (default: 10)
  --truncate-threshold N       Single-tool threshold in tokens (default: 50000)
  --store-raw                  Save gzip-compressed raw log/request/response payloads
  --no-duckdb                  Skip DuckDB creation (derived JSONL + reports still written)
  --fixture PATH               Analyze a JSON fixture instead of calling Cloudflare
  --help                       Show this help

Fixture format:
  [
    {"log": {...Cloudflare log list row...}, "request": {...}, "response": {...}}
  ]
`);
}

function parseArgs(argv) {
  const options = {
    limit: 300,
    since: null,
    until: null,
    outDir: 'data/ai-gateway',
    db: null,
    report: null,
    reportJson: null,
    metadataSessionKey: 'session',
    subagentTools: defaults.subagentTools,
    payloadConcurrency: 4,
    topN: 10,
    truncationThreshold: 50_000,
    storeRaw: false,
    duckdb: true,
    fixture: null,
  };

  const takeValue = (i, name) => {
    if (argv[i + 1] === undefined) throw new Error(`${name} requires a value`);
    return argv[i + 1];
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--limit':
        options.limit = Number(takeValue(i, arg)); i += 1; break;
      case '--since':
        options.since = takeValue(i, arg); i += 1; break;
      case '--until':
        options.until = takeValue(i, arg); i += 1; break;
      case '--out-dir':
        options.outDir = takeValue(i, arg); i += 1; break;
      case '--db':
        options.db = takeValue(i, arg); i += 1; break;
      case '--report':
        options.report = takeValue(i, arg); i += 1; break;
      case '--report-json':
        options.reportJson = takeValue(i, arg); i += 1; break;
      case '--metadata-session-key':
        options.metadataSessionKey = takeValue(i, arg); i += 1; break;
      case '--subagent-tools':
        options.subagentTools = takeValue(i, arg).split(',').map((v) => v.trim()).filter(Boolean); i += 1; break;
      case '--payload-concurrency':
        options.payloadConcurrency = Number(takeValue(i, arg)); i += 1; break;
      case '--top':
        options.topN = Number(takeValue(i, arg)); i += 1; break;
      case '--truncate-threshold':
        options.truncationThreshold = Number(takeValue(i, arg)); i += 1; break;
      case '--store-raw':
        options.storeRaw = true; break;
      case '--no-duckdb':
        options.duckdb = false; break;
      case '--fixture':
        options.fixture = takeValue(i, arg); i += 1; break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  for (const [name, value] of [
    ['limit', options.limit],
    ['payload-concurrency', options.payloadConcurrency],
    ['top', options.topN],
    ['truncate-threshold', options.truncationThreshold],
  ]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be > 0`);
  }
  if (options.since && Number.isNaN(Date.parse(options.since))) throw new Error('--since must be an ISO/date timestamp');
  if (options.until && Number.isNaN(Date.parse(options.until))) throw new Error('--until must be an ISO/date timestamp');

  options.outDir = resolve(options.outDir);
  options.db = resolve(options.db ?? join(options.outDir, 'analysis.duckdb'));
  options.report = resolve(options.report ?? join(options.outDir, 'report.md'));
  options.reportJson = resolve(options.reportJson ?? join(options.outDir, 'report.json'));
  if (options.fixture) options.fixture = resolve(options.fixture);
  return options;
}

function envRequired(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required in live Cloudflare mode`);
  return value;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function cfFetchJson(url, token, { attempts = 4 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });
      if (response.ok) {
        const text = await response.text();
        return text ? JSON.parse(text) : null;
      }

      const body = await response.text();
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === attempts - 1) {
        throw new Error(`Cloudflare API ${response.status}: ${body.slice(0, 500)}`);
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * 2 ** attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) break;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastError ?? new Error(`Failed to fetch ${url}`);
}

function unwrapEnvelope(payload) {
  if (
    payload && typeof payload === 'object' &&
    Object.prototype.hasOwnProperty.call(payload, 'result') &&
    (Object.prototype.hasOwnProperty.call(payload, 'success') || Object.prototype.hasOwnProperty.call(payload, 'errors'))
  ) return payload.result;
  return payload;
}

async function listCloudflareLogs({ token, accountId, gatewayId, limit, since, until }) {
  const logs = [];
  const sinceMs = since ? Date.parse(since) : null;
  const untilMs = until ? Date.parse(until) : null;
  let page = 1;
  let totalCount = null;
  let reachedSince = false;

  while (logs.length < limit && !reachedSince) {
    const params = new URLSearchParams({
      page: String(page),
      per_page: '50',
      order_by: 'created_at',
      order_by_direction: 'desc',
      meta_info: 'true',
    });
    const url = `${CF_API_BASE}/accounts/${encodeURIComponent(accountId)}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/logs?${params}`;
    const payload = await cfFetchJson(url, token);
    const result = Array.isArray(payload?.result) ? payload.result : [];
    totalCount ??= payload?.result_info?.total_count ?? null;
    if (!result.length) break;

    for (const log of result) {
      const createdMs = log.created_at ? Date.parse(log.created_at) : null;
      if (sinceMs !== null && createdMs !== null && createdMs < sinceMs) {
        reachedSince = true;
        break;
      }
      if (untilMs !== null && createdMs !== null && createdMs > untilMs) continue;
      logs.push(log);
      if (logs.length >= limit) break;
    }

    page += 1;
    if (totalCount !== null && (page - 1) * 50 >= totalCount) break;
  }
  return logs;
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runner()));
  return results;
}

async function fetchPayloadEndpoint({ token, accountId, gatewayId, logId, kind }) {
  const url = `${CF_API_BASE}/accounts/${encodeURIComponent(accountId)}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/logs/${encodeURIComponent(logId)}/${kind}`;
  try {
    const payload = await cfFetchJson(url, token);
    return unwrapEnvelope(payload);
  } catch (error) {
    console.warn(`[warn] ${logId}: could not fetch ${kind} payload: ${error.message}`);
    return null;
  }
}

async function collectLive(options) {
  const token = envRequired('CLOUDFLARE_API_TOKEN');
  const accountId = envRequired('CLOUDFLARE_ACCOUNT_ID');
  const gatewayId = envRequired('CLOUDFLARE_GATEWAY_ID');
  console.log(`[collect] listing up to ${options.limit} logs from gateway ${gatewayId}`);
  const logs = await listCloudflareLogs({
    token,
    accountId,
    gatewayId,
    limit: options.limit,
    since: options.since,
    until: options.until,
  });
  console.log(`[collect] ${logs.length} log entries selected`);

  return mapConcurrent(logs, options.payloadConcurrency, async (log, index) => {
    if ((index + 1) % 25 === 0 || index === 0) console.log(`[payload] ${index + 1}/${logs.length}`);
    const [request, response] = await Promise.all([
      fetchPayloadEndpoint({ token, accountId, gatewayId, logId: log.id, kind: 'request' }),
      fetchPayloadEndpoint({ token, accountId, gatewayId, logId: log.id, kind: 'response' }),
    ]);
    return { log, request, response };
  });
}

async function loadFixture(path) {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  const records = Array.isArray(parsed) ? parsed : parsed.records;
  if (!Array.isArray(records)) throw new Error('Fixture must be an array or {"records": [...]}');
  return records;
}

async function writeJsonLines(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  const text = rows.map((row) => JSON.stringify(row)).join('\n');
  await writeFile(path, text ? `${text}\n` : '', 'utf8');
}

async function writeRawBundle(outDir, record) {
  const rawDir = join(outDir, 'raw');
  await mkdir(rawDir, { recursive: true });
  const content = JSON.stringify(record);
  await writeFile(join(rawDir, `${record.log.id}.json.gz`), gzipSync(Buffer.from(content)));
}

function sqlPath(path) {
  return path.replaceAll("'", "''");
}

async function createDuckDB(dbPath, derivedPaths, dataset) {
  let DuckDBInstance;
  try {
    ({ DuckDBInstance } = await import('@duckdb/node-api'));
  } catch (error) {
    throw new Error(
      `@duckdb/node-api is required for DuckDB output. Run npm install, or use --no-duckdb. Original error: ${error.message}`,
    );
  }

  await mkdir(dirname(dbPath), { recursive: true });
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  try {
    const tableDefs = {
      requests: `
        CREATE OR REPLACE TABLE requests (
          log_id VARCHAR, created_at VARCHAR, provider VARCHAR, model VARCHAR, request_path VARCHAR,
          success BOOLEAN, status_code BIGINT, cached BOOLEAN, tokens_in BIGINT, tokens_out BIGINT,
          cost DOUBLE, duration DOUBLE, session_id VARCHAR, session_source VARCHAR, agent VARCHAR,
          phase VARCHAR, category VARCHAR, experiment VARCHAR, metadata_json VARCHAR,
          payload_available BOOLEAN, token_scale DOUBLE, provider_input_tokens BIGINT,
          provider_output_tokens BIGINT, provider_cache_read_tokens BIGINT, provider_cache_write_tokens BIGINT
        )`,
      components: `
        CREATE OR REPLACE TABLE components (
          log_id VARCHAR, session_id VARCHAR, component VARCHAR, estimated_tokens BIGINT,
          allocated_tokens BIGINT, share DOUBLE
        )`,
      artifacts: `
        CREATE OR REPLACE TABLE artifacts (
          log_id VARCHAR, session_id VARCHAR, component VARCHAR, artifact_type VARCHAR,
          artifact_label VARCHAR, tool_name VARCHAR, message_index BIGINT, artifact_hash VARCHAR,
          estimated_tokens BIGINT, allocated_tokens BIGINT
        )`,
      session_deltas: `
        CREATE OR REPLACE TABLE session_deltas (
          log_id VARCHAR, session_id VARCHAR, turn_index BIGINT, previous_log_id VARCHAR,
          tokens_in BIGINT, delta_tokens_in BIGINT, previous_provider VARCHAR,
          provider_switched BOOLEAN, cache_read_ratio DOUBLE
        )`,
      amplification: `
        CREATE OR REPLACE TABLE amplification (
          session_id VARCHAR, artifact_hash VARCHAR, artifact_type VARCHAR, artifact_label VARCHAR,
          tool_name VARCHAR, occurrence_count BIGINT, total_allocated_tokens BIGINT,
          first_allocated_tokens BIGINT, reread_tokens BIGINT
        )`,
    };

    for (const sql of Object.values(tableDefs)) await connection.run(sql);

    const columnLists = {
      requests: [
        'log_id','created_at','provider','model','request_path','success','status_code','cached','tokens_in','tokens_out',
        'cost','duration','session_id','session_source','agent','phase','category','experiment','metadata_json',
        'payload_available','token_scale','provider_input_tokens','provider_output_tokens','provider_cache_read_tokens','provider_cache_write_tokens',
      ],
      components: ['log_id','session_id','component','estimated_tokens','allocated_tokens','share'],
      artifacts: ['log_id','session_id','component','artifact_type','artifact_label','tool_name','message_index','artifact_hash','estimated_tokens','allocated_tokens'],
      session_deltas: ['log_id','session_id','turn_index','previous_log_id','tokens_in','delta_tokens_in','previous_provider','provider_switched','cache_read_ratio'],
      amplification: ['session_id','artifact_hash','artifact_type','artifact_label','tool_name','occurrence_count','total_allocated_tokens','first_allocated_tokens','reread_tokens'],
    };

    for (const [table, columns] of Object.entries(columnLists)) {
      if (!dataset[table].length) continue;
      const selected = columns.map((column) => `"${column}"`).join(', ');
      await connection.run(`
        INSERT INTO ${table} (${selected})
        SELECT ${selected}
        FROM read_json_auto('${sqlPath(derivedPaths[table])}', format='newline_delimited')
      `);
    }

    await connection.run(`
      CREATE OR REPLACE VIEW component_share AS
      SELECT component, sum(allocated_tokens)::BIGINT AS allocated_tokens,
             sum(allocated_tokens) / nullif((SELECT sum(tokens_in) FROM requests), 0) AS share
      FROM components GROUP BY component ORDER BY allocated_tokens DESC
    `);
    await connection.run(`
      CREATE OR REPLACE VIEW top_context_amplifiers AS
      SELECT * FROM amplification WHERE occurrence_count > 1 ORDER BY reread_tokens DESC
    `);
    await connection.run(`
      CREATE OR REPLACE VIEW provider_switch_cache AS
      SELECT provider_switched, count(*) AS transitions,
             median(cache_read_ratio) FILTER (WHERE cache_read_ratio IS NOT NULL) AS cache_read_ratio_p50
      FROM session_deltas WHERE previous_log_id IS NOT NULL GROUP BY provider_switched
    `);
  } finally {
    connection.closeSync();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  await mkdir(options.outDir, { recursive: true });
  const records = options.fixture ? await loadFixture(options.fixture) : await collectLive(options);
  if (!records.length) throw new Error('No logs matched the requested range');

  if (options.storeRaw) {
    console.log(`[raw] saving ${records.length} gzip bundles under ${join(options.outDir, 'raw')}`);
    await mapConcurrent(records, 4, (record) => writeRawBundle(options.outDir, record));
  }

  const dataset = {
    requests: [],
    components: [],
    artifacts: [],
    session_deltas: [],
    amplification: [],
  };

  for (const record of records) {
    const analyzed = analyzeLogRecord(record.log, record.request, record.response, {
      metadataSessionKey: options.metadataSessionKey,
      subagentTools: options.subagentTools,
    });
    dataset.requests.push(analyzed.request);
    dataset.components.push(...analyzed.components);
    dataset.artifacts.push(...analyzed.artifacts);
  }
  dataset.session_deltas = buildSessionDeltas(dataset.requests);
  dataset.amplification = buildAmplification(dataset.artifacts);

  const derivedDir = join(options.outDir, 'derived');
  const derivedPaths = {
    requests: join(derivedDir, 'requests.jsonl'),
    components: join(derivedDir, 'components.jsonl'),
    artifacts: join(derivedDir, 'artifacts.jsonl'),
    session_deltas: join(derivedDir, 'session_deltas.jsonl'),
    amplification: join(derivedDir, 'amplification.jsonl'),
  };
  await Promise.all(Object.entries(derivedPaths).map(([key, path]) => writeJsonLines(path, dataset[key])));

  const report = buildReportData(dataset, {
    topN: options.topN,
    truncationThreshold: options.truncationThreshold,
  });
  await mkdir(dirname(options.report), { recursive: true });
  await writeFile(options.report, renderMarkdownReport(report), 'utf8');
  await writeFile(options.reportJson, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  if (options.duckdb) {
    console.log(`[duckdb] writing ${options.db}`);
    await createDuckDB(options.db, derivedPaths, dataset);
  }

  console.log(`[report] ${options.report}`);
  console.log(`[report] ${options.reportJson}`);
  console.log(`[summary] input/request p50=${Math.round(report.input_tokens_p50 ?? 0).toLocaleString()} p95=${Math.round(report.input_tokens_p95 ?? 0).toLocaleString()} sessions=${report.sessions}`);
  console.log('[summary] top recommendations:');
  for (const recommendation of report.recommendations.slice(0, 3)) console.log(`  - ${recommendation}`);
}

main().catch((error) => {
  console.error(`[error] ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
