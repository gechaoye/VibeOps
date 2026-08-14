import { chmod, readFile, rename, stat, writeFile } from 'node:fs/promises';
import dotenv from 'dotenv';

export const SCOUT_MODEL_PRESETS = [
  {
    id: 'qwen3.7-flash',
    name: 'Qwen3.7 Flash',
    modelName: 'qwen3.7-flash',
    modelFamily: 'qwen3',
    badge: '推荐',
    summary: '长 JSON 成本低，适合作为默认 Scout',
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

const SCOUT_KEYS = [
  'MIDSCENE_SCOUT_MODEL_BASE_URL',
  'MIDSCENE_SCOUT_MODEL_API_KEY',
  'MIDSCENE_SCOUT_MODEL_NAME',
  'MIDSCENE_SCOUT_MODEL_FAMILY',
  'MIDSCENE_SCOUT_MODEL_TIMEOUT',
  'MIDSCENE_SCOUT_MODEL_TEMPERATURE',
  'MIDSCENE_SCOUT_MODEL_REASONING_ENABLED',
];

const REVIEWER_KEYS = [
  'MIDSCENE_MODEL_BASE_URL',
  'MIDSCENE_MODEL_API_KEY',
  'MIDSCENE_MODEL_NAME',
  'MIDSCENE_MODEL_FAMILY',
  'MIDSCENE_MODEL_TIMEOUT',
  'MIDSCENE_MODEL_TEMPERATURE',
  'MIDSCENE_MODEL_REASONING_ENABLED',
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

async function loadRoleModelSettings(envPath, runtimeEnv, role) {
  const { values } = await readEnvDocument(envPath);
  const prefix = role === 'scout' ? 'MIDSCENE_SCOUT_MODEL' : 'MIDSCENE_MODEL';
  const apiKey = valueFrom(values, runtimeEnv, `${prefix}_API_KEY`);
  const config = {
    baseUrl: valueFrom(values, runtimeEnv, `${prefix}_BASE_URL`),
    modelName: valueFrom(values, runtimeEnv, `${prefix}_NAME`),
    modelFamily: valueFrom(values, runtimeEnv, `${prefix}_FAMILY`),
    timeout: Number(valueFrom(values, runtimeEnv, `${prefix}_TIMEOUT`, '180000')),
    temperature: Number(valueFrom(values, runtimeEnv, `${prefix}_TEMPERATURE`, '0')),
    reasoningEnabled: valueFrom(values, runtimeEnv, `${prefix}_REASONING_ENABLED`, 'false') === 'true',
    apiKeyConfigured: Boolean(apiKey),
    apiKeyHint: apiKeyHint(apiKey),
  };
  const runtimeModel = runtimeEnv[`${prefix}_NAME`] || null;
  return {
    envPath,
    role,
    config,
    presets: role === 'scout' ? SCOUT_MODEL_PRESETS : [{ id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol', modelName: 'gpt-5.6-sol', modelFamily: 'gpt-5', badge: '默认审核', summary: '独立重识别冻结画面，与 Scout 结果并列对照', inputPrice: null, outputPrice: null }],
    modelFamilies: MODEL_FAMILIES,
    runtimeModel,
    runtimeSynced: runtimeModel === config.modelName,
  };
}

export async function loadScoutModelSettings(envPath, runtimeEnv = process.env) {
  return loadRoleModelSettings(envPath, runtimeEnv, 'scout');
}

export async function loadReviewerModelSettings(envPath, runtimeEnv = process.env) {
  return loadRoleModelSettings(envPath, runtimeEnv, 'reviewer');
}

function normalizePayload(payload, role = 'scout') {
  const baseUrl = String(payload?.baseUrl || '').trim();
  const modelName = String(payload?.modelName || '').trim();
  const modelFamily = String(payload?.modelFamily || '').trim();
  const apiKey = String(payload?.apiKey || '').trim();
  const timeout = Number(payload?.timeout);
  const temperature = Number(payload?.temperature);

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
  if (apiKey && /[\r\n]/.test(apiKey)) throw settingsError('API Key 格式无效');

  return {
    baseUrl,
    modelName,
    modelFamily,
    timeout,
    temperature,
    reasoningEnabled: Boolean(payload?.reasoningEnabled),
    apiKey,
  };
}

function quoteEnvValue(value) {
  return JSON.stringify(String(value));
}

export function updateEnvDocument(content, patch, role = 'scout') {
  const lines = content ? content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : [];
  const requested = new Set(Object.keys(patch));
  const updatedKeys = new Set();
  let lastRoleLine = -1;
  const updated = lines.map((line, index) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/);
    const key = match?.[1];
    if (role === 'scout' && key?.startsWith('MIDSCENE_SCOUT_MODEL_')) lastRoleLine = index;
    if (role === 'reviewer' && key?.startsWith('MIDSCENE_MODEL_') && !key.startsWith('MIDSCENE_SCOUT_MODEL_')) lastRoleLine = index;
    if (!key || !requested.has(key)) return line;
    updatedKeys.add(key);
    return `${key}=${quoteEnvValue(patch[key])}`;
  });

  const keys = role === 'scout' ? SCOUT_KEYS : REVIEWER_KEYS;
  const additions = keys.filter((key) => requested.has(key) && !updatedKeys.has(key)).map((key) => `${key}=${quoteEnvValue(patch[key])}`);
  if (additions.length > 0) {
    if (lastRoleLine >= 0) updated.splice(lastRoleLine + 1, 0, ...additions);
    else updated.unshift(role === 'scout' ? '# === Scout 视觉模型 ===' : '# === Reviewer 审核模型 ===', ...additions, ...(updated.length ? [''] : []));
  }
  return `${updated.join('\n')}\n`;
}

export async function saveScoutModelSettings(envPath, payload, runtimeEnv = process.env) {
  const next = normalizePayload(payload, 'scout');
  const { content } = await readEnvDocument(envPath);
  const patch = {
    MIDSCENE_SCOUT_MODEL_BASE_URL: next.baseUrl,
    MIDSCENE_SCOUT_MODEL_NAME: next.modelName,
    MIDSCENE_SCOUT_MODEL_FAMILY: next.modelFamily,
    MIDSCENE_SCOUT_MODEL_TIMEOUT: String(next.timeout),
    MIDSCENE_SCOUT_MODEL_TEMPERATURE: String(next.temperature),
    MIDSCENE_SCOUT_MODEL_REASONING_ENABLED: String(next.reasoningEnabled),
  };
  if (next.apiKey) patch.MIDSCENE_SCOUT_MODEL_API_KEY = next.apiKey;

  const temporaryPath = `${envPath}.${process.pid}.${Date.now()}.tmp`;
  let mode = 0o600;
  try {
    mode = (await stat(envPath)).mode;
  } catch {}
  await writeFile(temporaryPath, updateEnvDocument(content, patch), { encoding: 'utf8', mode });
  await chmod(temporaryPath, mode);
  await rename(temporaryPath, envPath);

  for (const [key, value] of Object.entries(patch)) runtimeEnv[key] = value;
  return loadScoutModelSettings(envPath, runtimeEnv);
}

export async function saveReviewerModelSettings(envPath, payload, runtimeEnv = process.env) {
  const next = normalizePayload(payload, 'reviewer');
  const { content } = await readEnvDocument(envPath);
  const patch = {
    MIDSCENE_MODEL_BASE_URL: next.baseUrl,
    MIDSCENE_MODEL_NAME: next.modelName,
    MIDSCENE_MODEL_FAMILY: next.modelFamily,
    MIDSCENE_MODEL_TIMEOUT: String(next.timeout),
    MIDSCENE_MODEL_TEMPERATURE: String(next.temperature),
    MIDSCENE_MODEL_REASONING_ENABLED: String(next.reasoningEnabled),
  };
  if (next.apiKey) patch.MIDSCENE_MODEL_API_KEY = next.apiKey;
  const temporaryPath = `${envPath}.${process.pid}.${Date.now()}.tmp`;
  let mode = 0o600;
  try { mode = (await stat(envPath)).mode; } catch {}
  await writeFile(temporaryPath, updateEnvDocument(content, patch, 'reviewer'), { encoding: 'utf8', mode });
  await chmod(temporaryPath, mode);
  await rename(temporaryPath, envPath);
  for (const [key, value] of Object.entries(patch)) runtimeEnv[key] = value;
  return loadReviewerModelSettings(envPath, runtimeEnv);
}
