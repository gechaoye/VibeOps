import { randomUUID } from 'node:crypto';
import { getModelRuntime } from './model-runtime.mjs';
import { modelFamilyForName, ZTO_NEWAPI_VISIBLE_MODELS } from './model-compatibility.mjs';

export const MODEL_TARGETS = ['manual', 'auto', 'ultra_a', 'ultra_b', 'midscene'];
export const DEFAULT_MODEL_GATEWAY_ID = 'zto-newapi';
export const MODEL_FAMILIES = [
  'gpt-5',
  'qwen2.5-vl',
  'qwen3',
  'qwen3.5',
  'qwen3.6',
  'qwen3-vl',
  'doubao-seed',
  'doubao-vision',
  'gemini',
  'glm-v',
  'kimi',
  'kimi3',
  'xiaomi-mimo',
];
export const REASONING_EFFORTS = ['low', 'medium', 'high'];
export const WORKBENCH_MODES = ['manual', 'ultra', 'auto'];

const DASHSCOPE_VISIBLE_MODELS = new Set([
  'qwen3.7-flash',
  'qwen3.7-plus',
  'qwen3-vl-flash',
  'qwen3-vl-plus',
]);

function settingsError(message, status = 400, details = {}) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

function apiKeyHint(value) {
  if (!value) return null;
  return `${'•'.repeat(8)}${value.slice(-4)}`;
}

function publicGateway(gateway) {
  const { apiKey, ...settings } = gateway;
  return {
    ...settings,
    kind: gateway.id === DEFAULT_MODEL_GATEWAY_ID ? 'default' : 'custom',
    apiKeyConfigured: Boolean(apiKey),
    apiKeyHint: apiKeyHint(apiKey),
    defaultValueAvailable: gateway.id === DEFAULT_MODEL_GATEWAY_ID,
  };
}

export function resolveTargetModelConfig(modelStore, target) {
  const assignment = modelStore.getAssignment(target);
  if (!assignment) return null;
  const gateway = modelStore.getGateway(assignment.gatewayId, { includeApiKey: true });
  if (!gateway) return null;
  return {
    ...assignment,
    baseUrl: gateway.baseUrl,
    apiKey: gateway.apiKey,
    gatewayLabel: gateway.label,
  };
}

export function loadModelGateways(modelStore) {
  return modelStore.listGateways({ includeApiKey: true }).map(publicGateway);
}

export function loadWorkbenchPreferences(modelStore) {
  return {
    mode: modelStore.getWorkbenchPreferences?.().mode || 'ultra',
  };
}

export function saveWorkbenchMode(modelStore, mode) {
  const value = String(mode || '').trim().toLowerCase();
  if (!WORKBENCH_MODES.includes(value)) throw settingsError('请选择受支持的工作模式');
  return modelStore.saveWorkbenchPreferences({ mode: value });
}

export function loadTargetModelSettings(modelStore, target) {
  if (!MODEL_TARGETS.includes(target)) throw settingsError('未知模型配置目标');
  const assignment = modelStore.getAssignment(target);
  const gateway = assignment ? modelStore.getGateway(assignment.gatewayId, { includeApiKey: true }) : null;
  const runtime = getModelRuntime(target);
  const config = {
    gatewayId: assignment?.gatewayId || '',
    baseUrl: gateway?.baseUrl || '',
    modelName: assignment?.modelName || '',
    modelFamily: assignment?.modelFamily || '',
    timeout: assignment?.timeout || 180000,
    temperature: assignment?.temperature || 0,
    reasoningEffort: assignment?.reasoningEffort || 'low',
    apiKeyConfigured: Boolean(gateway?.apiKey),
    apiKeyHint: apiKeyHint(gateway?.apiKey),
  };
  return {
    storagePath: modelStore.databasePath,
    target,
    config,
    modelFamilies: MODEL_FAMILIES,
    runtimeModel: runtime?.modelName || null,
    runtimeSynced: Boolean(runtime?.modelName && runtime.modelName === config.modelName && runtime.gatewayId === config.gatewayId),
  };
}

function modelsEndpoint(baseUrl) {
  const value = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!value) throw settingsError('未配置模型 Base URL');
  const endpoint = value.replace(/\/chat\/completions$/i, '');
  return endpoint.endsWith('/models') ? endpoint : `${endpoint}/models`;
}

async function fetchGatewayModels(gateway, request) {
  if (!gateway.apiKey) throw settingsError(`${gateway.label} 尚未配置 API Key`);
  const sourceUrl = modelsEndpoint(gateway.baseUrl);
  let response;
  try {
    response = await request(sourceUrl, {
      headers: { accept: 'application/json', authorization: `Bearer ${gateway.apiKey}` },
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
    .filter((model) => !/^gpt-image-2$/i.test(model) && !/realtime/i.test(model));
  let hostname = '';
  try { hostname = new URL(gateway.baseUrl).hostname.toLowerCase(); } catch {}
  if (hostname === 'dashscope.aliyuncs.com') {
    return models.filter((model) => DASHSCOPE_VISIBLE_MODELS.has(model)).sort((left, right) => left.localeCompare(right));
  }
  if (hostname === 'znew-api.dev.ztosys.com') {
    return models.filter((model) => ZTO_NEWAPI_VISIBLE_MODELS.has(model)).sort((left, right) => left.localeCompare(right));
  }
  return models.sort((left, right) => left.localeCompare(right));
}

export async function fetchAvailableModelsByGateway(modelStore, request = fetch) {
  const gateways = modelStore.listGateways({ includeApiKey: true });
  const groups = await Promise.all(gateways.map(async (gateway) => {
    const settings = publicGateway(gateway);
    try {
      const models = await fetchGatewayModels(gateway, request);
      return {
        ...settings,
        sourceUrl: modelsEndpoint(gateway.baseUrl),
        models,
        modelFamilies: Object.fromEntries(models.map((model) => [model, modelFamilyForName(model)])),
      };
    } catch (error) {
      return {
        ...settings,
        sourceUrl: modelsEndpoint(gateway.baseUrl),
        models: [],
        modelFamilies: {},
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
  return {
    gateways: groups,
    totalModels: groups.reduce((total, gateway) => total + gateway.models.length, 0),
  };
}

export async function testModelGateway(modelStore, gatewayId, request = fetch) {
  const id = String(gatewayId || '').trim().toLowerCase();
  const gateway = modelStore.getGateway(id, { includeApiKey: true });
  if (!gateway) throw settingsError('模型网关不存在', 404);
  const startedAt = Date.now();
  const models = await fetchGatewayModels(gateway, request);
  return { gatewayId: id, ok: true, latencyMs: Math.max(0, Date.now() - startedAt), modelCount: models.length };
}

function normalizePayload(payload) {
  const target = String(payload?.target || '').trim();
  const gatewayId = String(payload?.gatewayId || '').trim();
  const modelName = String(payload?.modelName || '').trim();
  const modelFamily = String(payload?.modelFamily || '').trim();
  const timeout = Number(payload?.timeout);
  const temperature = Number(payload?.temperature);
  const reasoningEffort = String(payload?.reasoningEffort || '').trim().toLowerCase();
  if (!MODEL_TARGETS.includes(target)) throw settingsError('请选择模型配置目标');
  if (!gatewayId || !/^[a-z0-9][a-z0-9-]*$/.test(gatewayId)) throw settingsError('请选择模型网关');
  if (!modelName || !/^[a-zA-Z0-9._:/-]+$/.test(modelName)) throw settingsError('模型名称包含无效字符');
  if (/realtime/i.test(modelName)) throw settingsError('Realtime 模型使用独立实时接口，当前 HTTP 链路不支持');
  if (!MODEL_FAMILIES.includes(modelFamily)) throw settingsError('请选择受支持的模型 Family');
  if (!Number.isInteger(timeout) || timeout < 10_000 || timeout > 600_000) throw settingsError('超时时间必须是 10000 到 600000 毫秒之间的整数');
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw settingsError('Temperature 必须在 0 到 2 之间');
  if (!REASONING_EFFORTS.includes(reasoningEffort)) throw settingsError('请选择受支持的推理强度');
  return { target, gatewayId, modelName, modelFamily, timeout, temperature, reasoningEffort };
}

export function saveTargetModelSettings(modelStore, payload) {
  const next = normalizePayload(payload);
  const gateway = modelStore.getGateway(next.gatewayId, { includeApiKey: true });
  if (!gateway) throw settingsError('所选模型网关不存在');
  if (!gateway.apiKey) throw settingsError('所选模型网关尚未配置 API Key');
  modelStore.saveAssignment(next);
  return loadTargetModelSettings(modelStore, next.target);
}

export function saveModelGateway(modelStore, payload) {
  const requestedId = String(payload?.id || '').trim().toLowerCase();
  const id = requestedId || `gateway-${randomUUID()}`;
  const label = String(payload?.label || '').trim();
  const baseUrl = String(payload?.baseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = String(payload?.apiKey || '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw settingsError('网关 ID 无效');
  if (!label) throw settingsError('请输入网关名称');
  let parsedUrl;
  try { parsedUrl = new URL(baseUrl); } catch { throw settingsError('网关 Base URL 不是有效 URL'); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw settingsError('网关 Base URL 仅支持 HTTP 或 HTTPS');
  if (apiKey && /[\r\n]/.test(apiKey)) throw settingsError('API Key 格式无效');
  const existing = modelStore.getGateway(id, { includeApiKey: true });
  if (!existing && !apiKey) throw settingsError('新增网关时必须填写 API Key');
  if (!existing) {
    const customCount = modelStore.listGateways().filter((gateway) => gateway.id !== DEFAULT_MODEL_GATEWAY_ID).length;
    if (customCount >= 5) throw settingsError('最多只能添加 5 个自定义网关', 409, { limit: 5 });
  }
  return publicGateway(modelStore.saveGateway({ id, label, baseUrl, apiKey }));
}

export function resetDefaultModelGateway(modelStore) {
  const restored = modelStore.resetGatewayToDefault?.(DEFAULT_MODEL_GATEWAY_ID);
  if (!restored) throw settingsError('默认网关尚未保存可恢复的默认值', 409);
  return publicGateway(restored);
}

export function deleteModelGateway(modelStore, gatewayId) {
  const id = String(gatewayId || '').trim().toLowerCase();
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) throw settingsError('模型网关 ID 无效');
  const gateway = modelStore.getGateway(id);
  if (!gateway) throw settingsError('模型网关不存在', 404);
  const targets = modelStore.listAssignments()
    .filter((assignment) => assignment.gatewayId === id)
    .map((assignment) => assignment.target);
  modelStore.deleteGateway(id);
  return { deleted: true, gatewayId: id, clearedTargets: targets };
}
