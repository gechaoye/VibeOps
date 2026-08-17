import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertPortsAvailable, cleanupProjectListeners, findListeningPids } from './dev.mjs';

const workbenchRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(workbenchRoot, '../..');
const canInspectListeners = process.platform !== 'win32' && !spawnSync('lsof', ['-h'], { stdio: 'ignore' }).error;

function startListener(cwd) {
  const script = `const net=require('node:net');const server=net.createServer();server.listen(0,'127.0.0.1',()=>process.send(server.address().port));`;
  const child = spawn(process.execPath, ['-e', script], { cwd, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  return new Promise((resolve, reject) => {
    child.once('message', (port) => resolve({ child, port }));
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Listener exited before startup (${code})`)));
  });
}

function stopListener(child) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already stopped */ }
  }
}

test('development cleanup only stops listeners owned by this project', { skip: !canInspectListeners }, async (context) => {
  const foreignRoot = await mkdtemp(path.join(tmpdir(), 'vibeops-foreign-'));
  const owned = await startListener(projectRoot);
  const foreign = await startListener(foreignRoot);
  context.after(async () => {
    stopListener(owned.child);
    stopListener(foreign.child);
    await rm(foreignRoot, { recursive: true, force: true });
  });

  assert.deepEqual(await findListeningPids(owned.port), [owned.child.pid]);
  const cleaned = await cleanupProjectListeners([owned.port, foreign.port], projectRoot);
  assert.deepEqual(cleaned, [{ port: owned.port, pid: owned.child.pid }]);
  assert.deepEqual(await findListeningPids(owned.port), []);
  assert.deepEqual(await findListeningPids(foreign.port), [foreign.child.pid]);
  await assert.rejects(() => assertPortsAvailable([foreign.port]), /Required development ports are occupied/);
});
