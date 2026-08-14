import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { DraftStore } from './draft-store.mjs';
import { GraphWorkflow } from './graph-workflow.mjs';
import { registerWorkbenchRoutes } from './workbench-routes.mjs';

const serverRoot = path.dirname(fileURLToPath(import.meta.url));
const workbenchRoot = path.dirname(serverRoot);
const projectRoot = path.resolve(workbenchRoot, '../..');
const graphRoot = path.join(projectRoot, 'knowledge_graph');
const modelEnvPath = process.env.VIBEOPS_ENV_FILE || path.join(projectRoot, '.env');
const distRoot = path.join(workbenchRoot, 'dist');
const dataRoot = process.env.UIKG_WORKBENCH_DATA_DIR || path.join(workbenchRoot, '.data');

dotenv.config({ path: modelEnvPath, override: true });

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) results.push(...await listFiles(root, target));
    else if (entry.isFile()) results.push(path.relative(root, target).split(path.sep).join('/'));
  }
  return results.sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
}

async function normativeSpecContract() {
  const specRoot = path.join(graphRoot, 'spec');
  const files = await listFiles(specRoot);
  const hash = createHash('sha256');
  for (const relativePath of files) {
    hash.update(Buffer.from(relativePath, 'utf8'));
    hash.update(Buffer.from([0]));
    hash.update(await readFile(path.join(specRoot, relativePath)));
    hash.update(Buffer.from([0]));
  }
  return {
    version: 'UIKG 3.0.1',
    schemaVersion: '3.0.0',
    contentHash: `sha256:${hash.digest('hex')}`,
    index: 'knowledge_graph/spec/README.md',
  };
}

async function main() {
  const [{ androidPlaygroundPlatform, ScrcpyServer }, { launchPreparedPlaygroundPlatform }] = await Promise.all([
    import('@midscene/android-playground'),
    import('@midscene/playground'),
  ]);
  const store = new DraftStore(dataRoot);
  await store.initialize();
  const spec = await normativeSpecContract();
  const graphWorkflow = new GraphWorkflow({ graphRoot, workbenchRoot, dataRoot, spec });
  await graphWorkflow.initialize();
  let scrcpyServer;
  const sessionDeviceSource = {
    async getDevices() {
      const deviceId = scrcpyServer?.currentDeviceId;
      return deviceId ? [{ id: deviceId, name: deviceId, status: 'device' }] : [];
    },
    subscribe() {
      return () => {};
    },
  };
  scrcpyServer = new ScrcpyServer({ deviceListSource: sessionDeviceSource });
  const prepared = await androidPlaygroundPlatform.prepare({
    staticDir: existsSync(distRoot) ? distRoot : undefined,
    scrcpyServer,
  });
  const targetCache = { value: null, expiresAt: 0, inFlight: null };
  const listTargets = prepared.sessionManager?.listTargets?.bind(prepared.sessionManager);
  if (listTargets && prepared.sessionManager) {
    prepared.sessionManager.listTargets = async () => {
      const now = Date.now();
      if (targetCache.value && now < targetCache.expiresAt) return targetCache.value;
      if (targetCache.inFlight) return targetCache.inFlight;
      targetCache.inFlight = listTargets()
        .then((targets) => {
          targetCache.value = targets;
          targetCache.expiresAt = Date.now() + 30_000;
          return targets;
        })
        .finally(() => {
          targetCache.inFlight = null;
        });
      return targetCache.inFlight;
    };
  }
  const preparedConfigure = prepared.launchOptions?.configureServer;
  const requestedPort = Number(process.env.WORKBENCH_PORT || prepared.launchOptions?.port || 5800);
  const result = await launchPreparedPlaygroundPlatform(prepared, {
    port: requestedPort,
    openBrowser: false,
    verbose: true,
    enableCors: true,
    staticPath: existsSync(distRoot) ? distRoot : prepared.launchOptions?.staticPath,
    configureServer: async (server) => {
      await preparedConfigure?.(server);
      server.app.use('/session/targets', (req, _res, next) => {
        if (req.query.refresh === '1') {
          targetCache.value = null;
          targetCache.expiresAt = 0;
        }
        next();
      });
      await registerWorkbenchRoutes({
        server,
        store,
        graphWorkflow,
        workbenchRoot,
        modelEnvPath,
        spec,
      });
    },
  });

  const url = `http://127.0.0.1:${result.port}`;
  console.log(`UIKG Workbench server: ${url}`);
  if (!existsSync(distRoot)) {
    console.log('Frontend dist is absent. Run `pnpm dev` in another terminal for http://127.0.0.1:5173');
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await result.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Failed to start UIKG Workbench:', error);
  process.exit(1);
});
