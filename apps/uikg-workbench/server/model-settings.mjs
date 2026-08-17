import { chmod, readFile, rename, stat, writeFile } from 'node:fs/promises';
import dotenv from 'dotenv';

export const WORKER_MODEL_PRESETS = [
  {
    id: 'gpt-5.6-sol',
    name: 'GPT 5.6 Sol',
    modelName: 'gpt-5.6-sol',
    modelFamily: 'gpt-5',
    badge: '高质量',
    summary: '复杂画面的高质量结构化识别',
    inputPrice: null,
    outputPrice: null,
  },
  {
    id: 'qwen3.7-flash',
    name: 'Qwen3.7 Flash',
    modelName: 'qwen3.7-flash',
    modelFamily: 'qwen3',
    badge: '推荐',
    summary: '长 JSON 成本低，适合作为默认 Worker',
    inputPrice: '¥0.20',
    outputPrice: '¥0.80',
  },
  {
    id: 'qwen3.7-plus',
    name: 'Qwen3.7 Plus',
    modelName: 'qwen3.7-plus',
    modelFamily: 'qwen3',
    badge: '质量',
    summary: '复杂页面和低置信度结果的质量回退',
    inputPrice: null,
    outputPrice: null,
  },
  {
    id: 'qwen3-vl-flash',
    name: 'Qwen3-VL Flash',
    modelName: 'qwen3-vl-flash',
    modelFamily: 'qwen3-vl',
    badge: '视觉',
    summary: '视觉专用模型，适合作为定位对照组',
    inputPrice: '¥0.15',
    outputPrice: '¥1.50',
  },
  {
    id: 'qwen3-vl-plus',
    name: 'Qwen3-VL Plus',
    modelName: 'qwen3-vl-plus',
    modelFamily: 'qwen3-vl',
    badge: '旧配置',
    summary: '保留现有配置用于回放和基线比较',
    inputPrice: '¥1.00',
    outputPrice: '¥10.00',
  },
];

export const MODEL_FAMILIES = [
  'gpt-5',
  'qwen3',
  'qwen3-vl',
  'doubao-seed',
  'doubao-vision',
  'gemini',
  'glm-v',
  'kimi',
  'xiaomi-mimo',
];

export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high'];

const WORKER_A_KEYS = [
  'MIDSCENE_WORKER_A_MODEL_BASE_URL',
  'MIDSCENE_WORKER_A_MODEL_API_KEY',
  'MIDSCENE_WORKER_A_MODEL_NAME',
  'MIDSCENE_WORKER_A_MODEL_FAMILY',
  'MIDSCENE_WORKER_A_MODEL_TIMEOUT',
  'MIDSCENE_WORKER_A_MODEL_TEMPERATURE',
  'MIDSCENE_WORKER_A_MODEL_REASONING_EFFORT',
  'MIDSCENE_WORKER_A_MODEL_REASONING_ENABLED',
];

const WORKER_B_KEYS = [
  'MIDSCENE_WORKER_B_MODEL_BASE_URL',
  'MIDSCENE_WORKER_B_MODEL_API_KEY',
  'MIDSCENE_WORKER_B_MODEL_NAME',
  'MIDSCENE_WORKER_B_MODEL_FAMILY',
  'MIDSCENE_WORKER_B_MODEL_TIMEOUT',
  'MIDSCENE_WORKER_B_MODEL_TEMPERATURE',
  'MIDSCENE_WORKER_B_MODEL_REASONING_EFFORT',
  'MIDSCENE_WORKER_B_MODEL_REASONING_ENABLED',
];

function settingsError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

async function readEnvDocument(envPath) {
  try {
    const content = await readFile(envPath, 'utf8');
    return { content, values: dotenv.parse(content) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { content: '', values: {} };
    throw error;
  }
}

function valueFrom(fileValues, runtimeEnv, key, fallback = '') {
  return fileValues[key] ?? runtimeEnv[key] ?? fallback;
}

function apiKeyHint(value) {
  if (!value) return null;
  const tail = value.slice(-4);
  return `${'•'.repeat(8)}${tail}`;
}

function reasoningEffortFrom(values, runtimeEnv, prefix) {
  const configured = valueFrom(values, runtimeEnv, `${prefix}_REASONING_EFFORT`);
  if (REASONING_EFFORTS.includes(configured)) return configured;
  return valueFrom(values, runtimeEnv, `${prefix}_REASONING_ENABLED`, 'false') === 'true' ? 'medium' : 'none';
}

async function loadWorkerModelSettings(envPath, runtimeEnv, worker) {
  const { values } = await readEnvDocument(envPath);
  const prefix = worker === 'worker_a' ? 'MIDSCENE_WORKER_A_MODEL' : 'MIDSCENE_WORKER_B_MODEL';
  const apiKey = valueFrom(values, runtimeEnv, `${prefix}_API_KEY`);
  const reasoningEffort = reasoningEffortFrom(values, runtimeEnv, prefix);
  const config = {
    baseUrl: valueFrom(values, runtimeEnv, `${prefix}_BASE_URL`),
    modelName: valueFrom(values, runtimeEnv, `${prefix}_NAME`),
    modelFamily: valueFrom(values, runtimeEnv, `${prefix}_FAMILY`),
    timeout: Number(valueFrom(values, runtimeEnv, `${prefix}_TIMEOUT`, '180000')),
    temperature: Number(valueFrom(values, runtimeEnv, `${prefix}_TEMPERATURE`, '0')),
    reasoningEffort,
    reasoningEnabled: reasoningEffort !== 'none',
    apiKeyConfigured: Boolean(apiKey),
    apiKeyHint: apiKeyHint(apiKey),
  };
  const runtimeModel = runtimeEnv[`${prefix}_NAME`] || null;
  return {
    envPath,
    worker,
    config,
    presets: WORKER_MODEL_PRESETS,
    modelFamilies: MODEL_FAMILIES,
    runtimeModel,
    runtimeSynced: runtimeModel === config.modelName,
  };
}

function modelsEndpoint(baseUrl) {
  const value = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!value) throw settingsError('未配置模型 Base URL');
  const endpoint = value.replace(/\/chat\/completions$/i, '');
  return endpoint.endsWith('/models') ? endpoint : `${endpoint}/models`;
}

export async function fetchWorkerAvailableModels(envPath, worker, runtimeEnv = process.env, request = fetch) {
  const { values } = await readEnvDocument(envPath);
  const prefix = worker === 'worker_b' ? 'MIDSCENE_WORKER_B_MODEL' : 'MIDSCENE_WORKER_A_MODEL';
  const baseUrl = valueFrom(values, runtimeEnv, `${prefix}_BASE_URL`);
  const apiKey = valueFrom(values, runtimeEnv, `${prefix}_API_KEY`);
  if (!apiKey) throw settingsError(`${worker === 'worker_b' ? 'Worker B' : 'Worker A'} 尚未配置 API Key`);

  const sourceUrl = modelsEndpoint(baseUrl);
  let response;
  try {
    response = await request(sourceUrl, {
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const wrapped = settingsError(`模型列表请求失败：${error instanceof Error ? error.message : String(error)}`);
    wrapped.status = 502;
    throw wrapped;
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = settingsError(`模型列表请求失败（${response.status}）${detail ? `：${detail.slice(0, 300)}` : ''}`);
    error.status = 502;
    throw error;
  }

  const payload = await response.json().catch(() => null);
  const entries = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  const models = [...new Set(entries
    .map((entry) => typeof entry === 'string' ? entry : entry?.id || entry?.name)
    .filter((model) => typeof model === 'string' && /^[a-zA-Z0-9._:/-]+$/.test(model)))]
    .sort((left, right) => left.localeCompare(right));
  return { worker, sourceUrl, models };
}

export async function loadWorkerAModelSettings(envPath, runtimeEnv = process.env) {
  return loadWorkerModelSettings(envPath, runtimeEnv, 'worker_a');
}

export async function loadWorkerBModelSettings(envPath, runtimeEnv = process.env) {
  return loadWorkerModelSettings(envPath, runtimeEnv, 'worker_b');
}

function normalizePayload(payload) {
  const baseUrl = String(payload?.baseUrl || '').trim();
  const modelName = String(payload?.modelName || '').trim();
  const modelFamily = String(payload?.modelFamily || '').trim();
  const apiKey = String(payload?.apiKey || '').trim();
  const timeout = Number(payload?.timeout);
  const temperature = Number(payload?.temperature);
  const reasoningEffort = String(payload?.reasoningEffort || (payload?.reasoningEnabled ? 'medium' : 'none')).trim().toLowerCase();

  if (!baseUrl) throw settingsError('请输入模型 Base URL');
  let parsedUrl;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw settingsError('模型 Base URL 不是有效 URL');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw settingsError('模型 Base URL 仅支持 HTTP 或 HTTPS');
  if (!modelName || !/^[a-zA-Z0-9._:/-]+$/.test(modelName)) throw settingsError('模型名称包含无效字符');
  if (/realtime/i.test(modelName)) throw settingsError('Realtime 模型使用独立实时接口，当前 Workbench HTTP 链路不支持');
  if (!MODEL_FAMILIES.includes(modelFamily)) throw settingsError('请选择受支持的模型 Family');
  if (!Number.isInteger(timeout) || timeout < 10_000 || timeout > 600_000) throw settingsError('超时时间必须是 10000 到 600000 毫秒之间的整数');
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw settingsError('Temperature 必须在 0 到 2 之间');
  if (!REASONING_EFFORTS.includes(reasoningEffort)) throw settingsError('请选择受支持的推理强度');
  if (apiKey && /[\r\n]/.test(apiKey)) throw settingsError('API Key 格式无效');

  return {
    baseUrl,
    modelName,
    modelFamily,
    timeout,
    temperature,
    reasoningEffort,
    reasoningEnabled: reasoningEffort !== 'none',
    apiKey,
  };
}

function quoteEnvValue(value) {
  return JSON.stringify(String(value));
}

function normalizedBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

function providerApiKey(values, runtimeEnv, baseUrl) {
  const target = normalizedBaseUrl(baseUrl);
  for (const prefix of ['MIDSCENE_WORKER_A_MODEL', 'MIDSCENE_WORKER_B_MODEL']) {
    if (normalizedBaseUrl(valueFrom(values, runtimeEnv, `${prefix}_BASE_URL`)) !== target) continue;
    const apiKey = valueFrom(values, runtimeEnv, `${prefix}_API_KEY`);
    if (apiKey) return apiKey;
  }
  return '';
}

function applyApiKeyForProvider(patch, key, prefix, next, values, runtimeEnv) {
  if (next.apiKey) {
    patch[key] = next.apiKey;
    return;
  }
  const currentBaseUrl = valueFrom(values, runtimeEnv, `${prefix}_BASE_URL`);
  if (!currentBaseUrl || normalizedBaseUrl(currentBaseUrl) === normalizedBaseUrl(next.baseUrl)) return;
  const apiKey = providerApiKey(values, runtimeEnv, next.baseUrl);
  if (!apiKey) throw settingsError('切换模型服务时请输入对应的 API Key');
  patch[key] = apiKey;
}

export function updateEnvDocument(content, patch, worker = 'worker_a') {
  const lines = content ? content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : [];
  const requested = new Set(Object.keys(patch));
  const updatedKeys = new Set();
  let lastWorkerLine = -1;
  const updated = lines.map((line, index) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/);
    const key = match?.[1];
    if (worker === 'worker_a' && key?.startsWith('MIDSCENE_WORKER_A_MODEL_')) lastWorkerLine = index;
    if (worker === 'worker_b' && key?.startsWith('MIDSCENE_WORKER_B_MODEL_')) lastWorkerLine = index;
    if (!key || !requested.has(key)) return line;
    updatedKeys.add(key);
    return `${key}=${quoteEnvValue(patch[key])}`;
  });

  const keys = worker === 'worker_a' ? WORKER_A_KEYS : WORKER_B_KEYS;
  const additions = keys.filter((key) => requested.has(key) && !updatedKeys.has(key)).map((key) => `${key}=${quoteEnvValue(patch[key])}`);
  if (additions.length > 0) {
    if (lastWorkerLine >= 0) updated.splice(lastWorkerLine + 1, 0, ...additions);
    else updated.unshift(worker === 'worker_a' ? '# === Worker A 模型 ===' : '# === Worker B 模型 ===', ...additions, ...(updated.length ? [''] : []));
  }
  return `${updated.join('\n')}\n`;
}

export async function saveWorkerAModelSettings(envPath, payload, runtimeEnv = process.env) {
  const next = normalizePayload(payload);
  const { content, values } = await readEnvDocument(envPath);
  const patch = {
    MIDSCENE_WORKER_A_MODEL_BASE_URL: next.baseUrl,
    MIDSCENE_WORKER_A_MODEL_NAME: next.modelName,
    MIDSCENE_WORKER_A_MODEL_FAMILY: next.modelFamily,
    MIDSCENE_WORKER_A_MODEL_TIMEOUT: String(next.timeout),
    MIDSCENE_WORKER_A_MODEL_TEMPERATURE: String(next.temperature),
    MIDSCENE_WORKER_A_MODEL_REASONING_EFFORT: next.reasoningEffort,
    MIDSCENE_WORKER_A_MODEL_REASONING_ENABLED: String(next.reasoningEnabled),
  };
  applyApiKeyForProvider(patch, 'MIDSCENE_WORKER_A_MODEL_API_KEY', 'MIDSCENE_WORKER_A_MODEL', next, values, runtimeEnv);

  const temporaryPath = `${envPath}.${process.pid}.${Date.now()}.tmp`;
  let mode = 0o600;
  try {
    mode = (await stat(envPath)).mode;
  } catch {}
  await writeFile(temporaryPath, updateEnvDocument(content, patch), { encoding: 'utf8', mode });
  await chmod(temporaryPath, mode);
  await rename(temporaryPath, envPath);

  for (const [key, value] of Object.entries(patch)) runtimeEnv[key] = value;
  return loadWorkerAModelSettings(envPath, runtimeEnv);
}

export async function saveWorkerBModelSettings(envPath, payload, runtimeEnv = process.env) {
  const next = normalizePayload(payload);
  const { content, values } = await readEnvDocument(envPath);
  const patch = {
    MIDSCENE_WORKER_B_MODEL_BASE_URL: next.baseUrl,
    MIDSCENE_WORKER_B_MODEL_NAME: next.modelName,
    MIDSCENE_WORKER_B_MODEL_FAMILY: next.modelFamily,
    MIDSCENE_WORKER_B_MODEL_TIMEOUT: String(next.timeout),
    MIDSCENE_WORKER_B_MODEL_TEMPERATURE: String(next.temperature),
    MIDSCENE_WORKER_B_MODEL_REASONING_EFFORT: next.reasoningEffort,
    MIDSCENE_WORKER_B_MODEL_REASONING_ENABLED: String(next.reasoningEnabled),
  };
  applyApiKeyForProvider(patch, 'MIDSCENE_WORKER_B_MODEL_API_KEY', 'MIDSCENE_WORKER_B_MODEL', next, values, runtimeEnv);
  const temporaryPath = `${envPath}.${process.pid}.${Date.now()}.tmp`;
  let mode = 0o600;
  try { mode = (await stat(envPath)).mode; } catch {}
  await writeFile(temporaryPath, updateEnvDocument(content, patch, 'worker_b'), { encoding: 'utf8', mode });
  await chmod(temporaryPath, mode);
  await rename(temporaryPath, envPath);
  for (const [key, value] of Object.entries(patch)) runtimeEnv[key] = value;
  return loadWorkerBModelSettings(envPath, runtimeEnv);
}
