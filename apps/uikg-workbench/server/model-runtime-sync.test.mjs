import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createEmptyDraft } from './draft-model.mjs';
import { getModelRuntime } from './model-runtime.mjs';
import { ModelSettingsStore } from './model-settings-store.mjs';
import { registerWorkbenchRoutes } from './workbench-routes.mjs';

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4ZkAAAAASUVORK5CYII=';
const workbenchRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function assignment(target, gatewayId, modelName, modelFamily) {
  return { target, gatewayId, modelName, modelFamily, timeout: 180000, temperature: 0, reasoningEffort: 'medium' };
}

test('数据库配置热加载识别模型，并只把 Midscene 标签配置同步给 SDK', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uikg-model-runtime-'));
  const modelStore = new ModelSettingsStore(path.join(root, 'model-settings.sqlite'));
  await modelStore.initialize();
  modelStore.saveGateway({ id: 'recognition', label: 'Recognition', baseUrl: 'https://recognition.example/v1', apiKey: 'recognition-secret' });
  modelStore.saveGateway({ id: 'midscene', label: 'Midscene', baseUrl: 'https://midscene.example/v1', apiKey: 'midscene-secret' });
  modelStore.saveAssignment(assignment('manual', 'recognition', 'manual-v1', 'qwen3-vl'));
  modelStore.saveAssignment(assignment('auto', 'recognition', 'auto-v1', 'gpt-5'));
  modelStore.saveAssignment(assignment('midscene', 'midscene', 'midscene-v1', 'gpt-5'));
  modelStore.saveAssignment(assignment('self_heal', 'recognition', 'self-heal-v1', 'gpt-5'));

  const app = express();
  let draft = createEmptyDraft();
  let clearCount = 0;
  const expectedManual = 'manual-v1';
  let expectedAuto = 'auto-v1';
  let expectedMidscene = { modelName: 'midscene-v1', family: 'gpt-5', reasoningBudget: '' };
  const agent = {
    interface: {},
    modelConfigManager: { clearModelConfigMap() { clearCount += 1; } },
    async unfreezePageContext() {},
    async freezePageContext() {
      assert.equal(getModelRuntime('manual').modelName, expectedManual);
      assert.equal(getModelRuntime('auto').modelName, expectedAuto);
      assert.equal(getModelRuntime('self_heal').modelName, 'self-heal-v1');
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

    expectedAuto = 'auto-v2';
    modelStore.saveAssignment(assignment('auto', 'recognition', expectedAuto, 'gpt-5'));
    assert.equal((await fetch(`${baseUrl}/workbench/api/frames`, { method: 'POST' })).status, 200);
    assert.equal(getModelRuntime('manual').modelName, expectedManual, '修改 Auto 配置不应改变 Manual 模型');
    assert.equal(clearCount, 2);

    expectedMidscene = { modelName: 'qwen3.8-max', family: 'qwen3', reasoningBudget: '8192' };
    modelStore.saveAssignment(assignment('midscene', 'midscene', expectedMidscene.modelName, expectedMidscene.family));
    assert.equal((await fetch(`${baseUrl}/workbench/api/frames`, { method: 'POST' })).status, 200);
    assert.equal(clearCount, 3);
    assert.equal(process.env.MIDSCENE_MODEL_NAME, 'qwen3.8-max');
    assert.equal(process.env.MIDSCENE_MODEL_FAMILY, 'qwen3');
    assert.equal(process.env.MIDSCENE_MODEL_REASONING_BUDGET, '8192');
  } finally {
    await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    modelStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('保存模型配置不等待后台能力检测', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uikg-model-save-'));
  const modelStore = new ModelSettingsStore(path.join(root, 'model-settings.sqlite'));
  await modelStore.initialize();

  const upstream = createServer((request, response) => {
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    setTimeout(() => response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"frameId":"probe"}' } }] })}\n\ndata: [DONE]\n\n`), 500);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamBaseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  modelStore.saveGateway({ id: 'slow', label: 'Slow', baseUrl: upstreamBaseUrl, apiKey: 'secret' });

  const app = express();
  await registerWorkbenchRoutes({
    server: { app, agent: null, getSessionState: () => null },
    store: {},
    modelStore,
    graphWorkflow: {},
    workbenchRoot,
    spec: { version: 'test', schemaVersion: 'test', contentHash: 'test', index: 'test' },
  });
  const httpServer = createServer(app);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}/workbench/api`;
  try {
    const startedAt = Date.now();
    const response = await fetch(`${baseUrl}/model-settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: 'manual', gatewayId: 'slow', modelName: 'vision-model', modelFamily: 'gpt-5',
        timeout: 180000, temperature: 0, reasoningEffort: 'low',
      }),
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(response.status, 200);
    assert.ok(elapsedMs < 300, `保存被能力检测阻塞了 ${elapsedMs}ms`);
    assert.equal(modelStore.getAssignment('manual').modelName, 'vision-model');

    const deadline = Date.now() + 2_000;
    while (!modelStore.getModelCapability('slow', 'vision-model') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(modelStore.getModelCapability('slow', 'vision-model')?.mode, 'native');
  } finally {
    await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    modelStore.close();
    await rm(root, { recursive: true, force: true });
  }
});
