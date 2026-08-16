import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { GraphWorkflow } from './graph-workflow.mjs';

const workbenchRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const graphRoot = path.resolve(workbenchRoot, '../../knowledge_graph');

function version(stageId, createdAt) {
  return {
    stageId,
    appKey: 'zto.connect',
    draftRevision: 1,
    baseRootHash: 'sha256:base',
    createdAt,
    graphRevision: `graph-${stageId}`,
    diff: [],
    validation: { valid: true, errors: [], warnings: [], schemaChecks: 1, graphChecks: 1 },
    counts: { pages: 1, elements: 1, transitions: 0 },
    explorationId: null,
  };
}

test('Staging 版本支持列表、删除、归档且归档不可回退', async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'vibeops-staging-'));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const workflow = new GraphWorkflow({ graphRoot, workbenchRoot, dataRoot, spec: { version: 'test' }, pythonBinary: process.execPath });
  await workflow.initialize();

  const older = await workflow.saveStage(version('stage-1000-aaaa1111', '2026-01-01T00:00:00.000Z'));
  const newer = await workflow.saveStage(version('stage-2000-bbbb2222', '2026-01-02T00:00:00.000Z'));
  assert.equal(older.status, 'draft');
  assert.equal(older.operation, 'prepare');
  assert.deepEqual((await workflow.listStages()).map((item) => item.stageId), [newer.stageId, older.stageId]);

  await workflow.deleteStage(older.stageId);
  assert.deepEqual((await workflow.listStages()).map((item) => item.stageId), [newer.stageId]);

  const published = await workflow.saveStage({ ...newer, status: 'published', publishedAt: '2026-01-03T00:00:00.000Z' });
  await assert.rejects(() => workflow.deleteStage(published.stageId), /只有未发布版本可以删除/);
  const archived = await workflow.archiveStage(published.stageId);
  assert.equal(archived.status, 'archived');
  assert.ok(archived.archivedAt);
  await assert.rejects(() => workflow.rollback(archived.stageId), /已归档版本不能回退/);
  await assert.rejects(() => workflow.archiveStage(archived.stageId), /只有已发布版本可以归档/);
});
