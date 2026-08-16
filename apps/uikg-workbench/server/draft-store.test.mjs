import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DraftStore } from './draft-store.mjs';

test('成功和失败的模型会话都会持久化到历史', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vibeops-session-history-'));
  const store = new DraftStore(root);
  try {
    await store.initialize();
    await store.saveAnalysisSession({
      id: 'workerA-1', kind: 'worker_a', status: 'completed', frameId: 'frame-1', model: 'workerA',
      startedAt: '2026-08-15T01:00:00.000Z', updatedAt: '2026-08-15T01:01:00.000Z', reasoningContent: '', outputContent: '{}',
    });
    await store.saveAnalysisSession({
      id: 'review-1', kind: 'review', status: 'failed', frameId: 'frame-1', model: 'workerB',
      startedAt: '2026-08-15T01:02:00.000Z', updatedAt: '2026-08-15T01:03:00.000Z', errorMessage: '上游错误', reasoningContent: '检查画面', outputContent: '',
    });
    const sessions = await store.listAnalysisSessions();
    assert.deepEqual(sessions.map((session) => session.status), ['failed', 'completed']);
    assert.equal(sessions[0].errorMessage, '上游错误');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('页面图片上传任务和分片可跨 Store 实例续传', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vibeops-page-upload-store-'));
  try {
    const firstStore = new DraftStore(root);
    await firstStore.initialize();
    const task = {
      id: 'page-upload-test', sourceType: 'file', name: 'page.png', url: null, mimeType: 'image/png', totalBytes: 6,
      uploadedBytes: 0, status: 'uploading', errorReason: null, pageId: null, frameId: null,
      createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z',
    };
    await firstStore.savePageUploadTask(task);
    assert.equal(await firstStore.appendPageUploadChunk(task.id, 0, Buffer.from('abc')), 3);

    const resumedStore = new DraftStore(root);
    await resumedStore.initialize();
    const recovered = await resumedStore.loadPageUploadTask(task.id);
    assert.equal(recovered.status, 'failed');
    assert.match(recovered.errorReason, /断点继续/);
    assert.equal(await resumedStore.pageUploadPartSize(task.id), 3);
    assert.equal(await resumedStore.appendPageUploadChunk(task.id, 3, Buffer.from('def')), 6);
    assert.equal((await resumedStore.loadPageUploadBuffer(task.id)).toString(), 'abcdef');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
