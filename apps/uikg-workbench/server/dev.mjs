import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const workbenchRoot = path.resolve(path.dirname(scriptPath), '..');
const projectRoot = path.resolve(workbenchRoot, '../..');
const statePath = path.join(workbenchRoot, '.data', 'dev-processes.json');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const ports = [5800, 5173];

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function runCommand(command, args) {
  try {
    return await execFileAsync(command, args, { encoding: 'utf8' });
  } catch (error) {
    if (typeof error?.stdout === 'string') return { stdout: error.stdout, stderr: error.stderr || '' };
    throw error;
  }
}

export async function findListeningPids(port) {
  if (process.platform === 'win32') {
    const script = `(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique`;
    const { stdout } = await runCommand('powershell.exe', ['-NoProfile', '-Command', script]);
    return [...new Set(stdout.split(/\s+/).map(Number).filter(Number.isInteger))];
  }
  const { stdout } = await runCommand('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);
  return [...new Set(stdout.split('\n').filter((line) => /^p\d+$/.test(line)).map((line) => Number(line.slice(1))))];
}

async function processCwd(pid) {
  if (process.platform === 'linux') {
    try {
      const { stdout } = await runCommand('readlink', [`/proc/${pid}/cwd`]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await runCommand('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
      return stdout.split('\n').find((line) => line.startsWith('n'))?.slice(1) || null;
    } catch {
      return null;
    }
  }
  return null;
}

async function processInfo(pid) {
  if (process.platform === 'win32') return { parentPid: null, command: `PID ${pid}` };
  try {
    const [{ stdout: parent }, { stdout: command }] = await Promise.all([
      runCommand('ps', ['-p', String(pid), '-o', 'ppid=']),
      runCommand('ps', ['-p', String(pid), '-o', 'command=']),
    ]);
    return { parentPid: Number(parent.trim()) || null, command: command.trim() || `PID ${pid}` };
  } catch {
    return { parentPid: null, command: `PID ${pid}` };
  }
}

async function isProjectProcess(pid, root) {
  const cwd = await processCwd(pid);
  return Boolean(cwd && isPathInside(root, cwd));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function findDevLauncher(pid, root) {
  let current = pid;
  for (let depth = 0; depth < 10 && current > 1; depth += 1) {
    const [{ parentPid, command }, owned] = await Promise.all([processInfo(current), isProjectProcess(current, root)]);
    if (owned && /(?:^|[\\/])server[\\/]dev\.mjs(?:\s|$)/.test(command)) return current;
    if (!parentPid || parentPid === current) break;
    current = parentPid;
  }
  return null;
}

function signalPid(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function signalProcessGroup(pid, signal) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    signalPid(pid, signal);
  }
}

async function readState() {
  try {
    return JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    return null;
  }
}

async function removeState(instanceId = null) {
  if (instanceId) {
    const state = await readState();
    if (state?.instanceId !== instanceId) return;
  }
  await rm(statePath, { force: true });
}

async function stopTrackedProcesses(root) {
  const state = await readState();
  if (!state || path.resolve(state.projectRoot || '') !== root) return false;
  const launcherOwned = state.launcherPid && await isProjectProcess(state.launcherPid, root);
  if (launcherOwned && isAlive(state.launcherPid)) {
    signalPid(state.launcherPid, 'SIGTERM');
  } else {
    for (const pid of state.childPids || []) {
      if (isAlive(pid) && await isProjectProcess(pid, root)) signalProcessGroup(pid, 'SIGTERM');
    }
  }
  await removeState(state.instanceId);
  await delay(400);
  return true;
}

async function ownedListeners(targetPorts, root) {
  const entries = [];
  for (const port of targetPorts) {
    for (const pid of await findListeningPids(port)) {
      if (await isProjectProcess(pid, root)) entries.push({ port, pid });
    }
  }
  return entries;
}

export async function cleanupProjectListeners(targetPorts = ports, root = projectRoot) {
  const listeners = await ownedListeners(targetPorts, root);
  const targets = new Set();
  for (const { pid } of listeners) targets.add(await findDevLauncher(pid, root) || pid);
  for (const pid of targets) signalPid(pid, 'SIGTERM');

  const deadline = Date.now() + 2500;
  let remaining = listeners;
  while (remaining.length && Date.now() < deadline) {
    await delay(100);
    remaining = await ownedListeners(targetPorts, root);
  }
  for (const { pid } of remaining) signalPid(pid, 'SIGKILL');
  if (remaining.length) await delay(150);
  return listeners;
}

function probePort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export async function assertPortsAvailable(targetPorts = ports) {
  const occupied = [];
  for (const port of targetPorts) {
    if (await probePort(port)) continue;
    const pids = await findListeningPids(port);
    const descriptions = await Promise.all(pids.map(async (pid) => `${pid} (${(await processInfo(pid)).command})`));
    occupied.push(`${port}${descriptions.length ? `: ${descriptions.join(', ')}` : ''}`);
  }
  if (occupied.length) throw new Error(`Required development ports are occupied: ${occupied.join('; ')}`);
}

async function cleanupBeforeStart() {
  await stopTrackedProcesses(projectRoot);
  const cleaned = await cleanupProjectListeners(ports, projectRoot);
  for (const { port, pid } of cleaned) console.log(`[dev] Stopped stale project process ${pid} on port ${port}.`);
  await assertPortsAvailable(ports);
}

async function runStopCommand() {
  const stoppedTracked = await stopTrackedProcesses(projectRoot);
  const cleaned = await cleanupProjectListeners(ports, projectRoot);
  if (stoppedTracked || cleaned.length) {
    console.log('[dev] Stopped project development services.');
  } else {
    console.log('[dev] No project development services are running.');
  }
}

async function runDev() {
  await cleanupBeforeStart();
  await mkdir(path.dirname(statePath), { recursive: true });
  const detached = process.platform !== 'win32';
  const children = [
    spawn(pnpm, ['--filter', 'uikg-workbench', 'dev:server'], {
      cwd: projectRoot,
      detached,
      env: { ...process.env, WORKBENCH_PORT: '5800' },
      stdio: 'inherit',
    }),
    spawn(pnpm, ['--filter', 'uikg-workbench', 'dev:frontend'], {
      cwd: projectRoot,
      detached,
      stdio: 'inherit',
    }),
  ];
  const instanceId = `${process.pid}-${Date.now()}`;
  await writeFile(statePath, `${JSON.stringify({
    instanceId,
    projectRoot,
    launcherPid: process.pid,
    childPids: children.map((child) => child.pid).filter(Boolean),
    ports,
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');

  let stopping = false;
  const exits = children.map((child) => new Promise((resolve) => child.once('exit', resolve)));
  const shutdown = async (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    for (const child of children) if (child.pid && isAlive(child.pid)) signalProcessGroup(child.pid, 'SIGTERM');
    await Promise.race([Promise.allSettled(exits), delay(3000)]);
    for (const child of children) if (child.pid && isAlive(child.pid)) signalProcessGroup(child.pid, 'SIGKILL');
    await removeState(instanceId);
    process.exit(exitCode);
  };

  for (const child of children) {
    child.on('error', (error) => {
      console.error(error);
      void shutdown(1);
    });
    child.on('exit', (code, signal) => {
      if (!stopping) void shutdown(code ?? (signal ? 1 : 0));
    });
  }
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
}

async function main() {
  if (process.argv.includes('--stop')) await runStopCommand();
  else await runDev();
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
