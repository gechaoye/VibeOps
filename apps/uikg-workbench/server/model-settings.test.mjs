import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  deleteModelGateway,
  fetchAvailableModelsByGateway,
  loadModelGateways,
  loadTargetModelSettings,
  loadWorkbenchPreferences,
  resetDefaultModelGateway,
  saveModelGateway,
  saveTargetModelSettings,
  saveWorkbenchMode,
  testModelGateway,
} from './model-settings.mjs';
import { ModelSettingsStore } from './model-settings-store.mjs';

async function temporaryStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uikg-model-settings-'));
  const store = new ModelSettingsStore(path.join(root, 'model-settings.sqlite'));
  await store.initialize();
  return { root, store };
}

test('网关和三个运行目标持久化到 SQLite 且彼此独立', async () => {
  const { root, store } = await temporaryStore();
  try {
    store.saveGateway({ id: 'alpha', label: 'Alpha', baseUrl: 'https://alpha.example/v1', apiKey: 'alpha-secret-1234' });
    for (const [target, modelName] of [['model_a', 'model-a'], ['model_b', 'model-b'], ['midscene', 'model-midscene']]) {
      saveTargetModelSettings(store, {
        target, gatewayId: 'alpha', modelName, modelFamily: 'gpt-5', timeout: 180000, temperature: 0, reasoningEffort: 'medium',
      });
    }
    store.close();

    const reopened = new ModelSettingsStore(path.join(root, 'model-settings.sqlite'));
    await reopened.initialize();
    assert.equal(reopened.getAssignment('model_a').modelName, 'model-a');
    assert.equal(reopened.getAssignment('model_b').modelName, 'model-b');
    assert.equal(reopened.getAssignment('midscene').modelName, 'model-midscene');
    assert.equal(reopened.getGateway('alpha', { includeApiKey: true }).apiKey, 'alpha-secret-1234');
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('设置响应只返回 SQLite 网关密钥掩码', async () => {
  const { root, store } = await temporaryStore();
  try {
    store.saveGateway({ id: 'cfz', label: 'CFZ', baseUrl: 'https://gateway.example/v1', apiKey: 'private-value-5678' });
    store.saveAssignment({ target: 'model_a', gatewayId: 'cfz', modelName: 'gpt-5.6-sol', modelFamily: 'gpt-5', timeout: 180000, temperature: 0, reasoningEffort: 'high' });
    const gateways = loadModelGateways(store);
    const settings = loadTargetModelSettings(store, 'model_a');
    assert.equal(gateways[0].apiKeyHint, '••••••••5678');
    assert.equal(settings.config.apiKeyConfigured, true);
    assert.equal(settings.storagePath, store.databasePath);
    assert.equal(JSON.stringify({ gateways, settings }).includes('private-value-5678'), false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('网关目录中 ZTO New API 与 CFZ 互换展示位置', async () => {
  const { root, store } = await temporaryStore();
  try {
    store.saveGateway({ id: 'cfz', label: 'CFZ', baseUrl: 'https://cfz.nodemapz.com/v1', apiKey: 'cfz-secret' });
    store.saveGateway({ id: 'dashscope', label: 'DashScope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'dashscope-secret' });
    store.saveGateway({ id: 'zto-newapi', label: 'ZTO New API', baseUrl: 'https://znew-api.dev.ztosys.com/v1', apiKey: 'zto-secret' });

    assert.deepEqual(store.listGateways().map((gateway) => gateway.id), ['zto-newapi', 'dashscope', 'cfz']);
    assert.deepEqual(loadModelGateways(store).map((gateway) => [gateway.id, gateway.kind]), [
      ['zto-newapi', 'default'],
      ['dashscope', 'custom'],
      ['cfz', 'custom'],
    ]);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('按数据库网关聚合模型，过滤图片与 Realtime，并隔离单网关错误', async () => {
  const { root, store } = await temporaryStore();
  try {
    store.saveGateway({ id: 'alpha', label: 'Alpha', baseUrl: 'https://alpha.example/v1', apiKey: 'alpha-secret' });
    store.saveGateway({ id: 'beta', label: 'Beta', baseUrl: 'https://beta.example/v1', apiKey: 'beta-secret' });
    const result = await fetchAvailableModelsByGateway(store, async (url, options) => {
      if (url.startsWith('https://beta.example')) return new Response('upstream failed', { status: 503 });
      assert.equal(options.headers.authorization, 'Bearer alpha-secret');
      return new Response(JSON.stringify({ data: [
        { id: 'gpt-5.6-sol' }, { id: 'gpt-image-2' }, { id: 'gpt-5-realtime' }, { id: 'gpt-5.6-sol' },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    assert.equal(result.totalModels, 1);
    assert.deepEqual(result.gateways[0].models, ['gpt-5.6-sol']);
    assert.match(result.gateways[1].error, /503/);
    assert.equal(JSON.stringify(result).includes('alpha-secret'), false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('DashScope 固定展示四个模型，ZTO New API 仅展示已验证的视觉模型', async () => {
  const { root, store } = await temporaryStore();
  try {
    store.saveGateway({ id: 'dashscope', label: 'DashScope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'dashscope-secret' });
    store.saveGateway({ id: 'zto-newapi', label: 'ZTO New API', baseUrl: 'https://znew-api.dev.ztosys.com/v1', apiKey: 'zto-secret' });
    const result = await fetchAvailableModelsByGateway(store, async (url) => {
      const data = url.includes('dashscope') ? [
        { id: 'deepseek-v4-pro' }, { id: 'qwen3.7-plus' }, { id: 'qwen3-vl-plus' },
        { id: 'qwen3-vl-flash' }, { id: 'qwen3.7-flash' }, { id: 'qwen-image-2.0' },
      ] : [
        { id: 'claude-opus-4-6' }, { id: 'deepseek-v4-pro' }, { id: 'glm-5.3' }, { id: 'kimi-k3' },
        { id: 'doubao-seed-evolving' }, { id: 'MiniMax-M3' }, { id: 'qwen3.7-max' }, { id: 'qwen3.8-max' },
      ];
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const dashscope = result.gateways.find((gateway) => gateway.id === 'dashscope');
    const zto = result.gateways.find((gateway) => gateway.id === 'zto-newapi');
    assert.deepEqual(dashscope.models, ['qwen3-vl-flash', 'qwen3-vl-plus', 'qwen3.7-flash', 'qwen3.7-plus'].sort((left, right) => left.localeCompare(right)));
    assert.deepEqual(zto.models, ['MiniMax-M3', 'qwen3.8-max'].sort((left, right) => left.localeCompare(right)));
    assert.deepEqual(zto.modelFamilies, {
      'MiniMax-M3': 'gpt-5',
      'qwen3.8-max': 'qwen3',
    });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('编辑网关时留空 API Key 会保留凭据且响应不泄露密钥', async () => {
  const { root, store } = await temporaryStore();
  try {
    store.saveGateway({ id: 'alpha', label: 'Alpha', baseUrl: 'https://alpha.example/v1', apiKey: 'private-value-5678' });
    store.saveAssignment({ target: 'midscene', gatewayId: 'alpha', modelName: 'model-a', modelFamily: 'gpt-5', timeout: 180000, temperature: 0, reasoningEffort: 'medium' });
    const response = saveModelGateway(store, { id: 'alpha', label: 'Alpha Updated', baseUrl: 'https://alpha.example/v2', apiKey: '' });
    assert.equal(store.getGateway('alpha', { includeApiKey: true }).apiKey, 'private-value-5678');
    assert.equal(store.getAssignment('midscene').modelName, 'model-a');
    assert.equal(response.apiKeyConfigured, true);
    assert.equal(JSON.stringify(response).includes('private-value-5678'), false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('删除网关时同步清除关联的模型指派', async () => {
  const { root, store } = await temporaryStore();
  try {
    store.saveGateway({ id: 'active', label: 'Active', baseUrl: 'https://active.example/v1', apiKey: 'active-secret' });
    store.saveGateway({ id: 'unused', label: 'Unused', baseUrl: 'https://unused.example/v1', apiKey: 'unused-secret' });
    store.saveAssignment({ target: 'model_a', gatewayId: 'active', modelName: 'model-a', modelFamily: 'gpt-5', timeout: 180000, temperature: 0, reasoningEffort: 'medium' });

    assert.deepEqual(deleteModelGateway(store, 'active'), { deleted: true, gatewayId: 'active', clearedTargets: ['model_a'] });
    assert.equal(store.getGateway('active'), null);
    assert.equal(store.getAssignment('model_a'), null);

    assert.deepEqual(deleteModelGateway(store, 'unused'), { deleted: true, gatewayId: 'unused', clearedTargets: [] });
    assert.equal(store.getGateway('unused'), null);
    assert.throws(() => deleteModelGateway(store, 'unused'), (error) => error.status === 404);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('默认网关可直接删除，且仍可通过重置恢复', async () => {
  const { root, store } = await temporaryStore();
  try {
    store.saveGateway({ id: 'zto-newapi', label: 'ZTO New API', baseUrl: 'https://znew-api.dev.ztosys.com/v1', apiKey: 'zto-secret' });
    assert.deepEqual(deleteModelGateway(store, 'zto-newapi'), { deleted: true, gatewayId: 'zto-newapi', clearedTargets: [] });
    assert.equal(store.getGateway('zto-newapi'), null);
    assert.equal(resetDefaultModelGateway(store).id, 'zto-newapi');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('新增网关由后端生成与显示名称无关的唯一 ID', async () => {
  const { root, store } = await temporaryStore();
  try {
    const first = saveModelGateway(store, { label: 'Same Name', baseUrl: 'https://first.example/v1', apiKey: 'secret' });
    const second = saveModelGateway(store, { label: 'Same Name', baseUrl: 'https://second.example/v1', apiKey: 'secret' });
    assert.match(first.id, /^gateway-[a-f0-9-]{36}$/);
    assert.match(second.id, /^gateway-[a-f0-9-]{36}$/);
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.id, 'same-name');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('自定义网关最多保存 5 个，但已有网关仍可修改', async () => {
  const { root, store } = await temporaryStore();
  try {
    store.saveGateway({ id: 'zto-newapi', label: 'Default', baseUrl: 'https://default.example/v1', apiKey: 'default-secret' });
    for (let index = 1; index <= 5; index += 1) {
      saveModelGateway(store, { id: `custom-${index}`, label: `Custom ${index}`, baseUrl: `https://custom-${index}.example/v1`, apiKey: 'secret' });
    }
    assert.throws(() => saveModelGateway(store, { id: 'custom-6', label: 'Custom 6', baseUrl: 'https://custom-6.example/v1', apiKey: 'secret' }), (error) => {
      assert.equal(error.status, 409);
      assert.deepEqual(error.details, { limit: 5 });
      return true;
    });
    assert.equal(saveModelGateway(store, { id: 'custom-1', label: 'Updated', baseUrl: 'https://custom-1.example/v2', apiKey: '' }).label, 'Updated');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('默认网关保存初始快照并可在修改后重置', async () => {
  const { root, store } = await temporaryStore();
  try {
    saveModelGateway(store, { id: 'zto-newapi', label: 'ZTO New API', baseUrl: 'https://default.example/v1', apiKey: 'original-secret' });
    saveModelGateway(store, { id: 'zto-newapi', label: 'Changed', baseUrl: 'https://changed.example/v1', apiKey: 'changed-secret' });
    const restored = resetDefaultModelGateway(store);
    assert.equal(restored.label, 'ZTO New API');
    assert.equal(restored.baseUrl, 'https://default.example/v1');
    assert.equal(store.getGateway('zto-newapi', { includeApiKey: true }).apiKey, 'original-secret');
    assert.equal(JSON.stringify(restored).includes('original-secret'), false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('模式配置持久化并拒绝未知模式', async () => {
  const { root, store } = await temporaryStore();
  try {
    assert.deepEqual(loadWorkbenchPreferences(store), { mode: 'ultra' });
    assert.deepEqual(saveWorkbenchMode(store, 'manual'), { mode: 'manual' });
    assert.deepEqual(loadWorkbenchPreferences(store), { mode: 'manual' });
    assert.throws(() => saveWorkbenchMode(store, 'turbo'), /受支持的工作模式/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('所有已保存网关均可执行连通性测试', async () => {
  const { root, store } = await temporaryStore();
  try {
    store.saveGateway({ id: 'alpha', label: 'Alpha', baseUrl: 'https://alpha.example/v1', apiKey: 'alpha-secret' });
    const result = await testModelGateway(store, 'alpha', async (url, options) => {
      assert.equal(url, 'https://alpha.example/v1/models');
      assert.equal(options.headers.authorization, 'Bearer alpha-secret');
      return new Response(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    assert.equal(result.ok, true);
    assert.equal(result.gatewayId, 'alpha');
    assert.equal(result.modelCount, 2);
    assert.equal(typeof result.latencyMs, 'number');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('首次启动把旧环境配置迁移到 SQLite，Midscene 默认继承原 Worker A', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uikg-model-migration-'));
  const envPath = path.join(root, '.env');
  await writeFile(envPath, [
    'MIDSCENE_GATEWAY_ALPHA_LABEL="Alpha"',
    'MIDSCENE_GATEWAY_ALPHA_BASE_URL="https://alpha.example/v1"',
    'MIDSCENE_GATEWAY_ALPHA_API_KEY="alpha-secret"',
    'MIDSCENE_WORKER_A_MODEL_GATEWAY="alpha"',
    'MIDSCENE_WORKER_A_MODEL_NAME="qwen3.7-flash"',
    'MIDSCENE_WORKER_A_MODEL_FAMILY="qwen3"',
    'MIDSCENE_WORKER_A_MODEL_REASONING_EFFORT="low"',
    'MIDSCENE_WORKER_B_MODEL_GATEWAY="alpha"',
    'MIDSCENE_WORKER_B_MODEL_NAME="gpt-5.6-sol"',
    'MIDSCENE_WORKER_B_MODEL_FAMILY="gpt-5"',
    '',
  ].join('\n'), 'utf8');
  const store = new ModelSettingsStore(path.join(root, 'model-settings.sqlite'));
  try {
    assert.equal(await store.initialize({ legacyEnvPath: envPath }), undefined);
    assert.equal(store.getAssignment('model_a').modelName, 'qwen3.7-flash');
    assert.equal(store.getAssignment('model_b').modelName, 'gpt-5.6-sol');
    assert.equal(store.getAssignment('midscene').modelName, 'qwen3.7-flash');
    assert.equal(store.getGateway('alpha', { includeApiKey: true }).apiKey, 'alpha-secret');
    await store.migrateLegacyEnvironment(envPath);
    assert.equal(store.listGateways().length, 1, '重复启动不应重复迁移');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('旧数据库中的 worker 目标无损迁移为 model 目标', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uikg-model-target-migration-'));
  const databasePath = path.join(root, 'model-settings.sqlite');
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE model_gateways (id TEXT PRIMARY KEY, label TEXT NOT NULL, base_url TEXT NOT NULL UNIQUE COLLATE NOCASE, api_key TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE model_assignments (target TEXT PRIMARY KEY CHECK (target IN ('worker_a', 'worker_b', 'midscene')), gateway_id TEXT NOT NULL REFERENCES model_gateways(id), model_name TEXT NOT NULL, model_family TEXT NOT NULL, timeout INTEGER NOT NULL, temperature REAL NOT NULL, reasoning_effort TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE model_settings_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO model_gateways VALUES ('legacy', 'Legacy', 'https://legacy.example/v1', 'secret', '2026-01-01', '2026-01-01');
    INSERT INTO model_assignments VALUES ('worker_a', 'legacy', 'old-a', 'gpt-5', 180000, 0, 'medium', '2026-01-01');
    INSERT INTO model_assignments VALUES ('worker_b', 'legacy', 'old-b', 'gpt-5', 180000, 0, 'medium', '2026-01-01');
  `);
  legacy.close();
  const store = new ModelSettingsStore(databasePath);
  try {
    await store.initialize();
    assert.equal(store.getAssignment('model_a').modelName, 'old-a');
    assert.equal(store.getAssignment('model_b').modelName, 'old-b');
    assert.deepEqual(store.listAssignments().map((assignment) => assignment.target), ['model_a', 'model_b']);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('拒绝 Realtime 模型用于 HTTP 链路', async () => {
  const { root, store } = await temporaryStore();
  try {
    store.saveGateway({ id: 'test', label: 'Test', baseUrl: 'https://gateway.example/v1', apiKey: 'secret' });
    assert.throws(() => saveTargetModelSettings(store, {
      target: 'midscene', gatewayId: 'test', modelName: 'qwen3.5-omni-flash-realtime', modelFamily: 'qwen3.5',
      timeout: 120000, temperature: 0, reasoningEffort: 'low',
    }), /Realtime 模型/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
