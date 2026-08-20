import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { beginFrameCapture, createEmptyDraft, gridForBox, inferGridForBox, mergeRecognitionIntoDraft, normalizeDraftShape, normalizeRecognitionOutput, prepareRecognitionForDraft, removePagesFromDraft, validateDraft, validateRecognitionConsistency } from './draft-model.mjs';
import { ELEMENT_TYPES, RECOGNITION_ACTIONS } from './element-taxonomy.mjs';

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

function sampleRecognition() {
  return {
    frameId: 'sha256:abc',
    page: { name: '设置', surfaceType: 'page', stateSummary: '默认状态', scrollableRegions: [] },
    elements: [
      {
        candidateKey: 'settings.row', label: '提醒设置', visualDescription: '设置行', elementType: 'list-item', interactive: false, enabled: true, state: null,
        approximateRegion: { x: 0.1, y: 0.2, width: 0.8, height: 0.2 }, geometryKind: 'approximate', geometryConfidence: 0.8,
        meaning: { status: 'known', description: '设置容器', evidence: meaningEvidence({ visibleTexts: ['提醒设置'] }) }, dynamicContent: false, riskSignals: [], confidence: 0.9,
      },
      {
        candidateKey: 'settings.toggle', label: '提醒开关', visualDescription: '右侧开关', elementType: 'switch', interactive: true, enabled: true, state: 'off',
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

test('宫格按完整元素边框动态分割并从左上到右下计算区域编号', () => {
  assert.deepEqual(inferGridForBox({ x: 0.1, y: 0.2, width: 0.2, height: 0.1 }), { columns: 3, rows: 6 });
  assert.deepEqual(gridForBox({ x: 0.41, y: 0.26, width: 0.1, height: 0.1 }, 4, 3), { columns: 3, rows: 2, region: 2 });
  assert.deepEqual(gridForBox({ x: 0.4, y: 0.4, width: 0.1, height: 0.1 }, 4, 4), { columns: 3, rows: 3, region: 5 });
  assert.deepEqual(gridForBox({ x: 0, y: 0.2, width: 0.02, height: 0.1 }), { columns: 12, rows: 6, region: 13 });

  const draft = mergeRecognitionIntoDraft(createEmptyDraft(), sampleRecognition(), 'model.json');
  const row = draft.elements.find((element) => element.candidateKey === 'settings.row');
  assert.deepEqual(
    { columns: row.gridColumns, rows: row.gridRows, region: row.gridRegion },
    { columns: 1, rows: 2, region: 1 },
  );
  assert.equal(row.displayCondition, '');
});

test('草稿归一化保留人工分块并根据最新边框重算区域', () => {
  const draft = mergeRecognitionIntoDraft(createEmptyDraft(), sampleRecognition(), 'model.json');
  const row = draft.elements.find((element) => element.candidateKey === 'settings.row');
  row.bbox = { x: 0.6, y: 0.6, width: 0.1, height: 0.1 };
  row.gridColumns = 4;
  row.gridRows = 4;
  row.gridRegion = 99;

  const normalized = normalizeDraftShape(draft);
  const normalizedRow = normalized.elements.find((element) => element.id === row.id);
  assert.equal(normalizedRow.gridColumns, 4);
  assert.equal(normalizedRow.gridRows, 4);
  assert.equal(normalizedRow.gridRegion, 11);
  assert.ok(!validateDraft(normalized).some((issue) => issue.code === 'grid_region_invalid'));

  normalizedRow.gridRegion = 12;
  assert.ok(validateDraft(normalized).some((issue) => issue.code === 'grid_region_invalid'));
});

test('Model A 候选转换为带 owner 的可编辑草稿', () => {
  const recognitionResult = sampleRecognition();
  const draft = mergeRecognitionIntoDraft(createEmptyDraft(), recognitionResult, 'model.json');
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
  assert.deepEqual(validateRecognitionConsistency(recognitionResult), []);
});

test('人工审核结果不会被后续 Model A 覆盖', () => {
  const recognitionResult = sampleRecognition();
  const first = mergeRecognitionIntoDraft(createEmptyDraft(), recognitionResult, 'first.json');
  first.elements[0].label = '人工名称';
  first.elements[0].reviewStatus = 'edited';
  first.elements[0].source = 'mixed';
  first.elementEditRecords.push({ elementId: first.elements[0].id, kind: 'updated', fields: ['label'], editedAt: new Date().toISOString() });
  const secondRecognition = sampleRecognition();
  secondRecognition.elements[0].label = '模型新名称';
  const second = mergeRecognitionIntoDraft(first, secondRecognition, 'second.json');
  assert.equal(second.elements[0].label, '人工名称');
  assert.equal(second.elements[0].lastModelProposal.label, '模型新名称');
});

test('草稿校验发现 owner 循环和越界 bbox', () => {
  const draft = mergeRecognitionIntoDraft(createEmptyDraft(), sampleRecognition(), 'model.json');
  draft.elements[0].parentId = draft.elements[1].id;
  draft.elements[0].ownerKind = 'component';
  draft.elements[0].bbox.width = 2;
  const issues = validateDraft(draft);
  assert.ok(issues.some((issue) => issue.code === 'owner_cycle'));
  assert.ok(issues.some((issue) => issue.code === 'bbox_invalid'));
});

test('草稿校验区分同页和跨页候选键重复，并标记全部冲突元素', () => {
  const samePageDraft = mergeRecognitionIntoDraft(createEmptyDraft(), sampleRecognition(), 'same-page.json');
  samePageDraft.elements[1].candidateKey = samePageDraft.elements[0].candidateKey;
  const samePageIssues = validateDraft(samePageDraft).filter((issue) => issue.code === 'candidate_key_duplicate_current_page');
  assert.equal(samePageIssues.length, 2);
  assert.deepEqual(new Set(samePageIssues.map((issue) => issue.elementId)), new Set(samePageDraft.elements.map((element) => element.id)));
  assert.ok(samePageIssues.every((issue) => issue.candidateKey === 'settings.row'));
  assert.ok(samePageIssues.every((issue) => issue.relatedElementIds.length === 2));
  assert.ok(samePageIssues.every((issue) => issue.message.includes('本页面')));

  const firstPageDraft = mergeRecognitionIntoDraft(createEmptyDraft(), sampleRecognition(), 'first-page.json');
  const otherPageRecognition = sampleRecognition();
  otherPageRecognition.frameId = 'sha256:other-page';
  otherPageRecognition.page.name = '提醒详情';
  otherPageRecognition.elements[0].candidateKey = 'detail.row';
  otherPageRecognition.elements[1].candidateKey = 'detail.toggle';
  otherPageRecognition.relationships = [{ fromCandidateKey: 'detail.row', type: 'contains', toCandidateKey: 'detail.toggle' }];
  otherPageRecognition.actionCandidates = [{ ...otherPageRecognition.actionCandidates[0], triggerCandidateKey: 'detail.toggle' }];
  const crossPageDraft = mergeRecognitionIntoDraft(firstPageDraft, otherPageRecognition, 'other-page.json');
  crossPageDraft.elements.find((element) => element.candidateKey === 'detail.row').candidateKey = 'settings.row';
  const crossPageIssues = validateDraft(crossPageDraft).filter((issue) => issue.code === 'candidate_key_duplicate_other_page');
  assert.equal(crossPageIssues.length, 2);
  assert.deepEqual(new Set(crossPageIssues.map((issue) => issue.elementId)), new Set(crossPageDraft.elements.filter((element) => element.candidateKey === 'settings.row').map((element) => element.id)));
  assert.ok(crossPageIssues.every((issue) => issue.pageIds.length === 2));
  assert.ok(crossPageIssues.every((issue) => issue.message.includes('其他页面')));
});

test('可修正的 Model A 几何和动作矛盾进入待审核草稿', () => {
  const recognitionResult = sampleRecognition();
  recognitionResult.elements[1].interactive = false;
  recognitionResult.elements[1].approximateRegion = { x: 0.9, y: 0.95, width: 0.2, height: 0.1 };
  const proposal = prepareRecognitionForDraft(recognitionResult);
  assert.deepEqual(proposal.elements[1].approximateRegion, { x: 0.9, y: 0.95, width: 0.1, height: 0.05 });
  assert.ok(proposal.elements[1].riskSignals.includes('geometry-clamped-to-frame'));
  assert.ok(proposal.elements[1].riskSignals.includes('model-action-inconsistent'));
  assert.equal(proposal.actionCandidates.length, 0);
});

test('旧单页草稿升级后保留 Page、Frame 和 AI 模型来源', () => {
  const legacy = mergeRecognitionIntoDraft(createEmptyDraft(), sampleRecognition(), 'model.json', 'qwen3-vl-plus');
  delete legacy.pages;
  delete legacy.elements[0].pageId;
  delete legacy.elements[0].aiModel;
  const upgraded = normalizeDraftShape(legacy);
  assert.equal(upgraded.pages.length, 1);
  assert.deepEqual(upgraded.pages[0].frameIds, ['sha256:abc']);
  assert.equal(upgraded.elements[0].pageId, upgraded.currentPageId);
  assert.equal(upgraded.elements[0].aiModel, 'qwen3-vl-plus');
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
  const draft = mergeRecognitionIntoDraft(createEmptyDraft(), sampleRecognition(), 'model.json');
  draft.elements[1].elementType = 'button';
  draft.elements[1].actionable = 'yes';
  draft.elements[1].capabilities = ['tap', 'zoom', 'tap'];
  draft.elements[1].actionEffects = [];

  const normalized = normalizeDraftShape(draft);

  assert.equal(normalized.elements[1].elementType, 'text-button');
  assert.equal('actionable' in normalized.elements[1], false);
  assert.deepEqual(normalized.elements[1].capabilities, ['tap', 'zoom']);
  assert.deepEqual(normalized.elements[1].actionEffects.map((item) => item.action), ['tap', 'zoom']);
});

test('无元素动作时交互区域归一为无', () => {
  const draft = mergeRecognitionIntoDraft(createEmptyDraft(), sampleRecognition(), 'model.json');
  draft.elements[0].interactionBoundary = 'whole_element';
  draft.elements[1].capabilities = ['none'];
  draft.elements[1].interactionBoundary = 'point_only';

  const normalized = normalizeDraftShape(draft);

  assert.equal(normalized.elements[0].interactionBoundary, 'none');
  assert.equal(normalized.elements[1].interactionBoundary, 'none');
});

test('探索新页面时保留上一页元素并建立独立 Page', () => {
  const first = mergeRecognitionIntoDraft(createEmptyDraft(), sampleRecognition(), 'first.json', 'qwen3-vl-plus');
  const nextRecognition = sampleRecognition();
  nextRecognition.frameId = 'sha256:def';
  nextRecognition.page.name = '提醒详情';
  nextRecognition.elements[0].candidateKey = 'detail.row';
  nextRecognition.elements[1].candidateKey = 'detail.toggle';
  nextRecognition.relationships = [{ fromCandidateKey: 'detail.row', type: 'contains', toCandidateKey: 'detail.toggle' }];
  nextRecognition.actionCandidates = [{ ...nextRecognition.actionCandidates[0], triggerCandidateKey: 'detail.toggle' }];
  const second = mergeRecognitionIntoDraft(first, nextRecognition, 'second.json', 'qwen3-vl-plus');
  assert.equal(second.pages.length, 2);
  assert.equal(second.elements.length, 4);
  assert.ok(second.elements.some((element) => element.candidateKey === 'settings.row'));
  assert.ok(second.elements.some((element) => element.candidateKey === 'detail.row'));
});

test('冻结新画面时使用空白待识别 Page 并保留上一页数据', () => {
  const previous = mergeRecognitionIntoDraft(createEmptyDraft(), sampleRecognition(), 'first.json', 'qwen3-vl-plus');
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
  const previous = mergeRecognitionIntoDraft(createEmptyDraft(), sampleRecognition(), 'first.json', 'qwen3-vl-plus');
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
    id: 'element-first', candidateKey: 'first', label: '按钮', visualDescription: '', elementType: 'button', role: '', capabilities: ['tap'], actionEffects: [], enabled: true,
    state: '', dynamicContent: false, bbox: { x: 0, y: 0, width: 1, height: 1 }, geometryKind: 'boundary', geometryConfidence: 1, confidence: 1,
    meaning: { status: 'unknown', description: null, evidence: { visibleTexts: [], visibleIcons: [], visibleStates: [], visualCues: [], userContext: null, unclassified: [] } },
    riskSignals: [], ownerKind: 'page', ownerRef: firstPageId, parentId: null, childrenIds: [], pageId: firstPageId, availableOnPageIds: [], interactionBoundary: 'self', reviewStatus: 'pending', source: 'human', aiModel: null, lastModelProposal: null,
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

test('没有人工编辑记录的 Model A 元素始终恢复为初始化状态', () => {
  const draft = mergeRecognitionIntoDraft(createEmptyDraft(), sampleRecognition(), 'model.json', 'qwen3-vl-plus');
  const row = draft.elements.find((element) => element.candidateKey === 'settings.row');
  row.reviewStatus = 'edited';
  row.source = 'mixed';
  const normalized = normalizeDraftShape(draft);
  const restored = normalized.elements.find((element) => element.id === row.id);
  assert.equal(restored.reviewStatus, 'pending');
  assert.equal(restored.source, 'ai');
});

test('存在人工编辑记录时保留人工修订状态', () => {
  const draft = mergeRecognitionIntoDraft(createEmptyDraft(), sampleRecognition(), 'model.json', 'qwen3-vl-plus');
  const row = draft.elements.find((element) => element.candidateKey === 'settings.row');
  row.reviewStatus = 'edited';
  row.source = 'mixed';
  draft.elementEditRecords.push({ elementId: row.id, kind: 'updated', fields: ['label'], editedAt: new Date().toISOString() });
  const normalized = normalizeDraftShape(draft);
  const preserved = normalized.elements.find((element) => element.id === row.id);
  assert.equal(preserved.reviewStatus, 'edited');
  assert.equal(preserved.source, 'mixed');
});

test('Model A 归一化保留原始输出，并仅降级含未知证据的元素', () => {
  const raw = sampleRecognition();
  raw.elements[0].meaning = { status: 'known', description: '设置容器', basis: 'visible-icon' };
  const original = structuredClone(raw);

  const { recognitionResult, normalizationIssues } = normalizeRecognitionOutput(raw);

  assert.deepEqual(raw, original);
  assert.notEqual(recognitionResult, raw);
  assert.equal(recognitionResult.elements[0].meaning.status, 'candidate');
  assert.deepEqual(recognitionResult.elements[0].meaning.evidence.unclassified, [{ type: 'model-basis', detail: 'visible-icon' }]);
  assert.ok(recognitionResult.elements[0].riskSignals.includes('meaning-evidence-needs-review'));
  assert.equal(recognitionResult.elements[1].meaning.status, 'known');
  assert.ok(!recognitionResult.elements[1].riskSignals.includes('meaning-evidence-needs-review'));
  assert.equal(normalizationIssues.length, 1);
  assert.equal(normalizationIssues[0].candidateKey, 'settings.row');
});

test('未来模型证据字段进入待归类证据，归一化结果通过 Model A Schema', async () => {
  const raw = sampleRecognition();
  raw.elements[0].meaning.evidence.glyphSignature = { family: 'search', score: 0.81 };
  const { recognitionResult } = normalizeRecognitionOutput(raw);
  const schema = JSON.parse(await readFile(new URL('./recognition-output.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  assert.deepEqual(recognitionResult.elements[0].meaning.evidence.unclassified, [
    { type: 'glyphSignature', detail: '{"family":"search","score":0.81}' },
  ]);
  assert.equal(validate(recognitionResult), true, JSON.stringify(validate.errors));
});

test('qwen3.7-flash 的 meaning 顶层字段和 candidate_key 可归一化并通过 Model A Schema', async () => {
  const raw = sampleRecognition();
  const element = raw.elements[0];
  element.candidate_key = element.candidateKey;
  delete element.candidateKey;
  element.meaning.dynamicContent = element.dynamicContent;
  element.meaning.riskSignals = ['model-placement-drift'];
  element.meaning.confidence = element.confidence;
  delete element.dynamicContent;
  delete element.riskSignals;
  delete element.confidence;

  const { recognitionResult, normalizationIssues } = normalizeRecognitionOutput(raw);
  const normalized = recognitionResult.elements[0];
  const schema = JSON.parse(await readFile(new URL('./recognition-output.schema.json', import.meta.url), 'utf8'));
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
  assert.equal(validate(recognitionResult), true, JSON.stringify(validate.errors));
});

test('qwen3-vl-plus 的 visible-icon 动作依据可归一化并通过 Model A Schema', async () => {
  const raw = sampleRecognition();
  raw.elements[0].meaning = { status: 'known', description: '设置容器', basis: 'visible-icon' };
  raw.actionCandidates[0].basis = 'visible-icon';

  const { recognitionResult, normalizationIssues } = normalizeRecognitionOutput(raw);
  const schema = JSON.parse(await readFile(new URL('./recognition-output.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  assert.equal(recognitionResult.elements[0].meaning.status, 'candidate');
  assert.deepEqual(recognitionResult.elements[0].meaning.evidence.unclassified, [{ type: 'model-basis', detail: 'visible-icon' }]);
  assert.equal(recognitionResult.actionCandidates[0].basis, 'visible-affordance');
  assert.ok(normalizationIssues.some((issue) => issue.messages.includes('actionCandidates.basis 已从 visible-icon 归一化为 visible-affordance')));
  assert.equal(validate(recognitionResult), true, JSON.stringify(validate.errors));
});

test('模型误用 container 几何类型时归一化为 boundary 并通过 Model A Schema', async () => {
  const raw = sampleRecognition();
  raw.elements[0].geometryKind = 'container';

  const { recognitionResult, normalizationIssues } = normalizeRecognitionOutput(raw);
  const schema = JSON.parse(await readFile(new URL('./recognition-output.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  assert.equal(recognitionResult.elements[0].geometryKind, 'boundary');
  assert.ok(normalizationIssues.some((issue) => issue.messages.includes('geometryKind 已从 container 归一化为 boundary')));
  assert.equal(validate(recognitionResult), true, JSON.stringify(validate.errors));
});

test('模型返回未知元素类型时留空标红所需字段并通过 Model A Schema', async () => {
  const raw = sampleRecognition();
  raw.elements[0].elementType = 'segmented-control';

  const { recognitionResult, normalizationIssues } = normalizeRecognitionOutput(raw);
  const schema = JSON.parse(await readFile(new URL('./recognition-output.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  assert.equal(recognitionResult.elements[0].elementType, '');
  assert.ok(recognitionResult.elements[0].riskSignals.includes('element-type-needs-review'));
  assert.ok(normalizationIssues.some((issue) => issue.messages.includes('elementType segmented-control 未在当前分类中，已留空等待审核')));
  assert.equal(validate(recognitionResult), true, JSON.stringify(validate.errors));
});

test('GPT-5 在未请求比较时返回文字 changes 可归一化并通过 Model A Schema', async () => {
  const raw = sampleRecognition();
  raw.comparison.changes = ['补充了结构容器', '调整了候选区域'];

  const { recognitionResult, normalizationIssues } = normalizeRecognitionOutput(raw);
  const schema = JSON.parse(await readFile(new URL('./recognition-output.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  assert.deepEqual(recognitionResult.comparison.changes, []);
  assert.ok(normalizationIssues.some((issue) => issue.messages.includes('comparison.status 为 not-requested，已移除 2 条模型说明')));
  assert.equal(validate(recognitionResult), true, JSON.stringify(validate.errors));
});

test('Model A 支持完整操作枚举并通过 Schema', async () => {
  const raw = sampleRecognition();
  raw.actionCandidates = RECOGNITION_ACTIONS.map((action) => ({ ...raw.actionCandidates[0], action }));

  const { recognitionResult, normalizationIssues } = normalizeRecognitionOutput(raw);
  const schema = JSON.parse(await readFile(new URL('./recognition-output.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  assert.deepEqual(schema.properties.elements.items.properties.elementType.enum, ['', ...ELEMENT_TYPES]);
  assert.deepEqual(schema.properties.actionCandidates.items.properties.action.enum, RECOGNITION_ACTIONS);
  assert.deepEqual(recognitionResult.actionCandidates.map((candidate) => candidate.action), RECOGNITION_ACTIONS);
  assert.equal(normalizationIssues.length, 0);
  assert.equal(validate(recognitionResult), true, JSON.stringify(validate.errors));
});

test('AI Schema、Inspector 与项目图谱模型共用完整元素类型', async () => {
  const schema = JSON.parse(await readFile(new URL('./recognition-output.schema.json', import.meta.url), 'utf8'));
  const inspectorSource = await readFile(new URL('../src/model.ts', import.meta.url), 'utf8');
  const inspectorGroupsSource = inspectorSource.match(/export const elementTypeGroups[^=]*=\s*\[([\s\S]*?)\n\];\n\nexport const elementTypeOptions/)?.[1] || '';
  const inspectorOptions = [...inspectorGroupsSource.matchAll(/\['([^']+)',\s*'([^']+)'\]/g)].map((match) => ({ value: match[1], label: match[2] }));
  const require = createRequire(import.meta.url);
  const yaml = require(fileURLToPath(new URL('../../../knowledge_graph/tools/vendor/js-yaml-4.1.1.js', import.meta.url)));
  const core = yaml.load(await readFile(new URL('../../../knowledge_graph/model/core.yaml', import.meta.url), 'utf8'));
  const coreOptions = core.optionSets['element-type'].options;

  assert.deepEqual(schema.properties.elements.items.properties.elementType.enum, ['', ...ELEMENT_TYPES]);
  assert.deepEqual(inspectorOptions.map((option) => option.value), ELEMENT_TYPES);
  assert.deepEqual(coreOptions, inspectorOptions);
});

test('输入框类型只保留单行、多行和富文本', () => {
  assert.deepEqual(
    ['input', 'text-area', 'rich-text-input'].filter((elementType) => ELEMENT_TYPES.includes(elementType)),
    ['input', 'text-area', 'rich-text-input'],
  );
  for (const removedType of ['search-input', 'password-input', 'number-input', 'amount-input', 'url-input', 'email-input', 'phone-input', 'verification-code-input', 'pin-input', 'search', 'chat-input']) {
    assert.equal(ELEMENT_TYPES.includes(removedType), false, `${removedType} 不应继续作为元素类型`);
  }
});

test('按钮开关与选择器类型按交互形态分类', () => {
  for (const elementType of ['text-button', 'icon-button', 'floating-button', 'switch', 'slider', 'dropdown-selector', 'radio', 'checkbox', 'wheel-picker', 'date-picker', 'time-picker', 'date-time-picker', 'number-picker', 'cascader', 'tag-selector', 'segmented-selector']) {
    assert.equal(ELEMENT_TYPES.includes(elementType), true, `${elementType} 应继续作为元素类型`);
  }
  for (const removedType of ['select', 'dropdown', 'spinner', 'city-picker', 'address-picker', 'autocomplete']) {
    assert.equal(ELEMENT_TYPES.includes(removedType), false, `${removedType} 不应作为笼统或业务用途型选择器`);
  }
});

test('容器合并列表、结构容器和媒体，并只保留可观察的具体形态', () => {
  for (const elementType of ['list', 'list-item', 'grouped-list', 'swipe-list', 'expandable-list', 'card', 'panel', 'section', 'form', 'table', 'chart', 'audio', 'video', 'image-viewer', 'file-preview']) {
    assert.equal(ELEMENT_TYPES.includes(elementType), true, `${elementType} 应作为容器的具体形态`);
  }
  for (const removedType of ['container', 'group', 'product-image', 'grid', 'camera', 'live-stream', 'screen-share', 'remote-control']) {
    assert.equal(ELEMENT_TYPES.includes(removedType), false, `${removedType} 不应作为元素类型`);
  }
});

test('弹层与反馈严格保留六种可观察形态', () => {
  for (const elementType of ['dialog', 'confirm-dialog', 'bottom-sheet', 'popover', 'floating-card', 'toast']) {
    assert.equal(ELEMENT_TYPES.includes(elementType), true, `${elementType} 应作为弹层与反馈类型`);
  }
  for (const removedType of ['alert', 'popup', 'tooltip', 'snackbar', 'error', 'warning', 'success', 'info', 'status', 'advertisement']) {
    assert.equal(ELEMENT_TYPES.includes(removedType), false, `${removedType} 应归入六种形态或元素描述`);
  }
});

test('交互标签统一为标签选择器，滚动仅作为元素动作', () => {
  assert.equal(ELEMENT_TYPES.includes('static-label'), true, '只读标签应统一使用静态标签');
  assert.equal(ELEMENT_TYPES.includes('tag-selector'), true, '交互标签应统一使用标签选择器');
  for (const removedType of ['label', 'static-chip', 'selectable-chip', 'filter-chip', 'action-chip', 'input-chip', 'scroll-view', 'horizontal-scroll', 'recycler-view', 'pager']) {
    assert.equal(ELEMENT_TYPES.includes(removedType), false, `${removedType} 不应继续作为元素类型`);
  }
  for (const action of ['scroll_vertical', 'scroll_horizontal', 'swipe']) {
    assert.equal(RECOGNITION_ACTIONS.includes(action), true, `${action} 应继续作为元素动作`);
  }
});

test('进度类型仅保留进度条和 Loading', () => {
  assert.deepEqual(
    ['progress-bar', 'loading'].filter((elementType) => ELEMENT_TYPES.includes(elementType)),
    ['progress-bar', 'loading'],
  );
  for (const removedType of ['circular-progress', 'skeleton', 'download-progress']) {
    assert.equal(ELEMENT_TYPES.includes(removedType), false, `${removedType} 的具体样式或功能应写入元素描述`);
  }
});

test('Model A 操作直接转换为元素支持操作', () => {
  const recognitionResult = sampleRecognition();
  recognitionResult.actionCandidates = ['scroll_vertical', 'swipe', 'long_press', 'drag', 'zoom', 'multi_touch'].map((action) => ({
    ...recognitionResult.actionCandidates[0],
    action,
  }));

  const draft = mergeRecognitionIntoDraft(createEmptyDraft(), recognitionResult, 'model.json');
  const trigger = draft.elements.find((element) => element.candidateKey === 'settings.toggle');

  assert.deepEqual(trigger.capabilities, ['scroll_vertical', 'swipe', 'long_press', 'drag', 'zoom', 'multi_touch']);
});

test('删除业务结果使用点击动作和动作效果表达', () => {
  const raw = sampleRecognition();
  raw.actionCandidates = [{
    triggerCandidateKey: raw.elements[1].candidateKey,
    action: 'tap',
    expectedOutcome: '删除该成员',
    basis: 'visible-affordance',
    riskSignals: [],
    confidence: 0.95,
  }];
  const draft = mergeRecognitionIntoDraft(createEmptyDraft(), raw, 'test-model');
  const trigger = draft.elements.find((element) => element.candidateKey === raw.elements[1].candidateKey);
  assert.deepEqual(trigger.capabilities, ['tap']);
  assert.deepEqual(trigger.actionEffects, [{ action: 'tap', effect: '删除该成员' }]);
  assert.equal(RECOGNITION_ACTIONS.includes('delete'), false);
});

test('旧草稿 meaning.basis 不迁移，缺少新证据时语义降级为未知', () => {
  const draft = mergeRecognitionIntoDraft(createEmptyDraft(), sampleRecognition(), 'model.json');
  draft.elements[0].meaning = { status: 'known', description: '旧草稿说明', basis: 'visible-text' };

  const normalized = normalizeDraftShape(draft);
  const meaning = normalized.elements[0].meaning;

  assert.equal(meaning.status, 'unknown');
  assert.equal(meaning.description, '旧草稿说明');
  assert.equal('basis' in meaning, false);
  assert.deepEqual(meaning.evidence, meaningEvidence());
});
