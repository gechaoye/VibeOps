import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createEmptyDraft, mergeScoutIntoDraft } from './draft-model.mjs';
import { registerWorkbenchRoutes } from './workbench-routes.mjs';

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4ZkAAAAASUVORK5CYII=';

test('AI 初审路由保留人工状态并写入 Reviewer 结论', async () => {
  const previousModel = process.env.MIDSCENE_MODEL_NAME;
  process.env.MIDSCENE_MODEL_NAME = 'test-reviewer';
  const app = express();
  let draft = createEmptyDraft();
  const agent = {
    interface: {},
    async unfreezePageContext() {},
    async freezePageContext() {},
    async _snapshotContext() { return { screenshot: { base64: `data:image/png;base64,${PNG_1X1}`, capturedAt: Date.now() } }; },
    async aiQuery() {
      return {
        frameId: 'sha256:frame',
        page: { name: '消息', surfaceType: 'page', stateSummary: '消息页', scrollableRegions: [] },
        elements: [{
          candidateKey: 'reviewer.title', label: '消息', visualDescription: '顶部标题', controlType: 'label', interactive: false,
          enabled: true, state: null, approximateRegion: { x: 0.1, y: 0.05, width: 0.3, height: 0.05 }, geometryKind: 'boundary', geometryConfidence: 0.9,
          meaning: { status: 'known', description: '页面标题', evidence: { visibleTexts: ['消息'], visibleIcons: [], visibleStates: [], visualCues: [], userContext: null, unclassified: [] } },
          dynamicContent: false, riskSignals: [], confidence: 0.93,
        }],
        relationships: [], actionCandidates: [], comparison: { basisFrameId: null, status: 'not-requested', changes: [] }, uncertainties: [], done: true,
      };
    },
  };
  const store = {
    async saveFrame(frame) { return { frameId: frame.frameId, mimeType: frame.mimeType, extension: frame.extension, width: frame.width, height: frame.height, bytes: frame.buffer.length, capturedAt: frame.capturedAt }; },
    async loadFrame() { return { imagePath: '/tmp/frame.png', mimeType: 'image/png' }; },
    async loadDraft() { return structuredClone(draft); },
    async saveDraft(value) { draft = structuredClone(value); },
    async saveModelResult(id) { return path.join(process.cwd(), '.data', 'evidence', 'model-results', `${id}.json`); },
  };
  await registerWorkbenchRoutes({
    server: { app, agent, getSessionState: () => null }, store, graphWorkflow: {}, workbenchRoot: process.cwd(),
    spec: { version: 'test', schemaVersion: 'test', contentHash: 'test', index: 'test' },
  });
  const httpServer = createServer(app);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  try {
    const frameResponse = await fetch(`${baseUrl}/workbench/api/frames`, { method: 'POST' });
    const { frame } = await frameResponse.json();
    draft = mergeScoutIntoDraft(draft, {
      frameId: frame.frameId,
      page: { name: '消息', surfaceType: 'page', stateSummary: '消息页', scrollableRegions: [] },
      elements: [{
        candidateKey: 'header.title', label: '消息', visualDescription: '顶部标题', controlType: 'label', interactive: false,
        enabled: true, state: null, approximateRegion: { x: 0.1, y: 0.05, width: 0.3, height: 0.05 }, geometryKind: 'boundary',
        geometryConfidence: 0.9, meaning: { status: 'known', description: '页面标题', evidence: { visibleTexts: ['消息'], visibleIcons: [], visibleStates: [], visualCues: [], userContext: null, unclassified: [] } },
        dynamicContent: false, riskSignals: [], confidence: 0.9,
      }],
      relationships: [], actionCandidates: [], comparison: { basisFrameId: null, status: 'not-requested', changes: [] }, uncertainties: [],
    }, 'scout.json', 'test-scout');
    const response = await fetch(`${baseUrl}/workbench/api/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ frameId: frame.frameId }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(draft.elements.length, 1, 'Reviewer 不应直接覆盖 Scout 草稿');
    assert.equal(result.reviewerResult.elements[0].candidateKey, 'reviewer.title');
    assert.equal(result.reviewerModel, 'test-reviewer');
    const applyResponse = await fetch(`${baseUrl}/workbench/api/review/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        frameId: frame.frameId,
        reviewerResult: result.reviewerResult,
        selectedScoutKeys: [],
        selectedReviewerKeys: ['reviewer.title'],
        modelResultRef: result.modelResultRef,
      }),
    });
    assert.equal(applyResponse.status, 200);
    const applied = await applyResponse.json();
    assert.deepEqual(applied.draft.elements.map((element) => element.candidateKey), ['reviewer.title']);
  } finally {
    await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    if (previousModel === undefined) delete process.env.MIDSCENE_MODEL_NAME;
    else process.env.MIDSCENE_MODEL_NAME = previousModel;
  }
});
