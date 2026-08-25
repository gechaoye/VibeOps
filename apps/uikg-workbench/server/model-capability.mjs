import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { jsonrepair } from 'jsonrepair';
import { chatCompletionCompatibility } from './model-compatibility.mjs';
import { openAIStructuredOutputSchema } from './structured-output-schema.mjs';

const capabilitySchemaPromise = readFile(new URL('./recognition-output.schema.json', import.meta.url), 'utf8').then(JSON.parse);

export const MODEL_CAPABILITY_MODES = ['native', 'local', 'unavailable'];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function createProbeImage() {
  const size = 32;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc(size * (1 + size * 3), 255);
  for (let row = 0; row < size; row += 1) rows[row * (1 + size * 3)] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

const PROBE_IMAGE = createProbeImage();

function endpointFor(baseUrl) {
  const value = String(baseUrl || '').trim().replace(/\/+$/, '');
  return value.endsWith('/chat/completions') ? value : `${value}/chat/completions`;
}

function requestBody(config, structuredSchema) {
  const body = {
    model: config.modelName,
    temperature: 0,
    stream: true,
    messages: [
      { role: 'system', content: '只输出简体中文 JSON，不要输出 Markdown 或解释。' },
      { role: 'user', content: [
        { type: 'text', text: '这是模型能力检测。请返回一个完整的页面识别 JSON 对象；如果画面没有可识别元素，elements 可以为空。' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PROBE_IMAGE}`, detail: 'low' } },
      ] },
    ],
  };
  Object.assign(body, chatCompletionCompatibility({ modelName: config.modelName, reasoningEffort: 'low', reasoningEnabled: true }));
  if (structuredSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'uikg_capability_probe', strict: true, schema: structuredSchema },
    };
  }
  return body;
}

async function tryRequest(config, structuredSchema, request) {
  let response;
  try {
    response = await request(endpointFor(config.baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(requestBody(config, structuredSchema)),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    return { ok: false, status: 0, detail: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) return { ok: false, status: response.status, detail: (await response.text().catch(() => '')).slice(0, 500) };
  const raw = await response.text().catch(() => '');
  let content = '';
  for (const line of raw.split(/\r?\n/)) {
    const value = line.trim();
    if (!value.startsWith('data:')) continue;
    const payload = value.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const choice = JSON.parse(payload)?.choices?.[0];
      const delta = choice?.delta || choice?.message || {};
      if (typeof delta.content === 'string') content += delta.content;
    } catch {}
  }
  if (!content && raw.trim().startsWith('{')) {
    try {
      const payload = JSON.parse(raw);
      content = payload?.choices?.[0]?.message?.content || payload?.output_text || '';
    } catch {}
  }
  const visibleContent = stripThinking(content);
  const start = visibleContent.indexOf('{');
  if (start < 0) return { ok: false, status: response.status, detail: '模型响应中没有 JSON 对象' };
  try {
    JSON.parse(jsonrepair(visibleContent.slice(start).replace(/\s*```\s*$/i, '')));
  } catch (error) {
    return { ok: false, status: response.status, detail: `模型响应 JSON 无法解析：${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, status: response.status };
}

function errorDetail(result) {
  if (!result?.detail) return `HTTP ${result?.status || 0}`;
  try {
    const body = JSON.parse(result.detail);
    return body?.detail || body?.error?.message || body?.message || body?.title || result.detail;
  } catch { return result.detail; }
}

function stripThinking(content) {
  return String(content || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .trim();
}

export async function probeModelCapability(config, request = fetch) {
  if (!config?.baseUrl || !config?.apiKey || !config?.modelName) {
    return { mode: 'unavailable', checkedAt: new Date().toISOString(), detail: '模型网关、凭据或模型名称未配置' };
  }
  let schema;
  try {
    schema = openAIStructuredOutputSchema(await capabilitySchemaPromise);
  } catch (error) {
    return { mode: 'unavailable', checkedAt: new Date().toISOString(), detail: error instanceof Error ? error.message : String(error) };
  }
  const native = await tryRequest(config, schema, request);
  if (native.ok) return { mode: 'native', checkedAt: new Date().toISOString(), detail: '原生 JSON Schema 输出可用' };
  const local = await tryRequest(config, null, request);
  if (local.ok) return { mode: 'local', checkedAt: new Date().toISOString(), detail: `原生结构化输出不可用，已切换本地校验：${errorDetail(native)}` };
  return { mode: 'unavailable', checkedAt: new Date().toISOString(), detail: `原生请求：${errorDetail(native)}；普通 JSON 请求：${errorDetail(local)}` };
}
