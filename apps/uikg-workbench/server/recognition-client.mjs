import { readFile } from 'node:fs/promises';
import { jsonrepair } from 'jsonrepair';
import { chatCompletionCompatibility } from './model-compatibility.mjs';
import { openAIStructuredOutputSchema } from './structured-output-schema.mjs';
import { getModelRuntime } from './model-runtime.mjs';

const CHINESE_SYSTEM_PROMPT = '你必须始终使用简体中文进行思考和回答。所有可见的思考过程、推理内容、说明和最终输出中的自然语言都必须是简体中文；JSON 的键名和约定枚举值保持 Schema 要求。';

const RECOGNITION_TARGETS = {
  manual: { label: 'Manual 页面识别模型', modelTarget: 'manual' },
  auto: { label: 'Auto 页面识别模型', modelTarget: 'auto' },
};

function recognitionConfig(target) {
  const definition = RECOGNITION_TARGETS[target];
  if (!definition) throw new Error(`未知识别目标：${target}`);
  const runtime = getModelRuntime(definition.modelTarget);
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
    structuredOutputMode: runtime.structuredOutputMode || 'unverified',
  };
}

function endpointFor(config) {
  const value = String(config.baseUrl || '').trim().replace(/\/+$/, '');
  if (!value) throw new Error(`未配置 ${config.label} 模型 Base URL`);
  return value.endsWith('/chat/completions') ? value : `${value}/chat/completions`;
}

function parseObject(source) {
  const text = String(source || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = text.indexOf('{');
  if (start < 0) throw new Error('模型未返回 JSON 对象');
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return JSON.parse(jsonrepair(text.slice(start)));
  }
}

function textFromPart(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFromPart).join('');
  if (!value || typeof value !== 'object') return '';
  for (const key of ['text', 'content', 'value']) {
    const text = textFromPart(value[key]);
    if (text) return text;
  }
  return '';
}

function extractDelta(payload) {
  const choice = payload?.choices?.[0] || {};
  // Merge message and delta because gateways may put reasoning in one and
  // visible output in the other, including on the final streamed chunk.
  const delta = {
    ...(choice.message && typeof choice.message === 'object' ? choice.message : {}),
    ...(choice.delta && typeof choice.delta === 'object' ? choice.delta : {}),
    ...choice,
  };
  const content = textFromPart(delta.content ?? choice.text);
  const reasoningKeys = [
    'reasoning_content', 'reasoningContent', 'reasoning',
    'reasoning_details', 'reasoningDetails',
    'thinking_content', 'thinkingContent', 'thinking',
    'analysis_content', 'analysisContent', 'analysis',
  ];
  const reasoningContent = reasoningKeys.reduce((result, key) => result || textFromPart(delta[key]), '');
  return { content, reasoningContent };
}

function createThinkingContentSplitter() {
  let pending = '';
  let thinking = false;

  const markersForState = () => (thinking
    ? ['</think>', '</analysis>', '</thinking>', '</reasoning>']
    : ['<think>', '<analysis>', '<thinking>', '<reasoning>']);
  const findMarker = (source) => {
    const pattern = thinking
      ? /<\/(?:think|analysis|thinking|reasoning)\s*>/i
      : /<(?:think|analysis|thinking|reasoning)\s*>/i;
    const match = source.match(pattern);
    return match ? { index: match.index ?? -1, marker: match[0] } : null;
  };

  const split = (chunk, flush = false) => {
    let source = pending + String(chunk || '');
    let content = '';
    let reasoningContent = '';
    pending = '';
    while (source) {
      const found = findMarker(source);
      if (found) {
        const text = source.slice(0, found.index);
        if (thinking) reasoningContent += text;
        else content += text;
        source = source.slice(found.index + found.marker.length);
        thinking = !thinking;
        continue;
      }
      let retainedLength = 0;
      if (!flush) {
        const markers = markersForState();
        const limit = Math.min(Math.max(...markers.map((marker) => marker.length)) - 1, source.length);
        for (let length = limit; length > 0; length -= 1) {
          const suffix = source.slice(-length).toLowerCase();
          if (markers.some((marker) => marker.toLowerCase().startsWith(suffix))) {
            retainedLength = length;
            break;
          }
        }
      }
      const text = retainedLength ? source.slice(0, -retainedLength) : source;
      if (thinking) reasoningContent += text;
      else content += text;
      pending = retainedLength ? source.slice(-retainedLength) : '';
      break;
    }
    return { content, reasoningContent };
  };

  return {
    push: (chunk) => split(chunk),
    flush: () => split('', true),
  };
}

function providerError(status, detail) {
  let message = '';
  try {
    const body = JSON.parse(detail);
    message = body?.detail || body?.error?.message || body?.message || body?.title || '';
  } catch {
    message = String(detail || '').trim();
  }
  const error = new Error(`模型请求失败（${status}）${message ? `：${message.slice(0, 500)}` : ''}`);
  error.status = status;
  error.retryable = status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  return error;
}

export async function runRecognitionModel({
  target,
  prompt,
  imagePath,
  imageBuffer,
  mimeType = 'image/png',
  responseSchema,
  continuation = false,
  continuationContent = '',
  signal,
  onChunk = () => {},
}) {
  const config = recognitionConfig(target);
  if (!config.model) throw new Error(`未配置 ${config.label} 模型`);
  if (!config.apiKey) throw new Error(`未配置 ${config.label} 模型网关凭据`);
  if (config.structuredOutputMode === 'unverified') throw new Error('模型能力尚未检测，请在模型设置中完成检测');
  if (config.structuredOutputMode === 'unavailable') throw new Error('模型能力检测未通过，请在模型设置中重新检测或更换模型');

  const bytes = imageBuffer ? Buffer.from(imageBuffer) : await readFile(imagePath);
  const image = bytes.toString('base64');
  const requestBody = {
    model: config.model,
    temperature: config.temperature,
    stream: true,
    messages: [
      { role: 'system', content: CHINESE_SYSTEM_PROMPT },
      ...(continuation && continuationContent.trim() ? [{ role: 'assistant', content: continuationContent }] : []),
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${image}`, detail: 'high' } },
        ],
      },
    ],
  };
  Object.assign(requestBody, chatCompletionCompatibility({
    modelName: config.model,
    reasoningEffort: config.reasoningEffort,
    reasoningEnabled: config.reasoningEnabled,
  }));
  if (responseSchema && config.structuredOutputMode === 'native') {
    requestBody.response_format = {
      type: 'json_schema',
      json_schema: {
        name: `uikg_${target}_${continuation ? 'continuation' : 'result'}`,
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
      accept: 'text/event-stream',
      'cache-control': 'no-cache',
    },
    body: JSON.stringify(requestBody),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw providerError(response.status, detail);
  }
  if (!response.body) throw new Error(`${config.label} 模型没有返回可读取的响应流`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';
  let done = false;
  const thinkingContent = createThinkingContentSplitter();
  const emitDelta = (content, reasoningContent) => {
    if (content) accumulated += content;
    if (content || reasoningContent) {
      onChunk({ content, reasoning_content: reasoningContent, accumulated });
    }
  };
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
      const separated = thinkingContent.push(delta.content);
      emitDelta(separated.content, delta.reasoningContent + separated.reasoningContent);
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
  const trailing = thinkingContent.flush();
  emitDelta(trailing.content, trailing.reasoningContent);
  return parseObject(accumulated);
}
