import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { runRecognitionRepairModel } from './recognition-repair-client.mjs';
import { clearModelRuntime, setModelRuntime } from './model-runtime.mjs';

const responseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['frameId'],
  properties: { frameId: { type: 'string' } },
};

async function withRepairGateway(mode, assertion) {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      assertion(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: '<think>检查 {"draft":true}</think>\n```json\n{"frameId":"frame-1"}\n```', reasoning_content: '已做最小修复' } }] }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  setModelRuntime('self_heal', {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'secret', modelName: 'repair-model',
    temperature: 0, reasoningEffort: 'low', structuredOutputMode: mode, timeout: 10_000,
  });
  try {
    return await runRecognitionRepairModel({
      frameId: 'frame-1', candidate: { frameId: 'wrong' },
      schemaErrors: [{ instancePath: '/frameId', message: 'invalid' }], consistencyIssues: [], normalizationIssues: [], responseSchema,
    });
  } finally {
    clearModelRuntime('self_heal');
    await new Promise((resolve) => server.close(resolve));
  }
}

test('local 自愈模型不发送 response_format 并在本地解析完整 JSON', async () => {
  const result = await withRepairGateway('local', (payload) => {
    assert.equal(payload.stream, false);
    assert.equal(payload.response_format, undefined);
    assert.match(payload.messages[1].content, /interactionBoundary 只能是 "none"、"candidate_bbox"/);
    assert.match(payload.messages[1].content, /待修复 JSON/);
  });
  assert.deepEqual(result.repairedResult, { frameId: 'frame-1' });
  assert.equal(result.reasoningContent, '已做最小修复');
});

test('native 自愈模型发送严格 JSON Schema', async () => {
  const result = await withRepairGateway('native', (payload) => {
    assert.equal(payload.response_format.type, 'json_schema');
    assert.equal(payload.response_format.json_schema.strict, true);
    assert.deepEqual(payload.response_format.json_schema.schema.required, ['frameId']);
  });
  assert.deepEqual(result.repairedResult, { frameId: 'frame-1' });
});
