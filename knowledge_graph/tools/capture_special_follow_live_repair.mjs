#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { normalizeWorkerOutput } from '../../apps/uikg-workbench/server/draft-model.mjs';
import { runWorkerModel } from '../../apps/uikg-workbench/server/worker-client.mjs';
import { buildWorkerPrompt } from '../../apps/uikg-workbench/server/worker-prompt.mjs';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const MIDSCENE_ROOT = path.resolve(
  process.env.MIDSCENE_REPO || path.join(REPO_ROOT, '../midscene'),
);
const DEVICE_REF =
  'sha256:b1485ad4b9da3cb307ec62ea7b5c062bd3753b1875f0897bdbe49cba51e5eb36';
const PACKAGE_ID = 'com.zto.connect.fat';
const BUILD_REF = 'android-package:com.zto.connect.fat@10542';
const EXPLORATION_ID =
  process.env.SPECIAL_FOLLOW_REPAIR_EXPLORATION_ID ||
  'zto-connect-fat-messages-special-follow-live-repair-20260731-attempt1';
const EXPLORATION_ROOT = path.join(
  REPO_ROOT,
  'knowledge_graph',
  'explorations',
  EXPLORATION_ID,
);
const FRAMES_ROOT = path.join(EXPLORATION_ROOT, 'frames');
const MODEL_ROOT = path.join(EXPLORATION_ROOT, 'model-results');
const ACTION_ROOT = path.join(EXPLORATION_ROOT, 'actions');
const LOCATOR_ROOT = path.join(EXPLORATION_ROOT, 'locators');
const SPEC_HASH =
  'sha256:03904e083f55a42e36b035db877d2bf575f6973426a2abde089326b51833969f';
const REMAINING_MODEL_REPAIR =
  process.env.SPECIAL_FOLLOW_REPAIR_TARGET_REMAINING === '1';
const POPUP_BACKDROP_REPAIR =
  process.env.SPECIAL_FOLLOW_REPAIR_TARGET_POPUP_BACKDROP === '1';
const execFileAsync = promisify(execFile);

const requireFromMidscene = createRequire(
  path.join(MIDSCENE_ROOT, 'packages', 'shared', 'package.json'),
);
const dotenv = requireFromMidscene('dotenv');
dotenv.config({
  path: path.join(REPO_ROOT, '.env'),
  override: true,
  quiet: true,
});

function requireConfigured(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required Midscene setting: ${name}`);
  return value;
}

const DEVICE_SERIAL = requireConfigured('ANDROID_DEVICE_SERIAL');

const modelDiagnostics = {
  worker_a: {
    slot: 'worker_a',
    name: requireConfigured('MIDSCENE_WORKER_A_MODEL_NAME'),
    family: requireConfigured('MIDSCENE_WORKER_A_MODEL_FAMILY'),
  },
  worker_b: {
    slot: 'worker_b',
    name: requireConfigured('MIDSCENE_WORKER_B_MODEL_NAME'),
    family: requireConfigured('MIDSCENE_WORKER_B_MODEL_FAMILY'),
  },
};
requireConfigured('MIDSCENE_WORKER_A_MODEL_API_KEY');
requireConfigured('MIDSCENE_WORKER_A_MODEL_BASE_URL');
requireConfigured('MIDSCENE_WORKER_B_MODEL_API_KEY');
requireConfigured('MIDSCENE_WORKER_B_MODEL_BASE_URL');
const workerSchema = JSON.parse(await readFile(path.join(REPO_ROOT, 'apps/uikg-workbench/server/worker-output.schema.json'), 'utf8'));

const { agentFromAdbDevice } = await import(
  pathToFileURL(
    path.join(MIDSCENE_ROOT, 'packages', 'android', 'dist', 'es', 'index.mjs'),
  ).href
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const capturedStates = [];
const actionRecords = [];

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function screenshotBuffer(dataUrl) {
  const match = /^data:image\/(?:png|jpeg);base64,(.+)$/s.exec(dataUrl);
  if (!match) throw new Error('Midscene screenshot is not a supported data URL');
  return Buffer.from(match[1], 'base64');
}

function safeName(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-');
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readKeepAwakeSetting() {
  const { stdout } = await execFileAsync('adb', [
    '-s',
    DEVICE_SERIAL,
    'shell',
    'settings',
    'get',
    'global',
    'stay_on_while_plugged_in',
  ]);
  return stdout.trim();
}

async function writeKeepAwakeSetting(value) {
  const operation = value === '' || value === 'null' ? 'delete' : 'put';
  const args = [
    '-s',
    DEVICE_SERIAL,
    'shell',
    'settings',
    operation,
    'global',
    'stay_on_while_plugged_in',
  ];
  if (operation === 'put') args.push(value);
  await execFileAsync('adb', args);
}

async function ensureKeepAwakeSetting() {
  if ((await readKeepAwakeSetting()) !== '7') {
    await writeKeepAwakeSetting('7');
  }
  if ((await readKeepAwakeSetting()) !== '7') {
    throw new Error('Task-level keep-awake guard is not active');
  }
}

async function archiveUnindexedRetryEvidence() {
  const previousHistory = await readJsonIfExists(
    path.join(EXPLORATION_ROOT, 'attempts', 'retry-history.json'),
  );
  const indexedFrameFiles = new Set(
    capturedStates.map((item) => path.basename(item.screenshotPath)),
  );
  const retryRoot = path.join(EXPLORATION_ROOT, 'attempts');
  const retryFramesRoot = path.join(retryRoot, 'frames');
  const archivedFrames = [];
  for (const entry of await readdir(FRAMES_ROOT, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.png')) continue;
    if (indexedFrameFiles.has(entry.name)) continue;
    await mkdir(retryFramesRoot, { recursive: true });
    await rename(
      path.join(FRAMES_ROOT, entry.name),
      path.join(retryFramesRoot, entry.name),
    );
    archivedFrames.push(`attempts/frames/${entry.name}`);
  }

  const indexedActionIds = new Set(actionRecords.map((item) => item.id));
  const nonCanonicalActions = [];
  for (const entry of await readdir(ACTION_ROOT, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const action = await readJsonIfExists(path.join(ACTION_ROOT, entry.name));
    if (!action || indexedActionIds.has(action.id)) continue;
    nonCanonicalActions.push({
      actionRef: `actions/${entry.name}`,
      actionId: action.id,
      status: action.status,
      classification: 'noncanonical_retry_or_runtime_conflict_evidence',
    });
  }
  const previousActions = previousHistory?.nonCanonicalActions || [];
  const actionById = new Map(
    [...previousActions, ...nonCanonicalActions].map((item) => [
      item.actionId,
      item,
    ]),
  );
  const retryHistory = {
    recordType: 'LiveRepairRetryHistory',
    explorationRef: EXPLORATION_ID,
    generatedAt: new Date().toISOString(),
    canonicalCoverageRef: 'evidence-index.json',
    classification:
      'Supporting retry evidence excluded from canonical coverage; failed runtime-conflict actions remain preserved.',
    archivedFrames: [
      ...new Set([...(previousHistory?.archivedFrames || []), ...archivedFrames]),
    ].sort(),
    nonCanonicalActions: [...actionById.values()].sort((a, b) =>
      a.actionId.localeCompare(b.actionId),
    ),
  };
  await writeJson(path.join(retryRoot, 'retry-history.json'), retryHistory);
  return retryHistory;
}

function validateLocator(name, located) {
  const rect = located?.rect;
  const center = located?.center;
  if (
    !rect ||
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    !Array.isArray(center) ||
    center.length !== 2 ||
    center.some((item) => !Number.isFinite(item))
  ) {
    throw new Error(`Midscene returned an invalid locator for ${name}`);
  }
}

async function locateWithRetry(agent, prompt, name) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const located = await agent.aiLocate(prompt);
      validateLocator(name, located);
      return located;
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;
      const retryDelay = String(error).includes('502') ? 60000 : 5000;
      process.stdout.write(
        `${JSON.stringify({ event: 'locator-retry', name, attempt: attempt + 1, retryDelay })}\n`,
      );
      await sleep(retryDelay);
    }
  }
  throw lastError;
}

async function readOnlyModelCallWithRetry(name, operation) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === 4) break;
      process.stdout.write(
        `${JSON.stringify({ event: 'worker-retry', name, message: `正在重试：${attempt + 1}/5` })}\n`,
      );
    }
  }
  throw lastError;
}

function requiredWorkerKeys(stateKey) {
  if (stateKey.endsWith('popup_backdrop_repair.overlay')) {
    return ['popup-backdrop'];
  }
  if (stateKey.endsWith('remaining.main_model')) {
    return [
      'members-action-row-container',
      'members-explanatory-label',
      'members-action-chevron',
      'popup-interval-row-container',
      'popup-interval-label',
      'popup-interval-current-value',
      'popup-interval-chevron',
      'sms-interval-row-container',
      'sms-interval-label',
      'sms-interval-current-value',
      'sms-interval-chevron',
      'reminder-method-row-container',
      'reminder-method-label',
      'reminder-method-current-value',
      'reminder-method-chevron',
      'night-dnd-row-container',
      'night-dnd-label',
      'night-dnd-secondary-text',
      'night-dnd-toggle',
      'sound-row-container',
      'sound-label',
      'sound-current-value',
      'sound-chevron',
    ];
  }
  if (stateKey.endsWith('remaining.popup_interval_selector')) {
    return [
      'popup-option-10-minutes-row',
      'popup-option-30-minutes-row',
      'popup-option-1-hour-row',
      'popup-option-4-hours-row',
    ];
  }
  if (stateKey.endsWith('remaining.sms_interval_selector')) {
    return ['sms-option-10-minutes-row', 'sms-option-30-minutes-row'];
  }
  if (stateKey.endsWith('remaining.reminder_method_selector')) {
    return ['reminder-method-sms-row', 'reminder-method-phone-row'];
  }
  if (stateKey.endsWith('remaining.sound_selector')) {
    return [
      'sound-default-row',
      'sound-default-label',
      'sound-default-preview',
      'sound-wave-row',
      'sound-wave-label',
      'sound-wave-preview',
      'sound-briefing-row',
      'sound-briefing-label',
      'sound-briefing-preview',
      'sound-bell-row',
      'sound-bell-label',
      'sound-bell-preview',
    ];
  }
  if (stateKey.endsWith('remaining.people')) {
    return ['member-row-container', 'member-remove-button'];
  }
  if (stateKey.includes('.remaining.')) return [];
  if (stateKey.endsWith('reminder_method_selector')) {
    return ['reminder-method-phone-option'];
  }
  const keys = [
    'popup-reminder-row-container',
    'popup-reminder-name-label',
    'popup-reminder-help-icon',
    'popup-reminder-toggle',
    'sms-phone-row-container',
    'sms-phone-name-label',
    'sms-phone-help-icon',
    'sms-phone-toggle',
    'group-dnd-row-container',
    'group-dnd-name-label',
    'group-dnd-help-icon',
    'group-dnd-toggle',
  ];
  if (stateKey.includes('popup_help_visible')) {
    keys.push('popup-reminder-help-popover');
  }
  if (stateKey.includes('sms_phone_help_visible')) {
    keys.push('sms-phone-help-popover');
  }
  if (stateKey.includes('group_dnd_help_visible')) {
    keys.push('group-dnd-help-popover');
  }
  return keys;
}

function validateWorkerAnswer(frameId, stateKey, value, label) {
  if (!value || typeof value !== 'object') {
    throw new Error(`${label} output for ${frameId} is not an object`);
  }
  if (value.frameId !== frameId) {
    throw new Error(
      `${label} frame mismatch: expected ${frameId}, got ${value.frameId}`,
    );
  }
  if (!value.page || !Array.isArray(value.elements)) {
    throw new Error(`${label} output for ${frameId} lacks page/elements`);
  }
  if (!Array.isArray(value.relationships) || !Array.isArray(value.uncertainties)) {
    throw new Error(`${label} output for ${frameId} lacks relationship fields`);
  }
  const actualKeys = new Set(value.elements.map((item) => item?.candidateKey));
  const missing = requiredWorkerKeys(stateKey).filter(
    (candidateKey) => !actualKeys.has(candidateKey),
  );
  if (missing.length) {
    throw new Error(
      `${label} output for ${stateKey} omitted required candidates: ${missing.join(', ')}`,
    );
  }
  for (const item of value.elements) {
    const region = item?.approximateRegion;
    if (
      !region ||
      ![region.x, region.y, region.width, region.height].every(Number.isFinite) ||
      region.x < 0 ||
      region.y < 0 ||
      region.width <= 0 ||
      region.height <= 0 ||
      region.x > 1 ||
      region.y > 1 ||
      region.width > 1 ||
      region.height > 1
    ) {
      throw new Error(
        `${label} output for ${stateKey} has an invalid approximateRegion on ${item?.candidateKey}`,
      );
    }
  }
  if (stateKey.includes('group_dnd_help_visible')) {
    const help = value.elements.find(
      (item) => item?.candidateKey === 'group-dnd-help-icon',
    );
    if (help?.elementType !== 'icon-button' || help?.interactive !== true) {
      throw new Error(
        `${label} must inventory the visible group-DND circled-question-mark as an interactive icon-button`,
      );
    }
  }
}

function normalizeWorkerAnswer(value) {
  return normalizeWorkerOutput(value).workerResult;
}

const workerADemand = (frameId, stateKey, validationCorrection = null) => {
  const required = requiredWorkerKeys(stateKey);
  return {
  frameId: `string, exactly \"${frameId}\"`,
  page:
    'object with name (string or null), surfaceType (page|dialog|drawer|bottom-sheet|menu|shared-component|unknown), stateSummary string, scrollableRegions unique string[]',
  elements:
    `array of every visible UI candidate. Each object must contain candidateKey string; label string|null; visualDescription string; elementType one of button|icon-button|switch|checkbox|radio|tab|menu-item|list-item|input|slider|status|badge|label|image|container|other; interactive boolean; enabled boolean|null; state string|null; approximateRegion object x,y,width,height normalized from 0 to 1; meaning object with status known|candidate|unknown, description string|null, basis visible-text|visible-state|user-context|visual-only|none; dynamicContent boolean; riskSignals unique string[]; confidence number 0..1. Inventory containers, text labels, help icons, help bubbles, switches and all other visible controls separately. This frame MUST include separate entries using these exact candidateKey values when visible: ${required.join(', ')}. Every *-row-container is a non-interactive container spanning one setting row; every *-name-label is a non-interactive label; every *-help-icon is an interactive icon-button; every *-toggle is an interactive switch; every *-help-popover is a non-interactive container; reminder-method-phone-option is the 电话 radio option. Never merge a name label, help icon, popover and switch into one switch candidate.`,
  relationships:
    'array of objects with fromCandidateKey string, type contains|labels|controls|belongs-to|adjacent-to|opens|selects, toCandidateKey string. Express row container membership and label/help/popover/switch relationships explicitly.',
  uncertainties:
    'string[] listing every uncertain meaning or interaction boundary; do not infer a whole row or nearby text is clickable merely because an icon is clickable',
  userCertifiedVisibleFacts: POPUP_BACKDROP_REPAIR
    ? 'The target is the modal backdrop above the popup-interval bottom sheet. Inventory the entire visible semi-transparent gray backdrop as candidateKey popup-backdrop, separate from the white bottom sheet, its options, the cancel button, and the top title bar. Do not reduce the backdrop to one local empty strip or one background setting row.'
    : REMAINING_MODEL_REPAIR
    ? 'Use UIKG 3.0.1 boundaries. Main-page selector rows contain a row container, non-independent label, non-independent current value, and chevron affordance; label-area taps are testing the parent row hit target, not an independent label action. The night-DND row contains a non-actionable label, non-actionable secondary explanation, and an independently actionable switch. Each sound option is one selectable row with a separate preview button. The all-members member row contains its own independent remove button. Inventory every named semantic part separately and never merge sibling hit boundaries.'
    : 'The 免打扰群通知 row visibly contains a gray circled-question-mark immediately to the right of its name in every target settings-page frame. Inventory it as candidateKey group-dnd-help-icon, elementType icon-button, interactive true, with its real non-zero visible approximateRegion. The three target setting rows visibly contain separate name labels, circled-question-mark help icons and switches; preserve their separate interaction boundaries.',
  validationCorrection,
  };
};

async function captureState(agent, stateKey, locatorDefinitions = []) {
  await ensureKeepAwakeSetting();
  await agent.freezePageContext();
  try {
    const context = await agent.getUIContext();
    const bytes = screenshotBuffer(context.screenshot.base64);
    const screenshotSha = digest(bytes);
    const frameId = `sha256:${screenshotSha}`;
    const screenshotPath = path.join(FRAMES_ROOT, `${screenshotSha}.png`);
    await mkdir(FRAMES_ROOT, { recursive: true });
    await writeFile(screenshotPath, bytes);

    const pageContext = JSON.stringify(workerADemand(frameId, stateKey));
    const prompt = buildWorkerPrompt(frameId, pageContext);
    const runWorker = (worker) => readOnlyModelCallWithRetry(
      `${stateKey}.${worker}`,
      () => runWorkerModel({
        worker,
        prompt,
        imageBuffer: bytes,
        responseSchema: workerSchema,
      }),
    );
    const [workerARaw, workerBRaw] = await Promise.all([
      runWorker('worker_a'),
      runWorker('worker_b'),
    ]);
    const workerA = normalizeWorkerAnswer(workerARaw);
    const workerB = normalizeWorkerAnswer(workerBRaw);
    validateWorkerAnswer(frameId, stateKey, workerA, 'Worker A');
    validateWorkerAnswer(frameId, stateKey, workerB, 'Worker B');
    await ensureKeepAwakeSetting();

    const locators = {};
    for (let index = 0; index < locatorDefinitions.length; index += 3) {
      const batch = locatorDefinitions.slice(index, index + 3);
      const locatedBatch = await Promise.all(
        batch.map(async (definition) => ({
          definition,
          located: await locateWithRetry(
            agent,
            definition.prompt,
            definition.key,
          ),
        })),
      );
      for (const { definition, located } of locatedBatch) {
        locators[definition.key] = {
          ...located,
          frameRef: frameId,
          prompt: definition.prompt,
          status: 'pass',
        };
      }
    }

    const observedAt = new Date(context.screenshot.capturedAt).toISOString();
    const record = {
      recordType: 'FrozenUiFrameEvidence',
      stateKey,
      frameId,
      observedAt,
      buildRef: BUILD_REF,
      deviceRef: DEVICE_REF,
      viewport: {
        width: context.shotSize.width,
        height: context.shotSize.height,
        orientation:
          context.shotSize.height >= context.shotSize.width
            ? 'portrait'
            : 'landscape',
      },
      screenshotRef: `sha256:${screenshotSha}`,
      screenshotPath: path.relative(EXPLORATION_ROOT, screenshotPath),
      dpr: context.deprecatedDpr || 1,
      workerARef: `model-results/${safeName(stateKey)}.worker-a.json`,
      workerBRef: `model-results/${safeName(stateKey)}.worker-b.json`,
      locatorRef: `locators/${safeName(stateKey)}.json`,
      evidenceStatus: 'dual_model_verified_live_frame',
      locators,
    };
    await writeJson(
      path.join(MODEL_ROOT, `${safeName(stateKey)}.worker-a.json`),
      workerA,
    );
    await writeJson(
      path.join(MODEL_ROOT, `${safeName(stateKey)}.worker-b.json`),
      workerB,
    );
    await writeJson(
      path.join(LOCATOR_ROOT, `${safeName(stateKey)}.json`),
      record,
    );
    capturedStates.push(record);
    process.stdout.write(
      `${JSON.stringify({ event: 'captured', stateKey, frameId, locators: Object.keys(locators) })}\n`,
    );
    return record;
  } finally {
    await agent.unfreezePageContext();
  }
}

async function executeTap(agent, definition, beforeFrame) {
  await ensureKeepAwakeSetting();
  const actionLocator = await locateWithRetry(
    agent,
    definition.prompt,
    definition.id,
  );
  const startedAt = new Date().toISOString();
  let assertion;
  let status = 'executed_verified';
  try {
    await agent.aiTap(definition.prompt);
    await sleep(definition.waitMs || 1400);
    assertion = await readOnlyModelCallWithRetry(
      `${definition.id}.assertion`,
      () => agent.aiAssert(definition.postcondition, undefined, {
        keepRawResponse: true,
      }),
    );
    if (!assertion?.pass) {
      status = 'unresolved';
      throw new Error(
        `Postcondition failed for ${definition.id}: ${assertion?.thought || 'unknown'}`,
      );
    }
  } catch (error) {
    const failed = {
      recordType: 'MidsceneActionTrace',
      id: definition.id,
      method: 'aiTap',
      prompt: definition.prompt,
      beforeFrameRef: beforeFrame.frameId,
      locator: actionLocator,
      startedAt,
      completedAt: new Date().toISOString(),
      postcondition: definition.postcondition,
      assertion: assertion || null,
      status,
      error: String(error),
    };
    await writeJson(path.join(ACTION_ROOT, `${safeName(definition.id)}.json`), failed);
    throw error;
  }
  const record = {
    recordType: 'MidsceneActionTrace',
    id: definition.id,
    method: 'aiTap',
    prompt: definition.prompt,
    beforeFrameRef: beforeFrame.frameId,
    locator: actionLocator,
    startedAt,
    completedAt: new Date().toISOString(),
    postcondition: definition.postcondition,
    assertion,
    status,
  };
  await writeJson(path.join(ACTION_ROOT, `${safeName(definition.id)}.json`), record);
  actionRecords.push(record);
  process.stdout.write(
    `${JSON.stringify({ event: 'action', id: definition.id, status })}\n`,
  );
  return record;
}

async function executeBack(agent, definition, beforeFrame) {
  await ensureKeepAwakeSetting();
  const startedAt = new Date().toISOString();
  let assertion;
  let status = 'executed_verified';
  try {
    await agent.back();
    await sleep(definition.waitMs || 1200);
    assertion = await readOnlyModelCallWithRetry(
      `${definition.id}.assertion`,
      () => agent.aiAssert(definition.postcondition, undefined, {
        keepRawResponse: true,
      }),
    );
    if (!assertion?.pass) {
      status = 'unresolved';
      throw new Error(
        `Postcondition failed for ${definition.id}: ${assertion?.thought || 'unknown'}`,
      );
    }
  } catch (error) {
    const failed = {
      recordType: 'MidsceneActionTrace',
      id: definition.id,
      method: 'AndroidBackButton',
      beforeFrameRef: beforeFrame.frameId,
      startedAt,
      completedAt: new Date().toISOString(),
      postcondition: definition.postcondition,
      assertion: assertion || null,
      status,
      error: String(error),
    };
    await writeJson(path.join(ACTION_ROOT, `${safeName(definition.id)}.json`), failed);
    throw error;
  }
  const record = {
    recordType: 'MidsceneActionTrace',
    id: definition.id,
    method: 'AndroidBackButton',
    beforeFrameRef: beforeFrame.frameId,
    startedAt,
    completedAt: new Date().toISOString(),
    postcondition: definition.postcondition,
    assertion,
    status,
  };
  await writeJson(path.join(ACTION_ROOT, `${safeName(definition.id)}.json`), record);
  actionRecords.push(record);
  process.stdout.write(
    `${JSON.stringify({ event: 'action', id: definition.id, status })}\n`,
  );
  return record;
}

async function resetSettingsPage(agent, id, beforeFrame) {
  await ensureKeepAwakeSetting();
  const startedAt = new Date().toISOString();
  const steps = [];
  try {
    const backPrompt =
      '定位标题为“特别关注提醒”的页面顶栏最左侧黑色向左箭头返回按钮。';
    const backLocator = await locateWithRetry(
      agent,
      backPrompt,
      `${id}-back`,
    );
    await agent.aiTap(backPrompt);
    await sleep(1300);
    const returned = await readOnlyModelCallWithRetry(
      `${id}.return-assertion`,
      () => agent.aiAssert(
        '当前已返回标题为“特别关注”的页面，右上蓝色“设置”按钮可见。',
        undefined,
        { keepRawResponse: true },
      ),
    );
    if (!returned?.pass) throw new Error(returned?.thought || 'return failed');
    steps.push({ method: 'aiTap', prompt: backPrompt, locator: backLocator, assertion: returned });

    const settingsPrompt =
      '定位标题为“特别关注”的页面中，“我的特别关注”同一行最右侧的蓝色文字按钮“设置”；不要定位成员、添加按钮或右箭头。';
    const settingsLocator = await locateWithRetry(
      agent,
      settingsPrompt,
      `${id}-settings`,
    );
    await agent.aiTap(settingsPrompt);
    await sleep(1300);
    const reentered = await readOnlyModelCallWithRetry(
      `${id}.reentry-assertion`,
      () => agent.aiAssert(
        '当前已进入标题为“特别关注提醒”的页面，并且没有显示任何深色帮助说明气泡。',
        undefined,
        { keepRawResponse: true },
      ),
    );
    if (!reentered?.pass) throw new Error(reentered?.thought || 're-entry failed');
    steps.push({
      method: 'aiTap',
      prompt: settingsPrompt,
      locator: settingsLocator,
      assertion: reentered,
    });
  } catch (error) {
    const failed = {
      recordType: 'MidsceneRecoveryTrace',
      id,
      beforeFrameRef: beforeFrame.frameId,
      startedAt,
      completedAt: new Date().toISOString(),
      steps,
      status: 'unresolved',
      error: String(error),
    };
    await writeJson(path.join(ACTION_ROOT, `${safeName(id)}.json`), failed);
    throw error;
  }
  const record = {
    recordType: 'MidsceneRecoveryTrace',
    id,
    beforeFrameRef: beforeFrame.frameId,
    startedAt,
    completedAt: new Date().toISOString(),
    steps,
    status: 'executed_verified',
  };
  await writeJson(path.join(ACTION_ROOT, `${safeName(id)}.json`), record);
  actionRecords.push(record);
  process.stdout.write(
    `${JSON.stringify({ event: 'action', id, status: record.status })}\n`,
  );
}

async function inspectCurrentPage(agent) {
  return await readOnlyModelCallWithRetry('inspect-current-page', () => agent.aiQuery({
    pageName: 'string: current visible business page title or concise identity',
    isSpecialFollowSettings:
      'boolean: true only if title is 特别关注提醒 and its settings are visible',
    isSpecialFollowPage:
      'boolean: true only if the 特别关注 page itself is visible',
    isMessagesPage:
      'boolean: true if the main 消息 page and its shortcut toolbar are visible',
    hasOpenHelpPopover: 'boolean: whether any dark help explanation bubble is visible',
    hasBlockingOverlay:
      'boolean: whether a modal, reminder, task popup or other overlay besides the target dark help bubble is blocking normal page interaction',
    blockingOverlayDescription:
      'string|null: concise visible title and safe close affordance for the blocking overlay',
  }));
}

async function navigateToSettings(agent) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = await inspectCurrentPage(agent);
    process.stdout.write(
      `${JSON.stringify({ event: 'page-check', attempt, current })}\n`,
    );
    if (current.pageName?.includes('黑')) {
      await agent.home();
      await sleep(900);
      await agent.launch(PACKAGE_ID);
      await sleep(1800);
      continue;
    }
    if (current.hasBlockingOverlay) {
      await agent.aiTap(
        '定位当前遮挡页面的弹窗或提醒层中明确用于关闭、取消、稍后处理或返回的安全控件；优先右上角关闭图标，其次“取消”“稍后”或“知道了”，绝不点击确认执行、提交或打开任务正文。',
      );
      await sleep(1400);
      continue;
    }
    if (current.isSpecialFollowSettings) return;
    if (current.isSpecialFollowPage) {
      await agent.aiTap(
        '定位标题为“特别关注”的页面中，“我的特别关注”同一行最右侧的蓝色文字按钮“设置”；不要定位成员、添加按钮或右箭头。',
      );
    } else if (current.isMessagesPage) {
      await agent.aiTap(
        '定位消息页会话列表上方快捷工具栏中的爱心图标；用户确认该入口名为“特别关注”，不要定位底部导航图标。',
      );
    } else {
      await agent.aiTap(
        '定位底部导航栏中带双对话气泡图标、文字为“消息”的标签；不要定位页面正文中的“消息”文字。',
      );
    }
    await sleep(1600);
  }
  throw new Error('Unable to navigate to 特别关注提醒 with Midscene');
}

async function loadCanonicalEvidence(extraStateNames = [], extraActionNames = []) {
  capturedStates.length = 0;
  actionRecords.length = 0;
  const stateNames = [
    'messages.special_follow.settings.collapsed',
    'messages.special_follow.settings.popup_help_visible',
    'messages.special_follow.settings.after_popup_help',
    'messages.special_follow.settings.sms_phone_help_visible',
    'messages.special_follow.settings.after_sms_phone_help',
    'messages.special_follow.settings.group_dnd_help_visible',
    'messages.special_follow.settings.reminder_method_selector',
    ...extraStateNames,
  ];
  for (const stateName of [...new Set(stateNames)]) {
    const state = await readJsonIfExists(
      path.join(LOCATOR_ROOT, `${safeName(stateName)}.json`),
    );
    if (!state) throw new Error(`Missing canonical evidence for ${stateName}`);
    capturedStates.push(state);
  }
  const actionNames = [
    'open-popup-reminder-help-live-repair',
    'reset-settings-after-popup-help-live-repair',
    'open-sms-phone-help-live-repair',
    'reset-settings-after-sms-phone-help-live-repair',
    'open-group-dnd-help-live-repair',
    'reset-settings-after-group-dnd-help-live-repair',
    'open-reminder-method-selector-live-repair',
    'cancel-reminder-method-selector-live-repair',
    ...extraActionNames,
  ];
  for (const actionName of actionNames) {
    const action = await readJsonIfExists(
      path.join(ACTION_ROOT, `${safeName(actionName)}.json`),
    );
    if (action?.status !== 'executed_verified') {
      throw new Error(`Missing canonical successful action ${actionName}`);
    }
    actionRecords.push(action);
  }
}

const baselineLocators = [
  {
    key: 'popup_reminder_row',
    prompt:
      '定位包含“单聊消息未读，弹窗提醒我”名称文案、其右侧灰色圆圈问号和最右侧开关的完整横向设置项总容器；框住该设置项整行，不包括下方间隔时间或任何弹出帮助气泡。',
  },
  {
    key: 'popup_reminder_label',
    prompt:
      '只定位设置名称文案“单聊消息未读，弹窗提醒我”的完整文字区域；不要包含右侧问号、开关或整行空白。',
  },
  {
    key: 'popup_reminder_help',
    prompt:
      '只定位“单聊消息未读，弹窗提醒我”文字紧右侧的第一枚灰色圆圈问号帮助图标；不要定位文字、开关或下方问号。',
  },
  {
    key: 'popup_reminder_toggle',
    prompt:
      '只定位“单聊消息未读，弹窗提醒我”设置项最右侧的开关；不要定位问号、文字或下方开关。',
  },
  {
    key: 'sms_phone_row',
    prompt:
      '定位包含“弹窗消息未读，短信/电话提醒我”名称文案、其右侧灰色圆圈问号和最右侧开关的完整横向设置项总容器；框住该设置项整行，不包括下方间隔时间、提醒方式或任何弹出帮助气泡。',
  },
  {
    key: 'sms_phone_label',
    prompt:
      '只定位设置名称文案“弹窗消息未读，短信/电话提醒我”的完整文字区域；不要包含右侧问号、开关或整行空白。',
  },
  {
    key: 'sms_phone_help',
    prompt:
      '只定位“弹窗消息未读，短信/电话提醒我”文字紧右侧的灰色圆圈问号帮助图标；不要定位文字、开关或其他问号。',
  },
  {
    key: 'sms_phone_toggle',
    prompt:
      '只定位“弹窗消息未读，短信/电话提醒我”设置项最右侧的开关；不要定位问号、文字或其他开关。',
  },
  {
    key: 'group_dnd_row',
    prompt:
      '定位包含“免打扰群通知”名称文案、其右侧灰色圆圈问号和最右侧开关的完整横向设置项总容器；框住该设置项整行，不包括上下相邻设置项或任何弹出帮助气泡。',
  },
  {
    key: 'group_dnd_label',
    prompt:
      '只定位设置名称文案“免打扰群通知”的完整文字区域；不要包含右侧问号、开关或整行空白。',
  },
  {
    key: 'group_dnd_help',
    prompt:
      '只定位“免打扰群通知”文字紧右侧的灰色圆圈问号帮助图标；不要定位文字、开关或上方问号。',
  },
  {
    key: 'group_dnd_toggle',
    prompt:
      '只定位“免打扰群通知”设置项最右侧的开关；不要定位问号、文字或上方开关。',
  },
];

const popupExpandedLocators = [
  ...baselineLocators.slice(0, 4),
  {
    key: 'popup_reminder_help_popover',
    prompt:
      '只定位第一项“单聊消息未读，弹窗提醒我”问号上方当前展开的深色帮助说明气泡完整边界，包含气泡正文和尖角；不要定位问号图标或设置项整行。',
  },
];

const smsExpandedLocators = [
  ...baselineLocators.slice(4, 8),
  {
    key: 'sms_phone_help_popover',
    prompt:
      '只定位“弹窗消息未读，短信/电话提醒我”问号上方当前展开的深色帮助说明气泡完整边界，包含气泡正文和尖角；不要定位问号图标或设置项整行。',
  },
];

const dndExpandedLocators = [
  ...baselineLocators.slice(8, 12),
  {
    key: 'group_dnd_help_popover',
    prompt:
      '只定位“免打扰群通知”问号上方当前展开的深色帮助说明气泡完整边界，包含气泡正文和尖角；不要定位问号图标或设置项整行。',
  },
];

const remainingMainLocators = [
  {
    key: 'members_container',
    prompt:
      '定位“我的特别关注”标题文案、右侧动态人数和最右箭头所在的完整横向入口总容器；只框这一标题入口行，不包含下方成员头像、添加或移除按钮。',
  },
  {
    key: 'members_label',
    prompt:
      '只定位“我的特别关注”五个字的说明文案区域；不要包含右侧人数、箭头或下方成员。',
  },
  {
    key: 'members_chevron',
    prompt:
      '只定位“我的特别关注”标题行最右侧、动态人数右边的黑色向右箭头图标；不要包含人数或标题文字。',
  },
  {
    key: 'popup_interval_row',
    prompt:
      '定位第一组弹窗提醒开关下方，左侧名称为“间隔时间”、右侧显示当前间隔值和向右箭头的完整横向设置行；不包含上下相邻行。',
  },
  {
    key: 'popup_interval_label',
    prompt:
      '只定位第一组弹窗提醒开关下方那一行左侧的“间隔时间”名称文字；不要包含右侧当前值、箭头或整行空白。',
  },
  {
    key: 'popup_interval_value',
    prompt:
      '只定位第一组“间隔时间”设置行右侧、向右箭头左边显示的当前时间值文字；不要包含箭头或左侧名称。',
  },
  {
    key: 'popup_interval_chevron',
    prompt:
      '只定位第一组“间隔时间”设置行最右侧的浅灰色向右箭头图标；不要包含当前值或左侧名称。',
  },
  {
    key: 'sms_interval_row',
    prompt:
      '定位短信/电话提醒开关下方，左侧名称为“间隔时间”、右侧显示当前间隔值和向右箭头的完整横向设置行；不包含上下相邻行。',
  },
  {
    key: 'sms_interval_label',
    prompt:
      '只定位短信/电话提醒开关下方那一行左侧的“间隔时间”名称文字；不要定位上方同名行，也不要包含右侧值或箭头。',
  },
  {
    key: 'sms_interval_value',
    prompt:
      '只定位短信/电话提醒开关下方“间隔时间”行右侧、向右箭头左边的当前时间值文字；不要包含箭头或左侧名称。',
  },
  {
    key: 'sms_interval_chevron',
    prompt:
      '只定位短信/电话提醒开关下方“间隔时间”行最右侧的浅灰色向右箭头图标；不要定位上方同名行的箭头。',
  },
  {
    key: 'reminder_method_row',
    prompt:
      '定位左侧为“提醒方式”、右侧显示当前方式文字和向右箭头的完整横向设置行；不包含上方间隔时间或下方夜间免打扰。',
  },
  {
    key: 'reminder_method_label',
    prompt:
      '只定位设置行左侧“提醒方式”四个字的名称文字；不要包含右侧当前方式、箭头或整行空白。',
  },
  {
    key: 'reminder_method_value',
    prompt:
      '只定位“提醒方式”行右侧、向右箭头左边显示的当前方式文字；不要包含箭头或左侧名称。',
  },
  {
    key: 'reminder_method_chevron',
    prompt:
      '只定位“提醒方式”设置行最右侧的浅灰色向右箭头图标；不要包含当前方式文字。',
  },
  {
    key: 'night_dnd_row',
    prompt:
      '定位包含“夜间免打扰”名称、最右侧开关和其下方灰色时间段说明文案的完整设置项总容器；不包含上方提醒方式或下方免打扰群通知。',
  },
  {
    key: 'night_dnd_label',
    prompt:
      '只定位“夜间免打扰”五个字的设置名称文字；不要包含开关或下方灰色说明。',
  },
  {
    key: 'night_dnd_secondary_text',
    prompt:
      '只定位“夜间免打扰”开关下方，以“开启后，在22:00至次日06:00期间”开头的完整灰色说明文案区域；不要包含标题或开关。',
  },
  {
    key: 'night_dnd_toggle',
    prompt:
      '只定位“夜间免打扰”设置项最右侧的开关；不要包含名称、说明文案或上方开关。',
  },
  {
    key: 'sound_row',
    prompt:
      '定位“个性化提醒”分区下，左侧为“特别关注提示音”、右侧显示当前提示音名称和向右箭头的完整横向设置行；不包含分区标题。',
  },
  {
    key: 'sound_label',
    prompt:
      '只定位提示音设置行左侧“特别关注提示音”文字；不要包含右侧当前值、箭头或分区标题。',
  },
  {
    key: 'sound_value',
    prompt:
      '只定位“特别关注提示音”设置行右侧、向右箭头左边显示的当前提示音名称文字；不要包含箭头。',
  },
  {
    key: 'sound_chevron',
    prompt:
      '只定位“特别关注提示音”设置行最右侧的浅灰色向右箭头图标；不要包含当前提示音名称。',
  },
];

const popupOptionLocators = [
  ['popup_option_10_minutes', '10分钟'],
  ['popup_option_30_minutes', '30分钟'],
  ['popup_option_1_hour', '1小时'],
  ['popup_option_4_hours', '4小时'],
].map(([key, label]) => ({
  key,
  prompt: `定位弹窗提醒间隔底部选择面板中“${label}”对应的完整横向选项命中行，从面板左边缘到右边缘并包含可能的左侧勾选标记和选项文字；不要包含相邻选项或取消按钮。`,
}));

const popupBackdropLocators = [
  {
    key: 'popup_backdrop',
    prompt:
      '只定位弹窗提醒间隔底部白色选择面板之外、标题栏下方的完整半透明灰色背景遮罩命中区域；横向覆盖整个页面内容区，纵向从标题栏下边缘延伸到白色选择面板上边缘。不要只框面板上方的一小条空白，不要包含顶部白色标题栏、底部白色选项面板、选项文字或取消按钮。',
  },
];

const smsOptionLocators = [
  ['sms_option_10_minutes', '10分钟'],
  ['sms_option_30_minutes', '30分钟'],
].map(([key, label]) => ({
  key,
  prompt: `定位短信/电话提醒间隔底部选择面板中“${label}”对应的完整横向选项命中行，从面板左边缘到右边缘并包含可能的左侧勾选标记和选项文字；不要包含相邻选项或取消按钮。`,
}));

const reminderMethodOptionLocators = [
  ['reminder_method_sms_row', '短信'],
  ['reminder_method_phone_row', '电话'],
].map(([key, label]) => ({
  key,
  prompt: `定位提醒方式底部选择面板中“${label}”对应的完整横向选项命中行，从面板左边缘到右边缘并包含可能的左侧勾选标记和选项文字；不要包含另一个选项或取消按钮。`,
}));

const soundOptionLocators = [
  ['default', '默认'],
  ['wave', '波浪'],
  ['briefing', '简报'],
  ['bell', '门铃'],
].flatMap(([key, label]) => [
  {
    key: `sound_${key}_row`,
    prompt: `定位提示音底部选择面板中“${label}”对应的完整横向选择行，从面板左边缘到右边缘，包含可能的左侧勾选、名称文字和右侧试听按钮；不要包含相邻行或取消按钮。`,
  },
  {
    key: `sound_${key}_label`,
    prompt: `只定位提示音面板“${label}”选项的名称文字区域；不要包含左侧勾选、右侧试听按钮或整行空白。`,
  },
  {
    key: `sound_${key}_preview`,
    prompt: `只定位提示音面板“${label}”选项最右侧的圆形播放试听按钮；不要包含名称文字或其他行的播放按钮。`,
  },
]);

const peopleLocators = [
  {
    key: 'member_row',
    prompt:
      '定位“全部成员”页面中包含成员头像、成员姓名以及最右侧“移除”按钮的完整横向成员行总容器；框住整行但不包含页面标题栏。',
  },
  {
    key: 'member_remove',
    prompt:
      '只定位“全部成员”页面成员行最右侧的“移除”按钮边界；不要包含成员头像、姓名或整行空白。',
  },
];

await mkdir(EXPLORATION_ROOT, { recursive: true });
await Promise.all(
  [FRAMES_ROOT, MODEL_ROOT, ACTION_ROOT, LOCATOR_ROOT].map((directory) =>
    mkdir(directory, { recursive: true }),
  ),
);

const scopeRecord = {
  task: {
    id: EXPLORATION_ID,
    requestedAt: new Date().toISOString(),
    objective: POPUP_BACKDROP_REPAIR
      ? '按 UIKG 3.0.1 补采弹窗提醒间隔选择器完整背景遮罩的独立实时边界，修正错误红框。'
      : REMAINING_MODEL_REPAIR
        ? '按 UIKG 3.0.1 补采特别关注剩余复合设置行、选择选项、提示音选项与试听按钮、成员行与移除按钮的独立实时边界。'
        : '补采特别关注提醒设置项容器、名称、帮助图标、帮助浮层、开关及提醒方式电话选项实时帧，修正图谱模型和红框。',
    status: 'in_progress',
  },
  application: {
    key: 'zto.connect',
    packageId: PACKAGE_ID,
    build: { environment: 'fat', versionCode: '10542' },
  },
  entry: {
    description: '消息/特别关注/特别关注提醒',
    knownFacts: POPUP_BACKDROP_REPAIR ? [
      '背景遮罩是底部白色选择面板之外的完整半透明灰色命中区域。',
      '背景遮罩不包含顶部标题栏、底部白色选择面板、选项或取消按钮。',
      '本次仅修正遮罩 Observation 的 locator/redbox，不改变元素稳定身份、owner 或 capability。',
    ] : REMAINING_MODEL_REPAIR ? [
      '页面只直接引用设置行总容器，不直接引用行内成员。',
      '主页面选择行的名称区域点击用于验证父行命中区；名称与当前值不是独立动作 Element。',
      '夜间免打扰名称与说明不可操作，开关是独立设置控件。',
      '提示音选项的选择行与右侧试听按钮是两个独立交互边界。',
      '全部成员的移除按钮是成员行总容器的独立子 Trigger。',
    ] : [
      '三个设置项均为页面直接持有的总容器。',
      '每个总容器包含名称文案、帮助图标、帮助浮层和开关四个子元素。',
      '名称文案和总容器不可点击；帮助图标和开关是独立可操作控件。',
      '旧 settings.help.* 实体是帮助图标的重复框选，应迁移到唯一帮助图标。',
    ],
  },
  scope: {
    recursion: 'targeted-live-evidence-repair',
    include: POPUP_BACKDROP_REPAIR ? [
      'popup-interval-selector-full-backdrop-locator',
    ] : REMAINING_MODEL_REPAIR ? [
      'remaining-main-setting-row-models',
      'three-interval-or-method-selector-option-pages',
      'sound-selector-options-and-preview-buttons',
      'all-members-member-row-and-remove-button',
    ] : [
      'settings-collapsed-state',
      'three-help-popover-states',
      'reminder-method-selector-phone-option',
    ],
  },
  midscene: {
    repository: MIDSCENE_ROOT,
    reloadEnvInFreshProcess: true,
    oneAndroidAgent: true,
    modelDiagnostics,
  },
  device: { serialHash: DEVICE_REF, keepAwakeForWholeTask: true },
  graph: {
    root: path.join(REPO_ROOT, 'knowledge_graph'),
    normativeSpec: {
      index: 'spec/README.md',
      version: 'UIKG 3.0.1',
      schemaVersion: '3.0.0',
      contentHash: SPEC_HASH,
      relationshipRules: 'spec/relationship-invariants.md',
      precedenceAccepted: true,
    },
    mergePolicy: 'reviewed-migration-plus-additive-upsert',
    stageBeforePublish: true,
  },
};
await writeJson(path.join(EXPLORATION_ROOT, 'scope.yaml'), scopeRecord);

process.stdout.write(`${JSON.stringify({ event: 'models', modelDiagnostics })}\n`);

let agent;
let originalKeepAwake;
let keepAwakeGuardEnabled = false;
let taskError;
let completionSummary;
try {
  originalKeepAwake = await readKeepAwakeSetting();
  await writeKeepAwakeSetting('7');
  keepAwakeGuardEnabled = true;
  await ensureKeepAwakeSetting();
  agent = await agentFromAdbDevice(DEVICE_SERIAL, {
    reportFileName: EXPLORATION_ID,
    autoPrintReportMsg: false,
    scrcpyConfig: { enabled: false },
    aiActionContext:
      '仅操作中通服 FAT 包 com.zto.connect.fat。目标是特别关注提醒设置页的只读取证与临时帮助浮层/选择面板。不得操作外部应用、支付、账号或权限。用户确认设置名称文字和设置项总容器不可点击，帮助问号和开关是独立控件。',
  });
  await navigateToSettings(agent);

  const baselinePath = path.join(
    LOCATOR_ROOT,
    'messages.special_follow.settings.collapsed.json',
  );
  const popupExpandedPath = path.join(
    LOCATOR_ROOT,
    'messages.special_follow.settings.popup_help_visible.json',
  );
  let baseline = await readJsonIfExists(baselinePath);
  let popupExpanded = await readJsonIfExists(popupExpandedPath);
  let recoveredState = await inspectCurrentPage(agent);
  let beforeSelector;

  if (POPUP_BACKDROP_REPAIR) {
    if (recoveredState.hasBlockingOverlay) {
      throw new Error('Popup-backdrop repair cannot start behind a blocking overlay');
    }
    if (recoveredState.hasOpenHelpPopover) {
      const checkpoint = await captureState(
        agent,
        'messages.special_follow.settings.popup_backdrop_repair.help_recovery_checkpoint',
      );
      await resetSettingsPage(
        agent,
        'reset-settings-before-popup-backdrop-repair',
        checkpoint,
      );
      recoveredState = await inspectCurrentPage(agent);
    }
    if (!recoveredState.isSpecialFollowSettings) {
      throw new Error('Popup-backdrop repair requires the special-follow settings page');
    }

    const beforeBackdrop = await captureState(
      agent,
      'messages.special_follow.settings.popup_backdrop_repair.before',
    );
    await executeTap(
      agent,
      {
        id: 'open-popup-interval-for-backdrop-repair',
        prompt: remainingMainLocators.find((item) => item.key === 'popup_interval_row').prompt,
        postcondition:
          '弹窗提醒间隔底部选择面板已打开，可见10分钟、30分钟、1小时、4小时和取消，面板上方显示完整半透明灰色背景遮罩。',
      },
      beforeBackdrop,
    );
    const backdrop = await captureState(
      agent,
      'messages.special_follow.settings.popup_backdrop_repair.overlay',
      popupBackdropLocators,
    );
    await executeTap(
      agent,
      {
        id: 'cancel-popup-interval-after-backdrop-repair',
        prompt: '只定位当前底部选择面板最下方居中的“取消”按钮。',
        postcondition: '底部选择面板已关闭，仍停留在特别关注提醒设置页。',
      },
      backdrop,
    );
  } else if (REMAINING_MODEL_REPAIR) {
    if (recoveredState.hasBlockingOverlay) {
      throw new Error('Remaining-model repair cannot start behind a blocking overlay');
    }
    if (recoveredState.hasOpenHelpPopover) {
      const checkpoint = await captureState(
        agent,
        'messages.special_follow.settings.remaining.help_recovery_checkpoint',
      );
      await resetSettingsPage(
        agent,
        'reset-settings-before-remaining-model-repair',
        checkpoint,
      );
      recoveredState = await inspectCurrentPage(agent);
    }
    if (!recoveredState.isSpecialFollowSettings) {
      throw new Error('Remaining-model repair requires the special-follow settings page');
    }

    const mainModel = await captureState(
      agent,
      'messages.special_follow.settings.remaining.main_model',
      remainingMainLocators,
    );

    await executeTap(
      agent,
      {
        id: 'open-popup-interval-via-label-area-uikg301',
        prompt: remainingMainLocators.find((item) => item.key === 'popup_interval_label').prompt,
        postcondition:
          '弹窗提醒间隔底部选择面板已打开，可见10分钟、30分钟、1小时、4小时和取消。',
      },
      mainModel,
    );
    const popupSelector = await captureState(
      agent,
      'messages.special_follow.settings.remaining.popup_interval_selector',
      popupOptionLocators,
    );
    await executeTap(
      agent,
      {
        id: 'cancel-popup-interval-uikg301',
        prompt: '只定位当前底部选择面板最下方居中的“取消”按钮。',
        postcondition: '底部选择面板已关闭，仍停留在特别关注提醒设置页。',
      },
      popupSelector,
    );

    const beforeSmsInterval = await captureState(
      agent,
      'messages.special_follow.settings.remaining.before_sms_interval',
    );
    await executeTap(
      agent,
      {
        id: 'open-sms-interval-via-label-area-uikg301',
        prompt: remainingMainLocators.find((item) => item.key === 'sms_interval_label').prompt,
        postcondition:
          '短信或电话提醒间隔底部选择面板已打开，可见10分钟、30分钟和取消。',
      },
      beforeSmsInterval,
    );
    const smsSelector = await captureState(
      agent,
      'messages.special_follow.settings.remaining.sms_interval_selector',
      smsOptionLocators,
    );
    await executeTap(
      agent,
      {
        id: 'cancel-sms-interval-uikg301',
        prompt: '只定位当前底部选择面板最下方居中的“取消”按钮。',
        postcondition: '底部选择面板已关闭，仍停留在特别关注提醒设置页。',
      },
      smsSelector,
    );

    const beforeReminderMethod = await captureState(
      agent,
      'messages.special_follow.settings.remaining.before_reminder_method',
    );
    await executeTap(
      agent,
      {
        id: 'open-reminder-method-via-label-area-uikg301',
        prompt: remainingMainLocators.find((item) => item.key === 'reminder_method_label').prompt,
        postcondition: '提醒方式底部选择面板已打开，可见短信、电话和取消。',
      },
      beforeReminderMethod,
    );
    const reminderSelector = await captureState(
      agent,
      'messages.special_follow.settings.remaining.reminder_method_selector',
      reminderMethodOptionLocators,
    );
    await executeTap(
      agent,
      {
        id: 'cancel-reminder-method-uikg301',
        prompt: '只定位当前底部选择面板最下方居中的“取消”按钮。',
        postcondition: '底部选择面板已关闭，仍停留在特别关注提醒设置页。',
      },
      reminderSelector,
    );

    const beforeSound = await captureState(
      agent,
      'messages.special_follow.settings.remaining.before_sound',
    );
    await executeTap(
      agent,
      {
        id: 'open-sound-via-label-area-uikg301',
        prompt: remainingMainLocators.find((item) => item.key === 'sound_label').prompt,
        postcondition:
          '提示音底部选择面板已打开，可见默认、波浪、简报、门铃、每行右侧试听按钮和取消。',
      },
      beforeSound,
    );
    const soundSelector = await captureState(
      agent,
      'messages.special_follow.settings.remaining.sound_selector',
      soundOptionLocators,
    );
    await executeTap(
      agent,
      {
        id: 'cancel-sound-uikg301',
        prompt: '只定位当前提示音底部选择面板最下方居中的“取消”按钮。',
        postcondition: '提示音选择面板已关闭，仍停留在特别关注提醒设置页。',
      },
      soundSelector,
    );

    const beforePeople = await captureState(
      agent,
      'messages.special_follow.settings.remaining.before_people',
    );
    await executeTap(
      agent,
      {
        id: 'open-all-members-via-chevron-uikg301',
        prompt: remainingMainLocators.find((item) => item.key === 'members_chevron').prompt,
        postcondition: '当前页面标题为全部成员，页面中可见成员行及其独立移除按钮。',
      },
      beforePeople,
    );
    const people = await captureState(
      agent,
      'messages.special_follow.settings.remaining.people',
      peopleLocators,
    );
    await executeTap(
      agent,
      {
        id: 'return-from-all-members-uikg301',
        prompt: '只定位“全部成员”页面顶栏最左侧的黑色向左返回箭头；不要定位右侧关闭X。',
        postcondition: '当前已返回标题为特别关注提醒的设置页面。',
      },
      people,
    );
    await captureState(
      agent,
      'messages.special_follow.settings.remaining.after_people_return',
    );
  } else if (process.env.SPECIAL_FOLLOW_REPAIR_TARGET_SMS === '1') {
    const supplementalStates = [];
    const supplementalActions = [];
    if (recoveredState.hasBlockingOverlay) {
      throw new Error('Targeted SMS repair cannot start behind a blocking overlay');
    }
    if (recoveredState.hasOpenHelpPopover) {
      const checkpoint = await captureState(
        agent,
        'messages.special_follow.settings.target_sms_recovery_checkpoint',
      );
      await resetSettingsPage(
        agent,
        'reset-settings-before-target-sms-live-repair',
        checkpoint,
      );
      supplementalStates.push(checkpoint.stateKey);
      supplementalActions.push('reset-settings-before-target-sms-live-repair');
      recoveredState = await inspectCurrentPage(agent);
    }
    if (!recoveredState.isSpecialFollowSettings || recoveredState.hasOpenHelpPopover) {
      throw new Error('Targeted SMS repair requires a collapsed settings page');
    }
    const beforeSms = await captureState(
      agent,
      'messages.special_follow.settings.target_sms_before',
    );
    await executeTap(
      agent,
      {
        id: 'open-sms-phone-help-live-repair',
        prompt: baselineLocators[6].prompt,
        postcondition:
          '第二项“弹窗消息未读，短信/电话提醒我”问号附近已显示深色帮助说明气泡，且仍停留在特别关注提醒页面。',
      },
      beforeSms,
    );
    const repairedSms = await captureState(
      agent,
      'messages.special_follow.settings.sms_phone_help_visible',
      smsExpandedLocators,
    );
    await resetSettingsPage(
      agent,
      'reset-settings-after-sms-phone-help-live-repair',
      repairedSms,
    );
    await loadCanonicalEvidence([
      'messages.special_follow.settings.target_sms_before',
      'messages.special_follow.settings.target_group_before',
      ...supplementalStates,
    ], supplementalActions);
  } else if (process.env.SPECIAL_FOLLOW_REPAIR_TARGET_GROUP === '1') {
    const supplementalStates = [];
    const supplementalActions = [];
    if (recoveredState.hasBlockingOverlay) {
      throw new Error('Targeted group repair cannot start behind a blocking overlay');
    }
    if (recoveredState.hasOpenHelpPopover) {
      const checkpoint = await captureState(
        agent,
        'messages.special_follow.settings.target_group_recovery_checkpoint',
      );
      await resetSettingsPage(
        agent,
        'reset-settings-before-target-group-live-repair',
        checkpoint,
      );
      supplementalStates.push(checkpoint.stateKey);
      supplementalActions.push('reset-settings-before-target-group-live-repair');
      recoveredState = await inspectCurrentPage(agent);
    }
    if (!recoveredState.isSpecialFollowSettings || recoveredState.hasOpenHelpPopover) {
      throw new Error('Targeted group repair requires a collapsed settings page');
    }
    const beforeGroup = await captureState(
      agent,
      'messages.special_follow.settings.target_group_before',
    );
    await executeTap(
      agent,
      {
        id: 'open-group-dnd-help-live-repair',
        prompt: baselineLocators[10].prompt,
        postcondition:
          '“免打扰群通知”问号附近已显示深色帮助说明气泡，且仍停留在特别关注提醒页面。',
      },
      beforeGroup,
    );
    const repairedGroup = await captureState(
      agent,
      'messages.special_follow.settings.group_dnd_help_visible',
      dndExpandedLocators,
    );
    await resetSettingsPage(
      agent,
      'reset-settings-after-group-dnd-help-live-repair',
      repairedGroup,
    );

    await loadCanonicalEvidence([
      'messages.special_follow.settings.target_group_before',
      ...supplementalStates,
    ], supplementalActions);
  } else {
  if (process.env.SPECIAL_FOLLOW_REPAIR_RESUME_SELECTOR === '1') {
    if (recoveredState.hasOpenHelpPopover || recoveredState.hasBlockingOverlay) {
      throw new Error('Selector resume requires an unobstructed collapsed settings page');
    }
    const resumeStateNames = [
      'messages.special_follow.settings.collapsed',
      'messages.special_follow.settings.popup_help_visible',
      'messages.special_follow.settings.after_popup_help',
      'messages.special_follow.settings.sms_phone_help_visible',
      'messages.special_follow.settings.after_sms_phone_help',
      'messages.special_follow.settings.group_dnd_help_visible',
    ];
    for (const stateName of resumeStateNames) {
      const state = await readJsonIfExists(
        path.join(LOCATOR_ROOT, `${safeName(stateName)}.json`),
      );
      if (!state) throw new Error(`Missing resume evidence for ${stateName}`);
      capturedStates.push(state);
    }
    const resumeActionNames = [
      'open-popup-reminder-help-live-repair',
      'reset-settings-after-popup-help-live-repair',
      'open-sms-phone-help-live-repair',
      'reset-settings-after-sms-phone-help-live-repair',
      'open-group-dnd-help-live-repair',
      'reset-settings-after-group-dnd-help-live-repair',
    ];
    for (const actionName of resumeActionNames) {
      const action = await readJsonIfExists(
        path.join(ACTION_ROOT, `${safeName(actionName)}.json`),
      );
      if (action?.status !== 'executed_verified') {
        throw new Error(`Missing successful resume action ${actionName}`);
      }
      actionRecords.push(action);
    }
    beforeSelector = capturedStates.find(
      (item) =>
        item.stateKey === 'messages.special_follow.settings.after_sms_phone_help',
    );
    process.stdout.write(
      `${JSON.stringify({ event: 'resume', stateKey: 'messages.special_follow.settings.before_reminder_method_selector' })}\n`,
    );
  } else {

  if (baseline && popupExpanded && recoveredState.hasOpenHelpPopover) {
    capturedStates.push(baseline, popupExpanded);
    const openPopupAction = await readJsonIfExists(
      path.join(ACTION_ROOT, 'open-popup-reminder-help-live-repair.json'),
    );
    if (openPopupAction?.status === 'executed_verified') {
      actionRecords.push(openPopupAction);
    }
    process.stdout.write(
      `${JSON.stringify({ event: 'resume', stateKey: popupExpanded.stateKey })}\n`,
    );
  } else {
    if (recoveredState.hasOpenHelpPopover) {
      await agent.aiTap(
        '定位页面浅灰色分区说明文字“来自「特别关注」的未读消息，自定义提醒方式”；点击该非操作说明区以关闭帮助气泡，不要点击问号、开关或设置行。',
      );
      await sleep(1200);
    }
    baseline = await captureState(
      agent,
      'messages.special_follow.settings.collapsed',
      baselineLocators,
    );
    await executeTap(
      agent,
      {
        id: 'open-popup-reminder-help-live-repair',
        prompt: baselineLocators[2].prompt,
        postcondition:
          '第一项“单聊消息未读，弹窗提醒我”问号附近已显示深色帮助说明气泡，且仍停留在特别关注提醒页面。',
      },
      baseline,
    );
    popupExpanded = await captureState(
      agent,
      'messages.special_follow.settings.popup_help_visible',
      popupExpandedLocators,
    );
  }

  await resetSettingsPage(
    agent,
    'reset-settings-after-popup-help-live-repair',
    popupExpanded,
  );
  const afterPopup = await captureState(
    agent,
    'messages.special_follow.settings.after_popup_help',
  );
  await executeTap(
    agent,
    {
      id: 'open-sms-phone-help-live-repair',
      prompt: baselineLocators[6].prompt,
      postcondition:
        '第二项“弹窗消息未读，短信/电话提醒我”问号附近已显示深色帮助说明气泡，且仍停留在特别关注提醒页面。',
    },
    afterPopup,
  );
  const smsExpanded = await captureState(
    agent,
    'messages.special_follow.settings.sms_phone_help_visible',
    smsExpandedLocators,
  );
  await resetSettingsPage(
    agent,
    'reset-settings-after-sms-phone-help-live-repair',
    smsExpanded,
  );
  const afterSms = await captureState(
    agent,
    'messages.special_follow.settings.after_sms_phone_help',
  );
  await executeTap(
    agent,
    {
      id: 'open-group-dnd-help-live-repair',
      prompt: baselineLocators[10].prompt,
      postcondition:
        '“免打扰群通知”问号附近已显示深色帮助说明气泡，且仍停留在特别关注提醒页面。',
    },
    afterSms,
  );
  const dndExpanded = await captureState(
    agent,
    'messages.special_follow.settings.group_dnd_help_visible',
    dndExpandedLocators,
  );
  await resetSettingsPage(
    agent,
    'reset-settings-after-group-dnd-help-live-repair',
    dndExpanded,
  );

  beforeSelector = await captureState(
    agent,
    'messages.special_follow.settings.before_reminder_method_selector',
    [{
      key: 'reminder_method_row',
      prompt:
        '定位短信/电话提醒开关下方、间隔时间行之后、夜间免打扰之前，左侧为“提醒方式”、右侧显示当前方式和右箭头的完整横向设置行。',
    }],
  );
  }
  await executeTap(
    agent,
    {
      id: 'open-reminder-method-selector-live-repair',
      prompt:
        '定位短信/电话提醒开关下方、间隔时间行之后、夜间免打扰之前，左侧为“提醒方式”、右侧显示当前方式和右箭头的完整横向设置行。',
      postcondition:
        '提醒方式底部选择面板已打开，面板中可见“短信”“电话”和“取消”。',
    },
    beforeSelector,
  );
  const selector = await captureState(
    agent,
    'messages.special_follow.settings.reminder_method_selector',
    [
      {
        key: 'reminder_method_phone',
        prompt:
          '只定位提醒方式底部选择面板第二行的“电话”文字和单选项可见内容边界；红框必须完整覆盖“电话”两个字及其同一选项的单选标识，不要偏到第一行“短信”、分隔线或最下方“取消”。',
      },
    ],
  );
  await executeTap(
    agent,
    {
      id: 'cancel-reminder-method-selector-live-repair',
      prompt: '只定位提醒方式底部选择面板最下方中央的“取消”按钮。',
      postcondition:
        '提醒方式底部选择面板已关闭，仍停留在特别关注提醒页面，提醒方式值未因取消而改变。',
    },
    selector,
  );
  }

  const coverage = {
    recordType: 'UiExplorationCoverage',
    explorationRef: EXPLORATION_ID,
    status: 'complete',
    queueEmpty: true,
    frames: capturedStates.map((item) => ({
      frameId: item.frameId,
      stateKey: item.stateKey,
      workerA: 'complete',
      workerB: 'complete',
      locators: Object.keys(item.locators),
    })),
    actions: actionRecords.map((item) => ({ id: item.id, status: item.status })),
    boundaries: [],
    unresolved: [],
  };
  await writeJson(path.join(EXPLORATION_ROOT, 'coverage.yaml'), coverage);
  await writeJson(path.join(EXPLORATION_ROOT, 'evidence-index.json'), {
    recordType: 'LiveRepairEvidenceIndex',
    explorationRef: EXPLORATION_ID,
    generatedAt: new Date().toISOString(),
    modelDiagnostics,
    frames: capturedStates,
    actions: actionRecords,
  });
  const retryHistory = await archiveUnindexedRetryEvidence();
  await writeFile(
    path.join(EXPLORATION_ROOT, 'report.md'),
    [
      POPUP_BACKDROP_REPAIR
        ? '# 弹窗提醒间隔选择背景遮罩实时补采'
        : REMAINING_MODEL_REPAIR
          ? '# 特别关注剩余 UIKG 3.0.1 模型实时补采'
          : '# 特别关注设置项实时补采',
      '',
      `- Exploration: \`${EXPLORATION_ID}\``,
      `- Build: \`${BUILD_REF}\``,
      `- Device: \`${DEVICE_REF}\``,
      `- Frames: ${capturedStates.length}`,
      `- Actions: ${actionRecords.length}`,
      '- Evidence: live Midscene Worker B + independent Worker A on frozen frames',
      POPUP_BACKDROP_REPAIR
        ? '- Scope: complete popup-interval modal backdrop boundary'
        : REMAINING_MODEL_REPAIR
          ? '- Scope: remaining setting-row profiles, selector option hit rows, sound preview children, all-members row composition'
          : '- Scope: three setting-row compositions, three help popovers, reminder-method phone option',
      `- Retry artifacts: ${retryHistory.archivedFrames.length} incomplete frames archived outside canonical coverage`,
      '',
    ].join('\n'),
    'utf8',
  );
  completionSummary = {
    frames: capturedStates.length,
    actions: actionRecords.length,
    archivedRetryFrames: retryHistory.archivedFrames.length,
  };
  scopeRecord.task.status = 'complete';
  scopeRecord.task.completedAt = new Date().toISOString();
  scopeRecord.task.evidenceSummary = completionSummary;
  scopeRecord.task.retryHistoryRef = 'attempts/retry-history.json';
} catch (error) {
  taskError = error;
} finally {
  try {
    if (agent) await agent.destroy();
  } catch (error) {
    taskError ||= error;
  }
  if (keepAwakeGuardEnabled) {
    try {
      await writeKeepAwakeSetting(originalKeepAwake);
      const restoredValue = await readKeepAwakeSetting();
      const expectedValue = originalKeepAwake || 'null';
      if (restoredValue !== expectedValue) {
        throw new Error('Unable to restore the task-level keep-awake setting');
      }
    } catch (error) {
      taskError ||= error;
    }
  }
  if (taskError) {
    scopeRecord.task.status = 'incomplete';
    scopeRecord.task.stoppedAt = new Date().toISOString();
    scopeRecord.task.failure = 'capture_validation_or_device_guard_failed';
  }
  await writeJson(path.join(EXPLORATION_ROOT, 'scope.yaml'), scopeRecord);
}

if (taskError) throw taskError;
process.stdout.write(
  `${JSON.stringify({ event: 'complete', exploration: EXPLORATION_ROOT, ...completionSummary })}\n`,
);
