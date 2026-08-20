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

function eventsFrom(streamText) {
  return streamText.trim().split(/\r?\n\r?\n/).map((block) => ({
    event: block.match(/^event:\s*(.+)$/m)?.[1],
    data: JSON.parse(block.match(/^data:\s*(.+)$/m)?.[1] || '{}'),
  }));
}

test('Model B 手动中断后从输出断点继续', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'vibeops-ultra-b-resume-'));
  const imagePath = path.join(tempRoot, 'frame.png');
  await writeFile(imagePath, Buffer.from(PNG_1X1, 'base64'));
  const result = {
    frameId: '',
    page: { name: '消息', surfaceType: 'page', stateSummary: '消息页', scrollableRegions: [] },
    elements: [{
      candidateKey: 'ultra-b.title', label: '消息', visualDescription: '顶部标题', elementType: 'label', interactive: false,
      enabled: true, state: null, approximateRegion: { x: 0.1, y: 0.05, width: 0.3, height: 0.05 }, geometryKind: 'boundary', geometryConfidence: 0.9,
      meaning: { status: 'known', description: '页面标题', evidence: { visibleTexts: ['消息'], visibleIcons: [], visibleStates: [], visualCues: [], userContext: null, unclassified: [] } },
      dynamicContent: false, riskSignals: [], confidence: 0.93,
    }],
    relationships: [], actionCandidates: [], comparison: { basisFrameId: null, status: 'not-requested', changes: [] }, uncertainties: [],
  };
  let prefix = '';
  const continuation = {
    frameId: '',
    elements: [],
    relationships: [],
    actionCandidates: [],
    comparison: { basisFrameId: null, status: 'not-requested', changes: [] },
    uncertainties: [],
    done: true,
  };
  let modelCalls = 0;
  const modelServer = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      modelCalls += 1;
      const payload = JSON.parse(body);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (modelCalls === 1) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '先检查截图' } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: prefix } }] })}\n\n`);
        return;
      }
      assert.equal(payload.messages.length, 2);
      assert.match(payload.messages[1].content[0].text, /ultra-b\.title/);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(continuation) } }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
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
    async saveModelResult(id) { return path.join(tempRoot, `${id}.json`); },
  };
  await registerWorkbenchRoutes({
    server: { app, agent, getSessionState: () => null }, store, graphWorkflow: {}, workbenchRoot: process.cwd(),
    spec: { version: 'test', schemaVersion: 'test', contentHash: 'test', index: 'test' },
  });
  const httpServer = createServer(app);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

  try {
    const frame = await (await fetch(`${baseUrl}/workbench/api/frames`, { method: 'POST' })).json();
    result.frameId = frame.frame.frameId;
    continuation.frameId = frame.frame.frameId;
    const serialized = JSON.stringify(result);
    const splitAt = serialized.indexOf(',"relationships"');
    prefix = serialized.slice(0, splitAt);
    draft = mergeRecognitionIntoDraft(draft, {
      frameId: frame.frame.frameId,
      page: { name: '消息', surfaceType: 'page', stateSummary: '消息页', scrollableRegions: [] },
      elements: [{
        candidateKey: 'ultra-a.title', label: '消息', visualDescription: '标题', elementType: 'label', interactive: false,
        enabled: true, state: null, approximateRegion: { x: 0.1, y: 0.05, width: 0.3, height: 0.05 }, geometryKind: 'boundary', geometryConfidence: 0.9,
        meaning: { status: 'known', description: '页面标题', evidence: { visibleTexts: ['消息'], visibleIcons: [], visibleStates: [], visualCues: [], userContext: null, unclassified: [] } },
        dynamicContent: false, riskSignals: [], confidence: 0.9,
      }],
      relationships: [], actionCandidates: [], comparison: { basisFrameId: null, status: 'not-requested', changes: [] }, uncertainties: [],
    }, 'modelA.json', 'test-ultra-a');

    const response = await fetch(`${baseUrl}/workbench/api/recognition/ultra_b/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ frameId: frame.frame.frameId }),
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let streamText = '';
    while (!streamText.includes('event: chunk')) {
      const { value, done } = await reader.read();
      if (done) break;
      streamText += decoder.decode(value, { stream: true });
    }
    const cancel = await fetch(`${baseUrl}/workbench/api/recognition/ultra_b/cancel`, { method: 'POST' });
    assert.deepEqual(await cancel.json(), { cancelled: true });
    while (true) {
      const { value, done } = await reader.read();
      streamText += decoder.decode(value || new Uint8Array(), { stream: !done });
      if (done) break;
    }
    const cancelled = eventsFrom(streamText).find((event) => event.event === 'cancelled');
    assert.ok(cancelled?.data.resumableSession, streamText);
    assert.equal(cancelled.data.resumableSession.outputContent, prefix);

    const resumed = await fetch(`${baseUrl}/workbench/api/recognition/ultra_b/resume/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: cancelled.data.resumableSession.id }),
    });
    const resumedEvents = eventsFrom(await resumed.text());
    const completed = resumedEvents.find((event) => event.event === 'result');
    assert.equal(completed.data.recognitionResult.elements[0].candidateKey, 'ultra-b.title');
    assert.equal(modelCalls, 2);
  } finally {
    await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    modelServer.closeAllConnections();
    await new Promise((resolve) => modelServer.close(resolve));
    await rm(tempRoot, { recursive: true, force: true });
    clearModelRuntime('ultra_b');
  }
});
