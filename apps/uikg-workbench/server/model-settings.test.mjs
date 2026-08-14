import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadReviewerModelSettings, loadScoutModelSettings, saveReviewerModelSettings, saveScoutModelSettings, updateEnvDocument } from './model-settings.mjs';

test('更新 Scout 配置时保留其他模型配置和已有 API Key', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uikg-model-settings-'));
  const envPath = path.join(root, '.env');
  const original = `# Scout\nMIDSCENE_SCOUT_MODEL_API_KEY="secret-1234"\nMIDSCENE_SCOUT_MODEL_NAME="qwen3-vl-plus"\nMIDSCENE_SCOUT_MODEL_FAMILY="qwen3-vl"\n\nMIDSCENE_MODEL_NAME="gpt-5.6-sol"\n`;
  await writeFile(envPath, original, 'utf8');
  const runtime = {};
  try {
    const result = await saveScoutModelSettings(envPath, {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      modelName: 'qwen3.7-flash',
      modelFamily: 'qwen3',
      timeout: 120000,
      temperature: 0,
      reasoningEnabled: false,
      apiKey: '',
    }, runtime);
    const saved = await readFile(envPath, 'utf8');
    assert.match(saved, /MIDSCENE_SCOUT_MODEL_API_KEY="secret-1234"/);
    assert.match(saved, /MIDSCENE_MODEL_NAME="gpt-5.6-sol"/);
    assert.match(saved, /MIDSCENE_SCOUT_MODEL_NAME="qwen3\.7-flash"/);
    assert.equal(result.config.modelFamily, 'qwen3');
    assert.equal(result.config.apiKeyHint, '••••••••1234');
    assert.equal(runtime.MIDSCENE_SCOUT_MODEL_NAME, 'qwen3.7-flash');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('读取设置不会返回完整 API Key', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uikg-model-settings-'));
  const envPath = path.join(root, '.env');
  await writeFile(envPath, 'MIDSCENE_SCOUT_MODEL_API_KEY="private-value-5678"\n', 'utf8');
  try {
    const settings = await loadScoutModelSettings(envPath, {});
    assert.equal(settings.config.apiKeyConfigured, true);
    assert.equal(settings.config.apiKeyHint, '••••••••5678');
    assert.equal(JSON.stringify(settings).includes('private-value-5678'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('缺少 Scout 配置块时在文件顶部插入完整配置', () => {
  const output = updateEnvDocument('MIDSCENE_MODEL_NAME="default"\n', {
    MIDSCENE_SCOUT_MODEL_NAME: 'qwen3.7-flash',
    MIDSCENE_SCOUT_MODEL_FAMILY: 'qwen3',
  });
  assert.match(output, /^# === Scout 视觉模型 ===\n/);
  assert.match(output, /MIDSCENE_MODEL_NAME="default"/);
});

test('重复的 Scout 环境变量会被全部更新', () => {
  const output = updateEnvDocument('MIDSCENE_SCOUT_MODEL_NAME="old-a"\nMIDSCENE_SCOUT_MODEL_NAME="old-b"\n', {
    MIDSCENE_SCOUT_MODEL_NAME: 'qwen3.7-flash',
  });
  assert.equal(output.match(/MIDSCENE_SCOUT_MODEL_NAME="qwen3\.7-flash"/g)?.length, 2);
  assert.equal(output.includes('old-'), false);
});

test('拒绝 Realtime 模型用于 Scout HTTP 链路', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uikg-model-settings-'));
  const envPath = path.join(root, '.env');
  try {
    await assert.rejects(() => saveScoutModelSettings(envPath, {
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

test('Reviewer 配置独立更新 MIDSCENE_MODEL_* 且保留 Scout', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uikg-reviewer-settings-'));
  const envPath = path.join(root, '.env');
  await writeFile(envPath, 'MIDSCENE_SCOUT_MODEL_NAME="qwen3.7-flash"\nMIDSCENE_MODEL_API_KEY="review-secret-9876"\nMIDSCENE_MODEL_NAME="gpt-old"\nMIDSCENE_MODEL_FAMILY="gpt-5"\n', 'utf8');
  const runtime = {};
  try {
    await saveReviewerModelSettings(envPath, {
      baseUrl: 'https://example.test/v1', modelName: 'gpt-5.6-sol', modelFamily: 'gpt-5',
      timeout: 180000, temperature: 0, reasoningEnabled: false, apiKey: '',
    }, runtime);
    const saved = await readFile(envPath, 'utf8');
    assert.match(saved, /MIDSCENE_SCOUT_MODEL_NAME="qwen3\.7-flash"/);
    assert.match(saved, /MIDSCENE_MODEL_NAME="gpt-5\.6-sol"/);
    assert.match(saved, /MIDSCENE_MODEL_API_KEY="review-secret-9876"/);
    const settings = await loadReviewerModelSettings(envPath, runtime);
    assert.equal(settings.config.modelName, 'gpt-5.6-sol');
    assert.equal(settings.config.apiKeyHint, '••••••••9876');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
