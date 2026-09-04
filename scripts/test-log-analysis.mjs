#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyzeLogRecord,
  buildAmplification,
  buildReportData,
  buildSessionDeltas,
  extractProviderUsage,
  stableStringify,
} from './lib/log-analysis.mjs';

function makeLog(id, tokensIn, provider = 'ollama', metadata = { session: 's1' }) {
  return {
    id,
    created_at: `2026-09-04T00:00:0${id}.000Z`,
    provider,
    model: 'kimi-k2.7-code',
    success: true,
    status_code: 200,
    cached: false,
    tokens_in: tokensIn,
    tokens_out: 100,
    metadata,
  };
}

const request1 = {
  model: 'dynamic/kimi-k2.7-code',
  messages: [
    { role: 'system', content: 'stable system prompt' },
    { role: 'user', content: 'Implement task one' },
    {
      role: 'assistant',
      content: 'I will delegate.',
      tool_calls: [
        { id: 'call-task', type: 'function', function: { name: 'task', arguments: '{"category":"quick"}' } },
        { id: 'call-read', type: 'function', function: { name: 'read', arguments: '{"file":"a.ts"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call-task', content: 'STATUS: complete\nCOMMIT: abc\nTESTS: pass' },
    { role: 'tool', tool_call_id: 'call-read', content: 'export const x = 1;'.repeat(100) },
  ],
  tools: [
    { type: 'function', function: { name: 'task', description: 'delegate', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'read', description: 'read file', parameters: { type: 'object' } } },
  ],
};

const request2 = {
  ...request1,
  messages: [
    ...request1.messages,
    { role: 'assistant', content: 'Task one is complete.' },
    { role: 'user', content: 'Continue.' },
  ],
};

const responseOpenAI = {
  usage: {
    prompt_tokens: 1200,
    completion_tokens: 150,
    prompt_tokens_details: { cached_tokens: 900 },
  },
};

const responseAnthropic = {
  usage: {
    input_tokens: 1000,
    output_tokens: 120,
    cache_read_input_tokens: 800,
    cache_creation_input_tokens: 100,
  },
};

const analyzed1 = analyzeLogRecord(makeLog('1', 1000), request1, responseOpenAI);
const analyzed2 = analyzeLogRecord(makeLog('2', 1250, 'commandcode'), request2, responseAnthropic);
const anthropicRequest = {
  model: 'claude-sonnet',
  messages: [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool-task', name: 'task', input: { category: 'quick' } }],
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'The delegated task completed.' },
        { type: 'tool_result', tool_use_id: 'tool-task', content: 'STATUS: complete' },
      ],
    },
  ],
};
const analyzedAnthropic = analyzeLogRecord(makeLog('5', 700), anthropicRequest, {});

assert.equal(
  analyzed1.components.reduce((sum, row) => sum + row.allocated_tokens, 0),
  1000,
  'allocated component tokens must equal Cloudflare tokens_in',
);
assert.ok(analyzed1.components.some((row) => row.component === 'system'));
assert.ok(analyzed1.components.some((row) => row.component === 'tool_schema'));
assert.ok(analyzed1.artifacts.some((row) => row.artifact_type === 'subagent_return' && row.tool_name === 'task'));
assert.ok(analyzed1.artifacts.some((row) => row.artifact_type === 'tool_output' && row.tool_name === 'read'));
assert.equal(analyzed1.request.session_id, 's1');
assert.equal(analyzed1.request.session_source, 'metadata:session');
assert.equal(analyzed1.request.provider_cache_read_tokens, 900);
assert.equal(analyzed2.request.provider_cache_read_tokens, 800);
assert.equal(analyzed2.request.provider_cache_write_tokens, 100);
assert.ok(analyzedAnthropic.artifacts.some((row) => (
  row.artifact_type === 'subagent_return' && row.component === 'subagent_return' && row.tool_name === 'task'
)));
assert.ok(analyzedAnthropic.artifacts.some((row) => (
  row.artifact_type === 'user_message' && row.component === 'user_history'
)));
assert.equal(stableStringify({ a: 1, A: 2 }), '{"a":1,"A":2}');

const requests = [analyzed1.request, analyzed2.request];
const components = [...analyzed1.components, ...analyzed2.components];
const artifacts = [...analyzed1.artifacts, ...analyzed2.artifacts];
const sessionDeltas = buildSessionDeltas(requests);
const amplification = buildAmplification(artifacts);

assert.equal(sessionDeltas.length, 2);
assert.equal(sessionDeltas[1].delta_tokens_in, 250);
assert.equal(sessionDeltas[1].provider_switched, true);
assert.ok(amplification.some((row) => row.occurrence_count > 1 && row.reread_tokens > 0));

const inferred = analyzeLogRecord(
  makeLog('3', 500, 'ollama', {}),
  { messages: [{ role: 'user', content: 'same stable first prompt' }] },
  {},
);
assert.match(inferred.request.session_id, /^inferred:/);
assert.equal(inferred.request.session_source, 'inferred:first-user');

assert.deepEqual(extractProviderUsage(responseOpenAI), {
  provider_input_tokens: 1200,
  provider_output_tokens: 150,
  provider_cache_read_tokens: 900,
  provider_cache_write_tokens: null,
});

const report = buildReportData({
  requests,
  components,
  artifacts,
  session_deltas: sessionDeltas,
  amplification,
});
assert.equal(report.requests, 2);
assert.equal(report.sessions, 1);
assert.ok(report.component_summary.length > 0);
assert.ok(Array.isArray(report.recommendations));

const tempDir = mkdtempSync(join(tmpdir(), 'cf-ai-gw-sonar-'));
try {
  const fixturePath = join(tempDir, 'fixture.json');
  const outputDir = join(tempDir, 'output');
  writeFileSync(fixturePath, JSON.stringify([{ log: makeLog('4', 500), request: request1, response: {} }]));
  const result = spawnSync(
    process.execPath,
    ['scripts/analyze-logs.mjs', '--fixture', fixturePath, '--store-raw', '--no-duckdb', '--out-dir', outputDir],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\[raw\] saving gzip bundles under raw output directory$/m);

  const chronologicalFixturePath = join(tempDir, 'chronological-fixture.json');
  const chronologicalOutputDir = join(tempDir, 'chronological-output');
  const stableRequest = { messages: [{ role: 'user', content: 'same artifact' }] };
  writeFileSync(
    chronologicalFixturePath,
    JSON.stringify([
      { log: makeLog('2', 200), request: stableRequest, response: {} },
      { log: makeLog('1', 100), request: stableRequest, response: {} },
    ]),
  );
  const chronologicalResult = spawnSync(
    process.execPath,
    [
      'scripts/analyze-logs.mjs',
      '--fixture',
      chronologicalFixturePath,
      '--no-duckdb',
      '--out-dir',
      chronologicalOutputDir,
    ],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' },
  );
  assert.equal(chronologicalResult.status, 0, chronologicalResult.stderr);
  const chronologicalReport = JSON.parse(
    readFileSync(join(chronologicalOutputDir, 'report.json'), 'utf8'),
  );
  assert.equal(chronologicalReport.top_amplifiers[0].first_allocated_tokens, 100);
  assert.equal(chronologicalReport.top_amplifiers[0].reread_tokens, 200);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log('✓ log-analysis self-test passed');
