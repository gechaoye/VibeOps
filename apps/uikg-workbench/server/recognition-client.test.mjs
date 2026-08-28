import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { runRecognitionModel } from './recognition-client.mjs';
import { clearModelRuntime, setModelRuntime } from './model-runtime.mjs';

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

test('Recognition client sends a frozen image and repairs streamed JSON', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'vibeops-recognition-'));
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
      assert.equal(payload.enable_thinking, true);
      assert.equal(payload.thinking_budget, 2048);
      assert.equal(payload.response_format.type, 'json_schema');
      assert.equal(payload.response_format.json_schema.strict, true);
      assert.equal(payload.response_format.json_schema.schema.properties.elements.uniqueItems, undefined);
      assert.equal(payload.messages[0].role, 'system');
      assert.match(payload.messages[0].content, /只返回请求 Schema 对应的 JSON 对象/);
      assert.match(payload.messages[0].content, /只记录截图内实际可见区域/);
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
  setModelRuntime('manual', {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-key', modelName: 'qwen3.7-flash',
    modelFamily: 'qwen3', temperature: 0, reasoningEffort: 'low',
    structuredOutputMode: 'native',
  });
  const chunks = [];

  try {
    const result = await runRecognitionModel({
      target: 'manual',
      prompt: 'inventory this frame',
      imagePath,
      responseSchema,
      onChunk: (chunk) => chunks.push(chunk.content),
    });
    assert.deepEqual(result, { frameId: 'f', elements: [] });
    assert.deepEqual(chunks, ['{"frameId":"f",', '"elements":[]}']);
  } finally {
    clearModelRuntime('manual');
    server.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Recognition client separates MiniMax think tags from streamed model output', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"<thi"}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"nk>检查页面"}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"结构</th"}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"ink>{\\"frameId\\":\\"f\\","}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"\\"elements\\":[]}"}}]}\n\n');
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  setModelRuntime('manual', {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-key', modelName: 'MiniMax-M3',
    modelFamily: 'gpt-5', temperature: 0, reasoningEffort: 'low',
    structuredOutputMode: 'local',
  });
  const chunks = [];

  try {
    const result = await runRecognitionModel({
      target: 'manual', prompt: 'inspect', imageBuffer: Buffer.from([137, 80, 78, 71]), responseSchema,
      onChunk: (chunk) => chunks.push(chunk),
    });
    assert.deepEqual(result, { frameId: 'f', elements: [] });
    assert.equal(chunks.map((chunk) => chunk.reasoning_content).join(''), '检查页面结构');
    assert.equal(chunks.map((chunk) => chunk.content).join(''), '{"frameId":"f","elements":[]}');
  } finally {
    clearModelRuntime('manual');
    server.close();
  }
});

test('Recognition client ignores a final message snapshot already received through deltas', async () => {
  const content = '{"frameId":"f","elements":[]}';
  const reasoning = '分析空白图像';
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ delta: { reasoning_content: reasoning } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ finish_reason: 'stop', delta: { content } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ object: 'chat.completion', choices: [{ finish_reason: 'stop', message: { content, reasoning_content: reasoning } }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  setModelRuntime('manual', {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-key', modelName: 'MiniMax-M3',
    modelFamily: 'gpt-5', temperature: 0, reasoningEffort: 'low', structuredOutputMode: 'local',
  });
  const chunks = [];
  try {
    const result = await runRecognitionModel({
      target: 'manual', prompt: 'inspect', imageBuffer: Buffer.from([137, 80, 78, 71]), responseSchema,
      onChunk: (chunk) => chunks.push(chunk),
    });
    assert.deepEqual(result, { frameId: 'f', elements: [] });
    assert.equal(chunks.map((chunk) => chunk.content).join(''), content);
    assert.equal(chunks.map((chunk) => chunk.reasoning_content).join(''), reasoning);
  } finally {
    clearModelRuntime('manual');
    server.close();
  }
});

test('Recognition client preserves reasoning aliases and split analysis tags', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '<ana' } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'lysis>先' } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { thinking: '检查页面结构' } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '后续</analysis>{"frameId":"f","elements":[]}' } }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  setModelRuntime('manual', {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-key', modelName: 'gpt-5.6-terra',
    modelFamily: 'gpt-5', temperature: 0, reasoningEffort: 'medium', structuredOutputMode: 'local',
  });
  const chunks = [];

  try {
    const result = await runRecognitionModel({
      target: 'manual', prompt: 'inspect', imageBuffer: Buffer.from([137, 80, 78, 71]), responseSchema,
      onChunk: (chunk) => chunks.push(chunk),
    });
    assert.deepEqual(result, { frameId: 'f', elements: [] });
    assert.equal(chunks.map((chunk) => chunk.reasoning_content).join(''), '先检查页面结构后续');
    assert.equal(chunks.map((chunk) => chunk.content).join(''), '{"frameId":"f","elements":[]}');
  } finally {
    clearModelRuntime('manual');
    server.close();
  }
});

test('Recognition client sends the configured reasoning effort', async () => {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body);
      assert.equal(payload.model, 'gpt-5.6-sol');
      assert.equal(payload.reasoning_effort, 'high');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}\n\n');
      response.end('data: [DONE]\n\n');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  setModelRuntime('manual', {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-key', modelName: 'gpt-5.6-sol',
    modelFamily: 'gpt-5', temperature: 0, reasoningEffort: 'high',
    structuredOutputMode: 'local',
  });

  try {
    const result = await runRecognitionModel({
      target: 'manual',
      prompt: 'review this frame',
      imageBuffer: Buffer.from([137, 80, 78, 71]),
    });
    assert.deepEqual(result, { ok: true });
  } finally {
    clearModelRuntime('manual');
    server.close();
  }
});

test('Recognition client provider errors start with 模型请求失败', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Invalid schema' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  setModelRuntime('manual', {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-key', modelName: 'gpt-5.6-terra',
    modelFamily: 'gpt-5', temperature: 0, reasoningEffort: 'medium',
    structuredOutputMode: 'local',
  });

  try {
    await assert.rejects(
      runRecognitionModel({
        target: 'manual', prompt: 'inspect', imageBuffer: Buffer.from([137, 80, 78, 71]),
      }),
      { message: '模型请求失败（400）：Invalid schema' },
    );
  } finally {
    clearModelRuntime('manual');
    server.close();
  }
});

test('Recognition 为 Qwen、Doubao 和 MiniMax 构造兼容请求', async () => {
  const received = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      received.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}\n\n');
      response.end('data: [DONE]\n\n');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const models = [
    { modelName: 'qwen3.8-max', modelFamily: 'qwen3', reasoningEffort: 'high' },
    { modelName: 'doubao-seed-2.1-pro', modelFamily: 'doubao-seed', reasoningEffort: 'medium' },
    { modelName: 'MiniMax-M3', modelFamily: 'gpt-5', reasoningEffort: 'low' },
  ];

  try {
    for (const model of models) {
      setModelRuntime('manual', {
        baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-key', temperature: 0, structuredOutputMode: 'local', ...model,
      });
      await runRecognitionModel({
        target: 'manual', prompt: 'inspect', imageBuffer: Buffer.from([137, 80, 78, 71]), responseSchema,
      });
    }
    assert.equal(received[0].enable_thinking, true);
    assert.equal(received[0].thinking_budget, 16384);
    assert.equal(received[0].response_format, undefined);
    assert.deepEqual(received[1].thinking, { type: 'enabled' });
    assert.equal(received[1].reasoning_effort, 'medium');
    assert.equal(received[1].response_format, undefined);
    assert.equal(received[2].reasoning_effort, 'low');
    assert.equal(received[2].response_format, undefined);
  } finally {
    clearModelRuntime('manual');
    server.close();
  }
});
