import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workbenchRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(workbenchRoot, '../..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const children = [
  spawn(pnpm, ['--filter', 'uikg-workbench', 'dev:server'], { cwd: projectRoot, stdio: 'inherit' }),
  spawn(pnpm, ['--filter', 'uikg-workbench', 'dev:frontend'], { cwd: projectRoot, stdio: 'inherit' }),
];

let stopping = false;
function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill(signal);
}

for (const child of children) {
  child.on('error', (error) => {
    console.error(error);
    process.exitCode = 1;
    stop();
  });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    process.exitCode = code ?? (signal ? 1 : 0);
    stop();
  });
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
