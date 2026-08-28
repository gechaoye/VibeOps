import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { appendFrameToPage, createEmptyDraft, mergeRecognitionIntoDraft } from './draft-model.mjs';
import { DraftStore } from './draft-store.mjs';
import { registerWorkbenchRoutes } from './workbench-routes.mjs';

const workbenchRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function recognition(frameId, candidateKey, extraElements = []) {
  const evidence = { visibleTexts: ['提交'], visibleIcons: [], visibleStates: [], visualCues: ['顶部右侧文字按钮'], userContext: null, unclassified: [] };
  return {
    frameId,
    page: { name: '日志', surfaceType: 'page', stateSummary: '日报填写', scrollableRegions: [] },
    elements: [{
      candidateKey, label: '提交', visualDescription: '顶部右侧提交按钮', displayCondition: '', elementType: 'text-button', interactive: true, enabled: true, state: null,
      approximateRegion: { x: 0.786, y: 0.065, width: 0.089, height: 0.027 }, geometryKind: 'tap-target', geometryConfidence: 0.96,
      meaning: { status: 'known', description: '提交当前日报', evidence }, dynamicContent: false, abstraction: null, riskSignals: [], confidence: 0.96,
    }, ...extraElements],
    relationships: [],
    actionCandidates: [{ triggerCandidateKey: candidateKey, action: 'tap', expectedOutcome: '提交当前日报', basis: 'visible-affordance', riskSignals: [], confidence: 0.95 }],
    comparison: { basisFrameId: null, status: 'not-requested', changes: [] },
    uncertainties: [],
  };
}

test('增量预览与提交统一匹配键漂移元素，并将合并结果落盘', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vibeops-incremental-route-'));
  const store = new DraftStore(root);
  await store.initialize();
  const primaryFrameId = 'sha256:primary-frame';
  const auxiliaryFrameId = 'sha256:auxiliary-frame';
  const primary = mergeRecognitionIntoDraft(createEmptyDraft(), recognition(primaryFrameId, 'btn_submit'), 'primary.json');
  const draft = appendFrameToPage(primary, auxiliaryFrameId, { pageId: primary.currentPageId });
  await store.saveDraft(draft);

  const app = express();
  await registerWorkbenchRoutes({
    server: { app, agent: null, getSessionState: () => null },
    store,
    graphWorkflow: {},
    workbenchRoot,
    spec: { version: 'test', schemaVersion: 'test', contentHash: 'test', index: 'test' },
  });
  const httpServer = createServer(app);
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}/workbench/api`;
  const extraElement = {
    candidateKey: 'remark_tip', label: '备注提示', visualDescription: '备注区域提示', displayCondition: '', elementType: 'static-label', interactive: false, enabled: true, state: null,
    approximateRegion: { x: 0.1, y: 0.45, width: 0.4, height: 0.04 }, geometryKind: 'boundary', geometryConfidence: 0.9,
    meaning: { status: 'known', description: '备注提示', evidence: { visibleTexts: ['备注提示'], visibleIcons: [], visibleStates: [], visualCues: [], userContext: null, unclassified: [] } },
    dynamicContent: false, abstraction: null, riskSignals: [], confidence: 0.9,
  };
  const incremental = recognition(auxiliaryFrameId, 'submit_button', [extraElement]);
  const payload = { frameId: auxiliaryFrameId, pageId: draft.currentPageId, recognitionResult: incremental, modelResultRef: 'incremental.json', model: 'test-model' };

  try {
    const invalidIncremental = structuredClone(incremental);
    invalidIncremental.elements.at(-1).approximateRegion = { x: 0.9, y: 0.45, width: 0.2, height: 0.04 };
    const invalidPayload = { ...payload, recognitionResult: invalidIncremental };
    const invalidPreviewResponse = await fetch(`${baseUrl}/recognition/incremental-preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(invalidPayload),
    });
    assert.equal(invalidPreviewResponse.status, 422);
    const invalidPreview = await invalidPreviewResponse.json();
    assert.match(invalidPreview.error, /未执行增量合并/);
    assert.ok(invalidPreview.consistencyIssues.some((issue) => issue.includes('候选框超出截图边界')));

    const invalidAppendResponse = await fetch(`${baseUrl}/recognition/append`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(invalidPayload),
    });
    assert.equal(invalidAppendResponse.status, 422);
    assert.deepEqual((await store.loadDraft()).elements.map((element) => element.id), draft.elements.map((element) => element.id));

    const previewResponse = await fetch(`${baseUrl}/recognition/incremental-preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.candidates.find((candidate) => candidate.candidateKey === 'submit_button').disposition, 'duplicate');
    assert.equal(preview.candidates.find((candidate) => candidate.candidateKey === 'remark_tip').disposition, 'new');

    const appendResponse = await fetch(`${baseUrl}/recognition/append`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal(appendResponse.status, 200);
    const appended = await appendResponse.json();
    assert.equal(appended.draft.elements.some((element) => element.candidateKey === 'submit_button'), false);
    assert.equal(appended.draft.elements.some((element) => element.candidateKey === 'remark_tip'), true);
    const persisted = await store.loadDraft();
    assert.deepEqual(persisted.elements.map((element) => element.id), appended.draft.elements.map((element) => element.id));
    assert.equal(persisted.rawModelResultRef, 'incremental.json');
  } finally {
    await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
