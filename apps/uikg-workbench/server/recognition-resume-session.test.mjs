import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createEmptyDraft } from './draft-model.mjs';
import { registerWorkbenchRoutes } from './workbench-routes.mjs';
import { clearModelRuntime, setModelRuntime } from './model-runtime.mjs';

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4ZkAAAAASUVORK5CYII=';

function recognitionElement(candidateKey = 'header.title') {
  return {
    candidateKey,
    label: '消息',
    visualDescription: '顶部标题',
    elementType: 'label',
    interactive: false,
    enabled: true,
    state: null,
    approximateRegion: { x: 0.1, y: 0.05, width: 0.3, height: 0.05 },
    geometryKind: 'boundary',
    geometryConfidence: 0.9,
    meaning: {
      status: 'known',
      description: '页面标题',
      evidence: { visibleTexts: ['消息'], visibleIcons: [], visibleStates: [], visualCues: [], userContext: null, unclassified: [] },
    },
    dynamicContent: false,
    riskSignals: [],
    confidence: 0.9,
  };
}

function eventPayload(streamText, eventName) {
  const block = streamText.split(/\r?\n\r?\n/).find((item) => item.startsWith(`event: ${eventName}\n`));
  assert.ok(block, `missing ${eventName} event`);
  const data = block.split(/\r?\n/).find((line) => line.startsWith('data: '));
  return JSON.parse(data.slice(6));
}

test('模型错误重试从已收到的断点继续并最终合并草稿', async () => {
  setModelRuntime('manual', { modelName: 'test-recognition-model', modelFamily: 'gpt-5', baseUrl: 'https://test.invalid/v1', apiKey: 'test', temperature: 0, reasoningEffort: 'medium' });
  const app = express();
  let draft = createEmptyDraft();
  let frozenFrameId = null;
  let modelCalls = 0;
  const prompts = [];
  const agent = {
    interface: {},
    async unfreezePageContext() {},
    async freezePageContext() {},
    async _snapshotContext() {
      return { screenshot: { base64: `data:image/png;base64,${PNG_1X1}`, capturedAt: Date.now() } };
    },
    async runRecognitionModel({ prompt, onChunk }) {
      modelCalls += 1;
      prompts.push(prompt);
      if (modelCalls === 1) {
        const checkpoint = { frameId: frozenFrameId, page: { name: '消息', surfaceType: 'page', stateSummary: '消息页', scrollableRegions: [] }, elements: [recognitionElement()] };
        const content = `<data-json>${JSON.stringify(checkpoint)}`;
        onChunk({ content, reasoning_content: '', accumulated: content, isComplete: false });
        throw new Error('上游连接断开');
      }
      const result = {
        elements: [recognitionElement('footer')],
        relationships: [],
        actionCandidates: [],
        comparison: { basisFrameId: null, status: 'not-requested', changes: [] },
        uncertainties: [],
        done: true,
      };
      onChunk({ content: JSON.stringify(result), reasoning_content: '', accumulated: JSON.stringify(result), isComplete: true });
      return result;
    },
  };
  const store = {
    async saveFrame(frame) {
      return { frameId: frame.frameId, mimeType: frame.mimeType, extension: frame.extension, width: frame.width, height: frame.height, bytes: frame.buffer.length, capturedAt: frame.capturedAt };
    },
    async loadFrame() { return { imagePath: '/tmp/frame.png', mimeType: 'image/png' }; },
    async loadDraft() { return structuredClone(draft); },
    async saveDraft(value) { draft = structuredClone(value); },
    async saveModelResult(id) { return path.join(process.cwd(), '.data', 'evidence', 'model-results', `${id}.json`); },
  };
  await registerWorkbenchRoutes({
    server: { app, agent, runRecognitionModel: agent.runRecognitionModel, getSessionState: () => null },
    store,
    graphWorkflow: {},
    workbenchRoot: process.cwd(),
    spec: { version: 'test', schemaVersion: 'test', contentHash: 'test', index: 'test' },
  });

  const httpServer = createServer(app);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  try {
    const frameResponse = await fetch(`${baseUrl}/workbench/api/frames`, { method: 'POST' });
    frozenFrameId = (await frameResponse.json()).frame.frameId;
    const streamResponse = await fetch(`${baseUrl}/workbench/api/recognition/manual/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frameId: frozenFrameId, pageContext: '消息页', mergeIntoDraft: true }),
    });
    const streamText = await streamResponse.text();
    assert.equal(modelCalls, 2);
    assert.match(streamText, /event: stage[\s\S]*正在重试 · 原因：/);
    const resultEvent = eventPayload(streamText, 'result');
    assert.equal(resultEvent.draft.elements.length, 2);
    assert.match(prompts[1], /header\.title/);
  } finally {
    await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    clearModelRuntime('manual');
  }
});
