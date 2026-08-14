import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createEmptyDraft } from './draft-model.mjs';
import { registerWorkbenchRoutes } from './workbench-routes.mjs';

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4ZkAAAAASUVORK5CYII=';

function scoutElement() {
  return {
    candidateKey: 'header.title',
    label: '消息',
    visualDescription: '顶部标题',
    controlType: 'label',
    interactive: false,
    enabled: true,
    state: null,
    approximateRegion: { x: 0.1, y: 0.05, width: 0.3, height: 0.05 },
    geometryKind: 'boundary',
    geometryConfidence: 0.9,
    meaning: {
      status: 'known',
      description: '页面标题',
      evidence: {
        visibleTexts: ['消息'],
        visibleIcons: [],
        visibleStates: [],
        visualCues: [],
        userContext: null,
        unclassified: [],
      },
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

test('Scout 自动续写失败后保留会话，并可通过断点接口继续', async () => {
  const previousScoutModel = process.env.MIDSCENE_SCOUT_MODEL_NAME;
  process.env.MIDSCENE_SCOUT_MODEL_NAME = 'test-scout-model';
  const app = express();
  let draft = createEmptyDraft();
  let frozenFrameId = null;
  let mode = 'pause';
  let modelCalls = 0;
  const agent = {
    interface: {},
    async unfreezePageContext() {},
    async freezePageContext() {},
    async _snapshotContext() {
      return { screenshot: { base64: `data:image/png;base64,${PNG_1X1}`, capturedAt: Date.now() } };
    },
    async aiScout(_prompt, options) {
      modelCalls += 1;
      options.onChunk({ content: '{}', reasoning_content: '', accumulated: '<data-json>{}</data-json>', isComplete: false });
      if (mode === 'pause') {
        if (modelCalls === 1) {
          return {
            frameId: frozenFrameId,
            page: { name: '消息', surfaceType: 'page', stateSummary: '消息页', scrollableRegions: [] },
            elements: [scoutElement()],
          };
        }
        return { elements: [], done: false };
      }
      return {
        elements: [],
        relationships: [],
        actionCandidates: [],
        comparison: { basisFrameId: null, status: 'not-requested', changes: [] },
        uncertainties: [],
        done: true,
      };
    },
  };
  const store = {
    async initialize() {},
    async saveFrame(frame) {
      return { frameId: frame.frameId, mimeType: frame.mimeType, extension: frame.extension, width: frame.width, height: frame.height, bytes: frame.buffer.length, capturedAt: frame.capturedAt };
    },
    async loadFrame() { return { imagePath: '/tmp/frame.png', mimeType: 'image/png' }; },
    async loadDraft() { return structuredClone(draft); },
    async saveDraft(value) { draft = structuredClone(value); },
    async saveModelResult(id) { return path.join(process.cwd(), '.data', 'evidence', 'model-results', `${id}.json`); },
  };
  const server = { app, agent, getSessionState: () => null };
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
    frozenFrameId = (await frameResponse.json()).frame.frameId;

    const firstResponse = await fetch(`${baseUrl}/workbench/api/scout/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frameId: frozenFrameId, pageContext: '消息页' }),
    });
    const errorEvent = eventPayload(await firstResponse.text(), 'error');
    assert.equal(modelCalls, 6, '首次调用后应自动续写 5 次');
    assert.equal(errorEvent.resumableSession.completedCandidates, 1);

    const savedSession = await fetch(`${baseUrl}/workbench/api/scout/session`).then((response) => response.json());
    assert.equal(savedSession.session.id, errorEvent.resumableSession.id);

    mode = 'complete';
    const resumeResponse = await fetch(`${baseUrl}/workbench/api/scout/resume/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: savedSession.session.id }),
    });
    const resultEvent = eventPayload(await resumeResponse.text(), 'result');
    assert.equal(resultEvent.draft.elements.length, 1);
    const clearedSession = await fetch(`${baseUrl}/workbench/api/scout/session`).then((response) => response.json());
    assert.equal(clearedSession.session, null);
  } finally {
    await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    if (previousScoutModel === undefined) delete process.env.MIDSCENE_SCOUT_MODEL_NAME;
    else process.env.MIDSCENE_SCOUT_MODEL_NAME = previousScoutModel;
  }
});
