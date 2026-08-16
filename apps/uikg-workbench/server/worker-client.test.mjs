import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { runWorkerModel } from './worker-client.mjs';

const responseSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['frameId', 'elements'],
  properties: {
    frameId: { type: 'string' },
    elements: { type: 'array', uniqueItems: true, items: { type: 'string' } },
  },
};

test('Worker A client sends a frozen image and repairs streamed JSON', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'vibeops-worker-a-'));
  const imagePath = path.join(tempRoot, 'frame.png');
  await writeFile(imagePath, Buffer.from([137, 80, 78, 71]));

  const server = createServer((request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body);
      assert.equal(payload.model, 'qwen3.7-flash');
      assert.equal(payload.enable_thinking, false);
      assert.equal(payload.response_format.type, 'json_schema');
      assert.equal(payload.response_format.json_schema.strict, true);
      assert.equal(payload.response_format.json_schema.schema.properties.elements.uniqueItems, undefined);
      assert.equal(payload.messages[0].role, 'system');
      assert.match(payload.messages[0].content, /思考过程.*简体中文/);
      assert.match(payload.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"{\\"frameId\\":\\"f\\","}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"content":"\\"elements\\":[]}"}}]}\n\n');
      response.end('data: [DONE]\n\n');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const previous = {
    baseUrl: process.env.MIDSCENE_WORKER_A_MODEL_BASE_URL,
    apiKey: process.env.MIDSCENE_WORKER_A_MODEL_API_KEY,
    model: process.env.MIDSCENE_WORKER_A_MODEL_NAME,
  };
  process.env.MIDSCENE_WORKER_A_MODEL_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.MIDSCENE_WORKER_A_MODEL_API_KEY = 'test-key';
  process.env.MIDSCENE_WORKER_A_MODEL_NAME = 'qwen3.7-flash';
  const chunks = [];

  try {
    const result = await runWorkerModel({
      worker: 'worker_a',
      prompt: 'inventory this frame',
      imagePath,
      responseSchema,
      onChunk: (chunk) => chunks.push(chunk.content),
    });
    assert.deepEqual(result, { frameId: 'f', elements: [] });
    assert.deepEqual(chunks, ['{"frameId":"f",', '"elements":[]}']);
  } finally {
    if (previous.baseUrl === undefined) delete process.env.MIDSCENE_WORKER_A_MODEL_BASE_URL;
    else process.env.MIDSCENE_WORKER_A_MODEL_BASE_URL = previous.baseUrl;
    if (previous.apiKey === undefined) delete process.env.MIDSCENE_WORKER_A_MODEL_API_KEY;
    else process.env.MIDSCENE_WORKER_A_MODEL_API_KEY = previous.apiKey;
    if (previous.model === undefined) delete process.env.MIDSCENE_WORKER_A_MODEL_NAME;
    else process.env.MIDSCENE_WORKER_A_MODEL_NAME = previous.model;
    server.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
