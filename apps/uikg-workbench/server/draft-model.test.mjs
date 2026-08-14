import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { beginFrameCapture, createEmptyDraft, mergeScoutIntoDraft, normalizeDraftShape, normalizeScoutOutput, prepareScoutForDraft, validateDraft, validateScoutConsistency } from './draft-model.mjs';
import { ELEMENT_TYPES, SCOUT_ACTIONS } from './element-taxonomy.mjs';

function meaningEvidence(overrides = {}) {
  return {
    visibleTexts: [],
    visibleIcons: [],
    visibleStates: [],
    visualCues: [],
    userContext: null,
    unclassified: [],
    ...overrides,
  };
}

function sampleScout() {
  return {
    frameId: 'sha256:abc',
    page: { name: '设置', surfaceType: 'page', stateSummary: '默认状态', scrollableRegions: [] },
    elements: [
      {
        candidateKey: 'settings.row', label: '提醒设置', visualDescription: '设置行', controlType: 'container', interactive: false, enabled: true, state: null,
        approximateRegion: { x: 0.1, y: 0.2, width: 0.8, height: 0.2 }, geometryKind: 'approximate', geometryConfidence: 0.8,
        meaning: { status: 'known', description: '设置容器', evidence: meaningEvidence({ visibleTexts: ['提醒设置'] }) }, dynamicContent: false, riskSignals: [], confidence: 0.9,
      },
      {
        candidateKey: 'settings.toggle', label: '提醒开关', visualDescription: '右侧开关', controlType: 'switch', interactive: true, enabled: true, state: 'off',
        approximateRegion: { x: 0.75, y: 0.23, width: 0.15, height: 0.1 }, geometryKind: 'tap-target', geometryConfidence: 0.75,
        meaning: { status: 'known', description: '提醒开关', evidence: meaningEvidence({ visibleStates: ['关闭'] }) }, dynamicContent: false, riskSignals: [], confidence: 0.88,
      },
    ],
    relationships: [{ fromCandidateKey: 'settings.row', type: 'contains', toCandidateKey: 'settings.toggle' }],
    actionCandidates: [{ triggerCandidateKey: 'settings.toggle', action: 'toggle', expectedOutcome: '切换提醒', basis: 'visible-affordance', riskSignals: [], confidence: 0.8 }],
    comparison: { basisFrameId: null, status: 'not-requested', changes: [] },
    uncertainties: [],
  };
}

test('Scout 候选转换为带 owner 的可编辑草稿', () => {
  const scout = sampleScout();
  const draft = mergeScoutIntoDraft(createEmptyDraft(), scout, 'model.json');
  assert.equal(draft.elements.length, 2);
  const row = draft.elements.find((item) => item.candidateKey === 'settings.row');
  const toggle = draft.elements.find((item) => item.candidateKey === 'settings.toggle');
  assert.equal(toggle.parentId, row.id);
  assert.equal(toggle.ownerKind, 'component');
  assert.deepEqual(toggle.capabilities, ['toggle']);
  assert.deepEqual(validateScoutConsistency(scout), []);
});

test('人工审核结果不会被后续 Scout 覆盖', () => {
  const scout = sampleScout();
  const first = mergeScoutIntoDraft(createEmptyDraft(), scout, 'first.json');
  first.elements[0].label = '人工名称';
  first.elements[0].reviewStatus = 'edited';
  first.elements[0].source = 'mixed';
  first.elementEditRecords.push({ elementId: first.elements[0].id, kind: 'updated', fields: ['label'], editedAt: new Date().toISOString() });
  const secondScout = sampleScout();
  secondScout.elements[0].label = '模型新名称';
  const second = mergeScoutIntoDraft(first, secondScout, 'second.json');
  assert.equal(second.elements[0].label, '人工名称');
  assert.equal(second.elements[0].lastModelProposal.label, '模型新名称');
});

test('草稿校验发现 owner 循环和越界 bbox', () => {
  const draft = mergeScoutIntoDraft(createEmptyDraft(), sampleScout(), 'model.json');
  draft.elements[0].parentId = draft.elements[1].id;
  draft.elements[0].ownerKind = 'component';
  draft.elements[0].bbox.width = 2;
  const issues = validateDraft(draft);
  assert.ok(issues.some((issue) => issue.code === 'owner_cycle'));
  assert.ok(issues.some((issue) => issue.code === 'bbox_invalid'));
});

test('可修正的 Scout 几何和动作矛盾进入待审核草稿', () => {
  const scout = sampleScout();
  scout.elements[1].interactive = false;
  scout.elements[1].approximateRegion = { x: 0.9, y: 0.95, width: 0.2, height: 0.1 };
  const proposal = prepareScoutForDraft(scout);
  assert.deepEqual(proposal.elements[1].approximateRegion, { x: 0.9, y: 0.95, width: 0.1, height: 0.05 });
  assert.ok(proposal.elements[1].riskSignals.includes('geometry-clamped-to-frame'));
  assert.ok(proposal.elements[1].riskSignals.includes('model-action-inconsistent'));
  assert.equal(proposal.actionCandidates.length, 0);
});

test('旧单页草稿升级后保留 Page、Frame 和 Scout 模型来源', () => {
  const legacy = mergeScoutIntoDraft(createEmptyDraft(), sampleScout(), 'model.json', 'qwen3-vl-plus');
  delete legacy.pages;
  delete legacy.elements[0].pageId;
  delete legacy.elements[0].scoutModel;
  const upgraded = normalizeDraftShape(legacy);
  assert.equal(upgraded.pages.length, 1);
  assert.deepEqual(upgraded.pages[0].frameIds, ['sha256:abc']);
  assert.equal(upgraded.elements[0].pageId, upgraded.currentPageId);
  assert.equal(upgraded.elements[0].scoutModel, 'qwen3-vl-plus');
});

test('支持操作使用新枚举并去重', () => {
  const draft = mergeScoutIntoDraft(createEmptyDraft(), sampleScout(), 'model.json');
  draft.elements[1].capabilities = ['tap', 'zoom', 'tap'];

  const normalized = normalizeDraftShape(draft);

  assert.deepEqual(normalized.elements[1].capabilities, ['tap', 'zoom']);
});

test('探索新页面时保留上一页元素并建立独立 Page', () => {
  const first = mergeScoutIntoDraft(createEmptyDraft(), sampleScout(), 'first.json', 'qwen3-vl-plus');
  const nextScout = sampleScout();
  nextScout.frameId = 'sha256:def';
  nextScout.page.name = '提醒详情';
  nextScout.elements[0].candidateKey = 'detail.row';
  nextScout.elements[1].candidateKey = 'detail.toggle';
  nextScout.relationships = [{ fromCandidateKey: 'detail.row', type: 'contains', toCandidateKey: 'detail.toggle' }];
  nextScout.actionCandidates = [{ ...nextScout.actionCandidates[0], triggerCandidateKey: 'detail.toggle' }];
  const second = mergeScoutIntoDraft(first, nextScout, 'second.json', 'qwen3-vl-plus');
  assert.equal(second.pages.length, 2);
  assert.equal(second.elements.length, 4);
  assert.ok(second.elements.some((element) => element.candidateKey === 'settings.row'));
  assert.ok(second.elements.some((element) => element.candidateKey === 'detail.row'));
});

test('冻结新画面时使用空白待识别 Page 并保留上一页数据', () => {
  const previous = mergeScoutIntoDraft(createEmptyDraft(), sampleScout(), 'first.json', 'qwen3-vl-plus');
  const captured = beginFrameCapture(previous, 'sha256:def');
  assert.notEqual(captured.currentPageId, previous.currentPageId);
  assert.equal(captured.currentFrameId, 'sha256:def');
  assert.equal(captured.page.name, '待识别页面');
  assert.equal(captured.pages.length, 2);
  assert.equal(captured.elements.length, previous.elements.length);
  assert.equal(captured.elements.filter((element) => element.pageId === captured.currentPageId).length, 0);
  assert.deepEqual(captured.pages.find((page) => page.id === captured.currentPageId).elementIds, []);
});

test('未识别前重复冻结复用当前空白 Page', () => {
  const previous = mergeScoutIntoDraft(createEmptyDraft(), sampleScout(), 'first.json', 'qwen3-vl-plus');
  const firstCapture = beginFrameCapture(previous, 'sha256:def');
  const secondCapture = beginFrameCapture(firstCapture, 'sha256:ghi');
  assert.equal(secondCapture.currentPageId, firstCapture.currentPageId);
  assert.equal(secondCapture.pages.length, firstCapture.pages.length);
  assert.deepEqual(secondCapture.pages.find((page) => page.id === secondCapture.currentPageId).frameIds, ['sha256:ghi']);
});

test('没有人工编辑记录的 Scout 元素始终恢复为初始化状态', () => {
  const draft = mergeScoutIntoDraft(createEmptyDraft(), sampleScout(), 'model.json', 'qwen3-vl-plus');
  const row = draft.elements.find((element) => element.candidateKey === 'settings.row');
  row.reviewStatus = 'edited';
  row.source = 'mixed';
  const normalized = normalizeDraftShape(draft);
  const restored = normalized.elements.find((element) => element.id === row.id);
  assert.equal(restored.reviewStatus, 'pending');
  assert.equal(restored.source, 'ai_scout');
});

test('存在人工编辑记录时保留人工修订状态', () => {
  const draft = mergeScoutIntoDraft(createEmptyDraft(), sampleScout(), 'model.json', 'qwen3-vl-plus');
  const row = draft.elements.find((element) => element.candidateKey === 'settings.row');
  row.reviewStatus = 'edited';
  row.source = 'mixed';
  draft.elementEditRecords.push({ elementId: row.id, kind: 'updated', fields: ['label'], editedAt: new Date().toISOString() });
  const normalized = normalizeDraftShape(draft);
  const preserved = normalized.elements.find((element) => element.id === row.id);
  assert.equal(preserved.reviewStatus, 'edited');
  assert.equal(preserved.source, 'mixed');
});

test('Scout 归一化保留原始输出，并仅降级含未知证据的元素', () => {
  const raw = sampleScout();
  raw.elements[0].meaning = { status: 'known', description: '设置容器', basis: 'visible-icon' };
  const original = structuredClone(raw);

  const { scout, normalizationIssues } = normalizeScoutOutput(raw);

  assert.deepEqual(raw, original);
  assert.notEqual(scout, raw);
  assert.equal(scout.elements[0].meaning.status, 'candidate');
  assert.deepEqual(scout.elements[0].meaning.evidence.unclassified, [{ type: 'model-basis', detail: 'visible-icon' }]);
  assert.ok(scout.elements[0].riskSignals.includes('meaning-evidence-needs-review'));
  assert.equal(scout.elements[1].meaning.status, 'known');
  assert.ok(!scout.elements[1].riskSignals.includes('meaning-evidence-needs-review'));
  assert.equal(normalizationIssues.length, 1);
  assert.equal(normalizationIssues[0].candidateKey, 'settings.row');
});

test('未来模型证据字段进入待归类证据，归一化结果通过 Scout Schema', async () => {
  const raw = sampleScout();
  raw.elements[0].meaning.evidence.glyphSignature = { family: 'search', score: 0.81 };
  const { scout } = normalizeScoutOutput(raw);
  const schema = JSON.parse(await readFile(new URL('./scout-output.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  assert.deepEqual(scout.elements[0].meaning.evidence.unclassified, [
    { type: 'glyphSignature', detail: '{"family":"search","score":0.81}' },
  ]);
  assert.equal(validate(scout), true, JSON.stringify(validate.errors));
});

test('qwen3.7-flash 的 meaning 顶层字段和 candidate_key 可归一化并通过 Scout Schema', async () => {
  const raw = sampleScout();
  const element = raw.elements[0];
  element.candidate_key = element.candidateKey;
  delete element.candidateKey;
  element.meaning.dynamicContent = element.dynamicContent;
  element.meaning.riskSignals = ['model-placement-drift'];
  element.meaning.confidence = element.confidence;
  delete element.dynamicContent;
  delete element.riskSignals;
  delete element.confidence;

  const { scout, normalizationIssues } = normalizeScoutOutput(raw);
  const normalized = scout.elements[0];
  const schema = JSON.parse(await readFile(new URL('./scout-output.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  assert.equal(normalized.candidateKey, 'settings.row');
  assert.equal('candidate_key' in normalized, false);
  assert.equal(normalized.dynamicContent, false);
  assert.equal(normalized.confidence, 0.9);
  assert.deepEqual(normalized.riskSignals, ['model-placement-drift']);
  assert.equal('dynamicContent' in normalized.meaning, false);
  assert.equal('riskSignals' in normalized.meaning, false);
  assert.equal('confidence' in normalized.meaning, false);
  assert.ok(normalizationIssues[0].messages.includes('candidate_key 已归一化为 candidateKey'));
  assert.equal(validate(scout), true, JSON.stringify(validate.errors));
});

test('qwen3-vl-plus 的 visible-icon 动作依据可归一化并通过 Scout Schema', async () => {
  const raw = sampleScout();
  raw.elements[0].meaning = { status: 'known', description: '设置容器', basis: 'visible-icon' };
  raw.actionCandidates[0].basis = 'visible-icon';

  const { scout, normalizationIssues } = normalizeScoutOutput(raw);
  const schema = JSON.parse(await readFile(new URL('./scout-output.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  assert.equal(scout.elements[0].meaning.status, 'candidate');
  assert.deepEqual(scout.elements[0].meaning.evidence.unclassified, [{ type: 'model-basis', detail: 'visible-icon' }]);
  assert.equal(scout.actionCandidates[0].basis, 'visible-affordance');
  assert.ok(normalizationIssues.some((issue) => issue.messages.includes('actionCandidates.basis 已从 visible-icon 归一化为 visible-affordance')));
  assert.equal(validate(scout), true, JSON.stringify(validate.errors));
});

test('Scout 支持完整操作枚举并通过 Schema', async () => {
  const raw = sampleScout();
  raw.actionCandidates = SCOUT_ACTIONS.map((action) => ({ ...raw.actionCandidates[0], action }));

  const { scout, normalizationIssues } = normalizeScoutOutput(raw);
  const schema = JSON.parse(await readFile(new URL('./scout-output.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  assert.deepEqual(schema.properties.elements.items.properties.controlType.enum, ELEMENT_TYPES);
  assert.deepEqual(schema.properties.actionCandidates.items.properties.action.enum, SCOUT_ACTIONS);
  assert.deepEqual(scout.actionCandidates.map((candidate) => candidate.action), SCOUT_ACTIONS);
  assert.equal(normalizationIssues.length, 0);
  assert.equal(validate(scout), true, JSON.stringify(validate.errors));
});

test('Scout 操作直接转换为元素支持操作', () => {
  const scout = sampleScout();
  scout.actionCandidates = ['scroll_vertical', 'swipe', 'long_press', 'drag', 'play', 'share'].map((action) => ({
    ...scout.actionCandidates[0],
    action,
  }));

  const draft = mergeScoutIntoDraft(createEmptyDraft(), scout, 'model.json');
  const trigger = draft.elements.find((element) => element.candidateKey === 'settings.toggle');

  assert.deepEqual(trigger.capabilities, ['scroll_vertical', 'swipe', 'long_press', 'drag', 'play', 'share']);
});

test('旧草稿 meaning.basis 不迁移，缺少新证据时语义降级为未知', () => {
  const draft = mergeScoutIntoDraft(createEmptyDraft(), sampleScout(), 'model.json');
  draft.elements[0].meaning = { status: 'known', description: '旧草稿说明', basis: 'visible-text' };

  const normalized = normalizeDraftShape(draft);
  const meaning = normalized.elements[0].meaning;

  assert.equal(meaning.status, 'unknown');
  assert.equal(meaning.description, '旧草稿说明');
  assert.equal('basis' in meaning, false);
  assert.deepEqual(meaning.evidence, meaningEvidence());
});
