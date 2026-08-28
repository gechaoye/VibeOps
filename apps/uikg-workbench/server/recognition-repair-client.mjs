import { jsonrepair } from 'jsonrepair';
import { chatCompletionCompatibility } from './model-compatibility.mjs';
import { getModelRuntime } from './model-runtime.mjs';
import { openAIStructuredOutputSchema } from './structured-output-schema.mjs';

const INTERACTION_BOUNDARIES = ['none', 'candidate_bbox', 'whole_element', 'trailing_control', 'point_only', 'unresolved'];

function endpointFor(runtime) {
  const value = String(runtime?.baseUrl || '').trim().replace(/\/+$/, '');
  if (!value) throw new Error('未配置自愈模型 Base URL');
  return value.endsWith('/chat/completions') ? value : `${value}/chat/completions`;
}

function parseObject(source) {
  const text = String(source || '')
    .replace(/<(?:think|analysis|thinking|reasoning)\s*>[\s\S]*?<\/(?:think|analysis|thinking|reasoning)\s*>/gi, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  const start = text.indexOf('{');
  if (start < 0) throw new Error('自愈模型未返回 JSON 对象');
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
  return textFromPart(value.text ?? value.content ?? value.value);
}

function providerError(status, detail) {
  let message = '';
  try {
    const body = JSON.parse(detail);
    message = body?.detail || body?.error?.message || body?.message || body?.title || '';
  } catch {
    message = String(detail || '').trim();
  }
  const error = new Error(`自愈模型请求失败（${status}）${message ? `：${message.slice(0, 500)}` : ''}`);
  error.status = status;
  return error;
}

export function buildRecognitionRepairPrompt({ frameId, candidate, schemaErrors = [], consistencyIssues = [], normalizationIssues = [] }) {
  return `你是 UI 识别 JSON 的结构自愈器。只修复给定 JSON 的结构和值域，不重新识别截图，不添加无法从原结果确认的新元素，也不要删除仅因你不理解而存在的有效内容。返回修复后的完整 JSON 对象，不要返回 Markdown 或解释。

强制规则：
1. frameId 必须严格等于 ${JSON.stringify(frameId)}。
2. abstraction.fields[*].interactionBoundary 只能是 ${INTERACTION_BOUNDARIES.map((value) => JSON.stringify(value)).join('、')}。
3. geometryKind 只描述几何来源，不能作为 interactionBoundary 的值。
4. 根据下面的结构检查错误做最小修改；未报错字段尽量保持原值。
5. 输出必须是一个可被 JSON.parse 解析的完整 JSON 对象。

Schema 校验错误：
${JSON.stringify(schemaErrors)}

一致性检查错误：
${JSON.stringify(consistencyIssues)}

归一化提示：
${JSON.stringify(normalizationIssues)}

待修复 JSON：
${JSON.stringify(candidate)}`;
}

export async function runRecognitionRepairModel({ frameId, candidate, schemaErrors, consistencyIssues, normalizationIssues, responseSchema, signal }) {
  const runtime = getModelRuntime('self_heal');
  if (!runtime?.modelName) throw new Error('未配置自愈模型');
  if (!runtime.apiKey) throw new Error('未配置自愈模型网关凭据');
  const structuredOutputMode = runtime.structuredOutputMode || 'unverified';
  if (structuredOutputMode === 'unverified') throw new Error('自愈模型能力尚未检测，请在模型设置中完成检测');
  if (structuredOutputMode === 'unavailable') throw new Error('自愈模型不支持结构化输出，请重新检测或更换模型');

  const requestBody = {
    model: runtime.modelName,
    temperature: Number(runtime.temperature || 0),
    stream: false,
    messages: [
      { role: 'system', content: '你只负责修复 JSON 结构。最终回答只能包含一个完整 JSON 对象。' },
      { role: 'user', content: buildRecognitionRepairPrompt({ frameId, candidate, schemaErrors, consistencyIssues, normalizationIssues }) },
    ],
  };
  Object.assign(requestBody, chatCompletionCompatibility({ modelName: runtime.modelName, reasoningEffort: runtime.reasoningEffort, reasoningEnabled: true }));
  if (responseSchema && structuredOutputMode === 'native') {
    requestBody.response_format = {
      type: 'json_schema',
      json_schema: { name: 'uikg_recognition_self_heal', strict: true, schema: openAIStructuredOutputSchema(responseSchema) },
    };
  }

  const timeoutSignal = AbortSignal.timeout(Number(runtime.timeout || 180_000));
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(endpointFor(runtime), {
    method: 'POST',
    signal: requestSignal,
    headers: { authorization: `Bearer ${runtime.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(requestBody),
  });
  if (!response.ok) throw providerError(response.status, await response.text().catch(() => ''));
  const payload = await response.json().catch(() => null);
  const message = payload?.choices?.[0]?.message || {};
  const outputContent = textFromPart(message.content ?? payload?.output_text);
  if (!outputContent.trim()) throw new Error('自愈模型未返回可读取的输出');
  let repairedResult;
  try {
    repairedResult = parseObject(outputContent);
  } catch (error) {
    if (error && typeof error === 'object') {
      error.repairOutput = outputContent;
      error.reasoningContent = textFromPart(message.reasoning_content ?? message.reasoning);
    }
    throw error;
  }
  return {
    repairedResult,
    outputContent,
    reasoningContent: textFromPart(message.reasoning_content ?? message.reasoning),
  };
}
