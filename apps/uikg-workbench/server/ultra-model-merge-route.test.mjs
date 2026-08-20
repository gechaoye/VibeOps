import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createEmptyDraft, mergeRecognitionIntoDraft } from './draft-model.mjs';
import { registerWorkbenchRoutes } from './workbench-routes.mjs';
import { clearModelRuntime, setModelRuntime } from './model-runtime.mjs';

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4ZkAAAAASUVORK5CYII=';

test('Ultra 双模型 合并路由按字段选择两份答卷', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'vibeops-ultra-model-merge-route-'));
  const imagePath = path.join(tempRoot, 'frame.png');
  await writeFile(imagePath, Buffer.from(PNG_1X1, 'base64'));
  const modelBResult = {
    frameId: '',
    page: { name: '消息', surfaceType: 'page', stateSummary: '消息页', scrollableRegions: [] },
    elements: [{
      candidateKey: 'ultra-b.title', label: '消息中心', visualDescription: '顶部标题', elementType: 'label', interactive: false,
      enabled: true, state: null, approximateRegion: { x: 0.1, y: 0.05, width: 0.3, height: 0.05 }, geometryKind: 'boundary', geometryConfidence: 0.9,
      meaning: { status: 'known', description: '页面标题', evidence: { visibleTexts: ['消息'], visibleIcons: [], visibleStates: [], visualCues: [], userContext: null, unclassified: [] } },
      dynamicContent: false, riskSignals: [], confidence: 0.93,
    }],
    relationships: [], actionCandidates: [], comparison: { basisFrameId: null, status: 'not-requested', changes: [] }, uncertainties: [],
  };
  const modelServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"reasoning_content":"重新查看截图"}}]}\n\n');
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(modelBResult) } }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  modelServer.listen(0, '127.0.0.1');
  await once(modelServer, 'listening');
  setModelRuntime('ultra_b', {
    baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`, apiKey: 'test-key', modelName: 'test-ultra-b',
    modelFamily: 'gpt-5', temperature: 0, reasoningEffort: 'medium',
  });
  const app = express();
  let draft = createEmptyDraft();
  const agent = {
    interface: {},
    async unfreezePageContext() {},
    async freezePageContext() {},
    async _snapshotContext() { return { screenshot: { base64: `data:image/png;base64,${PNG_1X1}`, capturedAt: Date.now() } }; },
  };
  const store = {
    async saveFrame(frame) { return { frameId: frame.frameId, mimeType: frame.mimeType, extension: frame.extension, width: frame.width, height: frame.height, bytes: frame.buffer.length, capturedAt: frame.capturedAt }; },
    async loadFrame() { return { imagePath, mimeType: 'image/png' }; },
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
    modelBResult.frameId = frame.frameId;
    draft = mergeRecognitionIntoDraft(draft, {
      frameId: frame.frameId,
      page: { name: '消息', surfaceType: 'page', stateSummary: '消息页', scrollableRegions: [] },
      elements: [{
        candidateKey: 'header.title', label: '消息', visualDescription: '顶部标题', elementType: 'label', interactive: false,
        enabled: true, state: null, approximateRegion: { x: 0.1, y: 0.05, width: 0.3, height: 0.05 }, geometryKind: 'boundary',
        geometryConfidence: 0.9, meaning: { status: 'known', description: '页面标题', evidence: { visibleTexts: ['消息'], visibleIcons: [], visibleStates: [], visualCues: [], userContext: null, unclassified: [] } },
        dynamicContent: false, riskSignals: [], confidence: 0.9,
      }],
      relationships: [], actionCandidates: [], comparison: { basisFrameId: null, status: 'not-requested', changes: [] }, uncertainties: [],
    }, 'modelA.json', 'test-ultra-a');
    const response = await fetch(`${baseUrl}/workbench/api/recognition/ultra_b/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ frameId: frame.frameId }),
    });
    assert.equal(response.status, 200);
    const streamBody = await response.text();
    const events = streamBody.trim().split(/\r?\n\r?\n/).map((block) => {
      const event = block.match(/^event:\s*(.+)$/m)?.[1];
      const data = JSON.parse(block.match(/^data:\s*(.+)$/m)?.[1] || '{}');
      return { event, data };
    });
    assert.equal(events.find((event) => event.event === 'chunk' && event.data.reasoningContent)?.data.reasoningContent, '重新查看截图', streamBody);
    const result = events.find((event) => event.event === 'result')?.data;
    assert.ok(result, 'Model B 流应返回最终结果');
    assert.equal(draft.elements.length, 1, 'Model B 不应直接覆盖 Model A 草稿');
    assert.equal(result.recognitionResult.elements[0].candidateKey, 'ultra-b.title');
    assert.equal(result.model, 'test-ultra-b');
    const modelAResult = {
      frameId: frame.frameId,
      page: { name: '消息', surfaceType: 'page', stateSummary: '消息页', scrollableRegions: [] },
      elements: [{ candidateKey: 'header.title', label: '消息', visualDescription: '顶部标题', elementType: 'label', interactive: false, enabled: true, state: null, approximateRegion: { x: 0.1, y: 0.05, width: 0.3, height: 0.05 }, geometryKind: 'boundary', geometryConfidence: 0.9, meaning: { status: 'known', description: '页面标题', evidence: { visibleTexts: ['消息'], visibleIcons: [], visibleStates: [], visualCues: [], userContext: null, unclassified: [] } }, dynamicContent: false, riskSignals: [], confidence: 0.9 }],
      relationships: [], actionCandidates: [], comparison: { basisFrameId: null, status: 'not-requested', changes: [] }, uncertainties: [],
    };
    const applyResponse = await fetch(`${baseUrl}/workbench/api/recognition/ultra/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        frameId: frame.frameId,
        modelAResult,
        modelBResult: result.recognitionResult,
        selections: [{
          candidateKey: 'header.title',
          modelACandidateKey: 'header.title',
          modelBCandidateKey: 'ultra-b.title',
          baseSource: 'modelA',
          fieldSources: { label: 'modelB' },
        }],
        modelResultRef: result.modelResultRef,
      }),
    });
    assert.equal(applyResponse.status, 200);
    const applied = await applyResponse.json();
    assert.deepEqual(applied.draft.elements.map((element) => element.candidateKey), ['header.title']);
    assert.equal(applied.draft.elements[0].label, '消息中心');

    const sameKey识别模型BResult = structuredClone(result.recognitionResult);
    sameKey识别模型BResult.elements[0].candidateKey = 'header.title';
    const independentApplyResponse = await fetch(`${baseUrl}/workbench/api/recognition/ultra/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        frameId: frame.frameId,
        modelAResult,
        modelBResult: sameKey识别模型BResult,
        selections: [
          { candidateKey: 'modelA:header.title', modelACandidateKey: 'header.title', baseSource: 'modelA', fieldSources: {} },
          { candidateKey: 'modelB:header.title', modelBCandidateKey: 'header.title', baseSource: 'modelB', fieldSources: {} },
        ],
        modelResultRef: result.modelResultRef,
      }),
    });
    assert.equal(independentApplyResponse.status, 200);
    const independentlyApplied = await independentApplyResponse.json();
    assert.deepEqual(independentlyApplied.draft.elements.map((element) => element.candidateKey), ['header.title', 'header.title.ultra_b']);
    assert.deepEqual(independentlyApplied.draft.elements.map((element) => element.label), ['消息', '消息中心']);

    const replacementResult = structuredClone(modelAResult);
    replacementResult.elements[0].candidateKey = 'header.title';
    replacementResult.elements[0].label = '新识别标题';
    draft.elementEditRecords.push({ elementId: draft.elements[0].id, kind: 'updated', fields: ['label'], editedAt: new Date().toISOString() });
    const replacementResponse = await fetch(`${baseUrl}/workbench/api/recognition/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        frameId: frame.frameId,
        pageId: independentlyApplied.draft.currentPageId,
        recognitionResult: replacementResult,
        modelResultRef: 'replacement-model.json',
        model: 'replacement-model',
      }),
    });
    assert.equal(replacementResponse.status, 200);
    const replacement = await replacementResponse.json();
    assert.deepEqual(replacement.draft.elements.map((element) => element.candidateKey), ['header.title']);
    assert.equal(replacement.draft.elements[0].label, '新识别标题');
    assert.equal(replacement.draft.rawModelResultRef, 'replacement-model.json');
  } finally {
    await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    modelServer.close();
    await rm(tempRoot, { recursive: true, force: true });
    clearModelRuntime('ultra_b');
  }
});
