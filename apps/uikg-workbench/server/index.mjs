import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { DraftStore } from './draft-store.mjs';
import { GraphWorkflow } from './graph-workflow.mjs';
import { ModelSettingsStore } from './model-settings-store.mjs';
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
  const modelStore = new ModelSettingsStore(path.join(dataRoot, 'model-settings.sqlite'));
  await Promise.all([
    store.initialize(),
    modelStore.initialize(),
  ]);
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
    // Always provide a path: android-playground's ESM build falls back to
    // CommonJS-only `__dirname` when staticDir is undefined.
    staticDir: distRoot,
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
        modelStore,
        graphWorkflow,
        graphRoot,
        workbenchRoot,
        spec,
      });

      // Dev-only: when the built frontend is absent, the playground server has no
      // `dist/index.html` to serve and every HTML/asset request 500s. Forward those
      // requests to the Vite dev server (5173) so the preview renders regardless of
      // which port it targets. API routes are already handled above and skipped here.
      if (!existsSync(distRoot)) {
        const viteTarget = { host: '127.0.0.1', port: 5173 };
        server.app.use((req, res, next) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return next();
          if (req.path.startsWith('/workbench/api') || req.path.startsWith('/session')) return next();
          const proxyReq = http.request({
            host: viteTarget.host,
            port: viteTarget.port,
            method: req.method,
            path: req.originalUrl,
            headers: { ...req.headers, host: `${viteTarget.host}:${viteTarget.port}` },
          }, (proxyRes) => {
            res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
            proxyRes.pipe(res);
          });
          proxyReq.on('error', () => next());
          req.pipe(proxyReq);
        });
      }
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
    modelStore.close();
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
