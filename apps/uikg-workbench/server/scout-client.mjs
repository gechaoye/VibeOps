import { readFile } from 'node:fs/promises';
import { jsonrepair } from 'jsonrepair';

function endpointFor(baseUrl) {
  const value = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!value) throw new Error('未配置 Scout 模型 Base URL');
  return value.endsWith('/chat/completions') ? value : `${value}/chat/completions`;
}

function parseObject(source) {
  const text = String(source || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = text.indexOf('{');
  if (start < 0) throw new Error('Scout 模型未返回 JSON 对象');
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

export async function runScoutModel({
  prompt,
  imagePath,
  mimeType = 'image/png',
  signal,
  onChunk = () => {},
}) {
  const image = (await readFile(imagePath)).toString('base64');
  const model = process.env.MIDSCENE_SCOUT_MODEL_NAME;
  const apiKey = process.env.MIDSCENE_SCOUT_MODEL_API_KEY;
  if (!model) throw new Error('未配置 MIDSCENE_SCOUT_MODEL_NAME');
  if (!apiKey) throw new Error('未配置 MIDSCENE_SCOUT_MODEL_API_KEY');

  const response = await fetch(endpointFor(process.env.MIDSCENE_SCOUT_MODEL_BASE_URL), {
    method: 'POST',
    signal,
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: Number(process.env.MIDSCENE_SCOUT_MODEL_TEMPERATURE || 0),
      enable_thinking: process.env.MIDSCENE_SCOUT_MODEL_REASONING_ENABLED === 'true',
      stream: true,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${image}`, detail: 'high' } },
        ],
      }],
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Scout 模型请求失败 (${response.status}): ${detail.slice(0, 500)}`);
  }
  if (!response.body) throw new Error('Scout 模型没有返回可读取的响应流');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';
  let reasoningContent = '';
  let done = false;
  const emit = (content, reasoning) => onChunk({ content, reasoning_content: reasoning, accumulated });

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
      if (delta.reasoningContent) reasoningContent += delta.reasoningContent;
      if (delta.content || delta.reasoningContent) emit(delta.content, delta.reasoningContent);
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
  return parseObject(accumulated);
}
