import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  buildResultQueryPrompt,
  buildScreenQueryPrompt,
  cliMain,
  createOfflineFixtureRuntime,
  createRealRuntime,
  loadMidsceneEnvironment,
  resolveMidsceneRepo,
  runExploration,
  validateObservedControl,
  validateLocatedTarget,
  validatePlanPolicy,
} from './android_explorer.mjs';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const GRAPH_ROOT = path.dirname(TOOL_DIR);
const PLAN_PATH = path.join(
  GRAPH_ROOT,
  'plans',
  'zto-connect-fat.messages-heart-20260724.json',
);
const POLICY_PATH = path.join(
  GRAPH_ROOT,
  'policies',
  'zto-connect-fat.messages-heart-20260724.json',
);
const UIKG_PYTHON =
  process.env.UIKG_PYTHON ??
  '/Users/mohan/.codex/venvs/explore-app-ui-graph/bin/python';
const EVIDENCE_VALIDATOR =
  process.env.UIKG_EVIDENCE_VALIDATOR ??
  '/Users/mohan/.codex/skills/explore-app-ui-graph/scripts/validate_raw_evidence.py';

async function loadInputs() {
  const [plan, policy] = await Promise.all([
    fs.readFile(PLAN_PATH, 'utf8').then(JSON.parse),
    fs.readFile(POLICY_PATH, 'utf8').then(JSON.parse),
  ]);
  policy.capture.stabilityIntervalMs = 0;
  for (const state of Object.values(plan.states)) {
    state.inspection = {
      queryPrompt: 'Inventory every visible interactive control in the current viewport.',
      locateAllInteractiveControls: true,
      includeControlTypes: [
        'button',
        'icon_button',
        'list_entry',
        'toggle',
        'back',
        'close',
        'scroll_region',
      ],
      requireScrollCoverage: true,
    };
  }
  return {plan, policy};
}

function validateEvidence(outputDir, requireCompleted) {
  const args = [EVIDENCE_VALIDATOR, outputDir];
  if (requireCompleted) args.push('--require-completed');
  return spawnSync(UIKG_PYTHON, args, {encoding: 'utf8'});
}

test('compiled Midscene plan and policy are compatible', async () => {
  const {plan, policy} = await loadInputs();
  const result = validatePlanPolicy(plan, policy);
  assert.equal(result.status, 'compatible');
  assert.equal(result.executionFramework, 'midscene');
  assert.equal(result.actionCount, 2);
});

test('user-provided facts remain authoritative while the producer stays feature-agnostic', async () => {
  const {plan} = await loadInputs();
  assert.deepEqual(plan.semanticContext.knownFacts, [
    {
      subjectKey: 'messages.toolbar.heart',
      predicate: 'function_name',
      value: '特别关注',
      source: 'user',
    },
  ]);

  const targetStep = plan.steps.find((step) => step.target?.key === 'messages.toolbar.heart');
  const screenPrompt = buildScreenQueryPrompt(plan);
  const resultPrompt = buildResultQueryPrompt(plan, targetStep);
  assert.match(screenPrompt, /特别关注/);
  assert.match(resultPrompt, /特别关注/);
  assert.match(resultPrompt, /authoritative non-visual task context/i);

  const alternatePlan = structuredClone(plan);
  alternatePlan.semanticContext.knownFacts = [
    {
      subjectKey: 'settings.toolbar.star',
      predicate: 'function_name',
      value: '收藏',
      source: 'user',
    },
  ];
  const alternatePrompt = buildScreenQueryPrompt(alternatePlan);
  assert.match(alternatePrompt, /收藏/);
  assert.doesNotMatch(alternatePrompt, /特别关注|heart-shaped/);

  const producerSource = await fs.readFile(path.join(TOOL_DIR, 'android_explorer.mjs'), 'utf8');
  assert.doesNotMatch(producerSource, /特别关注|heart-shaped/);
  assert.doesNotMatch(producerSource, /\/Users\/mohan\//);
});

test('Midscene checkout resolves from explicit input, then MIDSCENE_REPO', () => {
  const env = {MIDSCENE_REPO: '/runtime/midscene'};
  assert.equal(resolveMidsceneRepo('/explicit/midscene', env), '/explicit/midscene');
  assert.equal(resolveMidsceneRepo(undefined, env), '/runtime/midscene');
  assert.throws(
    () => resolveMidsceneRepo(undefined, {}),
    (error) => error.code === 'MIDSCENE_REPO_REQUIRED' && error.stage === 'model_gate',
  );
});

test('Midscene repository .env is loaded without overriding inherited settings or exposing secrets', async (t) => {
  const midsceneRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'uikg-midscene-env-'));
  t.after(() => fs.rm(midsceneRepo, {recursive: true, force: true}));
  await fs.writeFile(
    path.join(midsceneRepo, '.env'),
    [
      'MIDSCENE_WORKER_A_MODEL_BASE_URL=https://fixture.invalid/v1',
      'MIDSCENE_WORKER_A_MODEL_API_KEY=fixture-secret-must-not-be-returned',
      'MIDSCENE_WORKER_A_MODEL_NAME=file-model',
      'MIDSCENE_WORKER_A_MODEL_FAMILY=gpt-5',
      'MIDSCENE_WORKER_A_MODEL_TIMEOUT=60000',
      'UNRELATED_VALUE=must-not-be-loaded',
      '',
    ].join('\n'),
    'utf8',
  );
  const env = {MIDSCENE_WORKER_A_MODEL_NAME: 'inherited-model'};
  const result = await loadMidsceneEnvironment({midsceneRepo, env});

  assert.deepEqual(result, {
    status: 'loaded',
    loadedKeyCount: 4,
    preservedKeyCount: 1,
    ignoredKeyCount: 1,
  });
  assert.equal(env.MIDSCENE_WORKER_A_MODEL_NAME, 'inherited-model');
  assert.equal(env.MIDSCENE_WORKER_A_MODEL_FAMILY, 'gpt-5');
  assert.equal(env.MIDSCENE_WORKER_A_MODEL_TIMEOUT, '60000');
  assert.equal(env.UNRELATED_VALUE, undefined);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|fixture\.invalid/);
});

test('incomplete auto-loaded model configuration fails before Midscene runtime import', async (t) => {
  const midsceneRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'uikg-midscene-env-incomplete-'));
  const keys = [
    'MIDSCENE_WORKER_A_MODEL_NAME',
    'MIDSCENE_WORKER_A_MODEL_FAMILY',
    'MIDSCENE_WORKER_A_MODEL_BASE_URL',
    'MIDSCENE_WORKER_A_MODEL_API_KEY',
    'MIDSCENE_WORKER_B_MODEL_NAME',
    'MIDSCENE_WORKER_B_MODEL_FAMILY',
    'MIDSCENE_WORKER_B_MODEL_BASE_URL',
    'MIDSCENE_WORKER_B_MODEL_API_KEY',
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  t.after(async () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(midsceneRepo, {recursive: true, force: true});
  });
  await fs.writeFile(
    path.join(midsceneRepo, '.env'),
    [
      'MIDSCENE_WORKER_A_MODEL_NAME=fixture-model-a',
      'MIDSCENE_WORKER_A_MODEL_FAMILY=gpt-5',
      'MIDSCENE_WORKER_A_MODEL_BASE_URL=https://fixture.invalid/v1',
      'MIDSCENE_WORKER_A_MODEL_API_KEY=fixture-key',
      'MIDSCENE_WORKER_B_MODEL_NAME=fixture-model-b',
      'MIDSCENE_WORKER_B_MODEL_FAMILY=gpt-5',
      '',
    ].join('\n'),
    'utf8',
  );

  await assert.rejects(
    createRealRuntime({serial: 'fixture-device', midsceneRepo}),
    (error) =>
      error.code === 'WORKER_MODEL_CONFIG_MISSING' &&
      error.stage === 'model_gate' &&
      /Base URL/.test(error.message),
  );
});

test('legacy OCR and prebound target geometry are rejected', async () => {
  const {plan, policy} = await loadInputs();
  const legacyGeometryPlan = structuredClone(plan);
  legacyGeometryPlan.steps[1].target.point = {
    x: 340,
    y: 2280,
    space: 'current_display_px',
  };
  assert.throws(
    () => validatePlanPolicy(legacyGeometryPlan, policy),
    (error) => error.code === 'PREBOUND_GEOMETRY_FORBIDDEN',
  );

  const legacyOcrPolicy = structuredClone(policy);
  legacyOcrPolicy.capture.ocr = {enabled: true, engine: 'legacy'};
  assert.throws(
    () => validatePlanPolicy(plan, legacyOcrPolicy),
    (error) => error.code === 'OBSOLETE_OCR_CONTRACT',
  );
});

test('CLI rejects duplicate JSON keys before contract validation', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'uikg-producer-json-'));
  t.after(() => fs.rm(parent, {recursive: true, force: true}));
  const source = await fs.readFile(PLAN_PATH, 'utf8');
  const duplicate = source.replace(
    '"recordType": "AppUiExplorationPlan",',
    '"recordType": "AppUiExplorationPlan",\n  "recordType": "AppUiExplorationPlan",',
  );
  const duplicatePath = path.join(parent, 'duplicate-plan.json');
  await fs.writeFile(duplicatePath, duplicate, 'utf8');
  await assert.rejects(
    cliMain([
      '--plan',
      duplicatePath,
      '--policy',
      POLICY_PATH,
      '--validate-only',
    ]),
    (error) => error.code === 'DUPLICATE_JSON_KEY',
  );
});

test('runtime locator outside its allowed region is denied', async () => {
  const {plan, policy} = await loadInputs();
  const step = plan.steps.find((candidate) => candidate.kind === 'tap');
  assert.throws(
    () =>
      validateLocatedTarget({
        locateResult: {
          rect: {left: 1100, top: 100, width: 20, height: 20},
          center: [1110, 110],
          dpr: 1,
        },
        logicalSize: plan.coordinateReference.currentDisplaySizePx,
        plan,
        policy,
        step,
      }),
    (error) => error.code === 'LOCATOR_OUTSIDE_ALLOWED_REGION',
  );
});

test('Midscene screenshot locator coordinates are not scaled by reported DPR', async () => {
  const {plan, policy} = await loadInputs();
  const step = plan.steps.find(
    (candidate) => candidate.target?.key === 'messages.toolbar.heart',
  );
  const result = validateLocatedTarget({
    locateResult: {
      rect: {left: 264, top: 581, width: 55, height: 51},
      center: [291, 606],
      dpr: 3.501519756838906,
    },
    logicalSize: {width: 329, height: 679},
    plan,
    policy,
    step,
  });

  assert.equal(result.source.space, 'midscene_screenshot_px');
  assert.deepEqual(result.source.logicalCoordinateSpace.size, {width: 329, height: 679});
  assert.ok(Math.abs(result.currentDisplay.center.x - 291) < 1e-9);
  assert.ok(Math.abs(result.currentDisplay.center.y - 606) < 1e-9);
  assert.ok(Math.abs(result.currentDisplay.rect.x - 264) < 1e-9);
  assert.ok(Math.abs(result.currentDisplay.rect.y - 581) < 1e-9);
  assert.equal(result.decision, 'allow');
});

test('inventory locators are geometry-checked without granting action permission', async () => {
  const {plan} = await loadInputs();
  const geometry = validateObservedControl({
    locateResult: {
      rect: {left: 264, top: 581, width: 55, height: 51},
      center: [291, 606],
      dpr: 3.5,
    },
    logicalSize: {width: 329, height: 679},
    plan,
  });
  assert.deepEqual(geometry.screenshot.rect, {x: 264, y: 581, width: 55, height: 51});
  assert.equal(Object.hasOwn(geometry, 'allowedRegionRef'), false);
  assert.equal(Object.hasOwn(geometry, 'decision'), false);
});

test('real runtime cannot bypass both physical-action confirmations', async (t) => {
  const {plan, policy} = await loadInputs();
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'uikg-producer-auth-'));
  t.after(() => fs.rm(parent, {recursive: true, force: true}));
  const outputDir = path.join(parent, 'evidence');
  const runtime = createOfflineFixtureRuntime({plan, policy});
  runtime.mode = 'recursive_feature_evidence_capture';

  await assert.rejects(
    runExploration({
      plan,
      policy,
      packageId: plan.packageId,
      outputDir,
      runtime,
      executionAuthorization: {
        physicalActionsAllowed: true,
        visualInspectionConfirmed: false,
        offlineFixture: false,
      },
    }),
    (error) => error.code === 'EXECUTION_AUTHORIZATION_INVALID',
  );
  assert.equal(runtime.stats.connects, 0);
  await assert.rejects(fs.access(outputDir), (error) => error.code === 'ENOENT');
});

test('offline fixture produces completed Raw Evidence without ADB or model I/O', async (t) => {
  const {plan, policy} = await loadInputs();
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'uikg-producer-test-'));
  t.after(() => fs.rm(parent, {recursive: true, force: true}));
  const outputDir = path.join(parent, 'evidence');
  const runtime = createOfflineFixtureRuntime({plan, policy});
  const result = await runExploration({
    plan,
    policy,
    packageId: plan.packageId,
    outputDir,
    runtime,
    executionAuthorization: {
      physicalActionsAllowed: false,
      visualInspectionConfirmed: false,
      offlineFixture: true,
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.frameCount, 3);
  assert.equal(result.actionCount, 2);
  assert.equal(runtime.stats.adbCalls, 0);
  assert.equal(runtime.stats.taps, 2);
  assert.equal(runtime.stats.locates, 4);
  assert.equal(runtime.stats.semanticContexts, 3);
  assert.equal(runtime.stats.stayAwakeEnabled, 1);
  assert.equal(runtime.stats.stayAwakeRestored, 1);
  const validation = validateEvidence(outputDir, true);
  assert.equal(
    validation.status,
    0,
    `${validation.stdout}\n${validation.stderr}`,
  );
});

test('unresolved Midscene assertion cannot produce a completed session', async (t) => {
  const {plan, policy} = await loadInputs();
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'uikg-producer-unresolved-'));
  t.after(() => fs.rm(parent, {recursive: true, force: true}));
  const outputDir = path.join(parent, 'evidence');
  const runtime = createOfflineFixtureRuntime({
    plan,
    policy,
    assertionUnknownAt: 1,
  });

  await assert.rejects(
    runExploration({
      plan,
      policy,
      packageId: plan.packageId,
      outputDir,
      runtime,
      executionAuthorization: {
        physicalActionsAllowed: false,
        visualInspectionConfirmed: false,
        offlineFixture: true,
      },
    }),
    (error) => error.code === 'STATE_SEMANTICS_UNRESOLVED',
  );

  const auditValidation = validateEvidence(outputDir, false);
  assert.equal(
    auditValidation.status,
    0,
    `${auditValidation.stdout}\n${auditValidation.stderr}`,
  );
  const completedValidation = validateEvidence(outputDir, true);
  assert.equal(completedValidation.status, 1);

  const manifest = JSON.parse(
    await fs.readFile(
      path.join(outputDir, 'raw-evidence', 'raw-evidence-manifest.json'),
      'utf8',
    ),
  );
  const session = JSON.parse(
    await fs.readFile(
      path.join(
        outputDir,
        'raw-evidence',
        'sessions',
        manifest.sessionRef,
        'raw-session.json',
      ),
      'utf8',
    ),
  );
  assert.equal(session.status, 'completed_with_unresolved_postconditions');
});

test('scroll steps use Midscene aiAct and retain locator evidence', async (t) => {
  const {plan, policy} = await loadInputs();
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'uikg-producer-scroll-'));
  t.after(() => fs.rm(parent, {recursive: true, force: true}));
  const outputDir = path.join(parent, 'evidence');
  const sourceState = plan.initialState;
  const targetState = 'fixture.scrolled';
  plan.states[targetState] = structuredClone(plan.states[sourceState]);
  plan.states[targetState].key = targetState;
  plan.states[targetState].label = 'Fixture scrolled';
  plan.states[sourceState].allowedActions = ['scroll_down'];
  plan.steps = [
    {id: 'capture-scroll-source', kind: 'capture', state: sourceState, depth: 0},
    {
      id: 'scroll-one-screen',
      kind: 'scroll',
      semanticAction: 'scroll_down',
      fromState: sourceState,
      toState: targetState,
      depth: 1,
      risk: 'safe',
      sideEffects: ['navigation_history'],
      waitMs: 0,
      direction: 'down',
      actionPrompt: 'Scroll down one screen inside the visible main content region.',
      target: {
        key: 'fixture.main-scroll-region',
        label: 'Main scroll region',
        scope: plan.steps[1].target.scope,
        locatorPrompt: plan.steps[1].target.locatorPrompt,
        allowedRegionRef: plan.steps[1].target.allowedRegionRef,
      },
      postcondition: {
        expectedForegroundPackage: plan.packageId,
        requiredScreenshotChange: true,
        semanticAssertions: ['The visible content is in the scrolled state.'],
      },
    },
  ];
  policy.maxActions = 1;
  const runtime = createOfflineFixtureRuntime({plan, policy});
  const result = await runExploration({
    plan,
    policy,
    packageId: plan.packageId,
    outputDir,
    runtime,
    executionAuthorization: {
      physicalActionsAllowed: false,
      visualInspectionConfirmed: false,
      offlineFixture: true,
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(runtime.stats.acts, 1);
  assert.equal(runtime.stats.taps, 0);
  const manifest = JSON.parse(
    await fs.readFile(path.join(outputDir, 'raw-evidence', 'raw-evidence-manifest.json'), 'utf8'),
  );
  assert.equal(Object.hasOwn(manifest, 'manifestVersion'), false);
});
