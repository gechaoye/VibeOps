import { readFile } from 'node:fs/promises';
import { jsonrepair } from 'jsonrepair';

function endpointFor(baseUrl) {
  const value = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!value) throw new Error('未配置 Reviewer 模型 Base URL');
  return value.endsWith('/chat/completions') ? value : `${value}/chat/completions`;
}

function parseObject(source) {
  const text = String(source || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = text.indexOf('{');
  if (start < 0) throw new Error('Reviewer 模型未返回 JSON 对象');
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

function providerError(status, detail) {
  let message = '';
  try {
    const body = JSON.parse(detail);
    message = body?.detail || body?.error?.message || body?.message || body?.title || '';
  } catch {
    message = String(detail || '').trim();
  }
  if (status === 524) {
    return new Error(`Reviewer 模型响应超时（524）${message ? `：${message}` : '，上游服务在代理时限内没有开始返回内容'}`);
  }
  return new Error(`Reviewer 模型请求失败（${status}）${message ? `：${message.slice(0, 500)}` : ''}`);
}

export async function runReviewerModel({
  prompt,
  imagePath,
  mimeType = 'image/png',
  continuationContent = '',
  signal,
  onChunk = () => {},
}) {
  const image = (await readFile(imagePath)).toString('base64');
  const model = process.env.MIDSCENE_MODEL_NAME;
  const apiKey = process.env.MIDSCENE_MODEL_API_KEY;
  const modelFamily = String(process.env.MIDSCENE_MODEL_FAMILY || '').toLowerCase();
  const reasoningEnabled = process.env.MIDSCENE_MODEL_REASONING_ENABLED === 'true';
  if (!model) throw new Error('未配置 MIDSCENE_MODEL_NAME');
  if (!apiKey) throw new Error('未配置 MIDSCENE_MODEL_API_KEY');

  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:${mimeType};base64,${image}`, detail: 'high' } },
    ],
  }];
  if (continuationContent) {
    messages.push(
      { role: 'assistant', content: continuationContent },
      { role: 'user', content: '请从上一段输出的最后一个字符之后继续，仅输出尚未完成的 JSON 后续内容；不要重复已有字符，不要添加解释或 Markdown。' },
    );
  }
  const requestBody = {
    model,
    temperature: Number(process.env.MIDSCENE_MODEL_TEMPERATURE || 0),
    stream: true,
    messages,
  };
  if (modelFamily.startsWith('qwen') || String(model).toLowerCase().startsWith('qwen')) {
    requestBody.enable_thinking = reasoningEnabled;
  } else if (reasoningEnabled) {
    requestBody.reasoning_effort = 'medium';
  }

  let buffer = '';
  let accumulated = continuationContent;
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
      // Ignore provider keepalive lines that are not JSON payloads.
    }
  };

  try {
    const response = await fetch(endpointFor(process.env.MIDSCENE_MODEL_BASE_URL), {
      method: 'POST',
      signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw providerError(response.status, detail);
    }
    if (!response.body) throw new Error('Reviewer 模型没有返回可读取的响应流');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
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
  } catch (error) {
    if (error && typeof error === 'object') {
      error.reviewerOutput = accumulated;
      error.receivedContent = Boolean(accumulated.trim());
    }
    throw error;
  }
}
