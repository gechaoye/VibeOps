import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createEmptyDraft } from './draft-model.mjs';
import { registerWorkbenchRoutes } from './workbench-routes.mjs';

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4ZkAAAAASUVORK5CYII=';
const MODEL_KEYS = ['MIDSCENE_MODEL_NAME', 'MIDSCENE_MODEL_FAMILY', 'MIDSCENE_SCOUT_MODEL_NAME'];

test('冻结画面会热加载新增和变化的模型配置', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uikg-model-runtime-'));
  const envPath = path.join(root, '.env');
  const previous = Object.fromEntries(MODEL_KEYS.map((key) => [key, process.env[key]]));
  for (const key of MODEL_KEYS) delete process.env[key];

  const app = express();
  let draft = createEmptyDraft();
  let clearCount = 0;
  let expectedModel = 'review-model-v1';
  const agent = {
    interface: {},
    modelConfigManager: {
      clearModelConfigMap() { clearCount += 1; },
    },
    async unfreezePageContext() {},
    async freezePageContext() {
      assert.equal(process.env.MIDSCENE_MODEL_NAME, expectedModel);
      assert.equal(process.env.MIDSCENE_MODEL_FAMILY, 'gpt-5');
    },
    async _snapshotContext() {
      return { screenshot: { base64: `data:image/png;base64,${PNG_1X1}`, capturedAt: Date.now() } };
    },
  };
  const store = {
    async saveFrame(frame) {
      return { frameId: frame.frameId, mimeType: frame.mimeType, extension: frame.extension, width: frame.width, height: frame.height, bytes: frame.buffer.length, capturedAt: frame.capturedAt };
    },
    async loadDraft() { return structuredClone(draft); },
    async saveDraft(value) { draft = structuredClone(value); },
  };
  await registerWorkbenchRoutes({
    server: { app, agent, getSessionState: () => null },
    store,
    graphWorkflow: {},
    workbenchRoot: process.cwd(),
    modelEnvPath: envPath,
    spec: { version: 'test', schemaVersion: 'test', contentHash: 'test', index: 'test' },
  });

  const httpServer = createServer(app);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  try {
    await writeFile(envPath, 'MIDSCENE_MODEL_NAME="review-model-v1"\nMIDSCENE_MODEL_FAMILY="gpt-5"\nMIDSCENE_SCOUT_MODEL_NAME="scout-v1"\n', 'utf8');
    assert.equal((await fetch(`${baseUrl}/workbench/api/frames`, { method: 'POST' })).status, 200);
    assert.equal(clearCount, 1);

    assert.equal((await fetch(`${baseUrl}/workbench/api/frames`, { method: 'POST' })).status, 200);
    assert.equal(clearCount, 1, '配置未变化时不应反复清理模型缓存');

    expectedModel = 'review-model-v2';
    await writeFile(envPath, 'MIDSCENE_MODEL_NAME="review-model-v2"\nMIDSCENE_MODEL_FAMILY="gpt-5"\nMIDSCENE_SCOUT_MODEL_NAME="scout-v1"\n', 'utf8');
    assert.equal((await fetch(`${baseUrl}/workbench/api/frames`, { method: 'POST' })).status, 200);
    assert.equal(clearCount, 2);
  } finally {
    await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
    for (const key of MODEL_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
