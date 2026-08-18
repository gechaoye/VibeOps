import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { beginFrameCapture, createEmptyDraft, mergeWorkerIntoDraft, normalizeDraftShape, normalizeWorkerOutput, prepareWorkerForDraft, removePagesFromDraft, validateDraft, validateWorkerConsistency } from './draft-model.mjs';
import { ELEMENT_TYPES, WORKER_ACTIONS } from './element-taxonomy.mjs';

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

function sampleWorker() {
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
    actionCandidates: [{ triggerCandidateKey: 'settings.toggle', action: 'tap', expectedOutcome: '切换提醒开关状态', basis: 'visible-affordance', riskSignals: [], confidence: 0.8 }],
    comparison: { basisFrameId: null, status: 'not-requested', changes: [] },
    uncertainties: [],
  };
}

test('Worker A 候选转换为带 owner 的可编辑草稿', () => {
  const workerResult = sampleWorker();
  const draft = mergeWorkerIntoDraft(createEmptyDraft(), workerResult, 'model.json');
  assert.equal(draft.elements.length, 2);
  const row = draft.elements.find((item) => item.candidateKey === 'settings.row');
  const toggle = draft.elements.find((item) => item.candidateKey === 'settings.toggle');
  assert.equal(toggle.parentId, row.id);
  assert.equal(toggle.ownerKind, 'component');
  assert.deepEqual(row.capabilities, ['none']);
  assert.equal(row.interactionBoundary, 'none');
  assert.deepEqual(toggle.capabilities, ['tap']);
  assert.equal(toggle.interactionBoundary, 'candidate_bbox');
  assert.deepEqual(toggle.actionEffects, [{ action: 'tap', effect: '切换提醒开关状态' }]);
  assert.deepEqual(validateWorkerConsistency(workerResult), []);
});

test('人工审核结果不会被后续 Worker A 覆盖', () => {
  const workerResult = sampleWorker();
  const first = mergeWorkerIntoDraft(createEmptyDraft(), workerResult, 'first.json');
  first.elements[0].label = '人工名称';
  first.elements[0].reviewStatus = 'edited';
  first.elements[0].source = 'mixed';
  first.elementEditRecords.push({ elementId: first.elements[0].id, kind: 'updated', fields: ['label'], editedAt: new Date().toISOString() });
  const secondWorker = sampleWorker();
  secondWorker.elements[0].label = '模型新名称';
  const second = mergeWorkerIntoDraft(first, secondWorker, 'second.json');
  assert.equal(second.elements[0].label, '人工名称');
  assert.equal(second.elements[0].lastModelProposal.label, '模型新名称');
});

test('草稿校验发现 owner 循环和越界 bbox', () => {
  const draft = mergeWorkerIntoDraft(createEmptyDraft(), sampleWorker(), 'model.json');
  draft.elements[0].parentId = draft.elements[1].id;
  draft.elements[0].ownerKind = 'component';
  draft.elements[0].bbox.width = 2;
  const issues = validateDraft(draft);
  assert.ok(issues.some((issue) => issue.code === 'owner_cycle'));
  assert.ok(issues.some((issue) => issue.code === 'bbox_invalid'));
});

test('草稿校验区分同页和跨页候选键重复，并标记全部冲突元素', () => {
  const samePageDraft = mergeWorkerIntoDraft(createEmptyDraft(), sampleWorker(), 'same-page.json');
  samePageDraft.elements[1].candidateKey = samePageDraft.elements[0].candidateKey;
  const samePageIssues = validateDraft(samePageDraft).filter((issue) => issue.code === 'candidate_key_duplicate_current_page');
  assert.equal(samePageIssues.length, 2);
  assert.deepEqual(new Set(samePageIssues.map((issue) => issue.elementId)), new Set(samePageDraft.elements.map((element) => element.id)));
  assert.ok(samePageIssues.every((issue) => issue.candidateKey === 'settings.row'));
  assert.ok(samePageIssues.every((issue) => issue.relatedElementIds.length === 2));
  assert.ok(samePageIssues.every((issue) => issue.message.includes('本页面')));

  const firstPageDraft = mergeWorkerIntoDraft(createEmptyDraft(), sampleWorker(), 'first-page.json');
  const otherPageWorker = sampleWorker();
  otherPageWorker.frameId = 'sha256:other-page';
  otherPageWorker.page.name = '提醒详情';
  otherPageWorker.elements[0].candidateKey = 'detail.row';
  otherPageWorker.elements[1].candidateKey = 'detail.toggle';
  otherPageWorker.relationships = [{ fromCandidateKey: 'detail.row', type: 'contains', toCandidateKey: 'detail.toggle' }];
  otherPageWorker.actionCandidates = [{ ...otherPageWorker.actionCandidates[0], triggerCandidateKey: 'detail.toggle' }];
  const crossPageDraft = mergeWorkerIntoDraft(firstPageDraft, otherPageWorker, 'other-page.json');
  crossPageDraft.elements.find((element) => element.candidateKey === 'detail.row').candidateKey = 'settings.row';
  const crossPageIssues = validateDraft(crossPageDraft).filter((issue) => issue.code === 'candidate_key_duplicate_other_page');
  assert.equal(crossPageIssues.length, 2);
  assert.deepEqual(new Set(crossPageIssues.map((issue) => issue.elementId)), new Set(crossPageDraft.elements.filter((element) => element.candidateKey === 'settings.row').map((element) => element.id)));
  assert.ok(crossPageIssues.every((issue) => issue.pageIds.length === 2));
  assert.ok(crossPageIssues.every((issue) => issue.message.includes('其他页面')));
});

test('可修正的 Worker A 几何和动作矛盾进入待审核草稿', () => {
  const workerResult = sampleWorker();
  workerResult.elements[1].interactive = false;
  workerResult.elements[1].approximateRegion = { x: 0.9, y: 0.95, width: 0.2, height: 0.1 };
  const proposal = prepareWorkerForDraft(workerResult);
  assert.deepEqual(proposal.elements[1].approximateRegion, { x: 0.9, y: 0.95, width: 0.1, height: 0.05 });
  assert.ok(proposal.elements[1].riskSignals.includes('geometry-clamped-to-frame'));
  assert.ok(proposal.elements[1].riskSignals.includes('model-action-inconsistent'));
  assert.equal(proposal.actionCandidates.length, 0);
});

test('旧单页草稿升级后保留 Page、Frame 和 Worker A 模型来源', () => {
  const legacy = mergeWorkerIntoDraft(createEmptyDraft(), sampleWorker(), 'model.json', 'qwen3-vl-plus');
  delete legacy.pages;
  delete legacy.elements[0].pageId;
  delete legacy.elements[0].workerModel;
  const upgraded = normalizeDraftShape(legacy);
  assert.equal(upgraded.pages.length, 1);
  assert.deepEqual(upgraded.pages[0].frameIds, ['sha256:abc']);
  assert.equal(upgraded.elements[0].pageId, upgraded.currentPageId);
  assert.equal(upgraded.elements[0].workerModel, 'qwen3-vl-plus');
});

test('零页面草稿再次冻结时创建新的待识别页面', () => {
  const empty = createEmptyDraft();
  empty.currentPageId = 'draft-page-empty';
  empty.page = { id: 'draft-page-empty', key: 'page.empty', name: '', surfaceType: 'unknown', stateSummary: '', scrollableRegions: [] };

  const normalized = normalizeDraftShape(empty);
  assert.equal(normalized.pages.length, 0);

  const captured = beginFrameCapture(normalized, 'sha256:new-frame');
  assert.equal(captured.pages.length, 1);
  assert.equal(captured.currentFrameId, 'sha256:new-frame');
  assert.equal(captured.currentPageId, captured.pages[0].id);
  assert.equal(captured.pages[0].name, '待识别页面');
});

test('支持操作使用新枚举并去重', () => {
  const draft = mergeWorkerIntoDraft(createEmptyDraft(), sampleWorker(), 'model.json');
  draft.elements[1].controlType = 'button';
  draft.elements[1].actionable = 'yes';
  draft.elements[1].capabilities = ['tap', 'zoom', 'tap'];
  draft.elements[1].actionEffects = [];

  const normalized = normalizeDraftShape(draft);

  assert.equal(normalized.elements[1].controlType, 'text-button');
  assert.equal('actionable' in normalized.elements[1], false);
  assert.deepEqual(normalized.elements[1].capabilities, ['tap', 'zoom']);
  assert.deepEqual(normalized.elements[1].actionEffects.map((item) => item.action), ['tap', 'zoom']);
});

test('无元素动作时交互区域归一为无', () => {
  const draft = mergeWorkerIntoDraft(createEmptyDraft(), sampleWorker(), 'model.json');
  draft.elements[0].interactionBoundary = 'whole_element';
  draft.elements[1].capabilities = ['none'];
  draft.elements[1].interactionBoundary = 'point_only';

  const normalized = normalizeDraftShape(draft);

  assert.equal(normalized.elements[0].interactionBoundary, 'none');
  assert.equal(normalized.elements[1].interactionBoundary, 'none');
});

test('探索新页面时保留上一页元素并建立独立 Page', () => {
  const first = mergeWorkerIntoDraft(createEmptyDraft(), sampleWorker(), 'first.json', 'qwen3-vl-plus');
  const nextWorker = sampleWorker();
  nextWorker.frameId = 'sha256:def';
  nextWorker.page.name = '提醒详情';
  nextWorker.elements[0].candidateKey = 'detail.row';
  nextWorker.elements[1].candidateKey = 'detail.toggle';
  nextWorker.relationships = [{ fromCandidateKey: 'detail.row', type: 'contains', toCandidateKey: 'detail.toggle' }];
  nextWorker.actionCandidates = [{ ...nextWorker.actionCandidates[0], triggerCandidateKey: 'detail.toggle' }];
  const second = mergeWorkerIntoDraft(first, nextWorker, 'second.json', 'qwen3-vl-plus');
  assert.equal(second.pages.length, 2);
  assert.equal(second.elements.length, 4);
  assert.ok(second.elements.some((element) => element.candidateKey === 'settings.row'));
  assert.ok(second.elements.some((element) => element.candidateKey === 'detail.row'));
});

test('冻结新画面时使用空白待识别 Page 并保留上一页数据', () => {
  const previous = mergeWorkerIntoDraft(createEmptyDraft(), sampleWorker(), 'first.json', 'qwen3-vl-plus');
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
  const previous = mergeWorkerIntoDraft(createEmptyDraft(), sampleWorker(), 'first.json', 'qwen3-vl-plus');
  const firstCapture = beginFrameCapture(previous, 'sha256:def');
  const secondCapture = beginFrameCapture(firstCapture, 'sha256:ghi');
  assert.equal(secondCapture.currentPageId, firstCapture.currentPageId);
  assert.equal(secondCapture.pages.length, firstCapture.pages.length);
  assert.deepEqual(secondCapture.pages.find((page) => page.id === secondCapture.currentPageId).frameIds, ['sha256:ghi']);
});

test('按指定 Page 替换未标注画面时不受当前 Page 影响', () => {
  const firstCapture = beginFrameCapture(createEmptyDraft(), 'sha256:first', { forceNewPage: true });
  const secondCapture = beginFrameCapture(firstCapture, 'sha256:second', { forceNewPage: true });
  const firstPageId = firstCapture.currentPageId;
  const replaced = beginFrameCapture(secondCapture, 'sha256:first-replaced', { replacePageId: firstPageId });

  assert.equal(replaced.currentPageId, firstPageId);
  assert.equal(replaced.pages.length, secondCapture.pages.length);
  assert.deepEqual(replaced.pages.find((page) => page.id === firstPageId).frameIds, ['sha256:first-replaced']);
  assert.deepEqual(replaced.pages.find((page) => page.id === secondCapture.currentPageId).frameIds, ['sha256:second']);
});

test('强制新建时为每个冻结帧创建独立待识别 Page', () => {
  const firstCapture = beginFrameCapture(createEmptyDraft(), 'sha256:first', { forceNewPage: true });
  const secondCapture = beginFrameCapture(firstCapture, 'sha256:second', { forceNewPage: true });

  assert.equal(secondCapture.pages.length, 2);
  assert.notEqual(secondCapture.pages[0].id, secondCapture.pages[1].id);
  assert.deepEqual(secondCapture.pages.map((page) => page.frameIds), [['sha256:first'], ['sha256:second']]);
  assert.equal(secondCapture.currentPageId, secondCapture.pages[1].id);
  assert.equal(secondCapture.pages[1].elementIds.length, 0);
});

test('批量删除 Page 时同步清理元素、跳转关系和当前页面', () => {
  const first = beginFrameCapture(createEmptyDraft(), 'sha256:first', { forceNewPage: true });
  const second = beginFrameCapture(first, 'sha256:second', { forceNewPage: true });
  const firstPageId = second.pages[0].id;
  const secondPageId = second.pages[1].id;
  second.elements = [{
    id: 'element-first', candidateKey: 'first', label: '按钮', visualDescription: '', controlType: 'button', role: '', capabilities: ['tap'], actionEffects: [], enabled: true,
    state: '', dynamicContent: false, bbox: { x: 0, y: 0, width: 1, height: 1 }, geometryKind: 'boundary', geometryConfidence: 1, confidence: 1,
    meaning: { status: 'unknown', description: null, evidence: { visibleTexts: [], visibleIcons: [], visibleStates: [], visualCues: [], userContext: null, unclassified: [] } },
    riskSignals: [], ownerKind: 'page', ownerRef: firstPageId, parentId: null, childrenIds: [], pageId: firstPageId, availableOnPageIds: [], interactionBoundary: 'self', reviewStatus: 'pending', source: 'human', workerModel: null, lastModelProposal: null,
  }];
  second.transitions = [{ id: 'transition-first', sourcePageId: firstPageId, targetPageId: secondPageId, triggerElementId: 'element-first' }];
  const removed = removePagesFromDraft(second, [secondPageId]);
  assert.equal(removed.pages.length, 1);
  assert.equal(removed.currentPageId, firstPageId);
  assert.equal(removed.currentFrameId, 'sha256:first');
  assert.equal(removed.transitions.length, 0);
  assert.equal(removed.elements.length, 1);
  assert.equal(removed.revision, second.revision + 1);
});

test('没有人工编辑记录的 Worker A 元素始终恢复为初始化状态', () => {
  const draft = mergeWorkerIntoDraft(createEmptyDraft(), sampleWorker(), 'model.json', 'qwen3-vl-plus');
  const row = draft.elements.find((element) => element.candidateKey === 'settings.row');
  row.reviewStatus = 'edited';
  row.source = 'mixed';
  const normalized = normalizeDraftShape(draft);
  const restored = normalized.elements.find((element) => element.id === row.id);
  assert.equal(restored.reviewStatus, 'pending');
  assert.equal(restored.source, 'ai_worker');
});

test('存在人工编辑记录时保留人工修订状态', () => {
  const draft = mergeWorkerIntoDraft(createEmptyDraft(), sampleWorker(), 'model.json', 'qwen3-vl-plus');
  const row = draft.elements.find((element) => element.candidateKey === 'settings.row');
  row.reviewStatus = 'edited';
  row.source = 'mixed';
  draft.elementEditRecords.push({ elementId: row.id, kind: 'updated', fields: ['label'], editedAt: new Date().toISOString() });
  const normalized = normalizeDraftShape(draft);
  const preserved = normalized.elements.find((element) => element.id === row.id);
  assert.equal(preserved.reviewStatus, 'edited');
  assert.equal(preserved.source, 'mixed');
});

test('Worker A 归一化保留原始输出，并仅降级含未知证据的元素', () => {
  const raw = sampleWorker();
  raw.elements[0].meaning = { status: 'known', description: '设置容器', basis: 'visible-icon' };
  const original = structuredClone(raw);

  const { workerResult, normalizationIssues } = normalizeWorkerOutput(raw);

  assert.deepEqual(raw, original);
  assert.notEqual(workerResult, raw);
  assert.equal(workerResult.elements[0].meaning.status, 'candidate');
  assert.deepEqual(workerResult.elements[0].meaning.evidence.unclassified, [{ type: 'model-basis', detail: 'visible-icon' }]);
  assert.ok(workerResult.elements[0].riskSignals.includes('meaning-evidence-needs-review'));
  assert.equal(workerResult.elements[1].meaning.status, 'known');
  assert.ok(!workerResult.elements[1].riskSignals.includes('meaning-evidence-needs-review'));
  assert.equal(normalizationIssues.length, 1);
  assert.equal(normalizationIssues[0].candidateKey, 'settings.row');
});

test('未来模型证据字段进入待归类证据，归一化结果通过 Worker A Schema', async () => {
  const raw = sampleWorker();
  raw.elements[0].meaning.evidence.glyphSignature = { family: 'search', score: 0.81 };
  const { workerResult } = normalizeWorkerOutput(raw);
  const schema = JSON.parse(await readFile(new URL('./worker-output.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  assert.deepEqual(workerResult.elements[0].meaning.evidence.unclassified, [
    { type: 'glyphSignature', detail: '{"family":"search","score":0.81}' },
  ]);
  assert.equal(validate(workerResult), true, JSON.stringify(validate.errors));
});

test('qwen3.7-flash 的 meaning 顶层字段和 candidate_key 可归一化并通过 Worker A Schema', async () => {
  const raw = sampleWorker();
  const element = raw.elements[0];
  element.candidate_key = element.candidateKey;
  delete element.candidateKey;
  element.meaning.dynamicContent = element.dynamicContent;
  element.meaning.riskSignals = ['model-placement-drift'];
  element.meaning.confidence = element.confidence;
  delete element.dynamicContent;
  delete element.riskSignals;
  delete element.confidence;

  const { workerResult, normalizationIssues } = normalizeWorkerOutput(raw);
  const normalized = workerResult.elements[0];
  const schema = JSON.parse(await readFile(new URL('./worker-output.schema.json', import.meta.url), 'utf8'));
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
  assert.equal(validate(workerResult), true, JSON.stringify(validate.errors));
});

test('qwen3-vl-plus 的 visible-icon 动作依据可归一化并通过 Worker A Schema', async () => {
  const raw = sampleWorker();
  raw.elements[0].meaning = { status: 'known', description: '设置容器', basis: 'visible-icon' };
  raw.actionCandidates[0].basis = 'visible-icon';

  const { workerResult, normalizationIssues } = normalizeWorkerOutput(raw);
  const schema = JSON.parse(await readFile(new URL('./worker-output.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  assert.equal(workerResult.elements[0].meaning.status, 'candidate');
  assert.deepEqual(workerResult.elements[0].meaning.evidence.unclassified, [{ type: 'model-basis', detail: 'visible-icon' }]);
  assert.equal(workerResult.actionCandidates[0].basis, 'visible-affordance');
  assert.ok(normalizationIssues.some((issue) => issue.messages.includes('actionCandidates.basis 已从 visible-icon 归一化为 visible-affordance')));
  assert.equal(validate(workerResult), true, JSON.stringify(validate.errors));
});

test('模型误用 container 几何类型时归一化为 boundary 并通过 Worker A Schema', async () => {
  const raw = sampleWorker();
  raw.elements[0].geometryKind = 'container';

  const { workerResult, normalizationIssues } = normalizeWorkerOutput(raw);
  const schema = JSON.parse(await readFile(new URL('./worker-output.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  assert.equal(workerResult.elements[0].geometryKind, 'boundary');
  assert.ok(normalizationIssues.some((issue) => issue.messages.includes('geometryKind 已从 container 归一化为 boundary')));
  assert.equal(validate(workerResult), true, JSON.stringify(validate.errors));
});

test('模型返回未知元素类型时留空标红所需字段并通过 Worker A Schema', async () => {
  const raw = sampleWorker();
  raw.elements[0].controlType = 'segmented-control';

  const { workerResult, normalizationIssues } = normalizeWorkerOutput(raw);
  const schema = JSON.parse(await readFile(new URL('./worker-output.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  assert.equal(workerResult.elements[0].controlType, '');
  assert.ok(workerResult.elements[0].riskSignals.includes('control-type-needs-review'));
  assert.ok(normalizationIssues.some((issue) => issue.messages.includes('controlType segmented-control 未在当前分类中，已留空等待审核')));
  assert.equal(validate(workerResult), true, JSON.stringify(validate.errors));
});

test('GPT-5 在未请求比较时返回文字 changes 可归一化并通过 Worker A Schema', async () => {
  const raw = sampleWorker();
  raw.comparison.changes = ['补充了结构容器', '调整了候选区域'];

  const { workerResult, normalizationIssues } = normalizeWorkerOutput(raw);
  const schema = JSON.parse(await readFile(new URL('./worker-output.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  assert.deepEqual(workerResult.comparison.changes, []);
  assert.ok(normalizationIssues.some((issue) => issue.messages.includes('comparison.status 为 not-requested，已移除 2 条模型说明')));
  assert.equal(validate(workerResult), true, JSON.stringify(validate.errors));
});

test('Worker A 支持完整操作枚举并通过 Schema', async () => {
  const raw = sampleWorker();
  raw.actionCandidates = WORKER_ACTIONS.map((action) => ({ ...raw.actionCandidates[0], action }));

  const { workerResult, normalizationIssues } = normalizeWorkerOutput(raw);
  const schema = JSON.parse(await readFile(new URL('./worker-output.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  assert.deepEqual(schema.properties.elements.items.properties.controlType.enum, ['', ...ELEMENT_TYPES]);
  assert.deepEqual(schema.properties.actionCandidates.items.properties.action.enum, WORKER_ACTIONS);
  assert.deepEqual(workerResult.actionCandidates.map((candidate) => candidate.action), WORKER_ACTIONS);
  assert.equal(normalizationIssues.length, 0);
  assert.equal(validate(workerResult), true, JSON.stringify(validate.errors));
});

test('Worker A 操作直接转换为元素支持操作', () => {
  const workerResult = sampleWorker();
  workerResult.actionCandidates = ['scroll_vertical', 'swipe', 'long_press', 'drag', 'zoom', 'multi_touch'].map((action) => ({
    ...workerResult.actionCandidates[0],
    action,
  }));

  const draft = mergeWorkerIntoDraft(createEmptyDraft(), workerResult, 'model.json');
  const trigger = draft.elements.find((element) => element.candidateKey === 'settings.toggle');

  assert.deepEqual(trigger.capabilities, ['scroll_vertical', 'swipe', 'long_press', 'drag', 'zoom', 'multi_touch']);
});

test('旧草稿 meaning.basis 不迁移，缺少新证据时语义降级为未知', () => {
  const draft = mergeWorkerIntoDraft(createEmptyDraft(), sampleWorker(), 'model.json');
  draft.elements[0].meaning = { status: 'known', description: '旧草稿说明', basis: 'visible-text' };

  const normalized = normalizeDraftShape(draft);
  const meaning = normalized.elements[0].meaning;

  assert.equal(meaning.status, 'unknown');
  assert.equal(meaning.description, '旧草稿说明');
  assert.equal('basis' in meaning, false);
  assert.deepEqual(meaning.evidence, meaningEvidence());
});
