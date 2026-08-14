import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const QUERY_SCRIPT = resolve(SCRIPT_DIR, 'query_navigation_paths.mjs');

function runQuery(...args) {
  return spawnSync(process.execPath, [QUERY_SCRIPT, ...args], {
    encoding: 'utf8',
  });
}

test('computes a verified route on demand from canonical atomic transitions', () => {
  const result = runQuery(
    '--from', 'messages.root',
    '--to', 'messages.special_follow.settings',
    '--profile', 'shortest',
  );
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(result.stdout);
  assert.equal(document.routeMaterialization, 'on_demand');
  assert.match(document.graph.graphRevision, /^zto-connect-uikg3(?:01)?-/);
  assert.equal(document.path.actionCount, 2);
  assert.deepEqual(
    document.path.steps.map((step) => step.edgeKey),
    ['messages.open_special_follow', 'messages.special_follow.open_settings'],
  );
});

test('returns a zero-step route when source and destination are identical', () => {
  const result = runQuery(
    '--from', 'messages.special_follow',
    '--to', 'messages.special_follow',
    '--profile', 'low-risk',
  );
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(result.stdout);
  assert.equal(document.path.actionCount, 0);
  assert.equal(document.path.totalRoutingCost, 0);
});

test('does not promote unresolved shared-navigation records to executable edges', () => {
  const result = runQuery(
    '--from', 'workbench.root',
    '--to', 'messages.root',
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No verified route/);
  assert.match(result.stderr, /unreconciled shared-navigation records/);
});

test('rejects the retired common profile instead of applying compatibility behavior', () => {
  const result = runQuery(
    '--from', 'messages.root',
    '--to', 'messages.special_follow',
    '--profile', 'common',
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported routing profile: common/);
});
