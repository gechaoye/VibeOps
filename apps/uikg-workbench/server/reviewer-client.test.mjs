import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runReviewerModel } from './reviewer-client.mjs';

const previousEnv = () => ({
  baseUrl: process.env.MIDSCENE_MODEL_BASE_URL,
  apiKey: process.env.MIDSCENE_MODEL_API_KEY,
  model: process.env.MIDSCENE_MODEL_NAME,
  family: process.env.MIDSCENE_MODEL_FAMILY,
  reasoning: process.env.MIDSCENE_MODEL_REASONING_ENABLED,
});

const restoreEnv = (previous) => {
  for (const [name, value] of Object.entries({
    MIDSCENE_MODEL_BASE_URL: previous.baseUrl,
    MIDSCENE_MODEL_API_KEY: previous.apiKey,
    MIDSCENE_MODEL_NAME: previous.model,
    MIDSCENE_MODEL_FAMILY: previous.family,
    MIDSCENE_MODEL_REASONING_ENABLED: previous.reasoning,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};

test('Reviewer client streams reasoning and structured output from a frozen image', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'vibeops-reviewer-'));
  const imagePath = path.join(tempRoot, 'frame.png');
  await writeFile(imagePath, Buffer.from([137, 80, 78, 71]));
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body);
      assert.equal(payload.model, 'test-reviewer');
      assert.equal(payload.stream, true);
      assert.equal(payload.reasoning_effort, 'medium');
      assert.match(payload.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"reasoning_content":"先检查截图"}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"content":"{\\"frameId\\":\\"f\\","}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"content":"\\"elements\\":[]}"}}]}\n\n');
      response.end('data: [DONE]\n\n');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const previous = previousEnv();
  process.env.MIDSCENE_MODEL_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  process.env.MIDSCENE_MODEL_API_KEY = 'test-key';
  process.env.MIDSCENE_MODEL_NAME = 'test-reviewer';
  process.env.MIDSCENE_MODEL_FAMILY = 'gpt-5';
  process.env.MIDSCENE_MODEL_REASONING_ENABLED = 'true';
  const chunks = [];

  try {
    const result = await runReviewerModel({ prompt: '识别截图', imagePath, onChunk: (chunk) => chunks.push(chunk) });
    assert.deepEqual(result, { frameId: 'f', elements: [] });
    assert.equal(chunks[0].reasoning_content, '先检查截图');
    assert.equal(chunks.slice(1).map((chunk) => chunk.content).join(''), '{"frameId":"f","elements":[]}');
  } finally {
    restoreEnv(previous);
    server.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Reviewer client condenses an upstream 524 error', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'vibeops-reviewer-'));
  const imagePath = path.join(tempRoot, 'frame.png');
  await writeFile(imagePath, Buffer.from([137, 80, 78, 71]));
  const server = createServer((_request, response) => {
    response.writeHead(524, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ detail: 'origin did not return a complete response within 120 seconds', stack: 'should not be shown' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const previous = previousEnv();
  process.env.MIDSCENE_MODEL_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  process.env.MIDSCENE_MODEL_API_KEY = 'test-key';
  process.env.MIDSCENE_MODEL_NAME = 'test-reviewer';

  try {
    await assert.rejects(
      runReviewerModel({ prompt: '识别截图', imagePath }),
      (error) => error.message === 'Reviewer 模型响应超时（524）：origin did not return a complete response within 120 seconds',
    );
  } finally {
    restoreEnv(previous);
    server.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
