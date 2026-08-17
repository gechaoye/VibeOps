import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadCanonicalGraph } from './canonical-graph.mjs';

const serverRoot = path.dirname(fileURLToPath(import.meta.url));
const graphRoot = path.resolve(serverRoot, '../../../knowledge_graph');
const require = createRequire(import.meta.url);
const yaml = require(path.join(graphRoot, 'tools/vendor/js-yaml-4.1.1.js'));

test('projects the canonical graph for the workbench', async () => {
  const graph = await loadCanonicalGraph({ graphRoot, yaml, appKey: 'zto.connect' });
  assert.equal(graph.appKey, 'zto.connect');
  assert.ok(graph.revision);
  assert.ok(graph.pages.length > 0);
  assert.ok(graph.edges.some((edge) => edge.kind === 'transition'));
  assert.ok(graph.edges.some((edge) => edge.kind === 'authority_contract'));
  assert.ok(graph.pages.every((page) => Number.isInteger(page.elementCount)));
  assert.ok(graph.edges.every((edge) => edge.source && edge.target));
});

test('rejects app keys that can escape the canonical app root', async () => {
  await assert.rejects(
    loadCanonicalGraph({ graphRoot, yaml, appKey: '../zto.connect' }),
    /无效的 App Key/,
  );
});
