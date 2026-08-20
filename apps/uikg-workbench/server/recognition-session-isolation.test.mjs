import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { beginFrameCapture, createEmptyDraft } from './draft-model.mjs';
import { clearModelRuntime, setModelRuntime } from './model-runtime.mjs';
import { registerWorkbenchRoutes } from './workbench-routes.mjs';

test('不同标签页的识别会话可并发运行并独立取消与查询断点', async () => {
  setModelRuntime('manual', {
    modelName: 'test-ultra-a', modelFamily: 'gpt-5', baseUrl: 'https://test.invalid/v1',
    apiKey: 'test', temperature: 0, reasoningEffort: 'medium',
  });
  const app = express();
  const draft = createEmptyDraft();
  const startedSessions = new Set();
  const server = {
    app,
    agent: null,
    getSessionState: () => null,
    async runRecognitionModel({ signal, prompt }) {
      const sessionName = prompt.includes('页面一') ? 'tab-one' : 'tab-two';
      startedSessions.add(sessionName);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  };
  const store = {
    async loadFrame() { return { frameId: 'sha256:test', imagePath: '/tmp/frame.png', mimeType: 'image/png' }; },
    async loadDraft() { return structuredClone(draft); },
    async saveDraft() {},
    async saveModelResult(id) { return path.join(process.cwd(), '.data', `${id}.json`); },
    async saveAnalysisSession() {},
    async listAnalysisSessions() { return []; },
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
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  const startRecognition = (workspaceSessionId, pageContext) => fetch(`${baseUrl}/workbench/api/recognition/manual/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ frameId: 'sha256:test', pageContext, workspaceSessionId }),
  });
  const cancelRecognition = (workspaceSessionId) => fetch(`${baseUrl}/workbench/api/recognition/manual/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceSessionId }),
  }).then((response) => response.json());

  try {
    const [firstResponse, secondResponse] = await Promise.all([
      startRecognition('tab-one', '页面一'),
      startRecognition('tab-two', '页面二'),
    ]);
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    while (startedSessions.size < 2) await new Promise((resolve) => setTimeout(resolve, 5));

    assert.deepEqual(await cancelRecognition('tab-one'), { cancelled: true });
    assert.deepEqual(await cancelRecognition('unknown-tab'), { cancelled: false });
    assert.deepEqual(await cancelRecognition('tab-two'), { cancelled: true });
    await Promise.all([firstResponse.text(), secondResponse.text()]);

    const firstSession = await (await fetch(`${baseUrl}/workbench/api/recognition/manual/session?workspaceSessionId=tab-one`)).json();
    const secondSession = await (await fetch(`${baseUrl}/workbench/api/recognition/manual/session?workspaceSessionId=tab-two`)).json();
    const unknownSession = await (await fetch(`${baseUrl}/workbench/api/recognition/manual/session?workspaceSessionId=unknown-tab`)).json();
    assert.ok(firstSession.session?.id);
    assert.ok(secondSession.session?.id);
    assert.notEqual(firstSession.session.id, secondSession.session.id);
    assert.equal(unknownSession.session, null);
  } finally {
    await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    clearModelRuntime('manual');
  }
});

test('不同页面标签页可基于同一 revision 独立保存', async () => {
  const app = express();
  let draft = beginFrameCapture(createEmptyDraft(), 'sha256:page-one', { forceNewPage: true });
  const firstPageId = draft.currentPageId;
  draft = beginFrameCapture(draft, 'sha256:page-two', { forceNewPage: true });
  const secondPageId = draft.currentPageId;
  const firstEdit = structuredClone(draft);
  const secondEdit = structuredClone(draft);
  firstEdit.pages.find((page) => page.id === firstPageId).name = '页面一已编辑';
  secondEdit.pages.find((page) => page.id === secondPageId).name = '页面二已编辑';

  const store = {
    async loadDraft() { return structuredClone(draft); },
    async saveDraft(value) { draft = structuredClone(value); },
    async listAnalysisSessions() { return []; },
  };
  await registerWorkbenchRoutes({
    server: { app, agent: null, getSessionState: () => null },
    store,
    graphWorkflow: {},
    workbenchRoot: process.cwd(),
    spec: { version: 'test', schemaVersion: 'test', contentHash: 'test', index: 'test' },
  });
  const httpServer = createServer(app);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  const savePage = (pageId, value) => fetch(`${baseUrl}/workbench/api/draft/pages/${encodeURIComponent(pageId)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });

  try {
    const [firstResponse, secondResponse] = await Promise.all([
      savePage(firstPageId, firstEdit),
      savePage(secondPageId, secondEdit),
    ]);
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(draft.pages.find((page) => page.id === firstPageId).name, '页面一已编辑');
    assert.equal(draft.pages.find((page) => page.id === secondPageId).name, '页面二已编辑');
    assert.equal(draft.revision, secondEdit.revision + 2);
  } finally {
    await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  }
});
