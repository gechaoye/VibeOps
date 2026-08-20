#!/usr/bin/env node

/*
 * Midscene Android exploration-evidence producer.
 *
 * AndroidAgent is the only semantic and action layer. Direct ADB access is
 * restricted to read-only runtime context. This producer writes immutable Raw
 * Evidence and never materializes UIKG Runtime or Canonical entities.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {normalizeRecognitionOutput, validateRecognitionConsistency} from '../../apps/uikg-workbench/server/draft-model.mjs';
import {runRecognitionModel} from '../../apps/uikg-workbench/server/recognition-client.mjs';
import {buildRecognitionPrompt} from '../../apps/uikg-workbench/server/recognition-prompt.mjs';
import {ModelSettingsStore} from '../../apps/uikg-workbench/server/model-settings-store.mjs';
import {resolveTargetModelConfig} from '../../apps/uikg-workbench/server/model-settings.mjs';
import {setModelRuntime} from '../../apps/uikg-workbench/server/model-runtime.mjs';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EVIDENCE_SCHEMA_VERSION = '2.0.0';
const EVIDENCE_PRODUCER_ID = 'midscene-android-uikg-evidence-producer';
const LOCATE_CONCURRENCY = 4;
const RECOGNITION_SCHEMA = JSON.parse(
  await fs.readFile(new URL('../../apps/uikg-workbench/server/recognition-output.schema.json', import.meta.url), 'utf8'),
);
const SCREEN_QUERY_SHAPE =
  '{visiblePageTitle: string, visiblePrimaryContent: string[], visibleNavigationState: string, ' +
  'visibleControls: {candidateKey: string, label: string, elementType: string, visibleState: string, ' +
  'semanticRole: string, enabled: boolean, reversible: boolean | null, riskHint: string, ' +
  'functionDescription: string, locatorPrompt: string}[], ' +
  'scrollableRegions: {candidateKey: string, label: string, directions: string[], locatorPrompt: string}[], ' +
  'unresolvedVisualMeanings: string[]}';

const EVIDENCE_CONTRACT = Object.freeze({
  outputKind: 'raw_exploration_evidence',
  recordNamespace: 'uikg.raw-evidence',
  graphMaterialization: 'none',
  producesGraphEntities: false,
  semanticAndActionFramework: 'midscene.AndroidAgent',
  adbPolicy: 'read_only_runtime_context_plus_reversible_stay_awake',
  requiredDownstreamProcessing: [
    'evidence_fusion',
    'semantic_identity_resolution',
    'page_and_state_resolution',
    'graph_materialization',
  ],
});

const VALUE_OPTIONS = new Set([
  'serial',
  'package',
  'plan',
  'policy',
  'output',
  'midscene-repo',
  'adb',
]);
const FLAG_OPTIONS = new Set([
  'allow-physical-actions',
  'confirm-screen-visually-inspected',
  'offline-fixture',
  'validate-only',
  'help',
]);

export class ExplorerError extends Error {
  constructor(code, message, stage = 'execution') {
    super(message);
    this.name = 'ExplorerError';
    this.code = code;
    this.stage = stage;
  }
}

export class SemanticResolutionError extends ExplorerError {
  constructor(code, message, stage = 'semantic_recognition') {
    super(code, message, stage);
    this.name = 'SemanticResolutionError';
  }
}

export class PolicyViolationError extends ExplorerError {
  constructor(code, message, stage = 'policy') {
    super(code, message, stage);
    this.name = 'PolicyViolationError';
  }
}

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      throw new ExplorerError('CLI_ARGUMENT_INVALID', `Unexpected argument: ${token}`, 'cli');
    }
    const key = token.slice(2);
    if (!VALUE_OPTIONS.has(key) && !FLAG_OPTIONS.has(key)) {
      throw new ExplorerError('CLI_OPTION_UNKNOWN', `Unknown option: --${key}`, 'cli');
    }
    if (Object.hasOwn(args, key)) {
      throw new ExplorerError('CLI_OPTION_DUPLICATE', `Duplicate option: --${key}`, 'cli');
    }
    if (FLAG_OPTIONS.has(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new ExplorerError('CLI_VALUE_MISSING', `Option --${key} requires a value`, 'cli');
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function encodeTime(value, length) {
  let remaining = BigInt(value);
  let encoded = '';
  for (let index = 0; index < length; index += 1) {
    encoded = CROCKFORD[Number(remaining % 32n)] + encoded;
    remaining /= 32n;
  }
  return encoded;
}

function ulid() {
  const time = encodeTime(Date.now(), 10);
  const bytes = crypto.randomBytes(10);
  let randomness = 0n;
  for (const byte of bytes) randomness = (randomness << 8n) | BigInt(byte);
  return time + encodeTime(randomness, 16);
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function semanticContextInstruction(plan) {
  const knownFacts = plan.semanticContext?.knownFacts ?? [];
  if (knownFacts.length === 0) {
    return 'No authoritative business facts were supplied; report unsupported visual meanings as unresolved.';
  }
  return (
    `Authoritative non-visual task context: ${JSON.stringify(knownFacts)}. ` +
    'Use these facts as supplied context without re-inferring, disputing, or marking them unresolved; ' +
    'do not present them as facts derived from pixels.'
  );
}

export function buildScreenQueryPrompt(plan, stateKey = plan.initialState) {
  const inspection = plan.states?.[stateKey]?.inspection;
  const requestedTypes = inspection?.includeControlTypes ?? [];
  return (
    `${SCREEN_QUERY_SHAPE}. Inspect only the current visible viewport and describe visible facts. ` +
    'Return every visible interactive control as a separate visibleControls item, including unlabeled icons, ' +
    'back and close controls, toggles, settings, rows, tabs, fields, and disabled controls. ' +
    'candidateKey must be a concise stable ASCII semantic key; locatorPrompt must uniquely describe the same ' +
    'visible control for a subsequent Midscene aiLocate call. ' +
    `Requested element types: ${JSON.stringify(requestedTypes)}. ` +
    `${inspection?.queryPrompt ?? ''} ${semanticContextInstruction(plan)} ` +
    'Do not infer any additional icon function from shape alone; use semanticRole "unknown", riskHint "unknown", ' +
    'and unresolvedVisualMeanings when visible evidence and supplied facts do not establish meaning.'
  );
}

export function buildFrameRecognitionPrompt(plan, frameId) {
  return buildRecognitionPrompt(frameId, semanticContextInstruction(plan));
}

export function buildResultQueryPrompt(plan, step) {
  return (
    '{visibleResultTitle: string, visibleResultContent: string[], supportedFunctionDescription: string, ' +
    'evidenceBasis: string[], unresolvedMeaning: string}, based on the current visible screen and ' +
    `the immediately preceding activation of the control labelled ${JSON.stringify(step.target?.label ?? step.semanticAction)}, ` +
    'describe the resulting page, overlay, state, and visibly supported behavior. ' +
    `${semanticContextInstruction(plan)} Do not infer any additional meaning from icon shape alone.`
  );
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function withContentHash(record) {
  const body = {...record};
  delete body.contentHash;
  return {...body, contentHash: `sha256:${sha256(canonicalJson(body))}`};
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  const tasks = Array.from(
    {length: Math.min(Math.max(1, concurrency), values.length)},
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await mapper(values[index], index);
      }
    },
  );
  await Promise.all(tasks);
  return results;
}

function normalizedFieldName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function hasForbiddenTreeMarker(value) {
  const normalized = normalizedFieldName(value);
  return [
    'uitree',
    'poco',
    'viewhierarchy',
    'uihierarchy',
    'accessibilitytree',
    'uiautomatorhierarchy',
    'pagesource',
    'xpath',
  ].some((marker) => normalized.includes(marker));
}

function assertNoForbiddenPayload(value, label) {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new ExplorerError(
      'NONFINITE_JSON_NUMBER',
      `${label} contains a non-finite JSON number`,
      'contract_validation',
    );
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenPayload(item, `${label}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    const normalized = normalizedFieldName(key);
    const serialHash =
      normalized.includes('serial') &&
      !normalized.includes('serializ') &&
      normalized.endsWith('hash');
    const serialPolicy =
      ['serialpersistencepolicy', 'deviceserialpersistencepolicy'].includes(normalized) ||
      (normalized === 'serialrecordedseparately' && typeof item === 'boolean');
    const plainSerial =
      normalized.includes('serial') &&
      !normalized.includes('serializ') &&
      !serialHash &&
      !serialPolicy;
    if (plainSerial) {
      throw new ExplorerError(
        'FORBIDDEN_PLAINTEXT_SERIAL',
        `${label} contains forbidden plaintext serial field ${key}`,
        'contract_validation',
      );
    }
    if (serialHash && !/^sha256:[0-9a-f]{64}$/i.test(String(item))) {
      throw new ExplorerError(
        'INVALID_SERIAL_HASH',
        `${label}.${key} must be a sha256-prefixed digest`,
        'contract_validation',
      );
    }
    const persistenceFlag = ['persistuitree', 'persistpocotree'].includes(normalized);
    if (hasForbiddenTreeMarker(normalized) && !(persistenceFlag && item === false)) {
      throw new ExplorerError(
        'FORBIDDEN_TREE_PAYLOAD',
        `${label} contains forbidden UI-tree/Poco/XPath field ${key}`,
        'contract_validation',
      );
    }
    if (
      ['recordtype', 'entitytype', 'type'].includes(normalized) &&
      typeof item === 'string' &&
      hasForbiddenTreeMarker(item)
    ) {
      throw new ExplorerError(
        'FORBIDDEN_TREE_RECORD_TYPE',
        `${label}.${key} contains a forbidden UI-tree/Poco/XPath record type`,
        'contract_validation',
      );
    }
    if (normalized.includes('ocr') || (typeof item === 'string' && /paddleocr|tesseract/i.test(item))) {
      throw new ExplorerError(
        'OBSOLETE_OCR_CONTRACT',
        `${label}.${key} is obsolete; semantic recognition must use Midscene`,
        'contract_validation',
      );
    }
    if (/(apikey|authorization|password|secret|accesstoken|refreshtoken|authtoken)/i.test(normalized)) {
      throw new ExplorerError(
        'SECRET_FIELD_FORBIDDEN',
        `${label} contains forbidden secret-bearing field ${key}`,
        'contract_validation',
      );
    }
    assertNoForbiddenPayload(item, `${label}.${key}`);
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExplorerError('CONTRACT_OBJECT_REQUIRED', `${label} must be an object`, 'contract_validation');
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ExplorerError('CONTRACT_STRING_REQUIRED', `${label} must be a non-empty string`, 'contract_validation');
  }
  return value.trim();
}

function requireStringArray(value, label, {nonempty = false} = {}) {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) {
    throw new ExplorerError('CONTRACT_ARRAY_REQUIRED', `${label} must be ${nonempty ? 'a non-empty' : 'an'} array`, 'contract_validation');
  }
  value.forEach((item, index) => requireString(item, `${label}[${index}]`));
  return value;
}

function semanticContextContract(value, label) {
  const context = requireObject(value, label);
  for (const key of ['featureOrPage', 'userIntent', 'environment']) {
    requireString(context[key], `${label}.${key}`);
  }
  if (!Array.isArray(context.knownFacts)) {
    throw new ExplorerError('KNOWN_FACTS_INVALID', `${label}.knownFacts must be an array`, 'contract_validation');
  }
  const signatures = new Set();
  for (const [index, item] of context.knownFacts.entries()) {
    const fact = requireObject(item, `${label}.knownFacts[${index}]`);
    for (const key of ['subjectKey', 'predicate', 'value', 'source']) {
      requireString(fact[key], `${label}.knownFacts[${index}].${key}`);
    }
    if (Object.hasOwn(fact, 'sourceRef')) {
      requireString(fact.sourceRef, `${label}.knownFacts[${index}].sourceRef`);
    }
    const signature = canonicalJson(fact);
    if (signatures.has(signature)) {
      throw new ExplorerError('KNOWN_FACT_DUPLICATE', `${label}.knownFacts contains a duplicate`, 'contract_validation');
    }
    signatures.add(signature);
  }
  return context;
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new ExplorerError('CONTRACT_NUMBER_REQUIRED', `${label} must be a finite number`, 'contract_validation');
  }
  return number;
}

function positiveSize(value, label) {
  const size = requireObject(value, label);
  const width = finiteNumber(size.width, `${label}.width`);
  const height = finiteNumber(size.height, `${label}.height`);
  if (width <= 0 || height <= 0) {
    throw new ExplorerError('CONTRACT_SIZE_INVALID', `${label} dimensions must be positive`, 'contract_validation');
  }
  return {width, height};
}

function normalizedRect(value, label) {
  const rect = requireObject(value, label);
  const result = {
    x: finiteNumber(rect.x, `${label}.x`),
    y: finiteNumber(rect.y, `${label}.y`),
    width: finiteNumber(rect.width, `${label}.width`),
    height: finiteNumber(rect.height, `${label}.height`),
  };
  if (result.width <= 0 || result.height <= 0) {
    throw new ExplorerError('CONTRACT_RECT_INVALID', `${label} dimensions must be positive`, 'contract_validation');
  }
  return result;
}

function pointInRect(rect, point) {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  );
}

function rectWithin(inner, outer) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function matrixBetween(transforms, from, to) {
  const matches = (transforms ?? []).filter(
    (candidate) => candidate?.from === from && candidate?.to === to,
  );
  if (matches.length !== 1) {
    throw new ExplorerError(
      'COORDINATE_TRANSFORM_MISSING',
      `Expected exactly one ${from} -> ${to} transform`,
      'contract_validation',
    );
  }
  const matrix = matches[0].matrix3x3;
  if (!Array.isArray(matrix) || matrix.length !== 9 || matrix.some((item) => !Number.isFinite(Number(item)))) {
    throw new ExplorerError('COORDINATE_TRANSFORM_INVALID', `${from} -> ${to} transform is invalid`, 'contract_validation');
  }
  return matrix.map(Number);
}

function invertMatrix3x3(matrix) {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const determinant =
    a * (e * i - f * h) -
    b * (d * i - f * g) +
    c * (d * h - e * g);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    throw new ExplorerError(
      'COORDINATE_TRANSFORM_SINGULAR',
      'Coordinate transform cannot be inverted',
      'runtime_policy',
    );
  }
  return [
    (e * i - f * h) / determinant,
    (c * h - b * i) / determinant,
    (b * f - c * e) / determinant,
    (f * g - d * i) / determinant,
    (a * i - c * g) / determinant,
    (c * d - a * f) / determinant,
    (d * h - e * g) / determinant,
    (b * g - a * h) / determinant,
    (a * e - b * d) / determinant,
  ];
}

function transformPoint(matrix, point) {
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  if (denominator === 0) {
    throw new ExplorerError('COORDINATE_TRANSFORM_ZERO', 'Coordinate transform has a zero denominator', 'runtime_policy');
  }
  return {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator,
  };
}

function transformRect(matrix, rect) {
  const corners = [
    transformPoint(matrix, {x: rect.x, y: rect.y}),
    transformPoint(matrix, {x: rect.x + rect.width, y: rect.y}),
    transformPoint(matrix, {x: rect.x, y: rect.y + rect.height}),
    transformPoint(matrix, {x: rect.x + rect.width, y: rect.y + rect.height}),
  ];
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

function semanticContract(value, label) {
  const contract = requireObject(value, label);
  const expected = {
    provider: 'midscene',
    required: true,
    persistDecisionEvidence: true,
    failurePolicy: 'abort',
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (contract[key] !== expectedValue) {
      throw new ExplorerError(
        'SEMANTIC_CONTRACT_INVALID',
        `${label}.${key} must be ${JSON.stringify(expectedValue)}`,
        'contract_validation',
      );
    }
  }
  return contract;
}

function safePatternMatches(pattern, text) {
  try {
    return new RegExp(pattern, 'i').test(text);
  } catch {
    return text.toLowerCase().includes(String(pattern).toLowerCase());
  }
}

export function validatePlanPolicy(plan, policy) {
  assertNoForbiddenPayload(plan, 'plan');
  assertNoForbiddenPayload(policy, 'policy');
  if (plan.recordType !== 'AppUiExplorationPlan') {
    throw new ExplorerError('PLAN_TYPE_INVALID', 'plan.recordType must be AppUiExplorationPlan', 'contract_validation');
  }
  if (policy.recordType !== 'AppUiExplorationPolicy') {
    throw new ExplorerError('POLICY_TYPE_INVALID', 'policy.recordType must be AppUiExplorationPolicy', 'contract_validation');
  }
  for (const key of ['applicationKey', 'packageId', 'sourceScopeHash']) {
    if (plan[key] !== policy[key]) {
      throw new ExplorerError('PLAN_POLICY_MISMATCH', `Plan/policy mismatch for ${key}`, 'contract_validation');
    }
  }
  if (!/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(String(plan.packageId ?? ''))) {
    throw new ExplorerError('PACKAGE_ID_INVALID', 'plan.packageId is not a valid Android package ID', 'contract_validation');
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(String(plan.sourceScopeHash ?? ''))) {
    throw new ExplorerError('SCOPE_HASH_INVALID', 'sourceScopeHash must be a sha256 digest', 'contract_validation');
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(String(plan.deviceSerialHash ?? ''))) {
    throw new ExplorerError('DEVICE_HASH_INVALID', 'plan.deviceSerialHash must be a sha256 digest', 'contract_validation');
  }
  if (plan.executionFramework !== 'midscene' || policy.executionFramework !== 'midscene') {
    throw new ExplorerError('EXECUTION_FRAMEWORK_INVALID', 'Plan and policy executionFramework must be midscene', 'contract_validation');
  }
  const planSemantic = semanticContract(plan.semanticRecognition, 'plan.semanticRecognition');
  const policySemantic = semanticContract(policy.capture?.semanticRecognition, 'policy.capture.semanticRecognition');
  if (canonicalJson(planSemantic) !== canonicalJson(policySemantic)) {
      throw new ExplorerError('SEMANTIC_CONTRACT_MISMATCH', 'Plan/policy semantic recognition mismatch', 'contract_validation');
  }
  semanticContextContract(plan.semanticContext, 'plan.semanticContext');

  const gates = requireObject(policy.deviceGates, 'policy.deviceGates');
  for (const key of ['requireUnlocked', 'requireNoExternalOverlay', 'requireFreshVisualInspection']) {
    if (gates[key] !== true) {
      throw new ExplorerError('DEVICE_GATE_MISSING', `policy.deviceGates.${key} must be true`, 'contract_validation');
    }
  }

  const reference = requireObject(plan.coordinateReference, 'plan.coordinateReference');
  if (reference.space !== 'current_display_px') {
    throw new ExplorerError('COORDINATE_SPACE_INVALID', 'coordinateReference.space must be current_display_px', 'contract_validation');
  }
  for (const key of [
    'physicalSizeNaturalPx',
    'effectiveSizeNaturalPx',
    'currentDisplaySizePx',
    'orientedScreenSizePx',
    'screenshotSizePx',
  ]) {
    positiveSize(reference[key], `plan.coordinateReference.${key}`);
  }
  normalizedRect(reference.captureRectScreenPx, 'plan.coordinateReference.captureRectScreenPx');
  if (![0, 90, 180, 270].includes(reference.rotationDegrees)) {
    throw new ExplorerError('ROTATION_INVALID', 'coordinateReference.rotationDegrees is invalid', 'contract_validation');
  }
  matrixBetween(reference.transforms, 'current_display_px', 'screen_px');
  matrixBetween(reference.transforms, 'screen_px', 'screenshot_px');

  if (!Array.isArray(policy.allowedTapRegions) || policy.allowedTapRegions.length === 0) {
    throw new ExplorerError('TAP_REGIONS_MISSING', 'policy.allowedTapRegions must be non-empty', 'contract_validation');
  }
  const displaySize = positiveSize(reference.currentDisplaySizePx, 'current display');
  const displayRect = {x: 0, y: 0, ...displaySize};
  const regionMap = new Map();
  for (const [index, item] of policy.allowedTapRegions.entries()) {
    const region = requireObject(item, `policy.allowedTapRegions[${index}]`);
    const key = requireString(region.key, `policy.allowedTapRegions[${index}].key`);
    if (regionMap.has(key)) {
      throw new ExplorerError('TAP_REGION_DUPLICATE', `Duplicate allowed tap region: ${key}`, 'contract_validation');
    }
    if (region.space !== 'current_display_px') {
      throw new ExplorerError('TAP_REGION_SPACE_INVALID', `Allowed region ${key} must use current_display_px`, 'contract_validation');
    }
    const rect = normalizedRect(region.rect, `policy.allowedTapRegions[${index}].rect`);
    if (!rectWithin(rect, displayRect)) {
      throw new ExplorerError('TAP_REGION_OUTSIDE_DISPLAY', `Allowed region ${key} is outside current display`, 'contract_validation');
    }
    regionMap.set(key, {...region, rect});
  }
  if (canonicalJson(reference.allowedTapRegions ?? []) !== canonicalJson(policy.allowedTapRegions)) {
    throw new ExplorerError('TAP_REGION_MISMATCH', 'Plan coordinate regions do not match policy regions', 'contract_validation');
  }

  const states = requireObject(plan.states, 'plan.states');
  requireString(plan.initialState, 'plan.initialState');
  if (!states[plan.initialState]) {
    throw new ExplorerError('INITIAL_STATE_UNKNOWN', 'plan.initialState is not declared', 'contract_validation');
  }
  for (const [key, stateValue] of Object.entries(states)) {
    const state = requireObject(stateValue, `plan.states.${key}`);
    requireStringArray(state.requiredSemanticAssertions, `plan.states.${key}.requiredSemanticAssertions`, {nonempty: true});
    requireStringArray(state.allowedActions, `plan.states.${key}.allowedActions`);
    const inspection = requireObject(state.inspection, `plan.states.${key}.inspection`);
    requireString(inspection.queryPrompt, `plan.states.${key}.inspection.queryPrompt`);
    if (inspection.locateAllInteractiveControls !== true) {
      throw new ExplorerError(
        'CONTROL_INVENTORY_REQUIRED',
        `plan.states.${key}.inspection.locateAllInteractiveControls must be true`,
        'contract_validation',
      );
    }
    requireStringArray(
      inspection.includeControlTypes,
      `plan.states.${key}.inspection.includeControlTypes`,
      {nonempty: true},
    );
    if (typeof inspection.requireScrollCoverage !== 'boolean') {
      throw new ExplorerError(
        'SCROLL_COVERAGE_INVALID',
        `plan.states.${key}.inspection.requireScrollCoverage must be boolean`,
        'contract_validation',
      );
    }
    if (Object.hasOwn(state, 'requiredVisibleSignals')) {
      throw new ExplorerError('LEGACY_VISIBLE_SIGNALS', `plan.states.${key} contains requiredVisibleSignals`, 'contract_validation');
    }
  }

  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new ExplorerError('PLAN_STEPS_MISSING', 'plan.steps must be non-empty', 'contract_validation');
  }
  const maxActions = Number(policy.maxActions);
  if (!Number.isInteger(maxActions) || maxActions < 1) {
    throw new ExplorerError('ACTION_BUDGET_INVALID', 'policy.maxActions must be a positive integer', 'contract_validation');
  }
  const allowedRisks = new Set(policy.allowedRiskLevels ?? []);
  const allowedScopes = new Set(policy.allowedTargetScopes ?? []);
  const allowedEffects = new Set(policy.allowedSideEffects ?? []);
  const prohibitedEffects = new Set(policy.prohibitedSideEffects ?? []);
  const stopAt = new Set(policy.scope?.stopAt ?? []);
  const entryOnly = new Set(policy.entryOnly ?? []);
  let currentState = plan.initialState;
  let actionCount = 0;
  const stepIds = new Set();
  for (const [index, stepValue] of plan.steps.entries()) {
    const step = requireObject(stepValue, `plan.steps[${index}]`);
    const stepId = requireString(step.id, `plan.steps[${index}].id`);
    if (stepIds.has(stepId)) {
      throw new ExplorerError('STEP_ID_DUPLICATE', `Duplicate step id: ${stepId}`, 'contract_validation');
    }
    stepIds.add(stepId);
    if (step.kind === 'capture') {
      if (step.state !== currentState) {
        throw new ExplorerError('CAPTURE_STATE_MISMATCH', `Capture ${stepId} does not match ${currentState}`, 'contract_validation');
      }
      continue;
    }
    actionCount += 1;
    if (actionCount > maxActions) {
      throw new ExplorerError('ACTION_BUDGET_EXCEEDED', 'Plan exceeds policy action budget', 'contract_validation');
    }
    if (step.fromState !== currentState || !states[step.toState]) {
      throw new ExplorerError('STATE_TRANSITION_INVALID', `Step ${stepId} has an invalid state transition`, 'contract_validation');
    }
    if (stopAt.has(currentState)) {
      throw new ExplorerError('STOP_BOUNDARY_EXCEEDED', `Step ${stepId} continues beyond stopAt`, 'contract_validation');
    }
    if (!allowedRisks.has(step.risk)) {
      throw new ExplorerError('RISK_NOT_ALLOWED', `Step ${stepId} risk is not allowed`, 'contract_validation');
    }
    if (!states[currentState].allowedActions.includes(step.semanticAction)) {
      throw new ExplorerError('SEMANTIC_ACTION_NOT_ALLOWED', `Step ${stepId} semantic action is not allowed`, 'contract_validation');
    }
    for (const effect of step.sideEffects ?? []) {
      if (!allowedEffects.has(effect) || prohibitedEffects.has(effect)) {
        throw new ExplorerError('SIDE_EFFECT_NOT_ALLOWED', `Step ${stepId} side effect is not allowed`, 'contract_validation');
      }
    }
    const postcondition = requireObject(step.postcondition, `plan.steps[${index}].postcondition`);
    if (postcondition.expectedForegroundPackage !== plan.packageId) {
      throw new ExplorerError('POSTCONDITION_PACKAGE_INVALID', `Step ${stepId} may leave the target package`, 'contract_validation');
    }
    requireStringArray(postcondition.semanticAssertions, `plan.steps[${index}].postcondition.semanticAssertions`, {nonempty: true});
    if (Object.hasOwn(postcondition, 'requiredVisibleSignals')) {
      throw new ExplorerError('LEGACY_VISIBLE_SIGNALS', `Step ${stepId} contains requiredVisibleSignals`, 'contract_validation');
    }
    if (step.kind === 'tap' || step.kind === 'scroll') {
      const target = requireObject(step.target, `plan.steps[${index}].target`);
      requireString(target.locatorPrompt, `plan.steps[${index}].target.locatorPrompt`);
      if (!regionMap.has(target.allowedRegionRef)) {
        throw new ExplorerError('TAP_REGION_UNKNOWN', `Step ${stepId} references an unknown allowed region`, 'contract_validation');
      }
      if (!allowedScopes.has(target.scope)) {
        throw new ExplorerError('TARGET_SCOPE_NOT_ALLOWED', `Step ${stepId} target scope is not allowed`, 'contract_validation');
      }
      if (entryOnly.has(target.key) || entryOnly.has(target.label)) {
        throw new ExplorerError('ENTRY_ONLY_TARGET', `Step ${stepId} activates an entry-only target`, 'contract_validation');
      }
      for (const obsolete of ['point', 'referenceBBox', 'referencePointScreenshotPx']) {
        if (Object.hasOwn(target, obsolete)) {
          throw new ExplorerError('PREBOUND_GEOMETRY_FORBIDDEN', `Step ${stepId} target.${obsolete} is forbidden`, 'contract_validation');
        }
      }
      if (step.kind === 'scroll') {
        if (!['up', 'down', 'left', 'right'].includes(step.direction)) {
          throw new ExplorerError('SCROLL_DIRECTION_INVALID', `Step ${stepId} has an invalid scroll direction`, 'contract_validation');
        }
        requireString(step.actionPrompt, `plan.steps[${index}].actionPrompt`);
      }
    } else if (step.kind === 'start_activity') {
      const component = requireString(step.component, `plan.steps[${index}].component`);
      if (!component.startsWith(`${plan.packageId}/`)) {
        throw new ExplorerError('START_COMPONENT_INVALID', `Step ${stepId} component leaves the package`, 'contract_validation');
      }
    } else if (step.kind !== 'back') {
      throw new ExplorerError('STEP_KIND_UNSUPPORTED', `Unsupported step kind: ${step.kind}`, 'contract_validation');
    }
    currentState = step.toState;
  }

  const bootstrap = requireObject(plan.bootstrap, 'plan.bootstrap');
  if (bootstrap.component !== null && bootstrap.component !== undefined) {
    const component = requireString(bootstrap.component, 'plan.bootstrap.component');
    if (!component.startsWith(`${plan.packageId}/`)) {
      throw new ExplorerError('BOOTSTRAP_COMPONENT_INVALID', 'Bootstrap component leaves the package', 'contract_validation');
    }
  }
  if (typeof bootstrap.coldStart !== 'boolean' || typeof bootstrap.requireUserPreparedState !== 'boolean') {
    throw new ExplorerError('BOOTSTRAP_CONTRACT_INVALID', 'Bootstrap booleans are required', 'contract_validation');
  }

  return {
    status: 'compatible',
    executionFramework: 'midscene',
    semanticProvider: 'midscene',
    stepCount: plan.steps.length,
    actionCount,
    sourceScopeHash: plan.sourceScopeHash,
  };
}

function normalizeLocateResult(result) {
  const center = result?.center;
  const rect = result?.rect;
  if (!Array.isArray(center) || center.length !== 2) {
    throw new SemanticResolutionError('MIDSCENE_LOCATE_UNRESOLVED', 'Midscene aiLocate returned no center');
  }
  const normalizedCenter = {
    x: finiteNumber(center[0], 'aiLocate.center[0]'),
    y: finiteNumber(center[1], 'aiLocate.center[1]'),
  };
  if (!rect || typeof rect !== 'object') {
    throw new SemanticResolutionError('MIDSCENE_LOCATE_UNRESOLVED', 'Midscene aiLocate returned no rect');
  }
  const normalized = {
    x: finiteNumber(rect.left, 'aiLocate.rect.left'),
    y: finiteNumber(rect.top, 'aiLocate.rect.top'),
    width: finiteNumber(rect.width, 'aiLocate.rect.width'),
    height: finiteNumber(rect.height, 'aiLocate.rect.height'),
  };
  if (normalized.width <= 0 || normalized.height <= 0) {
    throw new SemanticResolutionError('MIDSCENE_LOCATE_INVALID', 'Midscene aiLocate returned a non-positive rect');
  }
  if (!pointInRect(normalized, normalizedCenter)) {
    throw new SemanticResolutionError('MIDSCENE_LOCATE_INVALID', 'Midscene aiLocate center is outside its rect');
  }
  return {center: normalizedCenter, rect: normalized, dpr: Number.isFinite(Number(result.dpr)) ? Number(result.dpr) : null};
}

export function validateObservedControl({locateResult, logicalSize, plan}) {
  const located = normalizeLocateResult(locateResult);
  const logical = positiveSize(logicalSize, 'Midscene logical coordinate space');
  const screenshotSize = positiveSize(
    plan.coordinateReference.screenshotSizePx,
    'Midscene screenshot coordinate space',
  );
  const screenshotBounds = {x: 0, y: 0, ...screenshotSize};
  if (
    !pointInRect(screenshotBounds, located.center) ||
    !rectWithin(located.rect, screenshotBounds)
  ) {
    throw new PolicyViolationError(
      'LOCATOR_OUTSIDE_SCREENSHOT',
      'Midscene locator is outside the screenshot',
      'runtime_locator_policy',
    );
  }

  // AndroidAgent aiLocate returns screenshot pixels. Its deprecated dpr only
  // describes the screenshot-to-device-logical ratio used internally by aiTap.
  const currentSize = positiveSize(plan.coordinateReference.currentDisplaySizePx, 'current display');
  const displayToScreen = matrixBetween(
    plan.coordinateReference.transforms,
    'current_display_px',
    'screen_px',
  );
  const screenToScreenshot = matrixBetween(
    plan.coordinateReference.transforms,
    'screen_px',
    'screenshot_px',
  );
  const screenshotToScreen = invertMatrix3x3(screenToScreenshot);
  const screenToDisplay = invertMatrix3x3(displayToScreen);
  const screenCenter = transformPoint(screenshotToScreen, located.center);
  const screenRect = transformRect(screenshotToScreen, located.rect);
  const currentCenter = transformPoint(screenToDisplay, screenCenter);
  const currentRect = transformRect(screenToDisplay, screenRect);
  const currentBounds = {x: 0, y: 0, ...currentSize};
  if (
    !pointInRect(currentBounds, currentCenter) ||
    !rectWithin(currentRect, currentBounds)
  ) {
    throw new PolicyViolationError(
      'LOCATOR_OUTSIDE_CURRENT_DISPLAY',
      'Midscene locator maps outside the current display',
      'runtime_locator_policy',
    );
  }
  return {
    source: {
      space: 'midscene_screenshot_px',
      size: screenshotSize,
      center: located.center,
      rect: located.rect,
      reportedDpr: located.dpr,
      logicalCoordinateSpace: {space: 'midscene_logical_px', size: logical},
    },
    currentDisplay: {space: 'current_display_px', size: currentSize, center: currentCenter, rect: currentRect},
    screen: {space: 'screen_px', center: screenCenter, rect: screenRect},
    screenshot: {
      space: 'screenshot_px',
      size: screenshotSize,
      center: located.center,
      rect: located.rect,
    },
  };
}

export function validateLocatedTarget({locateResult, logicalSize, plan, policy, step}) {
  const geometry = validateObservedControl({locateResult, logicalSize, plan});
  const region = (policy.allowedTapRegions ?? []).find(
    (candidate) => candidate.key === step.target?.allowedRegionRef,
  );
  if (!region || region.space !== 'current_display_px') {
    throw new PolicyViolationError('ALLOWED_REGION_MISSING', `Allowed region is missing: ${step.target?.allowedRegionRef}`, 'runtime_locator_policy');
  }
  const allowedRect = normalizedRect(region.rect, `allowed region ${region.key}`);
  if (
    !pointInRect(allowedRect, geometry.currentDisplay.center) ||
    !rectWithin(geometry.currentDisplay.rect, allowedRect)
  ) {
    throw new PolicyViolationError('LOCATOR_OUTSIDE_ALLOWED_REGION', `Midscene locator is outside allowed region ${region.key}`, 'runtime_locator_policy');
  }
  return {
    ...geometry,
    allowedRegionRef: region.key,
    allowedRegion: {space: region.space, rect: allowedRect},
    decision: 'allow',
  };
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString('hex', 0, 8) !== '89504e470d0a1a0a') {
    throw new ExplorerError('SCREENSHOT_NOT_PNG', 'Midscene returned a non-PNG screenshot', 'capture');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width <= 0 || height <= 0) {
    throw new ExplorerError('SCREENSHOT_DIMENSIONS_INVALID', 'Screenshot dimensions are invalid', 'capture');
  }
  return {width, height};
}

function screenshotBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value !== 'string') {
    throw new ExplorerError('SCREENSHOT_PAYLOAD_INVALID', 'Screenshot payload is not Buffer or base64', 'capture');
  }
  const comma = value.indexOf(',');
  return Buffer.from(comma >= 0 ? value.slice(comma + 1) : value, 'base64');
}

function sanitizeForEvidence(value, depth = 0) {
  if (depth > 8) return '[depth-limited]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > 4000 ? `${value.slice(0, 4000)}[truncated]` : value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeForEvidence(item, depth + 1));
  if (!value || typeof value !== 'object') return String(value);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(api.?key|authorization|cookie|credential|headers?|reasoning|secret|thought|token)/i.test(key)) continue;
    result[key] = sanitizeForEvidence(item, depth + 1);
  }
  return result;
}

async function writeJsonExclusive(filePath, value) {
  await fs.mkdir(path.dirname(filePath), {recursive: true});
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {encoding: 'utf8', flag: 'wx'});
}

async function writeJsonlExclusive(filePath, values) {
  await fs.mkdir(path.dirname(filePath), {recursive: true});
  const body = values.length ? `${values.map((value) => JSON.stringify(value)).join('\n')}\n` : '';
  await fs.writeFile(filePath, body, {encoding: 'utf8', flag: 'wx'});
}

function mediaTypeFor(filePath) {
  if (filePath.endsWith('.json')) return 'application/json';
  if (filePath.endsWith('.jsonl')) return 'application/x-ndjson';
  if (filePath.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

async function collectEntryFiles(rootDir, resourceDir) {
  const files = [];
  async function visit(currentDir) {
    const entries = await fs.readdir(currentDir, {withFileTypes: true});
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(currentDir, entry.name);
      if (absolute === resourceDir || entry.name === 'raw-evidence-manifest.json') continue;
      if (entry.isDirectory()) await visit(absolute);
      if (entry.isFile()) files.push(absolute);
    }
  }
  await visit(rootDir);
  return files;
}

function descriptorRootHash(entries, resources) {
  const lines = [];
  for (const entry of entries) lines.push(`entry:${entry.path}:${entry.sha256}\n`);
  for (const resource of resources) {
    lines.push(`resource:${resource.sha256}:${resource.byteLength}:${resource.mediaType}\n`);
  }
  return `sha256:${sha256(lines.sort().join(''))}`;
}

class RawEvidenceWriter {
  constructor(outputDir, sessionId, plan, policy, now = () => new Date().toISOString()) {
    this.outputDir = outputDir;
    this.sessionId = sessionId;
    this.plan = plan;
    this.policy = policy;
    this.now = now;
    this.evidenceRoot = path.join(outputDir, 'raw-evidence');
    this.sessionDir = path.join(this.evidenceRoot, 'sessions', sessionId);
    this.resourceDir = path.join(this.evidenceRoot, 'resources', 'sha256');
    this.frames = [];
    this.traces = [];
    this.observations = [];
    this.resources = new Map();
    this.finalized = false;
  }

  async initialize() {
    await fs.mkdir(this.sessionDir, {recursive: true});
    await fs.mkdir(this.resourceDir, {recursive: true});
    await writeJsonExclusive(
      path.join(this.evidenceRoot, 'producer-contract.json'),
      withContentHash({
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        artifactType: 'RawExplorationEvidenceProducerContract',
        producer: {id: EVIDENCE_PRODUCER_ID},
        ...EVIDENCE_CONTRACT,
      }),
    );
    await writeJsonExclusive(path.join(this.evidenceRoot, 'policies', 'exploration-policy.json'), this.policy);
    await writeJsonExclusive(path.join(this.sessionDir, 'raw-exploration-plan.json'), this.plan);
  }

  async addResource(data, mediaType, metadata = {}) {
    let buffer;
    if (Buffer.isBuffer(data)) {
      buffer = data;
    } else if (typeof data === 'string') {
      buffer = Buffer.from(data, 'utf8');
    } else {
      buffer = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
    }
    const digest = sha256(buffer);
    const extension = mediaType === 'image/png' ? '.png' : mediaType === 'application/json' ? '.json' : '.bin';
    const relative = path.posix.join(
      'raw-evidence',
      'resources',
      'sha256',
      digest.slice(0, 2),
      `${digest}${extension}`,
    );
    if (!this.resources.has(digest)) {
      const absolute = path.join(this.outputDir, ...relative.split('/'));
      await fs.mkdir(path.dirname(absolute), {recursive: true});
      await fs.writeFile(absolute, buffer, {flag: 'wx'});
      const descriptor = {
        id: `sha256:${digest}`,
        sha256: digest,
        byteLength: buffer.length,
        mediaType,
        uri: relative,
        dataClassification: metadata.dataClassification ?? 'confidential',
        redaction: metadata.redaction ?? {status: 'not_applied'},
        encryption: metadata.encryption ?? {status: 'none'},
        retentionClass: metadata.retentionClass ?? 'local_exploration_evidence',
        createdAt: this.now(),
        evidenceRole: metadata.evidenceRole ?? 'raw_input_to_downstream_materialization',
        metadata: sanitizeForEvidence(metadata.metadata ?? {}),
      };
      if (metadata.dimensions) descriptor.dimensions = metadata.dimensions;
      this.resources.set(digest, descriptor);
    }
    return `sha256:${digest}`;
  }

  async addInsight(record) {
    const insight = withContentHash({
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      recordType: 'RawMidsceneInsightResult',
      id: ulid(),
      sessionRef: this.sessionId,
      provider: 'midscene',
      reasoningPersisted: false,
      credentialMaterialPersisted: false,
      ...sanitizeForEvidence(record),
    });
    return this.addResource(insight, 'application/json', {
      evidenceRole: 'midscene_semantic_decision',
      metadata: {provider: 'midscene', operation: insight.operation, status: insight.status},
    });
  }

  async finalize(session) {
    if (this.finalized) throw new ExplorerError('EVIDENCE_ALREADY_FINALIZED', 'Raw Evidence writer is already finalized', 'finalize');
    this.finalized = true;
    const frames = this.frames.map(withContentHash);
    const traces = this.traces.map(withContentHash);
    const observations = this.observations.map(withContentHash);
    const finalizedSession = withContentHash(session);
    await writeJsonlExclusive(path.join(this.sessionDir, 'raw-frames.jsonl'), frames);
    await writeJsonlExclusive(path.join(this.sessionDir, 'raw-action-traces.jsonl'), traces);
    await writeJsonlExclusive(path.join(this.sessionDir, 'raw-observations.jsonl'), observations);
    await writeJsonExclusive(path.join(this.sessionDir, 'raw-session.json'), finalizedSession);

    const files = await collectEntryFiles(this.evidenceRoot, this.resourceDir);
    const entries = [];
    for (const filePath of files) {
      const data = await fs.readFile(filePath);
      entries.push({
        path: path.relative(this.outputDir, filePath).split(path.sep).join('/'),
        mediaType: mediaTypeFor(filePath),
        byteLength: data.length,
        sha256: sha256(data),
      });
    }
    entries.sort((left, right) => left.path.localeCompare(right.path));
    const resources = [...this.resources.values()].sort((left, right) => left.sha256.localeCompare(right.sha256));
    const manifest = withContentHash({
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      manifestType: 'RawExplorationEvidenceManifest',
      sessionRef: this.sessionId,
      createdAt: this.now(),
      createdBy: EVIDENCE_PRODUCER_ID,
      ...EVIDENCE_CONTRACT,
      rootHashAlgorithm: 'descriptor_lines_v1',
      entries,
      resources,
      rootHash: descriptorRootHash(entries, resources),
    });
    await writeJsonExclusive(path.join(this.evidenceRoot, 'raw-evidence-manifest.json'), manifest);
    return manifest;
  }
}

function recognitionStatus(statuses) {
  if (statuses.some((status) => status === 'fail')) return 'failed';
  if (statuses.some((status) => status === 'unknown')) return 'unresolved';
  return statuses.length ? 'complete' : 'not_attempted';
}

function attachRecognition(frame, operation, resourceRef, status) {
  frame.recognitionResults.push({
    kind: 'midscene_insight',
    provider: 'midscene',
    operation,
    status,
    resourceRef,
  });
  frame.resourceRefs.push(resourceRef);
  const statuses = frame.recognitionResults.map((item) => item.status);
  frame.recognitionStatus = recognitionStatus(statuses);
}

async function captureStableScreenshot(runtime, policy, expectedSize) {
  const sampleCount = Number(policy.capture?.stabilitySampleCount ?? 3);
  const intervalMs = Number(policy.capture?.stabilityIntervalMs ?? 500);
  const threshold = Number(policy.capture?.visualDistanceThreshold ?? 0.015);
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const buffer = screenshotBuffer(await runtime.screenshot());
    const dimensions = pngDimensions(buffer);
    if (dimensions.width !== expectedSize.width || dimensions.height !== expectedSize.height) {
      throw new ExplorerError(
        'SCREENSHOT_GEOMETRY_MISMATCH',
        `Screenshot is ${dimensions.width}x${dimensions.height}, expected ${expectedSize.width}x${expectedSize.height}`,
        'capture',
      );
    }
    samples.push({buffer, hash: sha256(buffer), vector: runtime.visualVector ? await runtime.visualVector(buffer) : null});
    if (index + 1 < sampleCount) await sleep(intervalMs);
  }
  let maxDistance = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index - 1].hash === samples[index].hash) continue;
    const left = samples[index - 1].vector;
    const right = samples[index].vector;
    if (!left || !right || left.length !== right.length) {
      maxDistance = null;
      break;
    }
    let total = 0;
    for (let offset = 0; offset < left.length; offset += 1) total += Math.abs(left[offset] - right[offset]);
    maxDistance = Math.max(maxDistance, total / left.length / 255);
  }
  return {
    buffer: samples.at(-1).buffer,
    dimensions: expectedSize,
    stability: {
      settled: maxDistance !== null && maxDistance <= threshold,
      sampleCount,
      intervalMs,
      visualDistance: maxDistance,
      threshold,
      sampleHashes: samples.map((sample) => `sha256:${sample.hash}`),
      comparison: samples.every((sample) => sample.hash === samples[0].hash)
        ? 'exact_sha256'
        : maxDistance === null
          ? 'unavailable_for_changed_frames'
          : 'downsampled_grayscale_distance',
    },
  };
}

function operationFailureStatus(error) {
  if (error?.name === 'AssertionError' || /^Assertion failed:/i.test(String(error?.message ?? ''))) return 'fail';
  return 'unknown';
}

async function invokeQuery({runtime, writer, frame, prompt, semanticContext = null}) {
  const startedAt = new Date().toISOString();
  const startedNs = process.hrtime.bigint();
  try {
    const result = await runtime.aiQuery(prompt, semanticContext);
    const endedNs = process.hrtime.bigint();
    const resourceRef = await writer.addInsight({
      frameRef: frame.id,
      sourceScreenshotRef: frame.screenshot.resourceRef,
      operation: 'aiQuery',
      prompt,
      status: 'pass',
      result: sanitizeForEvidence(result),
      model: runtime.modelSummary,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Number(endedNs - startedNs) / 1_000_000,
      captureCoupling: semanticContext ? 'frozen_frame' : 'sequential_non_atomic',
    });
    attachRecognition(frame, 'aiQuery', resourceRef, 'pass');
    return {status: 'pass', resourceRef, result};
  } catch (error) {
    const endedNs = process.hrtime.bigint();
    const resourceRef = await writer.addInsight({
      frameRef: frame.id,
      sourceScreenshotRef: frame.screenshot.resourceRef,
      operation: 'aiQuery',
      prompt,
      status: 'unknown',
      result: null,
      failure: {code: 'MIDSCENE_QUERY_UNRESOLVED', category: error?.name ?? 'Error'},
      model: runtime.modelSummary,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Number(endedNs - startedNs) / 1_000_000,
      captureCoupling: semanticContext ? 'frozen_frame' : 'sequential_non_atomic',
    });
    attachRecognition(frame, 'aiQuery', resourceRef, 'unknown');
    return {status: 'unknown', resourceRef, result: null};
  }
}

function validateRecognitionInventory(value, expectedFrameId) {
  const {recognitionResult, normalizationIssues} = normalizeRecognitionOutput(value);
  if (recognitionResult.frameId !== expectedFrameId) {
    throw new SemanticResolutionError(
      'RECOGNITION_FRAME_ID_MISMATCH',
      'Auto 页面识别结果未绑定当前冻结帧',
    );
  }
  const consistencyIssues = validateRecognitionConsistency(recognitionResult);
  if (consistencyIssues.some((issue) => issue.startsWith('候选键重复'))) {
    throw new SemanticResolutionError('RECOGNITION_RESULT_INVALID', 'Auto 页面识别结果包含重复候选键');
  }
  return {recognitionResult, normalizationIssues, consistencyIssues};
}

async function invokeRecognition({runtime, writer, frame, prompt, imageBuffer}) {
  const startedAt = new Date().toISOString();
  const startedNs = process.hrtime.bigint();
  let rawResult = null;
  try {
    rawResult = await runtime.runRecognition({prompt, imageBuffer});
    const validated = validateRecognitionInventory(rawResult, frame.id);
    const endedNs = process.hrtime.bigint();
    const resourceRef = await writer.addInsight({
      frameRef: frame.id,
      sourceScreenshotRef: frame.screenshot.resourceRef,
      operation: 'auto_recognition',
      prompt,
      status: 'pass',
      result: sanitizeForEvidence(validated),
      model: runtime.modelSummary.auto,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Number(endedNs - startedNs) / 1_000_000,
      captureCoupling: 'frozen_frame',
    });
    attachRecognition(frame, 'auto_recognition', resourceRef, 'pass');
    return {status: 'pass', resourceRef, result: validated.recognitionResult, ...validated};
  } catch (error) {
    const endedNs = process.hrtime.bigint();
    const resourceRef = await writer.addInsight({
      frameRef: frame.id,
      sourceScreenshotRef: frame.screenshot.resourceRef,
      operation: 'auto_recognition',
      prompt,
      status: 'unknown',
      result: rawResult === null ? null : sanitizeForEvidence(rawResult),
      failure: {code: error?.code ?? 'RECOGNITION_RESULT_UNRESOLVED', category: error?.name ?? 'Error'},
      model: runtime.modelSummary.auto,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Number(endedNs - startedNs) / 1_000_000,
      captureCoupling: 'frozen_frame',
    });
    attachRecognition(frame, 'auto_recognition', resourceRef, 'unknown');
    return {status: 'unknown', resourceRef, result: null};
  }
}

async function invokeAssert({runtime, writer, frame, prompt, purpose, semanticContext = null}) {
  const startedAt = new Date().toISOString();
  const startedNs = process.hrtime.bigint();
  try {
    await runtime.aiAssert(prompt, semanticContext);
    const endedNs = process.hrtime.bigint();
    const resourceRef = await writer.addInsight({
      frameRef: frame.id,
      sourceScreenshotRef: frame.screenshot.resourceRef,
      operation: 'aiAssert',
      purpose,
      prompt,
      status: 'pass',
      result: {pass: true},
      model: runtime.modelSummary,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Number(endedNs - startedNs) / 1_000_000,
      captureCoupling: semanticContext ? 'frozen_frame' : 'sequential_non_atomic',
    });
    attachRecognition(frame, 'aiAssert', resourceRef, 'pass');
    return {status: 'pass', resourceRef};
  } catch (error) {
    const status = operationFailureStatus(error);
    const endedNs = process.hrtime.bigint();
    const resourceRef = await writer.addInsight({
      frameRef: frame.id,
      sourceScreenshotRef: frame.screenshot.resourceRef,
      operation: 'aiAssert',
      purpose,
      prompt,
      status,
      result: {pass: false},
      failure: {code: status === 'fail' ? 'SEMANTIC_ASSERTION_FALSE' : 'MIDSCENE_ASSERT_UNRESOLVED', category: error?.name ?? 'Error'},
      model: runtime.modelSummary,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Number(endedNs - startedNs) / 1_000_000,
      captureCoupling: semanticContext ? 'frozen_frame' : 'sequential_non_atomic',
    });
    attachRecognition(frame, 'aiAssert', resourceRef, status);
    return {status, resourceRef};
  }
}

async function invokeLocate({runtime, writer, frame, prompt, semanticContext = null}) {
  const startedAt = new Date().toISOString();
  const startedNs = process.hrtime.bigint();
  try {
    const result = await runtime.aiLocate(prompt, semanticContext);
    const normalized = normalizeLocateResult(result);
    const endedNs = process.hrtime.bigint();
    const resourceRef = await writer.addInsight({
      frameRef: frame.id,
      sourceScreenshotRef: frame.screenshot.resourceRef,
      operation: 'aiLocate',
      prompt,
      status: 'pass',
      result: normalized,
      model: runtime.modelSummary,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Number(endedNs - startedNs) / 1_000_000,
      cacheable: semanticContext ? false : true,
      captureCoupling: semanticContext ? 'frozen_frame' : 'sequential_non_atomic',
    });
    attachRecognition(frame, 'aiLocate', resourceRef, 'pass');
    return {status: 'pass', resourceRef, result};
  } catch (error) {
    const endedNs = process.hrtime.bigint();
    const resourceRef = await writer.addInsight({
      frameRef: frame.id,
      sourceScreenshotRef: frame.screenshot.resourceRef,
      operation: 'aiLocate',
      prompt,
      status: 'unknown',
      result: null,
      failure: {code: 'MIDSCENE_LOCATE_UNRESOLVED', category: error?.name ?? 'Error'},
      model: runtime.modelSummary,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Number(endedNs - startedNs) / 1_000_000,
      cacheable: semanticContext ? false : true,
      captureCoupling: semanticContext ? 'frozen_frame' : 'sequential_non_atomic',
    });
    attachRecognition(frame, 'aiLocate', resourceRef, 'unknown');
    return {status: 'unknown', resourceRef, result: null};
  }
}

function normalizeControlCandidate(value, index) {
  const control = requireObject(value, `visibleControls[${index}]`);
  const candidateKey = requireString(control.candidateKey, `visibleControls[${index}].candidateKey`);
  if (!/^[A-Za-z0-9_.-]+$/.test(candidateKey)) {
    throw new SemanticResolutionError(
      'CONTROL_CANDIDATE_KEY_INVALID',
      `visibleControls[${index}].candidateKey must use stable ASCII key characters`,
    );
  }
  const riskHint = String(control.riskHint ?? 'unknown').toLowerCase();
  return {
    candidateKey,
    label: requireString(control.label, `visibleControls[${index}].label`),
    elementType: requireString(control.elementType, `visibleControls[${index}].elementType`),
    visibleState: requireString(control.visibleState ?? 'default', `visibleControls[${index}].visibleState`),
    semanticRole: requireString(control.semanticRole ?? 'unknown', `visibleControls[${index}].semanticRole`),
    enabled: typeof control.enabled === 'boolean' ? control.enabled : null,
    reversible: typeof control.reversible === 'boolean' ? control.reversible : null,
    riskHint: ['safe', 'low', 'medium', 'high', 'critical', 'unknown'].includes(riskHint)
      ? riskHint
      : 'unknown',
    functionDescription: String(control.functionDescription ?? '').trim(),
    locatorPrompt: requireString(control.locatorPrompt, `visibleControls[${index}].locatorPrompt`),
    directions: Array.isArray(control.directions)
      ? control.directions.filter((item) => typeof item === 'string')
      : [],
  };
}

function normalizeControlInventory(result, state) {
  const inventory = requireObject(result, 'Midscene screen inventory');
  if (!Array.isArray(inventory.visibleControls)) {
    throw new SemanticResolutionError(
      'CONTROL_INVENTORY_INVALID',
      'Midscene screen inventory must return visibleControls as an array',
    );
  }
  if (!Array.isArray(inventory.scrollableRegions)) {
    throw new SemanticResolutionError(
      'SCROLL_INVENTORY_INVALID',
      'Midscene screen inventory must return scrollableRegions as an array',
    );
  }
  const candidates = inventory.visibleControls.map(normalizeControlCandidate);
  if (state.inspection?.requireScrollCoverage) {
    for (const [index, region] of inventory.scrollableRegions.entries()) {
      const value = requireObject(region, `scrollableRegions[${index}]`);
      candidates.push(
        normalizeControlCandidate(
          {
            ...value,
            elementType: 'scroll_region',
            visibleState: Array.isArray(value.directions)
              ? `directions:${value.directions.join(',')}`
              : 'scrollable',
            semanticRole: 'navigation',
            enabled: true,
            reversible: true,
            riskHint: 'safe',
            functionDescription: value.functionDescription ?? '可滚动查看当前页面的其他内容。',
            directions: value.directions,
          },
          candidates.length,
        ),
      );
    }
  }
  const seen = new Set();
  for (const control of candidates) {
    if (seen.has(control.candidateKey)) {
      throw new SemanticResolutionError(
        'CONTROL_CANDIDATE_DUPLICATE',
        `Midscene returned duplicate control candidate ${control.candidateKey}`,
      );
    }
    seen.add(control.candidateKey);
  }
  return {
    controls: candidates,
    pageSummary: {
      visiblePageTitle: inventory.visiblePageTitle ?? null,
      visiblePrimaryContent: inventory.visiblePrimaryContent ?? [],
      visibleNavigationState: inventory.visibleNavigationState ?? null,
      unresolvedVisualMeanings: inventory.unresolvedVisualMeanings ?? [],
      scrollableRegionCount: inventory.scrollableRegions.length,
    },
  };
}

function controlActionability(control, policy) {
  const targetText = `${control.candidateKey} ${control.label}`;
  if (control.enabled === false) return 'disabled';
  if (control.riskHint === 'unknown' || control.semanticRole === 'unknown') return 'unresolved';
  if ((policy.forbiddenTargetPatterns ?? []).some((pattern) => safePatternMatches(pattern, targetText))) {
    return 'skipped_policy';
  }
  return (policy.allowedRiskLevels ?? []).includes(control.riskHint)
    ? 'eligible_for_safe_exploration'
    : 'skipped_risk';
}

async function inspectVisibleControls({
  runtime,
  writer,
  frame,
  plan,
  policy,
  stateKey,
  queryResult,
  semanticContext = null,
}) {
  if (queryResult.status !== 'pass') {
    return {status: 'unknown', visibleControls: [], unresolvedControls: [], pageSummary: null};
  }
  let normalized;
  try {
    normalized = normalizeControlInventory(queryResult.result, plan.states[stateKey]);
  } catch (error) {
    return {
      status: 'unknown',
      visibleControls: [],
      unresolvedControls: [{candidateKey: null, reason: error.code ?? 'CONTROL_INVENTORY_INVALID'}],
      pageSummary: null,
    };
  }
  const logicalSize = await runtime.logicalSize();
  const visibleControls = [];
  const unresolvedControls = [];
  const locateResults = await mapWithConcurrency(
    normalized.controls,
    LOCATE_CONCURRENCY,
    (control) =>
      invokeLocate({
        runtime,
        writer,
        frame,
        prompt: control.locatorPrompt,
        semanticContext,
      }),
  );
  for (const [index, control] of normalized.controls.entries()) {
    const locate = locateResults[index];
    if (locate.status !== 'pass') {
      unresolvedControls.push({
        candidateKey: control.candidateKey,
        label: control.label,
        locatorPrompt: control.locatorPrompt,
        locatorEvidenceRef: locate.resourceRef,
        reason: 'MIDSCENE_LOCATE_UNRESOLVED',
      });
      continue;
    }
    try {
      const geometry = validateObservedControl({locateResult: locate.result, logicalSize, plan});
      visibleControls.push({
        ...control,
        actionability: controlActionability(control, policy),
        geometry: {
          bbox: {...geometry.screenshot.rect, space: 'screenshot_px'},
          centerPoint: geometry.screenshot.center,
          coordinateSpace: 'screenshot_px',
        },
        locator: {
          status: 'pass',
          evidenceRef: locate.resourceRef,
          screenshot: geometry.screenshot,
          currentDisplay: geometry.currentDisplay,
        },
        locatorEvidenceRef: locate.resourceRef,
      });
    } catch (error) {
      unresolvedControls.push({
        candidateKey: control.candidateKey,
        label: control.label,
        locatorPrompt: control.locatorPrompt,
        locatorEvidenceRef: locate.resourceRef,
        reason: error.code ?? 'CONTROL_GEOMETRY_INVALID',
      });
    }
  }
  return {
    status: unresolvedControls.length ? 'unknown' : 'pass',
    visibleControls,
    unresolvedControls,
    pageSummary: normalized.pageSummary,
  };
}

async function invokeAgentAction({runtime, writer, frame, operation, prompt = null, argument = null, locatorRef = null}) {
  const startedAt = new Date().toISOString();
  const startedNs = process.hrtime.bigint();
  try {
    if (operation === 'aiTap') await runtime.aiTap(prompt);
    else if (operation === 'aiAct') await runtime.aiAct(prompt);
    else if (operation === 'back') await runtime.back();
    else if (operation === 'launch') await runtime.launch(argument);
    else throw new ExplorerError('AGENT_ACTION_UNSUPPORTED', `Unsupported AndroidAgent action: ${operation}`);
    const endedNs = process.hrtime.bigint();
    const resourceRef = await writer.addInsight({
      frameRef: frame.id,
      sourceScreenshotRef: frame.screenshot.resourceRef,
      operation,
      prompt,
      argument,
      status: 'pass',
      result: {executedBy: 'midscene.AndroidAgent'},
      locatorEvidenceRef: locatorRef,
      model: runtime.modelSummary,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Number(endedNs - startedNs) / 1_000_000,
      cacheable: ['aiTap', 'aiAct'].includes(operation) ? true : null,
    });
    return {status: 'pass', resourceRef};
  } catch (error) {
    const endedNs = process.hrtime.bigint();
    const resourceRef = await writer.addInsight({
      frameRef: frame.id,
      sourceScreenshotRef: frame.screenshot.resourceRef,
      operation,
      prompt,
      argument,
      status: 'unknown',
      result: null,
      locatorEvidenceRef: locatorRef,
      failure: {code: 'MIDSCENE_ACTION_UNRESOLVED', category: error?.name ?? 'Error'},
      model: runtime.modelSummary,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Number(endedNs - startedNs) / 1_000_000,
      cacheable: ['aiTap', 'aiAct'].includes(operation) ? true : null,
    });
    return {status: 'unknown', resourceRef};
  }
}

function runtimeContextInScope(context, packageId) {
  return (
    context?.power?.wakefulness === 'Awake' &&
    context?.trust?.deviceLocked === false &&
    context?.window?.keyguardShowing === false &&
    context?.activeApplication?.packageId === packageId &&
    context?.window?.focusedPackageId === packageId
  );
}

async function assertRuntimeStillReady(runtime, packageId, operation) {
  const context = await runtime.readContext();
  if (!runtimeContextInScope(context, packageId)) {
    throw new ExplorerError(
      'DEVICE_BECAME_UNREADY',
      `Device became asleep, locked, obscured, or left the target app during ${operation}`,
      'device_gate',
    );
  }
  return context;
}

function buildAutoControlInventory(recognitionResult) {
  if (recognitionResult.status !== 'pass') {
    return {status: 'unknown', result: null};
  }
  const visibleControls = [];
  const unresolvedVisualMeanings = [];
  for (const element of recognitionResult.result.elements) {
    if (!element.interactive) continue;
    visibleControls.push({
      candidateKey: element.candidateKey,
      label: element.label || element.candidateKey,
      elementType: element.elementType,
      visibleState: element.state || 'default',
      semanticRole: element.meaning?.status === 'known' ? 'known' : 'unknown',
      enabled: element.enabled,
      reversible: null,
      riskHint: element.riskSignals?.length ? 'unknown' : 'safe',
      functionDescription: element.meaning?.description || element.visualDescription,
      locatorPrompt: element.visualDescription || element.label || element.candidateKey,
    });
  }
  return {
    status: 'pass',
    result: {
      visiblePageTitle: recognitionResult.result.page.name,
      visiblePrimaryContent: [],
      visibleNavigationState: recognitionResult.result.page.stateSummary,
      visibleControls,
      scrollableRegions: [],
      unresolvedVisualMeanings,
    },
  };
}

async function captureFrame({runtime, writer, plan, policy, stateKey, stepId, startedNs}) {
  const frameId = ulid();
  const sequence = writer.frames.length + 1;
  const captureStartedAt = new Date().toISOString();
  const captureStartedNs = process.hrtime.bigint();
  const beforeRuntime = await runtime.readContext();
  const expectedSize = positiveSize(plan.coordinateReference.screenshotSizePx, 'plan screenshot size');
  const sampled = await captureStableScreenshot(runtime, policy, expectedSize);
  const afterRuntime = await runtime.readContext();
  const semanticContext = await runtime.createSemanticContext(
    sampled.buffer,
    sampled.dimensions,
    Date.parse(captureStartedAt),
  );
  const screenshotRef = await writer.addResource(sampled.buffer, 'image/png', {
    dimensions: sampled.dimensions,
    evidenceRole: 'full_page_screenshot',
    redaction: {status: 'not_applied', reason: 'local_authorized_exploration'},
    metadata: {captureSource: runtime.screenshotSource, stateKeyHint: stateKey},
  });
  const runtimeRecord = withContentHash({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    recordType: 'RuntimeContextSnapshot',
    id: ulid(),
    sessionRef: writer.sessionId,
    frameRef: frameId,
    capturedAt: new Date().toISOString(),
    beforeScreenshot: beforeRuntime,
    afterScreenshot: afterRuntime,
    source: runtime.contextSource,
    adbAccess: runtime.adbAccess,
  });
  const runtimeContextRef = await writer.addResource(runtimeRecord, 'application/json', {
    evidenceRole: 'read_only_runtime_context',
    metadata: {captureSource: runtime.contextSource},
  });
  const captureEndedNs = process.hrtime.bigint();
  const frame = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    recordType: 'RawExplorationFrame',
    id: frameId,
    sessionRef: writer.sessionId,
    sequence,
    stepId,
    capturedAt: new Date().toISOString(),
    monotonicOffsetNs: Number(captureEndedNs - startedNs),
    activeApplication: afterRuntime.activeApplication,
    planStateKeyHint: stateKey,
    planHintSemantics: 'semantic_assertion_candidate_not_graph_identity',
    screenshot: {
      resourceRef: screenshotRef,
      pixelSize: sampled.dimensions,
      coordinateSpace: 'screenshot_px',
      captureRectScreenPx: plan.coordinateReference.captureRectScreenPx,
      rotationDegrees: plan.coordinateReference.rotationDegrees,
      transforms: plan.coordinateReference.transforms,
    },
    runtimeContextRef,
    recognitionStatus: 'not_attempted',
    recognitionResults: [],
    autoRecognitionStatus: 'not_attempted',
    controlInventoryStatus: 'not_attempted',
    visibleControls: [],
    unresolvedControls: [],
    captureWindow: {
      startedAt: captureStartedAt,
      endedAt: new Date().toISOString(),
      durationMs: Number(captureEndedNs - captureStartedNs) / 1_000_000,
      atomic: false,
    },
    stability: sampled.stability,
    resourceRefs: [screenshotRef, runtimeContextRef],
    quality: 'pending_semantic_recognition',
    producer: {adapter: 'midscene.AndroidAgent', id: EVIDENCE_PRODUCER_ID},
    graphMaterialization: 'none',
  };
  writer.frames.push(frame);

  const operationalFailures = [];
  if (!sampled.stability.settled) operationalFailures.push({code: 'FRAME_NOT_STABLE'});
  if (!runtimeContextInScope(afterRuntime, plan.packageId)) {
    operationalFailures.push({
      code: 'RUNTIME_CONTEXT_OUT_OF_SCOPE',
      observedPackage: afterRuntime.activeApplication?.packageId ?? 'unknown',
      focusedPackage: afterRuntime.window?.focusedPackageId ?? 'unknown',
    });
  }
  const state = plan.states[stateKey];
  const assertionResults = [];
  let autoRecognitionResult = {status: 'unknown', resourceRef: null, result: null};
  let queryResult = {status: 'unknown', result: null};
  let controlInventory = {
    status: 'unknown',
    visibleControls: [],
    unresolvedControls: [],
    pageSummary: null,
  };
  if (operationalFailures.length === 0) {
    const prompt = buildFrameRecognitionPrompt(plan, frame.id);
    autoRecognitionResult = await invokeRecognition({runtime, writer, frame, prompt, imageBuffer: sampled.buffer});
    await assertRuntimeStillReady(runtime, plan.packageId, 'Auto page recognition');
    queryResult = buildAutoControlInventory(autoRecognitionResult);
    if (queryResult.status === 'pass') {
      controlInventory = await inspectVisibleControls({
        runtime,
        writer,
        frame,
        plan,
        policy,
        stateKey,
        queryResult,
        semanticContext,
      });
      await assertRuntimeStillReady(runtime, plan.packageId, 'control inventory location');
      for (const prompt of state.requiredSemanticAssertions) {
        assertionResults.push(
          await invokeAssert({
            runtime,
            writer,
            frame,
            prompt,
            purpose: 'required_state_assertion',
            semanticContext,
          }),
        );
      }
      await assertRuntimeStillReady(runtime, plan.packageId, 'state assertions');
    }
  }
  frame.autoRecognitionStatus = autoRecognitionResult.status;
  frame.controlInventoryStatus = controlInventory.status;
  frame.visibleControls = controlInventory.visibleControls;
  frame.unresolvedControls = controlInventory.unresolvedControls;
  const semanticStatuses = [
    autoRecognitionResult.status,
    controlInventory.status,
    ...assertionResults.map((item) => item.status),
  ];
  frame.recognitionStatus = operationalFailures.length
    ? 'not_attempted'
    : recognitionStatus(semanticStatuses);
  frame.quality =
    operationalFailures.length === 0 && frame.recognitionStatus === 'complete' ? 'complete' : 'unresolved';
  writer.observations.push({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    recordType: 'RawExplorationObservation',
    id: ulid(),
    sessionRef: writer.sessionId,
    frameRef: frame.id,
    observationType: 'midscene_visible_state_evidence',
    planStateKeyHint: stateKey,
    autoRecognitionEvidenceRef: autoRecognitionResult.resourceRef,
    autoRecognitionStatus: autoRecognitionResult.status,
    pageSummary: controlInventory.pageSummary,
    visibleControls: controlInventory.visibleControls,
    unresolvedControls: controlInventory.unresolvedControls,
    controlInventoryStatus: controlInventory.status,
    requiredAssertionStatuses: assertionResults.map((item) => ({status: item.status, resourceRef: item.resourceRef})),
    semanticStatus: frame.recognitionStatus,
    operationalFailures,
    reviewStatus: 'pending',
    inputEvidenceRefs: frame.resourceRefs,
    recordedAt: new Date().toISOString(),
    graphMaterialization: 'none',
  });
  return {frame, queryResult, assertionResults, operationalFailures, semanticContext};
}

function decideStaticPolicy(step, currentState, policy) {
  const reasons = [];
  if (!(policy.allowedRiskLevels ?? []).includes(step.risk)) reasons.push(`risk_not_allowed:${step.risk}`);
  if (Number(step.depth) > Number(policy.maxDepth)) reasons.push(`depth_exceeded:${step.depth}`);
  if ((policy.scope?.stopAt ?? []).includes(currentState)) reasons.push(`stop_boundary:${currentState}`);
  if (step.target?.scope && !(policy.allowedTargetScopes ?? []).includes(step.target.scope)) {
    reasons.push(`target_scope_not_allowed:${step.target.scope}`);
  }
  if ((policy.entryOnly ?? []).includes(step.target?.key) || (policy.entryOnly ?? []).includes(step.target?.label)) {
    reasons.push('entry_only_target');
  }
  for (const effect of step.sideEffects ?? []) {
    if (!(policy.allowedSideEffects ?? []).includes(effect)) reasons.push(`side_effect_not_allowed:${effect}`);
    if ((policy.prohibitedSideEffects ?? []).includes(effect)) reasons.push(`side_effect_prohibited:${effect}`);
  }
  const targetText = `${step.target?.key ?? ''} ${step.target?.label ?? ''}`;
  for (const pattern of policy.forbiddenTargetPatterns ?? []) {
    if (safePatternMatches(pattern, targetText)) reasons.push(`forbidden_target_pattern:${pattern}`);
  }
  return {
    decision: reasons.length ? 'deny' : 'allow',
    ruleIds: ['POL-RISK-001', 'POL-BOUNDARY-001', 'POL-TARGET-001', 'POL-DEPTH-001'],
    reasons,
  };
}

async function evaluatePostcondition({
  runtime,
  writer,
  plan,
  step,
  beforeFrame,
  afterFrame,
  semanticContext = null,
}) {
  const failures = [];
  const expectedPackage = step.postcondition.expectedForegroundPackage;
  if (afterFrame.activeApplication?.packageId !== expectedPackage) {
    failures.push({
      code: 'FOREGROUND_PACKAGE_MISMATCH',
      expectedPackage,
      observedPackage: afterFrame.activeApplication?.packageId ?? 'unknown',
    });
  }
  if (
    step.postcondition.requiredScreenshotChange === true &&
    beforeFrame.screenshot.resourceRef === afterFrame.screenshot.resourceRef
  ) {
    failures.push({code: 'SCREENSHOT_DID_NOT_CHANGE'});
  }
  const resultQueryPrompt = buildResultQueryPrompt(plan, step);
  const resultQuery = await invokeQuery({
    runtime,
    writer,
    frame: afterFrame,
    prompt: resultQueryPrompt,
    semanticContext,
  });
  const semanticAssertions = [];
  for (const prompt of step.postcondition.semanticAssertions) {
    semanticAssertions.push(
      await invokeAssert({
        runtime,
        writer,
        frame: afterFrame,
        prompt,
        purpose: 'required_postcondition',
        semanticContext,
      }),
    );
  }
  if (semanticAssertions.some((item) => item.status === 'fail')) {
    failures.push({code: 'SEMANTIC_POSTCONDITION_FALSE'});
  }
  const hasUnknown =
    resultQuery.status === 'unknown' ||
    semanticAssertions.some((item) => item.status === 'unknown');
  return {
    status: failures.length ? 'fail' : hasUnknown ? 'unknown' : 'pass',
    failures,
    resultDescriptionQuery: {
      status: resultQuery.status,
      resourceRef: resultQuery.resourceRef,
    },
    semanticAssertions: semanticAssertions.map((item) => ({status: item.status, resourceRef: item.resourceRef})),
    supplementalChecks: {
      foregroundPackage: failures.some((item) => item.code === 'FOREGROUND_PACKAGE_MISMATCH') ? 'fail' : 'pass',
      screenshotChange:
        step.postcondition.requiredScreenshotChange === true
          ? failures.some((item) => item.code === 'SCREENSHOT_DID_NOT_CHANGE')
            ? 'fail'
            : 'pass'
          : 'not_required',
    },
  };
}

async function ensureOutputAbsent(outputDir) {
  try {
    await fs.access(outputDir);
    throw new ExplorerError('OUTPUT_ALREADY_EXISTS', `Output directory already exists: ${outputDir}`, 'output_gate');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function assertCaptureResultResolved(result, stateKey) {
  if (result.operationalFailures.length) {
    throw new ExplorerError('FRAME_CAPTURE_OUT_OF_SCOPE', `Frame for ${stateKey} failed runtime/stability gates`, 'capture');
  }
  if (result.frame.recognitionStatus !== 'complete') {
    throw new SemanticResolutionError('STATE_SEMANTICS_UNRESOLVED', `Required Midscene state semantics are unresolved for ${stateKey}`);
  }
}

export async function runExploration({plan, policy, packageId, outputDir, runtime, executionAuthorization}) {
  const validation = validatePlanPolicy(plan, policy);
  if (packageId !== plan.packageId || packageId !== policy.packageId) {
    throw new ExplorerError('PACKAGE_MISMATCH', 'Package ID mismatch between invocation, plan, and policy', 'contract_validation');
  }
  const offlineFixture = runtime?.mode === 'offline_fixture_evidence_certification';
  if (
    (!offlineFixture &&
      (executionAuthorization?.physicalActionsAllowed !== true ||
        executionAuthorization?.visualInspectionConfirmed !== true ||
        executionAuthorization?.offlineFixture !== false)) ||
    (offlineFixture && executionAuthorization?.offlineFixture !== true)
  ) {
    throw new ExplorerError(
      'EXECUTION_AUTHORIZATION_INVALID',
      'Execution authorization does not match the selected runtime mode',
      'authorization_gate',
    );
  }
  await ensureOutputAbsent(outputDir);
  const sessionId = ulid();
  const startedAt = new Date().toISOString();
  const startedNs = process.hrtime.bigint();
  const writer = new RawEvidenceWriter(outputDir, sessionId, plan, policy);
  await writer.initialize();

  let currentState = plan.initialState;
  let currentFrame = null;
  let currentSemanticContext = null;
  let status = 'aborted';
  let failure = null;
  let caughtError = null;
  let deviceMetadata = null;
  let buildMetadata = {platform: 'android', packageId, source: 'invocation_only'};
  let bootstrap = null;
  let stayAwake = null;

  try {
    await runtime.connect();
    deviceMetadata = await runtime.inspectDevice({packageId, serialHash: plan.deviceSerialHash});
    buildMetadata = deviceMetadata.observedApplicationBuild;
    const expectedCurrent = positiveSize(plan.coordinateReference.currentDisplaySizePx, 'plan current display');
    if (
      deviceMetadata.currentDisplaySizePx.width !== expectedCurrent.width ||
      deviceMetadata.currentDisplaySizePx.height !== expectedCurrent.height ||
      deviceMetadata.rotationDegrees !== plan.coordinateReference.rotationDegrees
    ) {
      throw new ExplorerError('DEVICE_GEOMETRY_MISMATCH', 'Observed device geometry does not match the compiled plan', 'device_gate');
    }
    const preBootstrapContext = await runtime.readContext();
    if (
      preBootstrapContext.power?.wakefulness !== 'Awake' ||
      preBootstrapContext.trust?.deviceLocked !== false ||
      preBootstrapContext.window?.keyguardShowing !== false
    ) {
      throw new ExplorerError('DEVICE_NOT_READY', 'Device is locked, asleep, or showing keyguard', 'device_gate');
    }
    if (!runtimeContextInScope(preBootstrapContext, packageId)) {
      throw new ExplorerError(
        'VISUALLY_INSPECTED_CONTEXT_CHANGED',
        'The target package is no longer the focused screen confirmed by G1 visual inspection',
        'device_gate',
      );
    }
    stayAwake = await runtime.enableStayAwake();
    await runtime.assertSemanticRuntimeReady();
    bootstrap = await runtime.bootstrap({
      packageId,
      config: plan.bootstrap,
      waitMs: Number(policy.defaultWaitMs ?? 2500),
    });
    const postBootstrapContext = await runtime.readContext();
    if (!runtimeContextInScope(postBootstrapContext, packageId)) {
      throw new ExplorerError('BOOTSTRAP_FOREGROUND_MISMATCH', 'Bootstrap did not leave the target package ready and focused', 'bootstrap');
    }

    for (let index = 0; index < plan.steps.length; index += 1) {
      const step = plan.steps[index];
      if (step.kind === 'capture') {
        currentState = step.state;
        const capture = await captureFrame({
          runtime,
          writer,
          plan,
          policy,
          stateKey: currentState,
          stepId: step.id,
          startedNs,
        });
        currentFrame = capture.frame;
        currentSemanticContext = capture.semanticContext;
        assertCaptureResultResolved(capture, currentState);
        continue;
      }
      if (!currentFrame) {
        const capture = await captureFrame({
          runtime,
          writer,
          plan,
          policy,
          stateKey: currentState,
          stepId: `${step.id}:before`,
          startedNs,
        });
        currentFrame = capture.frame;
        currentSemanticContext = capture.semanticContext;
        assertCaptureResultResolved(capture, currentState);
      }
      if (step.fromState !== currentState) {
        throw new ExplorerError('RUNTIME_STATE_MISMATCH', `Step ${step.id} expected ${step.fromState}, found ${currentState}`, 'execution');
      }
      if (writer.traces.length >= Number(policy.maxActions)) {
        throw new PolicyViolationError('ACTION_BUDGET_EXCEEDED', `Action budget exceeded at ${step.id}`);
      }

      const trace = {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        recordType: 'RawExplorationActionTrace',
        id: ulid(),
        sessionRef: sessionId,
        sequence: writer.traces.length + 1,
        startedAt: new Date().toISOString(),
        beforeFrameRef: currentFrame.id,
        afterFrameRef: null,
        fromPlanStateKeyHint: step.fromState,
        toPlanStateKeyHint: step.toState,
        targetCandidate: step.target ?? null,
        invocation: {semanticAction: step.semanticAction, framework: 'midscene.AndroidAgent', operation: null},
        locatorAttempts: [],
        operationEvidenceRefs: [],
        policyDecision: decideStaticPolicy(step, currentState, policy),
        postcondition: null,
        result: 'failed',
        error: null,
        recovery: step.recovery ? {strategy: step.recovery} : null,
        producer: {adapter: 'midscene.AndroidAgent', id: EVIDENCE_PRODUCER_ID},
        graphMaterialization: 'none',
      };
      writer.traces.push(trace);
      if (trace.policyDecision.decision !== 'allow') {
        trace.endedAt = new Date().toISOString();
        trace.error = {code: 'STATIC_POLICY_REJECTED', reasons: trace.policyDecision.reasons};
        throw new PolicyViolationError('STATIC_POLICY_REJECTED', `Policy rejected ${step.id}`);
      }

      let actionResult;
      if (step.kind === 'tap' || step.kind === 'scroll') {
        const locate = await invokeLocate({
          runtime,
          writer,
          frame: currentFrame,
          prompt: step.target.locatorPrompt,
          semanticContext: currentSemanticContext,
        });
        trace.operationEvidenceRefs.push(locate.resourceRef);
        trace.locatorAttempts.push({
          strategy: 'midscene.aiLocate',
          prompt: step.target.locatorPrompt,
          result: locate.status,
          evidenceRef: locate.resourceRef,
        });
        if (locate.status !== 'pass') {
          trace.endedAt = new Date().toISOString();
          trace.error = {code: 'MIDSCENE_LOCATE_UNRESOLVED'};
          throw new SemanticResolutionError('MIDSCENE_LOCATE_UNRESOLVED', `Midscene could not locate ${step.id}`);
        }
        const logicalSize = await runtime.logicalSize();
        let runtimeLocator;
        try {
          runtimeLocator = validateLocatedTarget({locateResult: locate.result, logicalSize, plan, policy, step});
        } catch (error) {
          trace.policyDecision = {
            decision: 'deny',
            ruleIds: [...trace.policyDecision.ruleIds, 'POL-RUNTIME-LOCATOR-001'],
            reasons: [error.code ?? 'runtime_locator_policy_failed'],
          };
          trace.endedAt = new Date().toISOString();
          trace.error = {code: error.code ?? 'RUNTIME_LOCATOR_POLICY_FAILED'};
          throw error;
        }
        trace.locatorAttempts[0].runtimeLocator = runtimeLocator;
        trace.invocation.operation = step.kind === 'tap' ? 'aiTap' : 'aiAct';
        trace.invocation.locatorPrompt = step.target.locatorPrompt;
        trace.invocation.runtimeTarget = runtimeLocator;
        if (step.kind === 'scroll') {
          trace.invocation.actionPrompt = step.actionPrompt;
          trace.invocation.direction = step.direction;
        }
        await assertRuntimeStillReady(runtime, packageId, `${step.id} action`);
        actionResult = await invokeAgentAction({
          runtime,
          writer,
          frame: currentFrame,
          operation: step.kind === 'tap' ? 'aiTap' : 'aiAct',
          prompt: step.kind === 'tap' ? step.target.locatorPrompt : step.actionPrompt,
          locatorRef: locate.resourceRef,
        });
      } else if (step.kind === 'back') {
        trace.invocation.operation = 'back';
        await assertRuntimeStillReady(runtime, packageId, `${step.id} action`);
        actionResult = await invokeAgentAction({runtime, writer, frame: currentFrame, operation: 'back'});
      } else {
        trace.invocation.operation = 'launch';
        trace.invocation.component = step.component;
        await assertRuntimeStillReady(runtime, packageId, `${step.id} action`);
        actionResult = await invokeAgentAction({
          runtime,
          writer,
          frame: currentFrame,
          operation: 'launch',
          argument: step.component,
        });
      }
      trace.operationEvidenceRefs.push(actionResult.resourceRef);
      if (actionResult.status !== 'pass') {
        trace.error = {code: 'MIDSCENE_ACTION_UNRESOLVED'};
      }
      await sleep(Number(step.waitMs ?? policy.defaultWaitMs));
      currentState = step.toState;
      const afterCapture = await captureFrame({
        runtime,
        writer,
        plan,
        policy,
        stateKey: currentState,
        stepId: `${step.id}:after`,
        startedNs,
      });
      currentFrame = afterCapture.frame;
      currentSemanticContext = afterCapture.semanticContext;
      trace.afterFrameRef = currentFrame.id;
      trace.postcondition = await evaluatePostcondition({
        runtime,
        writer,
        plan,
        step,
        beforeFrame: writer.frames.find((frame) => frame.id === trace.beforeFrameRef),
        afterFrame: currentFrame,
        semanticContext: currentSemanticContext,
      });
      trace.endedAt = new Date().toISOString();
      const captureResolved =
        afterCapture.operationalFailures.length === 0 && currentFrame.recognitionStatus === 'complete';
      const succeeded = actionResult.status === 'pass' && captureResolved && trace.postcondition.status === 'pass';
      trace.result = succeeded ? 'success' : 'failed';
      if (!succeeded) {
        trace.error = trace.error ?? {
          code:
            trace.postcondition.status === 'unknown' || currentFrame.recognitionStatus === 'unresolved'
              ? 'SEMANTIC_POSTCONDITION_UNRESOLVED'
              : 'POSTCONDITION_FAILED',
          failures: trace.postcondition.failures,
        };
        if (
          trace.postcondition.status === 'unknown' ||
          currentFrame.recognitionStatus !== 'complete' ||
          actionResult.status !== 'pass'
        ) {
          throw new SemanticResolutionError('SEMANTIC_POSTCONDITION_UNRESOLVED', `Step ${step.id} did not resolve semantically`);
        }
        throw new ExplorerError('POSTCONDITION_FAILED', `Step ${step.id} postcondition failed`, 'postcondition');
      }
    }
    status = 'completed';
  } catch (error) {
    caughtError = error;
    status = error instanceof SemanticResolutionError ? 'completed_with_unresolved_postconditions' : 'aborted';
    failure = {
      code: error.code ?? 'UNEXPECTED_EXPLORER_FAILURE',
      category: error.name ?? 'Error',
      stage: error.stage ?? 'execution',
    };
  } finally {
    if (stayAwake) {
      try {
        stayAwake.restoration = await runtime.restoreStayAwake(stayAwake);
      } catch (restoreError) {
        stayAwake.restoration = {status: 'failed', code: 'STAY_AWAKE_RESTORE_FAILED'};
        if (!caughtError) caughtError = restoreError;
        status = 'aborted';
        failure = {
          code: restoreError.code ?? 'STAY_AWAKE_RESTORE_FAILED',
          category: restoreError.name ?? 'Error',
          stage: restoreError.stage ?? 'device_orchestration',
        };
      }
    }
    const endedAt = new Date().toISOString();
    const session = {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      recordType: 'RawExplorationSession',
      id: sessionId,
      observedApplicationBuild: buildMetadata,
      rawDeviceContext: deviceMetadata ?? {serialHash: plan.deviceSerialHash, platform: 'android'},
      policyRef: policy.policyId,
      planRef: plan.planId,
      sourceScopeHash: plan.sourceScopeHash,
      startedAt,
      endedAt,
      mode: runtime.mode,
      status,
      failure,
      bootstrap,
      deviceOrchestration: {stayAwake},
      executionAuthorization,
      semanticModelSummary: runtime.modelSummary,
      frameCount: writer.frames.length,
      actionCount: writer.traces.length,
      contractValidation: validation,
      ...EVIDENCE_CONTRACT,
      producer: {
        id: EVIDENCE_PRODUCER_ID,
        midsceneVersion: runtime.midsceneVersion,
      },
    };
    try {
      await writer.finalize(session);
    } catch (finalizeError) {
      if (!caughtError) caughtError = finalizeError;
    }
    try {
      await runtime.destroy();
    } catch (destroyError) {
      if (!caughtError) caughtError = destroyError;
    }
  }
  if (caughtError) throw caughtError;
  return {
    status,
    sessionId,
    frameCount: writer.frames.length,
    actionCount: writer.traces.length,
    manifestPath: path.join(outputDir, 'raw-evidence', 'raw-evidence-manifest.json'),
  };
}

function parseActivity(raw) {
  const match = raw.match(
    /(?:mResumedActivity|topResumedActivity)[:=]\s*ActivityRecord\{[^\n]*?\s([a-zA-Z0-9._]+)\/([a-zA-Z0-9_.$]+)\s/,
  );
  return {packageId: match?.[1] ?? 'unknown', activity: match?.[2] ?? 'unknown'};
}

function normalizedActivityName(packageId, activity) {
  if (!activity || activity === 'unknown') return 'unknown';
  if (activity.startsWith('.')) return `${packageId}${activity}`;
  if (!activity.includes('.')) return `${packageId}.${activity}`;
  return activity;
}

function parseWindow(raw) {
  const focus = raw.match(/mCurrentFocus=Window\{[^\n]*?\s([a-zA-Z0-9._]+)\/([a-zA-Z0-9_.$]+)\}/);
  return {
    focusedPackageId: focus?.[1] ?? 'unknown',
    focusedActivity: focus?.[2] ?? 'unknown',
    keyguardShowing:
      /(?:isKeyguardShowing|mKeyguardShowing)=true/.test(raw) || /mAodShowing=true/.test(raw),
  };
}

function parseWmSize(raw) {
  const physical = raw.match(/Physical size:\s*(\d+)x(\d+)/);
  const override = raw.match(/Override size:\s*(\d+)x(\d+)/);
  const physicalSize = physical ? {width: Number(physical[1]), height: Number(physical[2])} : null;
  const overrideSize = override ? {width: Number(override[1]), height: Number(override[2])} : null;
  return {physical: physicalSize, override: overrideSize, effective: overrideSize ?? physicalSize};
}

function parseWmDensity(raw) {
  const physical = raw.match(/Physical density:\s*(\d+)/);
  const override = raw.match(/Override density:\s*(\d+)/);
  const physicalDensity = physical ? Number(physical[1]) : null;
  const overrideDensity = override ? Number(override[1]) : null;
  return {physical: physicalDensity, override: overrideDensity, effective: overrideDensity ?? physicalDensity};
}

function parseDisplayRotation(raw) {
  const surface = raw.match(/SurfaceOrientation:\s*(\d+)/)?.[1];
  if (surface !== undefined && [0, 1, 2, 3].includes(Number(surface))) return Number(surface) * 90;
  const match = raw.match(/\b(?:mCurrentRotation|rotation)=(?:ROTATION_)?(0|1|2|3|90|180|270)\b/i)?.[1];
  if (match === undefined) return null;
  const value = Number(match);
  return value <= 3 ? value * 90 : value;
}

export function resolveMidsceneRepo(midsceneRepo, env = process.env) {
  const explicitRepo = typeof midsceneRepo === 'string' ? midsceneRepo.trim() : '';
  const inheritedRepo = typeof env.MIDSCENE_REPO === 'string' ? env.MIDSCENE_REPO.trim() : '';
  const configuredRepo = explicitRepo || inheritedRepo;
  if (!configuredRepo) {
    throw new ExplorerError(
      'MIDSCENE_REPO_REQUIRED',
      '--midscene-repo or a non-empty MIDSCENE_REPO environment variable is required in real mode',
      'model_gate',
    );
  }
  return path.resolve(configuredRepo);
}

export async function loadAutoModelConfiguration({
  databasePath = path.join(process.env.UIKG_WORKBENCH_DATA_DIR || path.join(PROJECT_ROOT, 'apps/uikg-workbench/.data'), 'model-settings.sqlite'),
  env = process.env,
} = {}) {
  const store = new ModelSettingsStore(databasePath);
  await store.initialize();
  try {
    const auto = resolveTargetModelConfig(store, 'auto');
    const midscene = resolveTargetModelConfig(store, 'midscene');
    if (!auto?.modelName || !auto.apiKey || !auto.baseUrl) {
      throw new ExplorerError('AUTO_MODEL_CONFIG_MISSING', 'Auto 页面识别模型未完整配置', 'model_gate');
    }
    if (!midscene?.modelName || !midscene.apiKey || !midscene.baseUrl) {
      throw new ExplorerError('MIDSCENE_MODEL_CONFIG_MISSING', 'Auto Midscene 模型未完整配置', 'model_gate');
    }
    setModelRuntime('auto', auto);
    Object.assign(env, {
      MIDSCENE_MODEL_NAME: midscene.modelName,
      MIDSCENE_MODEL_FAMILY: midscene.modelFamily,
      MIDSCENE_MODEL_BASE_URL: midscene.baseUrl,
      MIDSCENE_MODEL_API_KEY: midscene.apiKey,
      MIDSCENE_MODEL_TIMEOUT: String(midscene.timeout),
      MIDSCENE_MODEL_TEMPERATURE: String(midscene.temperature),
      MIDSCENE_MODEL_REASONING_EFFORT: midscene.reasoningEffort,
    });
    return {
      auto: {name: auto.modelName, family: auto.modelFamily, slot: 'auto'},
      midscene: {name: midscene.modelName, family: midscene.modelFamily, slot: 'midscene'},
      configurationSource: 'workbench_model_settings',
      credentialsPersisted: false,
      serviceLocationPersisted: false,
    };
  } finally {
    store.close();
  }
}

export async function createRealRuntime({serial, adbPath, midsceneRepo}) {
  const resolvedRepo = resolveMidsceneRepo(midsceneRepo, process.env);
  const modelSummary = await loadAutoModelConfiguration();
  const modulePath = path.join(resolvedRepo, 'packages', 'android', 'dist', 'es', 'index.mjs');
  const coreModulePath = path.join(resolvedRepo, 'packages', 'core', 'dist', 'es', 'index.mjs');
  const packagePath = path.join(resolvedRepo, 'packages', 'android', 'package.json');
  const [{AndroidAgent, AndroidDevice}, {ScreenshotItem}, packageValue] = await Promise.all([
    import(pathToFileURL(modulePath).href),
    import(pathToFileURL(coreModulePath).href),
    fs.readFile(packagePath, 'utf8').then(JSON.parse),
  ]);
  if (
    typeof AndroidAgent !== 'function' ||
    typeof AndroidDevice !== 'function' ||
    typeof ScreenshotItem?.create !== 'function'
  ) {
    throw new ExplorerError(
      'MIDSCENE_EXPORTS_MISSING',
      'Midscene AndroidAgent/AndroidDevice/ScreenshotItem exports are unavailable',
      'runtime_loading',
    );
  }
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uikg-midscene-cache-'));
  const device = new AndroidDevice(serial, {
    androidAdbPath: adbPath,
    scrcpyConfig: {enabled: false},
  });
  const agent = new AndroidAgent(device, {
    generateReport: false,
    persistExecutionDump: false,
    autoPrintReportMsg: false,
    cache: {id: `uikg-${ulid()}`, strategy: 'read-write', cacheDir},
  });
  let adb = null;
  let packageId = null;

  const readOnlyShell = async (command, timeout = 15_000) => {
    if (!Array.isArray(command) || command.length === 0) {
      throw new ExplorerError('ADB_READ_COMMAND_INVALID', 'Read-only ADB command must be a non-empty array', 'runtime_context');
    }
    const [program, subcommand] = command;
    const allowed =
      program === 'getprop' ||
      program === 'dumpsys' ||
      (program === 'wm' && ['size', 'density'].includes(subcommand)) ||
      (program === 'pm' && subcommand === 'path');
    if (!allowed) {
      throw new ExplorerError('ADB_WRITE_COMMAND_FORBIDDEN', `ADB command is not read-only: ${program} ${subcommand ?? ''}`, 'runtime_context');
    }
    const result = await adb.shell(command, {timeout});
    return Buffer.isBuffer(result) ? result.toString('utf8') : String(result ?? '');
  };

  const readContext = async () => {
    const [activityRaw, windowRaw, powerRaw, trustRaw] = await Promise.all([
      readOnlyShell(['dumpsys', 'activity', 'activities']),
      readOnlyShell(['dumpsys', 'window']),
      readOnlyShell(['dumpsys', 'power']),
      readOnlyShell(['dumpsys', 'trust']),
    ]);
    const activity = parseActivity(activityRaw);
    const window = parseWindow(windowRaw);
    return {
      activeApplication: activity,
      window,
      power: {wakefulness: powerRaw.match(/mWakefulness=([^\s]+)/)?.[1] ?? 'unknown'},
      trust: {
        deviceLocked: (() => {
          const value = trustRaw.match(/deviceLocked=(\d+)/)?.[1];
          return value === undefined ? null : value !== '0';
        })(),
      },
      collectedBy: 'adb_read_only_dumpsys',
    };
  };

  const waitForTarget = async (expectedPackage, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    let context = null;
    while (Date.now() <= deadline) {
      context = await readContext();
      if (runtimeContextInScope(context, expectedPackage)) return context;
      await sleep(500);
    }
    throw new ExplorerError('TARGET_FOREGROUND_TIMEOUT', 'Target package did not become ready and focused', 'bootstrap');
  };

  const readStayAwakeValue = async () => {
    const raw = await adb.shell(
      ['settings', 'get', 'global', 'stay_on_while_plugged_in'],
      {timeout: 15_000},
    );
    const value = String(raw ?? '').trim();
    if (value === '' || value === 'null') return null;
    if (!/^\d+$/.test(value)) {
      throw new ExplorerError(
        'STAY_AWAKE_VALUE_INVALID',
        'Android returned an invalid stay-awake setting',
        'device_orchestration',
      );
    }
    return Number(value);
  };

  const writeStayAwakeValue = async (value) => {
    const command = value === null
      ? ['settings', 'delete', 'global', 'stay_on_while_plugged_in']
      : ['settings', 'put', 'global', 'stay_on_while_plugged_in', String(value)];
    await adb.shell(command, {timeout: 15_000});
  };

  let sharp = null;
  try {
    const sharpPath = path.join(resolvedRepo, 'packages', 'android', 'node_modules', 'sharp', 'lib', 'index.js');
    sharp = (await import(pathToFileURL(sharpPath).href)).default;
  } catch {
    sharp = null;
  }

  return {
    mode: 'recursive_feature_evidence_capture',
    midsceneVersion: packageValue.version ?? 'unknown',
    modelSummary,
    screenshotSource: 'midscene.AndroidDevice.screenshotBase64',
    contextSource: 'adb_read_only_runtime_context',
    adbAccess: 'read_only_allowlist_plus_reversible_stay_awake',
    async connect() {
      await device.connect();
      adb = await device.getAdb();
    },
    async enableStayAwake() {
      const battery = await readOnlyShell(['dumpsys', 'battery']);
      if (!/(?:AC|USB|Wireless) powered:\s*true/i.test(battery)) {
        throw new ExplorerError(
          'DEVICE_NOT_POWERED',
          'The Android device must be connected to power for reversible stay-awake mode',
          'device_orchestration',
        );
      }
      const originalValue = await readStayAwakeValue();
      const appliedValue = 7;
      const changed = originalValue !== appliedValue;
      if (changed) await writeStayAwakeValue(appliedValue);
      const verifiedValue = await readStayAwakeValue();
      if (verifiedValue !== appliedValue) {
        if (changed) await writeStayAwakeValue(originalValue);
        throw new ExplorerError(
          'STAY_AWAKE_ENABLE_FAILED',
          'Unable to verify Android stay-awake mode',
          'device_orchestration',
        );
      }
      return {
        status: 'enabled',
        mechanism: 'adb_global_stay_on_while_plugged_in',
        originalValue,
        appliedValue,
        changed,
      };
    },
    async restoreStayAwake(state) {
      if (!state?.changed) {
        return {status: 'not_required', verifiedValue: await readStayAwakeValue()};
      }
      await writeStayAwakeValue(state.originalValue);
      const verifiedValue = await readStayAwakeValue();
      if (verifiedValue !== state.originalValue) {
        throw new ExplorerError(
          'STAY_AWAKE_RESTORE_FAILED',
          'Unable to restore the original Android stay-awake setting',
          'device_orchestration',
        );
      }
      return {status: 'restored', verifiedValue};
    },
    async inspectDevice({packageId: targetPackage, serialHash}) {
      packageId = targetPackage;
      const [installed, manufacturer, model, characteristics, release, api, wmSizeRaw, wmDensityRaw, inputRaw, packageRaw] =
        await Promise.all([
          readOnlyShell(['pm', 'path', targetPackage]),
          readOnlyShell(['getprop', 'ro.product.manufacturer']),
          readOnlyShell(['getprop', 'ro.product.model']),
          readOnlyShell(['getprop', 'ro.build.characteristics']),
          readOnlyShell(['getprop', 'ro.build.version.release']),
          readOnlyShell(['getprop', 'ro.build.version.sdk']),
          readOnlyShell(['wm', 'size']),
          readOnlyShell(['wm', 'density']),
          readOnlyShell(['dumpsys', 'input']),
          readOnlyShell(['dumpsys', 'package', targetPackage]),
        ]);
      if (!installed.includes('package:')) {
        throw new ExplorerError('PACKAGE_NOT_INSTALLED', `${targetPackage} is not installed`, 'device_gate');
      }
      const wmSize = parseWmSize(wmSizeRaw);
      const density = parseWmDensity(wmDensityRaw);
      const rotationDegrees = parseDisplayRotation(inputRaw);
      if (!wmSize.physical || !wmSize.effective || density.effective === null || rotationDegrees === null) {
        throw new ExplorerError('DEVICE_METADATA_INCOMPLETE', 'Display metadata is incomplete', 'device_gate');
      }
      const currentDisplaySizePx = [90, 270].includes(rotationDegrees)
        ? {width: wmSize.effective.height, height: wmSize.effective.width}
        : wmSize.effective;
      const logical = await device.size();
      return {
        serialHash,
        serialRecordedSeparately: false,
        platform: 'android',
        manufacturer: manufacturer.trim(),
        model: model.trim(),
        buildCharacteristics: characteristics.trim(),
        android: {release: release.trim(), apiLevel: Number(api.trim())},
        physicalSizeNaturalPx: wmSize.physical,
        effectiveSizeNaturalPx: wmSize.effective,
        currentDisplaySizePx,
        densityDpi: density,
        logicalCoordinateSizePx: logical,
        rotationDegrees,
        orientation: currentDisplaySizePx.height >= currentDisplaySizePx.width ? 'portrait' : 'landscape',
        observedApplicationBuild: {
          platform: 'android',
          packageId: targetPackage,
          versionName: packageRaw.match(/versionName=([^\s]+)/)?.[1] ?? 'unknown',
          versionCode: packageRaw.match(/versionCode=(\d+)/)?.[1] ?? 'unknown',
          source: 'adb_read_only_dumpsys_package',
          semantics: 'raw_observed_metadata_not_graph_identity',
        },
      };
    },
    readContext,
    async assertSemanticRuntimeReady() {
      return true;
    },
    async bootstrap({packageId: targetPackage, config, waitMs}) {
      const operations = [];
      const launchTarget = config.component ?? targetPackage;
      if (config.coldStart) {
        await agent.terminate(targetPackage);
        operations.push({operation: 'AndroidAgent.terminate', target: targetPackage});
        await agent.launch(launchTarget);
        operations.push({operation: 'AndroidAgent.launch', target: launchTarget});
      } else if (!config.requireUserPreparedState) {
        await agent.launch(launchTarget);
        operations.push({operation: 'AndroidAgent.launch', target: launchTarget});
      } else {
        operations.push({operation: 'user_prepared_state_verified', target: targetPackage});
      }
      await sleep(waitMs);
      const context = await waitForTarget(targetPackage);
      const expectedActivity = config.component?.split('/')[1] ?? null;
      const activityVerified =
        expectedActivity === null ||
        normalizedActivityName(targetPackage, context.activeApplication.activity) ===
          normalizedActivityName(targetPackage, expectedActivity);
      if (!activityVerified) {
        throw new ExplorerError(
          'BOOTSTRAP_ACTIVITY_MISMATCH',
          'Bootstrap reached the target package but not the compiled Activity',
          'bootstrap',
        );
      }
      return {
        coldStart: config.coldStart,
        requireUserPreparedState: config.requireUserPreparedState,
        component: config.component ?? null,
        operations,
        foregroundVerified: runtimeContextInScope(context, targetPackage),
        activityVerified,
        framework: 'midscene.AndroidAgent',
      };
    },
    screenshot: () => device.screenshotBase64(),
    logicalSize: () => device.size(),
    async createSemanticContext(buffer, dimensions, capturedAt) {
      const logicalSize = await device.size();
      return {
        screenshot: ScreenshotItem.create(
          `data:image/png;base64,${buffer.toString('base64')}`,
          capturedAt,
        ),
        shotSize: dimensions,
        shrunkShotToLogicalRatio: dimensions.width / logicalSize.width,
        _isFrozen: true,
      };
    },
    visualVector: sharp
      ? async (buffer) => {
          const {data} = await sharp(buffer).resize(32, 64, {fit: 'fill'}).grayscale().raw().toBuffer({resolveWithObject: true});
          return data;
        }
      : null,
    runRecognition: ({prompt, imageBuffer}) => runRecognitionModel({
      target: 'auto',
      prompt,
      imageBuffer,
      responseSchema: RECOGNITION_SCHEMA,
    }),
    aiQuery: async (prompt, semanticContext = null) => {
      if (!semanticContext) return agent.aiQuery(prompt);
      const modelRuntime = agent.resolveModelRuntime('insight');
      const {output} = await agent.taskExecutor.createTypeQueryExecution(
        'Query',
        prompt,
        modelRuntime,
        undefined,
        undefined,
        {uiContext: semanticContext},
      );
      return output;
    },
    aiAssert: (prompt, semanticContext = null) =>
      semanticContext
        ? agent.aiAssertWithContext(prompt, semanticContext)
        : agent.aiAssert(prompt),
    aiLocate: (prompt, semanticContext = null) =>
      agent.aiLocate(prompt, {
        cacheable: semanticContext ? false : true,
        ...(semanticContext ? {uiContext: semanticContext} : {}),
      }),
    aiTap: (prompt) => agent.aiTap(prompt, {cacheable: true}),
    aiAct: (prompt) => agent.aiAct(prompt, {cacheable: true}),
    back: () => agent.back(),
    launch: (component) => agent.launch(component),
    async destroy() {
      try {
        await device.destroy();
      } finally {
        await fs.rm(cacheDir, {recursive: true, force: true});
      }
    },
  };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBuffer.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return result;
}

function solidPng(width, height, color) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rowLength = width * 3 + 1;
  const raw = Buffer.alloc(rowLength * height);
  for (let y = 0; y < height; y += 1) {
    const offset = y * rowLength;
    raw[offset] = 0;
    for (let x = 0; x < width; x += 1) {
      raw[offset + 1 + x * 3] = color[0];
      raw[offset + 2 + x * 3] = color[1];
      raw[offset + 3 + x * 3] = color[2];
    }
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function createOfflineFixtureRuntime({plan, policy, assertionFailureAt = null, assertionUnknownAt = null, outsideAllowedRegion = false} = {}) {
  const currentSize = positiveSize(plan.coordinateReference.currentDisplaySizePx, 'fixture current display');
  const screenshotSize = positiveSize(plan.coordinateReference.screenshotSizePx, 'fixture screenshot');
  const regions = new Map((policy.allowedTapRegions ?? []).map((region) => [region.key, normalizedRect(region.rect, region.key)]));
  const actionStepsByLocatorPrompt = new Map(
    plan.steps
      .filter((step) => ['tap', 'scroll'].includes(step.kind))
      .map((step) => [step.target.locatorPrompt, step]),
  );
  const scrollStepsByActionPrompt = new Map(
    plan.steps
      .filter((step) => step.kind === 'scroll')
      .map((step) => [step.actionPrompt, step]),
  );
  const stats = {
    connects: 0,
    queries: 0,
    autoRecognitionCalls: 0,
    assertions: 0,
    locates: 0,
    taps: 0,
    acts: 0,
    backs: 0,
    launches: 0,
    adbCalls: 0,
    semanticContexts: 0,
    stayAwakeEnabled: 0,
    stayAwakeRestored: 0,
  };
  let screenVersion = 0;
  let fixtureStateKey = plan.initialState;
  let cachedScreenshot = null;
  const screenshotForVersion = () => {
    if (!cachedScreenshot) {
      const color = [
        (41 + screenVersion * 61) % 256,
        (97 + screenVersion * 47) % 256,
        (163 + screenVersion * 37) % 256,
      ];
      cachedScreenshot = solidPng(screenshotSize.width, screenshotSize.height, color);
    }
    return cachedScreenshot;
  };
  const advance = () => {
    screenVersion += 1;
    cachedScreenshot = null;
  };
  const context = () => ({
    activeApplication: {packageId: plan.packageId, activity: plan.bootstrap.component?.split('/')[1] ?? 'FixtureActivity'},
    window: {
      focusedPackageId: plan.packageId,
      focusedActivity: plan.bootstrap.component?.split('/')[1] ?? 'FixtureActivity',
      keyguardShowing: false,
    },
    power: {wakefulness: 'Awake'},
    trust: {deviceLocked: false},
    collectedBy: 'offline_fixture',
  });
  const runtime = {
    mode: 'offline_fixture_evidence_certification',
    midsceneVersion: 'offline-fixture',
    modelSummary: {
      auto: {name: 'offline-fixture-auto-recognition', family: 'fixture', slot: 'auto'},
      midscene: {name: 'offline-fixture-midscene', family: 'fixture', slot: 'midscene'},
      credentialsPersisted: false,
      serviceLocationPersisted: false,
    },
    screenshotSource: 'offline_fixture_generated_png',
    contextSource: 'offline_fixture',
    adbAccess: 'none',
    stats,
    async connect() {
      stats.connects += 1;
    },
    async enableStayAwake() {
      stats.stayAwakeEnabled += 1;
      return {
        status: 'enabled',
        mechanism: 'offline_fixture',
        originalValue: 0,
        appliedValue: 7,
        changed: true,
      };
    },
    async restoreStayAwake() {
      stats.stayAwakeRestored += 1;
      return {status: 'restored', verifiedValue: 0};
    },
    async inspectDevice({packageId, serialHash}) {
      return {
        serialHash,
        serialRecordedSeparately: false,
        platform: 'android',
        manufacturer: 'fixture',
        model: 'offline',
        buildCharacteristics: 'fixture',
        android: {release: 'fixture', apiLevel: 0},
        physicalSizeNaturalPx: plan.coordinateReference.physicalSizeNaturalPx,
        effectiveSizeNaturalPx: plan.coordinateReference.effectiveSizeNaturalPx,
        currentDisplaySizePx: currentSize,
        densityDpi: {physical: 160, override: 160, effective: 160},
        logicalCoordinateSizePx: currentSize,
        rotationDegrees: plan.coordinateReference.rotationDegrees,
        orientation: plan.coordinateReference.orientation,
        observedApplicationBuild: {
          platform: 'android',
          packageId,
          versionName: 'offline-fixture',
          versionCode: '0',
          source: 'offline_fixture',
          semantics: 'certification_only_not_device_evidence',
        },
      };
    },
    readContext: async () => context(),
    async assertSemanticRuntimeReady() {
      return true;
    },
    async bootstrap({config}) {
      fixtureStateKey = plan.initialState;
      if (config.coldStart || !config.requireUserPreparedState) advance();
      return {
        coldStart: config.coldStart,
        requireUserPreparedState: config.requireUserPreparedState,
        component: config.component ?? null,
        operations: [{operation: 'offline_fixture_bootstrap'}],
        foregroundVerified: true,
        activityVerified: true,
        framework: 'offline_fixture_for_midscene_contract',
      };
    },
    screenshot: async () => screenshotForVersion(),
    logicalSize: async () => currentSize,
    createSemanticContext: async () => {
      stats.semanticContexts += 1;
      return {fixtureFrozenFrame: true};
    },
    runRecognition: async ({prompt}) => {
      stats.autoRecognitionCalls += 1;
      const frameId = prompt.match(/frameId[^"\n]*"([^"]+)"/)?.[1];
      if (!frameId) throw new Error('fixture recognition prompt does not declare a frame ID');
      const controls = plan.steps
        .filter((step) => ['tap', 'scroll'].includes(step.kind) && step.fromState === fixtureStateKey)
        .map((step, index) => ({
          candidateKey: step.target.key,
          label: step.target.label,
          visualDescription: step.target.locatorPrompt,
          elementType: step.kind === 'scroll' ? 'scroll-view' : 'text-button',
          interactive: true,
          enabled: true,
          state: 'enabled',
          approximateRegion: {x: 0.1 + index * 0.1, y: 0.1, width: 0.1, height: 0.1},
          geometryKind: 'boundary',
          geometryConfidence: 1,
          meaning: {
            status: 'known',
            description: `fixture ${step.semanticAction}`,
            evidence: {visibleTexts: [step.target.label], visibleIcons: [], visibleStates: ['enabled'], visualCues: [], userContext: null, unclassified: []},
          },
          dynamicContent: false,
          riskSignals: [],
          confidence: 1,
        }));
      return {
        frameId,
        page: {
          name: plan.states[fixtureStateKey]?.label ?? null,
          surfaceType: 'page',
          stateSummary: fixtureStateKey,
          scrollableRegions: controls.filter((control) => control.elementType === 'scroll-view').map((control) => control.candidateKey),
        },
        elements: controls,
        relationships: [],
        actionCandidates: controls.map((control) => ({
          triggerCandidateKey: control.candidateKey,
          action: control.elementType === 'scroll-view' ? 'scroll_vertical' : 'tap',
          expectedOutcome: '进入下一状态',
          basis: 'visible-affordance',
          riskSignals: [],
          confidence: 1,
        })),
        comparison: {basisFrameId: null, status: 'not-requested', changes: []},
        uncertainties: [],
      };
    },
    aiQuery: async (_prompt, semanticContext = null) => {
      if (!semanticContext?.fixtureFrozenFrame) throw new Error('fixture query requires a frozen Frame');
      stats.queries += 1;
      const state = plan.states[fixtureStateKey];
      const controls = plan.steps
        .filter((step) => step.kind === 'tap' && step.fromState === fixtureStateKey)
        .map((step) => ({
          candidateKey: step.target.key,
          label: step.target.label,
          elementType: 'button',
          visibleState: 'enabled',
          semanticRole: 'navigation',
          enabled: true,
          reversible: true,
          riskHint: step.risk,
          functionDescription: `fixture action ${step.semanticAction}`,
          locatorPrompt: step.target.locatorPrompt,
        }));
      const scrollableRegions = plan.steps
        .filter((step) => step.kind === 'scroll' && step.fromState === fixtureStateKey)
        .map((step) => ({
          candidateKey: step.target.key,
          label: step.target.label,
          directions: [step.direction],
          locatorPrompt: step.target.locatorPrompt,
        }));
      return {
        visiblePageTitle: state?.label ?? `Fixture state ${screenVersion}`,
        visiblePrimaryContent: [`offline fixture state ${fixtureStateKey}`],
        visibleControls: controls,
        scrollableRegions,
        visibleNavigationState: fixtureStateKey,
        unresolvedVisualMeanings: [],
      };
    },
    aiAssert: async (_prompt, semanticContext = null) => {
      if (!semanticContext?.fixtureFrozenFrame) throw new Error('fixture assertion requires a frozen Frame');
      stats.assertions += 1;
      if (stats.assertions === assertionFailureAt) {
        const error = new Error('fixture assertion false');
        error.name = 'AssertionError';
        throw error;
      }
      if (stats.assertions === assertionUnknownAt) {
        const error = new Error('fixture semantic service unavailable');
        error.name = 'SemanticServiceError';
        throw error;
      }
    },
    aiLocate: async (prompt, semanticContext = null) => {
      if (!semanticContext?.fixtureFrozenFrame) throw new Error('fixture locator requires a frozen Frame');
      stats.locates += 1;
      const step = actionStepsByLocatorPrompt.get(prompt);
      const region = regions.get(step?.target?.allowedRegionRef);
      if (!step || !region) throw new Error('fixture locator prompt not declared by plan');
      if (outsideAllowedRegion) {
        return {
          rect: {left: currentSize.width + 10, top: currentSize.height + 10, width: 20, height: 20},
          center: [currentSize.width + 20, currentSize.height + 20],
          dpr: 1,
        };
      }
      return {
        rect: {
          left: region.x + region.width * 0.25,
          top: region.y + region.height * 0.25,
          width: region.width * 0.5,
          height: region.height * 0.5,
        },
        center: [region.x + region.width * 0.5, region.y + region.height * 0.5],
        dpr: 1,
      };
    },
    aiTap: async (prompt) => {
      stats.taps += 1;
      const step = actionStepsByLocatorPrompt.get(prompt);
      if (!step) throw new Error('fixture tap prompt not declared by plan');
      fixtureStateKey = step.toState;
      advance();
    },
    aiAct: async (prompt) => {
      stats.acts += 1;
      const step = scrollStepsByActionPrompt.get(prompt);
      if (!step) throw new Error('fixture aiAct prompt not declared by plan');
      fixtureStateKey = step.toState;
      advance();
    },
    back: async () => {
      stats.backs += 1;
      advance();
    },
    launch: async () => {
      stats.launches += 1;
      advance();
    },
    destroy: async () => {},
  };
  return runtime;
}

function assertNoDuplicateJsonKeys(source, label) {
  let index = 0;
  const skipWhitespace = () => {
    while (/\s/.test(source[index] ?? '')) index += 1;
  };
  const parseStringToken = () => {
    if (source[index] !== '"') throw new SyntaxError(`Expected string at offset ${index}`);
    const start = index;
    index += 1;
    while (index < source.length) {
      if (source[index] === '\\') {
        index += 2;
        continue;
      }
      if (source[index] === '"') {
        index += 1;
        return JSON.parse(source.slice(start, index));
      }
      index += 1;
    }
    throw new SyntaxError(`Unterminated string at offset ${start}`);
  };
  const parseValue = (location) => {
    skipWhitespace();
    if (source[index] === '{') {
      index += 1;
      skipWhitespace();
      const keys = new Set();
      if (source[index] === '}') {
        index += 1;
        return;
      }
      while (index < source.length) {
        skipWhitespace();
        const key = parseStringToken();
        if (keys.has(key)) {
          throw new ExplorerError(
            'DUPLICATE_JSON_KEY',
            `${label} contains duplicate key ${JSON.stringify(key)} at ${location}`,
            'input',
          );
        }
        keys.add(key);
        skipWhitespace();
        if (source[index] !== ':') throw new SyntaxError(`Expected colon at offset ${index}`);
        index += 1;
        parseValue(`${location}.${key}`);
        skipWhitespace();
        if (source[index] === '}') {
          index += 1;
          return;
        }
        if (source[index] !== ',') throw new SyntaxError(`Expected comma at offset ${index}`);
        index += 1;
      }
      throw new SyntaxError(`Unterminated object at ${location}`);
    }
    if (source[index] === '[') {
      index += 1;
      skipWhitespace();
      if (source[index] === ']') {
        index += 1;
        return;
      }
      let itemIndex = 0;
      while (index < source.length) {
        parseValue(`${location}[${itemIndex}]`);
        itemIndex += 1;
        skipWhitespace();
        if (source[index] === ']') {
          index += 1;
          return;
        }
        if (source[index] !== ',') throw new SyntaxError(`Expected comma at offset ${index}`);
        index += 1;
      }
      throw new SyntaxError(`Unterminated array at ${location}`);
    }
    if (source[index] === '"') {
      parseStringToken();
      return;
    }
    const primitive = source.slice(index).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
    if (!primitive) throw new SyntaxError(`Invalid JSON value at offset ${index}`);
    index += primitive.length;
  };
  parseValue('$');
  skipWhitespace();
  if (index !== source.length) throw new SyntaxError(`Unexpected content at offset ${index}`);
}

async function readJson(filePath, label) {
  try {
    const source = await fs.readFile(filePath, 'utf8');
    assertNoDuplicateJsonKeys(source, label);
    const value = JSON.parse(source);
    return requireObject(value, label);
  } catch (error) {
    if (error instanceof ExplorerError) throw error;
    throw new ExplorerError('JSON_INPUT_INVALID', `${label} is not valid JSON: ${error.message}`, 'input');
  }
}

function printHelp() {
  console.log(`Usage:
  node knowledge_graph/tools/android_explorer.mjs --plan PLAN --policy POLICY --validate-only

  node knowledge_graph/tools/android_explorer.mjs \\
    --serial SERIAL --package PACKAGE --plan PLAN --policy POLICY --output NEW_DIR \\
    --allow-physical-actions --confirm-screen-visually-inspected \\
    [--midscene-repo DIR] [--adb PATH]

  node knowledge_graph/tools/android_explorer.mjs \\
    --package PACKAGE --plan PLAN --policy POLICY --output NEW_DIR --offline-fixture

Real mode resolves <midscene-repo> from --midscene-repo, then MIDSCENE_REPO. Auto page recognition
and Midscene use their independent Workbench model settings. Midscene AndroidAgent performs every
device action. Offline fixture mode uses no device, ADB, or model service and exists only for producer
certification.`);
}

export async function cliMain(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.plan || !args.policy) {
    throw new ExplorerError('CLI_INPUT_MISSING', '--plan and --policy are required', 'cli');
  }
  const planPath = path.resolve(args.plan);
  const policyPath = path.resolve(args.policy);
  const [plan, policy] = await Promise.all([readJson(planPath, 'plan'), readJson(policyPath, 'policy')]);
  const validation = validatePlanPolicy(plan, policy);
  if (args['validate-only']) {
    const incompatible = ['serial', 'package', 'output', 'allow-physical-actions', 'confirm-screen-visually-inspected', 'offline-fixture']
      .filter((key) => args[key]);
    if (incompatible.length) {
      throw new ExplorerError('VALIDATE_ONLY_SIDE_EFFECT_OPTIONS', `--validate-only cannot be combined with: ${incompatible.join(', ')}`, 'cli');
    }
    console.log(JSON.stringify(validation, null, 2));
    return;
  }
  if (!args.output) throw new ExplorerError('CLI_OUTPUT_MISSING', '--output is required', 'cli');
  const packageId = args.package ?? plan.packageId;
  const outputDir = path.resolve(args.output);
  let runtime;
  let authorization;
  if (args['offline-fixture']) {
    if (args.serial || args['allow-physical-actions'] || args['confirm-screen-visually-inspected']) {
      throw new ExplorerError('FIXTURE_REAL_OPTIONS_FORBIDDEN', 'Offline fixture cannot accept serial or physical-action flags', 'cli');
    }
    runtime = createOfflineFixtureRuntime({plan, policy});
    authorization = {
      physicalActionsAllowed: false,
      visualInspectionConfirmed: false,
      offlineFixture: true,
    };
  } else {
    if (!args.serial) throw new ExplorerError('CLI_SERIAL_MISSING', '--serial is required in real mode', 'cli');
    if (!args['allow-physical-actions'] || !args['confirm-screen-visually-inspected']) {
      throw new ExplorerError(
        'PHYSICAL_ACTION_CONFIRMATION_MISSING',
        'Real mode requires --allow-physical-actions and --confirm-screen-visually-inspected',
        'authorization_gate',
      );
    }
    const serialHash = `sha256:${sha256(args.serial)}`;
    if (serialHash !== plan.deviceSerialHash) {
      throw new ExplorerError('DEVICE_HASH_MISMATCH', 'CLI serial does not match plan.deviceSerialHash', 'device_gate');
    }
    runtime = await createRealRuntime({
      serial: args.serial,
      adbPath: args.adb,
      midsceneRepo: args['midscene-repo'],
    });
    authorization = {
      physicalActionsAllowed: true,
      visualInspectionConfirmed: true,
      offlineFixture: false,
    };
  }
  const result = await runExploration({
    plan,
    policy,
    packageId,
    outputDir,
    runtime,
    executionAuthorization: authorization,
  });
  console.log(JSON.stringify(result, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  cliMain().catch((error) => {
    const code = error?.code ?? 'UNEXPECTED_EXPLORER_FAILURE';
    const message = String(error?.message ?? error).replace(/(sk-|Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[redacted]');
    console.error(`${code}: ${message}`);
    process.exitCode = 1;
  });
}
