import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createEmptyDraft } from './draft-model.mjs';
import { getModelRuntime } from './model-runtime.mjs';
import { ModelSettingsStore } from './model-settings-store.mjs';
import { registerWorkbenchRoutes } from './workbench-routes.mjs';

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4ZkAAAAASUVORK5CYII=';

function assignment(target, gatewayId, modelName, modelFamily) {
  return { target, gatewayId, modelName, modelFamily, timeout: 180000, temperature: 0, reasoningEffort: 'medium' };
}

test('数据库配置热加载 Worker，并只把 Midscene 标签配置同步给 SDK', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uikg-model-runtime-'));
  const modelStore = new ModelSettingsStore(path.join(root, 'model-settings.sqlite'));
  await modelStore.initialize();
  modelStore.saveGateway({ id: 'workers', label: 'Workers', baseUrl: 'https://workers.example/v1', apiKey: 'worker-secret' });
  modelStore.saveGateway({ id: 'midscene', label: 'Midscene', baseUrl: 'https://midscene.example/v1', apiKey: 'midscene-secret' });
  modelStore.saveAssignment(assignment('model_a', 'workers', 'worker-a-v1', 'qwen3-vl'));
  modelStore.saveAssignment(assignment('model_b', 'workers', 'worker-b-v1', 'gpt-5'));
  modelStore.saveAssignment(assignment('midscene', 'midscene', 'midscene-v1', 'gpt-5'));

  const app = express();
  let draft = createEmptyDraft();
  let clearCount = 0;
  let expectedWorkerB = 'worker-b-v1';
  let expectedMidscene = { modelName: 'midscene-v1', family: 'gpt-5', reasoningBudget: '' };
  const agent = {
    interface: {},
    modelConfigManager: { clearModelConfigMap() { clearCount += 1; } },
    async unfreezePageContext() {},
    async freezePageContext() {
      assert.equal(getModelRuntime('model_b').modelName, expectedWorkerB);
      assert.equal(getModelRuntime('model_a').modelName, 'worker-a-v1');
      assert.equal(process.env.MIDSCENE_MODEL_NAME, expectedMidscene.modelName);
      assert.equal(process.env.MIDSCENE_MODEL_BASE_URL, 'https://midscene.example/v1');
      assert.equal(process.env.MIDSCENE_MODEL_API_KEY, 'midscene-secret');
      assert.equal(process.env.MIDSCENE_MODEL_FAMILY, expectedMidscene.family);
      assert.equal(process.env.MIDSCENE_MODEL_REASONING_BUDGET, expectedMidscene.reasoningBudget);
    },
    async _snapshotContext() {
      return { screenshot: { base64: `data:image/png;base64,${PNG_1X1}`, capturedAt: Date.now() } };
    },
  };
  const store = {
    async saveFrame(frame) { return { frameId: frame.frameId, mimeType: frame.mimeType, extension: frame.extension, width: frame.width, height: frame.height, bytes: frame.buffer.length, capturedAt: frame.capturedAt }; },
    async loadDraft() { return structuredClone(draft); },
    async saveDraft(value) { draft = structuredClone(value); },
  };
  await registerWorkbenchRoutes({
    server: { app, agent, getSessionState: () => null }, store, modelStore, graphWorkflow: {}, workbenchRoot: process.cwd(),
    spec: { version: 'test', schemaVersion: 'test', contentHash: 'test', index: 'test' },
  });

  const httpServer = createServer(app);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  try {
    assert.equal((await fetch(`${baseUrl}/workbench/api/frames`, { method: 'POST' })).status, 200);
    assert.equal(clearCount, 1);
    assert.equal((await fetch(`${baseUrl}/workbench/api/frames`, { method: 'POST' })).status, 200);
    assert.equal(clearCount, 1, '数据库配置未变化时不应清理模型缓存');

    expectedWorkerB = 'worker-b-v2';
    modelStore.saveAssignment(assignment('model_b', 'workers', expectedWorkerB, 'gpt-5'));
    assert.equal((await fetch(`${baseUrl}/workbench/api/frames`, { method: 'POST' })).status, 200);
    assert.equal(clearCount, 2);
    assert.equal(process.env.MIDSCENE_MODEL_NAME, 'midscene-v1', 'Worker 变化不应改变 Midscene 指派');

    expectedMidscene = { modelName: 'qwen3.8-max', family: 'qwen3', reasoningBudget: '8192' };
    modelStore.saveAssignment(assignment('midscene', 'midscene', expectedMidscene.modelName, expectedMidscene.family));
    assert.equal((await fetch(`${baseUrl}/workbench/api/frames`, { method: 'POST' })).status, 200);
    assert.equal(process.env.MIDSCENE_MODEL_NAME, 'qwen3.8-max');
    assert.equal(process.env.MIDSCENE_MODEL_FAMILY, 'qwen3');
    assert.equal(process.env.MIDSCENE_MODEL_REASONING_BUDGET, '8192');
  } finally {
    await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    modelStore.close();
    await rm(root, { recursive: true, force: true });
  }
});
