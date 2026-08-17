import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createEmptyDraft } from './draft-model.mjs';
import { registerWorkbenchRoutes } from './workbench-routes.mjs';
import { clearModelRuntime, setModelRuntime } from './model-runtime.mjs';

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4ZkAAAAASUVORK5CYII=';

test('Worker A 手动中断后保留断点并从断点继续', async () => {
  setModelRuntime('worker_a', { modelName: 'test-worker-a-model', modelFamily: 'gpt-5', baseUrl: 'https://test.invalid/v1', apiKey: 'test', temperature: 0, reasoningEffort: 'medium' });
  const app = express();
  let draft = createEmptyDraft();
  let modelAborted = false;
  let modelCalls = 0;
  let frozenFrameId = null;
  let draftSaveCount = 0;
  const agent = {
    interface: {},
    async unfreezePageContext() {},
    async freezePageContext() {},
    async _snapshotContext() {
      return { screenshot: { base64: `data:image/png;base64,${PNG_1X1}`, capturedAt: Date.now() } };
    },
    async runWorkerModel({ prompt, onChunk, signal }) {
      modelCalls += 1;
      if (modelCalls > 1) {
        assert.match(prompt, /header\.title/);
        return {
          elements: [], relationships: [], actionCandidates: [],
          comparison: { basisFrameId: null, status: 'not-requested', changes: [] }, uncertainties: [], done: true,
        };
      }
      const checkpoint = {
        frameId: frozenFrameId,
        page: { name: '消息', surfaceType: 'page', stateSummary: '消息页', scrollableRegions: [] },
        elements: [{
          candidateKey: 'header.title', label: '消息', visualDescription: '顶部标题', controlType: 'label', interactive: false,
          enabled: true, state: null, approximateRegion: { x: 0.1, y: 0.05, width: 0.3, height: 0.05 }, geometryKind: 'boundary', geometryConfidence: 0.9,
          meaning: { status: 'known', description: '页面标题', evidence: { visibleTexts: ['消息'], visibleIcons: [], visibleStates: [], visualCues: [], userContext: null, unclassified: [] } },
          dynamicContent: false, riskSignals: [], confidence: 0.9,
        }],
      };
      const partial = JSON.stringify(checkpoint);
      onChunk({ content: partial, reasoning_content: '正在识别页面', accumulated: partial, isComplete: false });
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          modelAborted = true;
          reject(new Error('aborted'));
        }, { once: true });
      });
    },
  };
  const server = { app, agent, runWorkerModel: agent.runWorkerModel, getSessionState: () => null };
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
    frozenFrameId = frame.frameId;

    const streamResponse = await fetch(`${baseUrl}/workbench/api/workers/a/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frameId: frame.frameId, mergeIntoDraft: true }),
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

    const cancelResponse = await fetch(`${baseUrl}/workbench/api/workers/a/cancel`, { method: 'POST' });
    assert.deepEqual(await cancelResponse.json(), { cancelled: true });
    while (true) {
      const { value, done } = await reader.read();
      streamText += decoder.decode(value || new Uint8Array(), { stream: !done });
      if (done) break;
    }

    assert.match(streamText, /正在识别页面/);
    assert.match(streamText, /event: cancelled/);
    assert.equal(modelAborted, true);
    assert.equal(draftSaveCount, 1, '只有冻结帧创建空白 Page，不应保存 Worker A 半截结果');
    const cancelled = streamText.split(/\r?\n\r?\n/).map((block) => ({
      event: block.match(/^event:\s*(.+)$/m)?.[1],
      data: JSON.parse(block.match(/^data:\s*(.+)$/m)?.[1] || '{}'),
    })).find((event) => event.event === 'cancelled');
    assert.equal(cancelled.data.resumableSession.completedCandidates, 1);

    const resumeResponse = await fetch(`${baseUrl}/workbench/api/workers/a/resume/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: cancelled.data.resumableSession.id }),
    });
    const resumeText = await resumeResponse.text();
    assert.match(resumeText, /event: result/);
    assert.equal(modelCalls, 2);
    assert.equal(draftSaveCount, 2, '恢复完成后才合并并保存草稿');
  } finally {
    await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    clearModelRuntime('worker_a');
  }
});
