import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createEmptyDraft } from './draft-model.mjs';
import { registerWorkbenchRoutes } from './workbench-routes.mjs';

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4ZkAAAAASUVORK5CYII=';

test('Scout 流输出可见且中断会传递到模型请求，不合并半截草稿', async () => {
  const previousScoutModel = process.env.MIDSCENE_SCOUT_MODEL_NAME;
  process.env.MIDSCENE_SCOUT_MODEL_NAME = 'test-scout-model';
  const app = express();
  let draft = createEmptyDraft();
  let modelAborted = false;
  let draftSaveCount = 0;
  const agent = {
    interface: {},
    async unfreezePageContext() {},
    async freezePageContext() {},
    async _snapshotContext() {
      return { screenshot: { base64: `data:image/png;base64,${PNG_1X1}`, capturedAt: Date.now() } };
    },
    async aiScout(_prompt, options) {
      options.onChunk({ content: '{"partial":', reasoning_content: '正在识别页面', accumulated: '{"partial":', isComplete: false });
      return new Promise((_resolve, reject) => {
        options.abortSignal.addEventListener('abort', () => {
          modelAborted = true;
          reject(new Error('aborted'));
        }, { once: true });
      });
    },
  };
  const server = { app, agent, getSessionState: () => null };
  const store = {
    async saveFrame(frame) {
      return { frameId: frame.frameId, mimeType: frame.mimeType, extension: frame.extension, width: frame.width, height: frame.height, bytes: frame.buffer.length, capturedAt: frame.capturedAt };
    },
    async loadFrame() { return { imagePath: '/tmp/frame.png', mimeType: 'image/png' }; },
    async loadDraft() { return structuredClone(draft); },
    async saveDraft(value) { draft = structuredClone(value); draftSaveCount += 1; },
    async saveModelResult(id) { return path.join(process.cwd(), '.data', 'evidence', 'model-results', `${id}.json`); },
  };
  await registerWorkbenchRoutes({
    server,
    store,
    graphWorkflow: {},
    workbenchRoot: process.cwd(),
    spec: { version: 'test', schemaVersion: 'test', contentHash: 'test', index: 'test' },
  });

  const httpServer = createServer(app);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const frameResponse = await fetch(`${baseUrl}/workbench/api/frames`, { method: 'POST' });
    assert.equal(frameResponse.status, 200);
    const { frame } = await frameResponse.json();

    const streamResponse = await fetch(`${baseUrl}/workbench/api/scout/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frameId: frame.frameId }),
    });
    assert.equal(streamResponse.status, 200);
    const reader = streamResponse.body.getReader();
    const decoder = new TextDecoder();
    let streamText = '';
    while (!streamText.includes('event: chunk')) {
      const { value, done } = await reader.read();
      if (done) break;
      streamText += decoder.decode(value, { stream: true });
    }

    const cancelResponse = await fetch(`${baseUrl}/workbench/api/scout/cancel`, { method: 'POST' });
    assert.deepEqual(await cancelResponse.json(), { cancelled: true });
    while (true) {
      const { value, done } = await reader.read();
      streamText += decoder.decode(value || new Uint8Array(), { stream: !done });
      if (done) break;
    }

    assert.match(streamText, /正在识别页面/);
    assert.match(streamText, /event: cancelled/);
    assert.equal(modelAborted, true);
    assert.equal(draftSaveCount, 1, '只有冻结帧创建空白 Page，不应保存 Scout 半截结果');
  } finally {
    await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    if (previousScoutModel === undefined) delete process.env.MIDSCENE_SCOUT_MODEL_NAME;
    else process.env.MIDSCENE_SCOUT_MODEL_NAME = previousScoutModel;
  }
});
