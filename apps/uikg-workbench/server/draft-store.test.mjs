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
      id: 'scout-1', kind: 'scout', status: 'completed', frameId: 'frame-1', model: 'scout',
      startedAt: '2026-08-15T01:00:00.000Z', updatedAt: '2026-08-15T01:01:00.000Z', reasoningContent: '', outputContent: '{}',
    });
    await store.saveAnalysisSession({
      id: 'review-1', kind: 'review', status: 'failed', frameId: 'frame-1', model: 'reviewer',
      startedAt: '2026-08-15T01:02:00.000Z', updatedAt: '2026-08-15T01:03:00.000Z', errorMessage: '上游错误', reasoningContent: '检查画面', outputContent: '',
    });
    const sessions = await store.listAnalysisSessions();
    assert.deepEqual(sessions.map((session) => session.status), ['failed', 'completed']);
    assert.equal(sessions[0].errorMessage, '上游错误');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
