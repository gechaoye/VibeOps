import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { DraftStore } from './draft-store.mjs';
import { registerWorkbenchRoutes } from './workbench-routes.mjs';

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4ZkAAAAASUVORK5CYII=', 'base64');
const workbenchRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('页面图片支持分片续传、链接失败重试及删除 Page 联动', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vibeops-page-upload-route-'));
  const store = new DraftStore(root);
  await store.initialize();
  let remoteShouldFail = true;
  const imageServer = createServer((request, response) => {
    if (remoteShouldFail) {
      response.writeHead(503).end('temporarily unavailable');
      return;
    }
    const start = Number(request.headers.range?.match(/^bytes=(\d+)-$/)?.[1] || 0);
    response.writeHead(start > 0 ? 206 : 200, {
      'content-type': 'image/png',
      'content-length': PNG_1X1.length - start,
      ...(start > 0 ? { 'content-range': `bytes ${start}-${PNG_1X1.length - 1}/${PNG_1X1.length}` } : {}),
    });
    response.end(PNG_1X1.subarray(start));
  });
  imageServer.listen(0, '127.0.0.1');
  await once(imageServer, 'listening');

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
  try {
    const tooMany = await fetch(`${baseUrl}/page-uploads`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: Array.from({ length: 21 }, (_, index) => ({ sourceType: 'file', name: `${index}.png`, mimeType: 'image/png', size: PNG_1X1.length })) }),
    });
    assert.equal(tooMany.status, 400);

    const created = await (await fetch(`${baseUrl}/page-uploads`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ sourceType: 'file', name: 'local.png', mimeType: 'image/png', size: PNG_1X1.length }] }),
    })).json();
    const localTask = created.tasks[0];
    const split = 25;
    const firstChunk = await (await fetch(`${baseUrl}/page-uploads/${localTask.id}/chunk`, {
      method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-upload-offset': '0' }, body: PNG_1X1.subarray(0, split),
    })).json();
    assert.equal(firstChunk.task.uploadedBytes, split);
    assert.equal(firstChunk.task.status, 'uploading');
    const resumed = await (await fetch(`${baseUrl}/page-uploads/${localTask.id}/chunk`, {
      method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-upload-offset': String(split) }, body: PNG_1X1.subarray(split),
    })).json();
    assert.equal(resumed.task.status, 'completed');
    assert.ok(resumed.task.pageId);
    assert.equal(resumed.draft.pages.length, 1);

    const remoteCreated = await (await fetch(`${baseUrl}/page-uploads`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ sourceType: 'url', name: 'remote.png', url: `http://127.0.0.1:${imageServer.address().port}/remote.png` }] }),
    })).json();
    const remoteTask = remoteCreated.tasks[0];
    const failed = await fetch(`${baseUrl}/page-uploads/${remoteTask.id}/process`, { method: 'POST' });
    assert.equal(failed.status, 502);
    assert.match((await store.loadPageUploadTask(remoteTask.id)).errorReason, /HTTP 503/);
    remoteShouldFail = false;
    const retried = await (await fetch(`${baseUrl}/page-uploads/${remoteTask.id}/process`, { method: 'POST' })).json();
    assert.equal(retried.task.status, 'completed');
    assert.equal(retried.draft.pages.length, 2);

    const deleted = await (await fetch(`${baseUrl}/page-uploads`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [localTask.id, remoteTask.id], deletePages: true }),
    })).json();
    assert.equal(deleted.deletedIds.length, 2);
    assert.equal(deleted.draft.pages.length, 0);
    assert.equal((await store.listPageUploadTasks()).length, 0);
  } finally {
    await Promise.all([
      new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve())),
      new Promise((resolve, reject) => imageServer.close((error) => error ? reject(error) : resolve())),
    ]);
    await rm(root, { recursive: true, force: true });
  }
});
