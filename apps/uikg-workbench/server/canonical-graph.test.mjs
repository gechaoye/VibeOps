import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalFullPageAssetPath, loadCanonicalGraph } from './canonical-graph.mjs';

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
  assert.ok(graph.pages.some((page) => page.preview?.imageUrl));
  assert.ok(graph.edges.some((edge) => edge.preview?.element?.rect));
  const popupInterval = graph.edges.find((edge) => edge.key === 'messages.special_follow.settings.open_popup_interval_selector');
  assert.equal(popupInterval.preview.frameRef, 'sha256:d51601503327cc26f595d0cfdc149540e74780d1bf5bd14e6c3d94ee6c046329');
  assert.equal(popupInterval.preview.element.rect.top, 970);
});

test('rejects app keys that can escape the canonical app root', async () => {
  await assert.rejects(
    loadCanonicalGraph({ graphRoot, yaml, appKey: '../zto.connect' }),
    /无效的 App Key/,
  );
});

test('only resolves canonical full-page assets with safe identifiers', () => {
  assert.match(
    canonicalFullPageAssetPath({ graphRoot, appKey: 'zto.connect', frameRef: 'sha256:abc_123-def' }),
    /obsidian\/zto\.connect\/assets\/full-pages\/sha256:abc_123-def\.png$/,
  );
  assert.throws(() => canonicalFullPageAssetPath({ graphRoot, appKey: '../zto.connect', frameRef: 'abc' }), /无效的 App Key/);
  assert.throws(() => canonicalFullPageAssetPath({ graphRoot, appKey: 'zto.connect', frameRef: '../abc' }), /无效的 Frame Ref/);
});
