import { readFile } from 'node:fs/promises';
import { jsonrepair } from 'jsonrepair';
import { chatCompletionCompatibility } from './model-compatibility.mjs';
import { openAIStructuredOutputSchema, supportsStructuredOutput } from './structured-output-schema.mjs';
import { getModelRuntime } from './model-runtime.mjs';

const CHINESE_SYSTEM_PROMPT = '你必须始终使用简体中文进行思考和回答。所有可见的思考过程、推理内容、说明和最终输出中的自然语言都必须是简体中文；JSON 的键名和约定枚举值保持 Schema 要求。';

const WORKERS = {
  worker_a: { label: 'Worker A' },
  worker_b: { label: 'Worker B' },
};

function workerConfig(worker) {
  const definition = WORKERS[worker];
  if (!definition) throw new Error(`未知 Worker：${worker}`);
  const runtime = getModelRuntime(worker);
  if (!runtime) throw new Error(`${definition.label} 模型运行时尚未加载`);
  const reasoningEffort = runtime.reasoningEffort;
  return {
    ...definition,
    model: runtime.modelName,
    apiKey: runtime.apiKey,
    baseUrl: runtime.baseUrl,
    modelFamily: String(runtime.modelFamily || '').toLowerCase(),
    temperature: Number(runtime.temperature || 0),
    reasoningEffort,
    reasoningEnabled: true,
  };
}

function endpointFor(config) {
  const value = String(config.baseUrl || '').trim().replace(/\/+$/, '');
  if (!value) throw new Error(`未配置 ${config.label} 模型 Base URL`);
  return value.endsWith('/chat/completions') ? value : `${value}/chat/completions`;
}

function parseObject(source, label) {
  const text = String(source || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`${label} 模型未返回 JSON 对象`);
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return JSON.parse(jsonrepair(text.slice(start)));
  }
}

function extractDelta(payload) {
  const choice = payload?.choices?.[0];
  const delta = choice?.delta || choice?.message || {};
  return {
    content: typeof delta.content === 'string' ? delta.content : '',
    reasoningContent: typeof delta.reasoning_content === 'string'
      ? delta.reasoning_content
      : typeof delta.reasoningContent === 'string' ? delta.reasoningContent : '',
  };
}

function providerError(config, status, detail) {
  let message = '';
  try {
    const body = JSON.parse(detail);
    message = body?.detail || body?.error?.message || body?.message || body?.title || '';
  } catch {
    message = String(detail || '').trim();
  }
  return new Error(`${config.label} 模型请求失败（${status}）${message ? `：${message.slice(0, 500)}` : ''}`);
}

export async function runWorkerModel({
  worker,
  prompt,
  imagePath,
  imageBuffer,
  mimeType = 'image/png',
  responseSchema,
  continuation = false,
  signal,
  onChunk = () => {},
}) {
  const config = workerConfig(worker);
  if (!config.model) throw new Error(`未配置 ${config.label} 模型`);
  if (!config.apiKey) throw new Error(`未配置 ${config.label} 模型网关凭据`);

  const bytes = imageBuffer ? Buffer.from(imageBuffer) : await readFile(imagePath);
  const image = bytes.toString('base64');
  const requestBody = {
    model: config.model,
    temperature: config.temperature,
    stream: true,
    messages: [{ role: 'system', content: CHINESE_SYSTEM_PROMPT }, {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${image}`, detail: 'high' } },
      ],
    }],
  };
  Object.assign(requestBody, chatCompletionCompatibility({
    modelName: config.model,
    reasoningEffort: config.reasoningEffort,
    reasoningEnabled: config.reasoningEnabled,
  }));
  if (responseSchema && supportsStructuredOutput(config.model, config.modelFamily)) {
    requestBody.response_format = {
      type: 'json_schema',
      json_schema: {
        name: `uikg_${worker}_${continuation ? 'continuation' : 'result'}`,
        strict: true,
        schema: openAIStructuredOutputSchema(responseSchema, { continuation }),
      },
    };
  }

  const response = await fetch(endpointFor(config), {
    method: 'POST',
    signal,
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw providerError(config, response.status, detail);
  }
  if (!response.body) throw new Error(`${config.label} 模型没有返回可读取的响应流`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';
  let done = false;
  const consumeLine = (line) => {
    const value = line.trim();
    if (!value || !value.startsWith('data:')) return;
    const payload = value.slice(5).trim();
    if (payload === '[DONE]') {
      done = true;
      return;
    }
    try {
      const delta = extractDelta(JSON.parse(payload));
      if (delta.content) accumulated += delta.content;
      if (delta.content || delta.reasoningContent) {
        onChunk({ content: delta.content, reasoning_content: delta.reasoningContent, accumulated });
      }
    } catch {
      // Providers occasionally emit non-JSON keepalive chunks.
    }
  };

  while (!done) {
    const { value, done: streamDone } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !streamDone });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    lines.forEach(consumeLine);
    if (streamDone) break;
  }
  if (buffer) consumeLine(buffer);
  return parseObject(accumulated, config.label);
}
