import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fetchWorkerAvailableModels, loadWorkerBModelSettings, loadWorkerAModelSettings, saveWorkerBModelSettings, saveWorkerAModelSettings, updateEnvDocument } from './model-settings.mjs';

test('更新 Worker A 配置时保留 Worker B 配置和已有 API Key', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uikg-model-settings-'));
  const envPath = path.join(root, '.env');
  const original = `# Worker A\nMIDSCENE_WORKER_A_MODEL_API_KEY="secret-1234"\nMIDSCENE_WORKER_A_MODEL_NAME="qwen3-vl-plus"\nMIDSCENE_WORKER_A_MODEL_FAMILY="qwen3-vl"\n\nMIDSCENE_WORKER_B_MODEL_NAME="gpt-5.6-sol"\n`;
  await writeFile(envPath, original, 'utf8');
  const runtime = {};
  try {
    const result = await saveWorkerAModelSettings(envPath, {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      modelName: 'qwen3.7-flash',
      modelFamily: 'qwen3',
      timeout: 120000,
      temperature: 0,
      reasoningEnabled: false,
      apiKey: '',
    }, runtime);
    const saved = await readFile(envPath, 'utf8');
    assert.match(saved, /MIDSCENE_WORKER_A_MODEL_API_KEY="secret-1234"/);
    assert.match(saved, /MIDSCENE_WORKER_B_MODEL_NAME="gpt-5.6-sol"/);
    assert.match(saved, /MIDSCENE_WORKER_A_MODEL_NAME="qwen3\.7-flash"/);
    assert.equal(result.config.modelFamily, 'qwen3');
    assert.equal(result.config.apiKeyHint, '••••••••1234');
    assert.equal(runtime.MIDSCENE_WORKER_A_MODEL_NAME, 'qwen3.7-flash');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('读取设置不会返回完整 API Key', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uikg-model-settings-'));
  const envPath = path.join(root, '.env');
  await writeFile(envPath, 'MIDSCENE_WORKER_A_MODEL_API_KEY="private-value-5678"\n', 'utf8');
  try {
    const settings = await loadWorkerAModelSettings(envPath, {});
    assert.equal(settings.config.apiKeyConfigured, true);
    assert.equal(settings.config.apiKeyHint, '••••••••5678');
    assert.equal(JSON.stringify(settings).includes('private-value-5678'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('使用 Worker API Key 获取并整理网关模型列表', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uikg-model-list-'));
  const envPath = path.join(root, '.env');
  await writeFile(envPath, 'MIDSCENE_WORKER_B_MODEL_BASE_URL="https://gateway.example/v1"\nMIDSCENE_WORKER_B_MODEL_API_KEY="model-list-secret"\n', 'utf8');
  try {
    const result = await fetchWorkerAvailableModels(envPath, 'worker_b', {}, async (url, options) => {
      assert.equal(url, 'https://gateway.example/v1/models');
      assert.equal(options.headers.authorization, 'Bearer model-list-secret');
      return new Response(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.4' }, { id: 'gpt-5.6-sol' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    assert.deepEqual(result.models, ['gpt-5.4', 'gpt-5.6-sol']);
    assert.equal(JSON.stringify(result).includes('model-list-secret'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('缺少 Worker A 配置块时在文件顶部插入完整配置', () => {
  const output = updateEnvDocument('MIDSCENE_WORKER_B_MODEL_NAME="default"\n', {
    MIDSCENE_WORKER_A_MODEL_NAME: 'qwen3.7-flash',
    MIDSCENE_WORKER_A_MODEL_FAMILY: 'qwen3',
  });
  assert.match(output, /^# === Worker A 模型 ===\n/);
  assert.match(output, /MIDSCENE_WORKER_B_MODEL_NAME="default"/);
});

test('重复的 Worker A 环境变量会被全部更新', () => {
  const output = updateEnvDocument('MIDSCENE_WORKER_A_MODEL_NAME="old-a"\nMIDSCENE_WORKER_A_MODEL_NAME="old-b"\n', {
    MIDSCENE_WORKER_A_MODEL_NAME: 'qwen3.7-flash',
  });
  assert.equal(output.match(/MIDSCENE_WORKER_A_MODEL_NAME="qwen3\.7-flash"/g)?.length, 2);
  assert.equal(output.includes('old-'), false);
});

test('拒绝 Realtime 模型用于 Worker HTTP 链路', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uikg-model-settings-'));
  const envPath = path.join(root, '.env');
  try {
    await assert.rejects(() => saveWorkerAModelSettings(envPath, {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      modelName: 'qwen3.5-omni-flash-realtime',
      modelFamily: 'qwen3',
      timeout: 120000,
      temperature: 0,
      reasoningEnabled: false,
    }, {}), /Realtime 模型/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Worker B 配置独立更新且保留 Worker A', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uikg-workerB-settings-'));
  const envPath = path.join(root, '.env');
  await writeFile(envPath, 'MIDSCENE_WORKER_A_MODEL_NAME="qwen3.7-flash"\nMIDSCENE_WORKER_B_MODEL_API_KEY="review-secret-9876"\nMIDSCENE_WORKER_B_MODEL_NAME="gpt-old"\nMIDSCENE_WORKER_B_MODEL_FAMILY="gpt-5"\n', 'utf8');
  const runtime = {};
  try {
    await saveWorkerBModelSettings(envPath, {
      baseUrl: 'https://example.test/v1', modelName: 'gpt-5.6-sol', modelFamily: 'gpt-5',
      timeout: 180000, temperature: 0, reasoningEffort: 'high', apiKey: '',
    }, runtime);
    const saved = await readFile(envPath, 'utf8');
    assert.match(saved, /MIDSCENE_WORKER_A_MODEL_NAME="qwen3\.7-flash"/);
    assert.match(saved, /MIDSCENE_WORKER_B_MODEL_NAME="gpt-5\.6-sol"/);
    assert.match(saved, /MIDSCENE_WORKER_B_MODEL_API_KEY="review-secret-9876"/);
    assert.match(saved, /MIDSCENE_WORKER_B_MODEL_REASONING_EFFORT="high"/);
    const settings = await loadWorkerBModelSettings(envPath, runtime);
    assert.equal(settings.config.modelName, 'gpt-5.6-sol');
    assert.equal(settings.config.reasoningEffort, 'high');
    assert.equal(settings.config.apiKeyHint, '••••••••9876');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('跨供应商指派模型时复用已有供应商 API Key', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uikg-provider-key-'));
  const envPath = path.join(root, '.env');
  await writeFile(envPath, [
    'MIDSCENE_WORKER_A_MODEL_BASE_URL="https://dashscope.example/v1"',
    'MIDSCENE_WORKER_A_MODEL_API_KEY="dashscope-secret"',
    'MIDSCENE_WORKER_B_MODEL_BASE_URL="https://gateway.example/v1"',
    'MIDSCENE_WORKER_B_MODEL_API_KEY="gateway-secret"',
    '',
  ].join('\n'), 'utf8');
  try {
    const settings = await saveWorkerAModelSettings(envPath, {
      baseUrl: 'https://gateway.example/v1', modelName: 'gpt-5.6-sol', modelFamily: 'gpt-5',
      timeout: 180000, temperature: 0, reasoningEffort: 'medium', apiKey: '',
    }, {});
    const saved = await readFile(envPath, 'utf8');
    assert.match(saved, /MIDSCENE_WORKER_A_MODEL_API_KEY="gateway-secret"/);
    assert.equal(settings.config.apiKeyHint, '••••••••cret');
    assert.equal(JSON.stringify(settings).includes('gateway-secret'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
