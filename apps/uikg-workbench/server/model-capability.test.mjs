import assert from 'node:assert/strict';
import test from 'node:test';
import { probeModelCapability } from './model-capability.mjs';

const config = { baseUrl: 'https://gateway.example/v1', apiKey: 'secret', modelName: 'gpt-5.6-terra' };
const stream = (content, status = 200) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`, { status });

test('能力检测优先使用完整原生结构化输出', async () => {
  let calls = 0;
  const result = await probeModelCapability(config, async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(JSON.stringify(body.response_format).includes('#/properties/'), false);
    return stream('{"frameId":"probe"}');
  });
  assert.equal(result.mode, 'native');
  assert.equal(calls, 1);
});

test('原生 Schema 不兼容但普通 JSON 可用时回退本地校验', async () => {
  let calls = 0;
  const result = await probeModelCapability(config, async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    if (body.response_format) return new Response(JSON.stringify({ error: { message: 'unsupported response_format' } }), { status: 400 });
    return stream('{"frameId":"probe"}');
  });
  assert.equal(result.mode, 'local');
  assert.equal(calls, 2);
});

test('原生与普通 JSON 请求都失败时标记不可用', async () => {
  const result = await probeModelCapability(config, async () => new Response('model unavailable', { status: 503 }));
  assert.equal(result.mode, 'unavailable');
  assert.match(result.detail, /model unavailable/);
});

test('能力检测忽略 MiniMax think 推理段后解析 JSON', async () => {
  const result = await probeModelCapability(config, async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.response_format) return new Response(JSON.stringify({ error: { message: 'unsupported response_format' } }), { status: 400 });
    return stream('<think>先分析一个无关对象 {"noise":true}</think>{"frameId":"probe"}');
  });
  assert.equal(result.mode, 'local');
});
