import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { appendFrameToPage, appendRecognitionIntoDraft, beginFrameCapture, createEmptyDraft, gridForBox, inferGridForBox, mergeRecognitionIntoDraft, normalizeDraftShape, normalizeRecognitionOutput, prepareRecognitionForDraft, removeFrameFromPage, removePagesFromDraft, validateDraft, validateRecognitionConsistency } from './draft-model.mjs';
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

test('旧草稿归一化时移除已经落盘的系统栏元素及其子元素', () => {
  const draft = mergeRecognitionIntoDraft(createEmptyDraft(), sampleRecognition(), 'model.json');
  const row = draft.elements.find((element) => element.candidateKey === 'settings.row');
  const systemBar = {
    ...structuredClone(row),
    id: 'system-bar-id',
    candidateKey: 'system_status',
    label: '系统状态栏',
    elementType: 'status-bar',
  };
  const systemChild = {
    ...structuredClone(row),
    id: 'system-child-id',
    candidateKey: 'system_time',
    label: '系统时间',
    elementType: 'text',
    parentId: systemBar.id,
  };
  draft.elements.push(systemBar, systemChild);
  draft.elementEditRecords.push({ elementId: systemChild.id, kind: 'updated', fields: ['bbox'], editedAt: new Date().toISOString() });

  const normalized = normalizeDraftShape(draft);

  assert.ok(!normalized.elements.some((element) => ['system-bar-id', 'system-child-id'].includes(element.id)));
  assert.ok(!normalized.elementEditRecords.some((record) => record.elementId === systemChild.id));
});

test('单模型候选转换为带 owner 的可编辑草稿', () => {
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

test('人工审核结果不会被后续 单模型覆盖', () => {
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

test('截图已有目标 Page 时识别不会因页面名称变化创建新 Page', () => {
  const captured = beginFrameCapture(createEmptyDraft(), 'sha256:captured-frame', { forceNewPage: true });
  const pageId = captured.currentPageId;
  const recognitionResult = sampleRecognition();
  recognitionResult.frameId = 'sha256:captured-frame';
  recognitionResult.page.name = '模型识别出的页面名称';

  const merged = mergeRecognitionIntoDraft(
    captured,
    recognitionResult,
    'captured-page.json',
    'test-model',
    { preservePageIdentity: true },
  );

  assert.equal(merged.currentPageId, pageId);
  assert.equal(merged.pages.length, captured.pages.length);
  assert.equal(merged.pages.find((page) => page.id === pageId)?.name, '模型识别出的页面名称');
});

test('增量识别跳过重复候选并仅追加新元素', () => {
  const first = mergeRecognitionIntoDraft(createEmptyDraft(), sampleRecognition(), 'first.json');
  const originalToggle = structuredClone(first.elements.find((element) => element.candidateKey === 'settings.toggle'));
  const incremental = sampleRecognition();
  incremental.frameId = 'sha256:new-frame';
  incremental.elements.find((element) => element.candidateKey === 'settings.toggle').label = '模型重复开关';
  incremental.elements.push({
    candidateKey: 'settings.help', label: '帮助入口', visualDescription: '新增帮助按钮', elementType: 'button', interactive: true, enabled: true, state: null,
    approximateRegion: { x: 0.8, y: 0.82, width: 0.12, height: 0.08 }, geometryKind: 'tap-target', geometryConfidence: 0.82,
    meaning: { status: 'known', description: '进入帮助页面', evidence: meaningEvidence({ visibleTexts: ['帮助'] }) }, dynamicContent: false, riskSignals: [], confidence: 0.91,
  });
  incremental.actionCandidates.push({ triggerCandidateKey: 'settings.help', action: 'tap', expectedOutcome: '进入帮助页面', basis: 'visible-text', riskSignals: [], confidence: 0.88 });

  const next = appendRecognitionIntoDraft(first, incremental, 'incremental.json', 'test-model');
  assert.equal(next.elements.filter((element) => element.candidateKey === 'settings.toggle').length, 1);
  const nextToggle = next.elements.find((element) => element.candidateKey === 'settings.toggle');
  assert.equal(nextToggle.id, originalToggle.id);
  assert.equal(nextToggle.label, originalToggle.label);
  assert.deepEqual(nextToggle.bbox, originalToggle.bbox);
  assert.equal(nextToggle.reviewStatus, originalToggle.reviewStatus);
  assert.equal(next.elements.find((element) => element.candidateKey === 'settings.help').label, '帮助入口');
  assert.equal(next.elements.length, first.elements.length + 1);
});

test('增量识别在候选键漂移时按文字、类型和位置复用旧内部 ID', () => {
  const first = mergeRecognitionIntoDraft(createEmptyDraft(), sampleRecognition(), 'first.json');
  const originalToggle = first.elements.find((element) => element.candidateKey === 'settings.toggle');
  const originalRow = first.elements.find((element) => element.candidateKey === 'settings.row');
  const incremental = sampleRecognition();
  incremental.frameId = 'sha256:new-frame';
  const toggle = incremental.elements.find((element) => element.candidateKey === 'settings.toggle');
  toggle.candidateKey = 'notification_switch';
  incremental.relationships = [
    { fromCandidateKey: 'settings.row', type: 'contains', toCandidateKey: 'notification_switch' },
    { fromCandidateKey: 'settings.row', type: 'contains', toCandidateKey: 'settings.help' },
  ];
  incremental.actionCandidates = incremental.actionCandidates.map((action) => ({ ...action, triggerCandidateKey: 'notification_switch' }));
  incremental.elements.push({
    candidateKey: 'settings.help', label: '帮助入口', visualDescription: '新增帮助按钮', elementType: 'text-button', interactive: true, enabled: true, state: null,
    approximateRegion: { x: 0.8, y: 0.82, width: 0.12, height: 0.08 }, geometryKind: 'tap-target', geometryConfidence: 0.82,
    meaning: { status: 'known', description: '进入帮助页面', evidence: meaningEvidence({ visibleTexts: ['帮助'] }) }, dynamicContent: false, riskSignals: [], confidence: 0.91,
  });

  const next = appendRecognitionIntoDraft(first, incremental, 'incremental.json', 'test-model');
  assert.equal(next.elements.some((element) => element.candidateKey === 'notification_switch'), false);
  assert.equal(next.elements.find((element) => element.candidateKey === 'settings.toggle').id, originalToggle.id);
  assert.equal(next.elements.filter((element) => element.label === '提醒开关').length, 1);
  const help = next.elements.find((element) => element.candidateKey === 'settings.help');
  assert.equal(help.parentId, originalRow.id);
  assert.equal(help.ownerRef, originalRow.id);
});

test('主帧重新识别仅替换主帧元素并保留辅助帧增量结果', () => {
  const first = mergeRecognitionIntoDraft(createEmptyDraft(), sampleRecognition(), 'first.json');
  const auxiliaryFrameId = 'sha256:auxiliary-frame';
  const withAuxiliaryFrame = appendFrameToPage(first, auxiliaryFrameId, { pageId: first.currentPageId });
  const auxiliaryRecognition = sampleRecognition();
  auxiliaryRecognition.frameId = auxiliaryFrameId;
  auxiliaryRecognition.elements = [{
    candidateKey: 'settings.conditional-tip', label: '条件提示', visualDescription: '满足条件后出现的提示', elementType: 'static-label', interactive: false, enabled: true, state: null,
    approximateRegion: { x: 0.12, y: 0.72, width: 0.76, height: 0.08 }, geometryKind: 'boundary', geometryConfidence: 0.84,
    meaning: { status: 'known', description: '条件满足时展示', evidence: meaningEvidence({ visibleTexts: ['条件提示'] }) }, dynamicContent: true, riskSignals: [], confidence: 0.9,
  }];
  auxiliaryRecognition.relationships = [];
  auxiliaryRecognition.actionCandidates = [];
  const withIncrement = appendRecognitionIntoDraft(withAuxiliaryFrame, auxiliaryRecognition, 'auxiliary.json', 'test-model');

  const refreshedPrimary = sampleRecognition();
  refreshedPrimary.elements[0].label = '更新后的提醒设置';
  const refreshed = mergeRecognitionIntoDraft(withIncrement, refreshedPrimary, 'refreshed-primary.json', 'test-model');

  assert.equal(refreshed.elements.find((element) => element.candidateKey === 'settings.row').label, '更新后的提醒设置');
  assert.equal(refreshed.elements.find((element) => element.candidateKey === 'settings.conditional-tip').sourceFrameId, auxiliaryFrameId);
  assert.equal(refreshed.pages.find((page) => page.id === first.currentPageId).primaryFrameId, first.currentFrameId);
});

test('删除观测帧同时删除该帧来源元素并保留其他帧', () => {
  const first = mergeRecognitionIntoDraft(createEmptyDraft(), sampleRecognition(), 'first.json');
  const firstFrame = first.currentFrameId;
  const secondFrame = 'sha256:second-frame';
  const withSecondFrame = appendFrameToPage(first, secondFrame, { pageId: first.currentPageId });
  const result = removeFrameFromPage(withSecondFrame, firstFrame, { pageId: first.currentPageId });
  assert.equal(result.removed, true);
  assert.deepEqual(result.draft.pages.find((page) => page.id === first.currentPageId).frameIds, [secondFrame]);
  assert.equal(result.draft.pages.find((page) => page.id === first.currentPageId).primaryFrameId, secondFrame);
  assert.equal(result.draft.elements.length, 0);
  assert.equal(result.draft.currentFrameId, secondFrame);
});

test('设备帧重拍只移除本次追加帧并保留页面原始观测帧', () => {
  const original = beginFrameCapture(createEmptyDraft(), 'sha256:original', { forceNewPage: true });
  const pageId = original.currentPageId;
  const firstAppend = appendFrameToPage(original, 'sha256:first-append', { pageId });
  const discarded = removeFrameFromPage(firstAppend, 'sha256:first-append', { pageId });
  const secondAppend = appendFrameToPage(discarded.draft, 'sha256:second-append', { pageId });

  assert.equal(discarded.removed, true);
  assert.deepEqual(discarded.draft.pages.find((page) => page.id === pageId).frameIds, ['sha256:original']);
  assert.deepEqual(secondAppend.pages.find((page) => page.id === pageId).frameIds, ['sha256:original', 'sha256:second-append']);
  assert.equal(secondAppend.pages.find((page) => page.id === pageId).primaryFrameId, 'sha256:original');
  assert.equal(secondAppend.currentPageId, pageId);
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

test('可修正的 单模型几何和动作矛盾进入待审核草稿', () => {
  const recognitionResult = sampleRecognition();
  recognitionResult.elements[1].interactive = false;
  recognitionResult.elements[1].approximateRegion = { x: 0.9, y: 0.95, width: 0.2, height: 0.1 };
  const proposal = prepareRecognitionForDraft(recognitionResult);
  assert.deepEqual(proposal.elements[1].approximateRegion, { x: 0.9, y: 0.95, width: 0.1, height: 0.05 });
  assert.ok(proposal.elements[1].riskSignals.includes('geometry-clamped-to-frame'));
  assert.ok(proposal.elements[1].riskSignals.includes('model-action-inconsistent'));
  assert.equal(proposal.actionCandidates.length, 0);
});

test('重复列表子元素归纳为一个抽象模板，而不是逐行进入元素树', () => {
  const result = sampleRecognition();
  result.elements = [
    { ...result.elements[0], candidateKey: 'todo-list', elementType: 'list' },
    ...[1, 2].map((index) => ({
      ...result.elements[0], candidateKey: `todo-${index}`, label: `具体列表项 ${index}`, elementType: 'list-item',
      approximateRegion: { x: 0.1, y: 0.2 + index * 0.15, width: 0.8, height: 0.12 },
    })),
    ...[1, 2].flatMap((index) => [
      { ...result.elements[1], candidateKey: `todo-${index}-checkbox`, label: `复选框 ${index}`, elementType: 'checkbox' },
      { ...result.elements[0], candidateKey: `todo-${index}-title`, label: `标题 ${index}`, elementType: 'static-label' },
      { ...result.elements[0], candidateKey: `todo-${index}-description`, label: `描述 ${index}`, elementType: 'static-label' },
    ]),
  ];
  result.relationships = [1, 2].flatMap((index) => [
    { fromCandidateKey: 'todo-list', type: 'contains', toCandidateKey: `todo-${index}` },
    ...['checkbox', 'title', 'description'].map((suffix) => ({ fromCandidateKey: `todo-${index}`, type: 'contains', toCandidateKey: `todo-${index}-${suffix}` })),
  ]);
  const prepared = prepareRecognitionForDraft(result);
  const templates = prepared.elements.filter((element) => element.abstraction?.kind === 'repeated-template');
  assert.deepEqual(templates.map((element) => element.candidateKey), ['todo-item-template']);
  assert.equal(templates[0].abstraction.instanceCount, 2);
  assert.equal(templates[0].abstraction.instanceRegions.length, 2);
  assert.deepEqual(templates[0].abstraction.fields.map((field) => field.key), ['checkbox', 'title', 'description']);
  assert.ok(templates[0].abstraction.fields.every((field) => field.instanceRegions.length === 2));
  assert.ok(prepared.relationships.some((relation) => relation.fromCandidateKey === 'todo-list' && relation.toCandidateKey === 'todo-item-template'));
  assert.ok(prepared.relationships.some((relation) => relation.fromCandidateKey === 'todo-item-template' && relation.toCandidateKey === 'todo-1-title'));
  assert.ok(prepared.relationships.some((relation) => relation.fromCandidateKey === 'todo-item-template' && relation.toCandidateKey === 'todo-1'));
  assert.ok(!prepared.relationships.some((relation) => relation.fromCandidateKey === 'todo-list' && relation.toCandidateKey === 'todo-1'));
  const draft = mergeRecognitionIntoDraft(createEmptyDraft(), prepared, 'abstract-inferred.json');
  assert.deepEqual(draft.elements.map((element) => element.candidateKey).sort(), ['todo-item-template', 'todo-list']);
});

test('重复表单模板吸收已表达的多行输入实例且保留模板外控件', () => {
  const result = sampleRecognition();
  const base = result.elements[0];
  const inputRegions = [
    { x: 0.08, y: 0.22, width: 0.84, height: 0.14 },
    { x: 0.08, y: 0.46, width: 0.84, height: 0.14 },
    { x: 0.08, y: 0.70, width: 0.84, height: 0.10 },
  ];
  const template = {
    ...base,
    candidateKey: 'daily-form-field-template',
    label: '表单填写项模板',
    elementType: 'section',
    approximateRegion: { x: 0.04, y: 0.14, width: 0.92, height: 0.70 },
    abstraction: {
      kind: 'repeated-template', templateKey: 'daily.form-field', instanceCount: 3, bboxStyle: 'abstract',
      instanceRegions: [
        { x: 0.04, y: 0.14, width: 0.92, height: 0.22 },
        { x: 0.04, y: 0.38, width: 0.92, height: 0.22 },
        { x: 0.04, y: 0.62, width: 0.92, height: 0.22 },
      ],
      fields: [{
        key: 'input', label: '多行文本输入框', elementType: 'text-area', description: '每个填写块的输入控件',
        displayCondition: '', capabilities: ['input'], interactionBoundary: 'candidate_bbox', actionEffects: [],
        parentId: null, required: false, instanceRegions: inputRegions,
      }],
    },
  };
  const inputs = inputRegions.map((approximateRegion, index) => ({
    ...base,
    candidateKey: `daily-field-${index + 1}-input`,
    label: ['今日完成工作', '明日工作计划', '备注'][index],
    elementType: 'text-area',
    interactive: true,
    approximateRegion,
  }));
  const externalInput = {
    ...inputs[0], candidateKey: 'external-notes-input', label: '模板外附加说明',
    approximateRegion: { x: 0.08, y: 0.88, width: 0.84, height: 0.08 },
  };
  const externalButton = {
    ...base, candidateKey: 'submit-button', label: '提交', elementType: 'text-button', interactive: true,
    approximateRegion: { x: 0.78, y: 0.05, width: 0.12, height: 0.04 },
  };
  result.elements = [template, ...inputs, externalInput, externalButton];
  result.relationships = inputs.map((input) => ({
    fromCandidateKey: input.candidateKey, type: 'belongs-to', toCandidateKey: template.candidateKey,
  }));
  result.actionCandidates = [
    ...inputs.map((input) => ({
      triggerCandidateKey: input.candidateKey, action: 'input', expectedOutcome: '编辑对应填写项', basis: 'visible-affordance', riskSignals: [], confidence: 0.9,
    })),
    { triggerCandidateKey: externalInput.candidateKey, action: 'input', expectedOutcome: '编辑附加说明', basis: 'visible-affordance', riskSignals: [], confidence: 0.9 },
    { triggerCandidateKey: externalButton.candidateKey, action: 'tap', expectedOutcome: '提交表单', basis: 'visible-affordance', riskSignals: [], confidence: 0.9 },
  ];

  const prepared = prepareRecognitionForDraft(result);
  assert.deepEqual(prepared.elements.map((element) => element.candidateKey), [
    'daily-form-field-template', 'external-notes-input', 'submit-button',
  ]);
  assert.deepEqual(prepared.elements[0].abstraction.fields[0].instanceRegions, inputRegions);
  assert.deepEqual(new Set(prepared.elements[0].abstraction.fields[0].capabilities), new Set(['tap', 'input']));
  assert.ok(prepared.elements[0].abstraction.fields[0].actionEffects.some((effect) => effect.action === 'input'));
  assert.deepEqual(prepared.actionCandidates.map((action) => action.triggerCandidateKey), [
    'external-notes-input', 'submit-button',
  ]);
  assert.ok(prepared.elements[0].riskSignals.includes('concrete-inputs-absorbed-into-template'));

  const draft = mergeRecognitionIntoDraft(createEmptyDraft(), prepared, 'form-template.json');
  assert.deepEqual(draft.elements.map((element) => element.candidateKey), [
    'daily-form-field-template', 'external-notes-input', 'submit-button',
  ]);
});

test('重复列表可投影为抽象模板并隐藏具体行元素', () => {
  const result = sampleRecognition();
  result.elements = [
    { ...result.elements[0], candidateKey: 'message-list', elementType: 'list', approximateRegion: { x: 0.04, y: 0.12, width: 0.92, height: 0.72 } },
    { ...result.elements[0], candidateKey: 'message-item', label: '消息列表项', elementType: 'list-item', approximateRegion: { x: 0.2, y: 0.22, width: 0.5, height: 0.08 }, abstraction: {
      kind: 'repeated-template', templateKey: 'message.item', instanceCount: 3,
      fields: [{ key: 'title', label: '主标题', elementType: 'static-label', description: '每个列表项中的主标题', required: true }],
      instanceRegions: [{ x: 0.1, y: 0.2, width: 0.8, height: 0.1 }, { x: 0.1, y: 0.31, width: 0.8, height: 0.1 }, { x: 0.1, y: 0.42, width: 0.8, height: 0.1 }], bboxStyle: 'abstract',
    } },
    { ...result.elements[0], candidateKey: 'message-1-title', label: '具体文字', elementType: 'static-label' },
  ];
  result.relationships = [
    { fromCandidateKey: 'message-list', type: 'contains', toCandidateKey: 'message-item' },
    { fromCandidateKey: 'message-item', type: 'contains', toCandidateKey: 'message-1-title' },
  ];
  result.actionCandidates = [];
  const draft = mergeRecognitionIntoDraft(createEmptyDraft(), result, 'abstract.json');
  assert.equal(draft.elements.some((element) => element.candidateKey === 'message-item'), true);
  assert.equal(draft.elements.some((element) => element.candidateKey === 'message-1-title'), false);
  const template = draft.elements.find((element) => element.candidateKey === 'message-item');
  assert.equal(template.abstraction?.instanceCount, 3);
  assert.equal(template.abstraction?.bboxStyle, 'abstract');
  assert.deepEqual(template.bbox, draft.elements.find((element) => element.candidateKey === 'message-list').bbox);
  assert.deepEqual([template.gridColumns, template.gridRows, template.gridRegion], [
    draft.elements.find((element) => element.candidateKey === 'message-list').gridColumns,
    draft.elements.find((element) => element.candidateKey === 'message-list').gridRows,
    draft.elements.find((element) => element.candidateKey === 'message-list').gridRegion,
  ]);
});

test('当前用户字段无关系证据时分别保留动态语义但不会自动合并', () => {
  const result = sampleRecognition();
  result.elements = [
    { ...result.elements[0], candidateKey: 'self_avatar', label: null, visualDescription: '当前登录用户头像', elementType: 'avatar', interactive: true, dynamicContent: false, approximateRegion: { x: 0.03, y: 0.04, width: 0.11, height: 0.08 }, meaning: { ...result.elements[0].meaning, description: '当前登录账号的头像入口' } },
    { ...result.elements[0], candidateKey: 'self_name_title', label: '示例姓名', elementType: 'title', dynamicContent: false, approximateRegion: { x: 0.18, y: 0.05, width: 0.3, height: 0.03 }, meaning: { ...result.elements[0].meaning, description: '当前账号的显示名称' } },
    { ...result.elements[0], candidateKey: 'self_org_subtitle', label: '示例组织', elementType: 'subtitle', dynamicContent: false, approximateRegion: { x: 0.18, y: 0.085, width: 0.3, height: 0.02 }, meaning: { ...result.elements[0].meaning, description: '当前账号所属组织' } },
  ];
  result.relationships = [];
  result.actionCandidates = [{ ...sampleRecognition().actionCandidates[0], triggerCandidateKey: 'self_avatar', expectedOutcome: '打开个人资料' }];

  const prepared = prepareRecognitionForDraft(result);
  assert.deepEqual(prepared.elements.map((element) => element.candidateKey), [
    'self_avatar', 'self_name_title', 'self_org_subtitle',
  ]);
  assert.ok(prepared.elements.every((element) => element.abstraction?.kind === 'dynamic-template'));
  assert.ok(prepared.elements.every((element) => element.dynamicContent === true));
  assert.deepEqual(
    prepared.elements.map((element) => element.abstraction?.templateKey),
    ['business.dynamic-content', 'business.dynamic-content', 'business.dynamic-content'],
  );
  assert.ok(prepared.elements.every((element) => element.abstraction?.instanceCount === 1));
});

test('模型已明确声明动态模板时保留其语义和字段结构', () => {
  const result = sampleRecognition();
  result.elements = [{
    ...result.elements[0],
    candidateKey: 'profile_slot',
    label: '用户资料',
    elementType: 'section',
    dynamicContent: true,
    abstraction: {
      kind: 'dynamic-template',
      templateKey: 'profile-slot',
      instanceCount: 1,
      instanceRegions: [{ x: 0.1, y: 0.1, width: 0.4, height: 0.1 }],
      fields: [{ key: 'profile-value', label: '资料值', elementType: 'static-label', instanceRegions: [{ x: 0.2, y: 0.12, width: 0.2, height: 0.03 }] }],
      bboxStyle: 'abstract',
    },
    approximateRegion: { x: 0.1, y: 0.1, width: 0.4, height: 0.1 },
  }];
  result.relationships = [];
  const prepared = prepareRecognitionForDraft(result);
  assert.equal(prepared.elements[0].abstraction.kind, 'dynamic-template');
  assert.equal(prepared.elements[0].dynamicContent, true);
});

test('无业务语义的无结构动态标题在草稿准备阶段降级为普通标题', () => {
  const result = sampleRecognition();
  result.elements = [{
    ...result.elements[0],
    candidateKey: 'welcome_heading',
    label: '欢迎页主标题',
    elementType: 'title',
    interactive: false,
    dynamicContent: true,
    abstraction: null,
  }];
  result.relationships = [];
  result.actionCandidates = [];

  const prepared = prepareRecognitionForDraft(result);
  const title = prepared.elements[0];
  assert.equal(title.dynamicContent, false);
  assert.equal(title.abstraction, null);
  assert.ok(title.riskSignals.includes('unstructured-dynamic-title-downgraded'));
});

test('明确的当前用户业务字段无需结构化兄弟字段也保留动态共相', () => {
  const result = sampleRecognition();
  result.elements = [{
    ...result.elements[0],
    candidateKey: 'current_user_name',
    label: '当前用户姓名',
    visualDescription: '当前登录用户的显示名称',
    elementType: 'static-label',
    interactive: false,
    dynamicContent: false,
    abstraction: null,
    approximateRegion: { x: 0.2, y: 0.1, width: 0.25, height: 0.04 },
    meaning: {
      ...result.elements[0].meaning,
      description: '当前登录用户的显示名称',
      evidence: meaningEvidence({ visibleTexts: ['当前用户姓名'] }),
    },
  }];
  result.relationships = [];
  result.actionCandidates = [];

  const prepared = prepareRecognitionForDraft(result);
  const name = prepared.elements[0];
  assert.equal(name.dynamicContent, true);
  assert.equal(name.abstraction?.kind, 'dynamic-template');
  assert.equal(name.abstraction?.instanceCount, 1);
  assert.ok(name.riskSignals.includes('business-dynamic-semantic-inferred'));
});

test('单字段纯文本动态标题也会降级，而多字段结构化载荷保持动态语义', () => {
  const result = sampleRecognition();
  const plain = {
    ...result.elements[0],
    candidateKey: 'plain_dynamic_title',
    label: '日报标题',
    elementType: 'title',
    interactive: false,
    dynamicContent: true,
    abstraction: {
      kind: 'dynamic-template', templateKey: 'plain-title', instanceCount: 1,
      instanceRegions: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.04 }],
      fields: [{ key: 'text', label: '标题文本', elementType: 'title', capabilities: ['none'],
        instanceRegions: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.04 }] }],
      bboxStyle: 'abstract',
    },
  };
  const structured = {
    ...result.elements[0],
    candidateKey: 'structured_profile_title',
    label: '当前用户资料',
    elementType: 'title',
    interactive: false,
    dynamicContent: true,
    abstraction: {
      kind: 'dynamic-template', templateKey: 'profile-title', instanceCount: 1,
      instanceRegions: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.1 }],
      fields: [
        { key: 'avatar', label: '用户头像', elementType: 'avatar', capabilities: ['none'],
          instanceRegions: [{ x: 0.1, y: 0.21, width: 0.08, height: 0.08 }] },
        { key: 'name', label: '用户姓名', elementType: 'title', capabilities: ['none'],
          instanceRegions: [{ x: 0.21, y: 0.22, width: 0.25, height: 0.04 }] },
      ],
      bboxStyle: 'abstract',
    },
  };
  result.elements = [plain, structured];
  result.relationships = [];
  result.actionCandidates = [];

  const prepared = prepareRecognitionForDraft(result);
  const plainTitle = prepared.elements.find((element) => element.candidateKey === plain.candidateKey);
  const profileTitle = prepared.elements.find((element) => element.candidateKey === structured.candidateKey);
  assert.equal(plainTitle.dynamicContent, false);
  assert.equal(plainTitle.abstraction, null);
  assert.equal(profileTitle.dynamicContent, true);
  assert.equal(profileTitle.abstraction?.kind, 'dynamic-template');
  assert.deepEqual(profileTitle.abstraction.fields.map((field) => field.key), ['avatar', 'name']);
});

test('业务语义明确时单字段日报标题保留为动态共相', () => {
  const result = sampleRecognition();
  result.page = {
    ...result.page,
    name: '工作日志日报填写页面',
    stateSummary: '当前用户填写并提交工作日志日报',
  };
  result.elements = [{
    ...result.elements[0],
    candidateKey: 'report_heading',
    label: '葛超烨的日报',
    visualDescription: '页面顶部显示当前填写人的日报标题',
    elementType: 'title',
    interactive: false,
    dynamicContent: false,
    abstraction: null,
    approximateRegion: { x: 0.08, y: 0.04, width: 0.32, height: 0.03 },
    meaning: {
      ...result.elements[0].meaning,
      description: '当前填写人的日报标题',
      evidence: meaningEvidence({ visibleTexts: ['葛超烨的日报'] }),
    },
  }];
  result.relationships = [];
  result.actionCandidates = [];

  const prepared = prepareRecognitionForDraft(result, '工作日志日报填写页面；当前用户填写日报');
  const title = prepared.elements[0];
  assert.equal(title.dynamicContent, true);
  assert.equal(title.abstraction?.kind, 'dynamic-template');
  assert.equal(title.abstraction?.instanceCount, 1);
  assert.equal(title.abstraction?.templateKey, 'business.report-title');
  assert.deepEqual(title.abstraction?.fields.map((field) => field.key), ['report-title-text']);
  assert.equal(title.abstraction?.fields[0].parentId, 'report_heading');
  assert.ok(title.riskSignals.includes('business-dynamic-title-inferred'));
});

test('业务填写上下文可从泛化的日报标题标签推断动态共相', () => {
  const result = sampleRecognition();
  result.page = {
    ...result.page,
    name: '工作日志日报填写页面',
    stateSummary: '当前页面用于填写并提交日报',
  };
  result.elements = [{
    ...result.elements[0],
    candidateKey: 'generic_report_heading',
    label: '日报标题',
    visualDescription: '页面顶部的日报标题',
    elementType: 'title',
    interactive: false,
    dynamicContent: false,
    abstraction: null,
    approximateRegion: { x: 0.08, y: 0.04, width: 0.32, height: 0.03 },
  }];
  result.relationships = [];
  result.actionCandidates = [];

  const prepared = prepareRecognitionForDraft(result);
  const title = prepared.elements[0];
  assert.equal(title.dynamicContent, true);
  assert.equal(title.abstraction?.kind, 'dynamic-template');
  assert.equal(title.abstraction?.templateKey, 'business.report-title');
  assert.ok(title.riskSignals.includes('business-dynamic-title-inferred'));
});

test('业务语义可通用提升接收对象及其实体字段为动态共相', () => {
  const result = sampleRecognition();
  result.page = {
    ...result.page,
    name: '工作日志日报填写页面',
    stateSummary: '当前页面用于填写并提交日报，已设置接收人和接收群',
  };
  const base = result.elements[0];
  const businessElement = (candidateKey, label, visualDescription, elementType, approximateRegion, extra = {}) => ({
    ...base,
    candidateKey,
    label,
    visualDescription,
    elementType,
    interactive: false,
    dynamicContent: false,
    abstraction: null,
    approximateRegion,
    meaning: {
      ...base.meaning,
      description: visualDescription,
      evidence: meaningEvidence({ visibleTexts: label ? [label] : [] }),
    },
    ...extra,
  });
  result.elements = [
    businessElement('recipient_section', '接收人', '已选接收人区域', 'section', { x: 0.08, y: 0.4, width: 0.84, height: 0.1 }),
    businessElement('recipient_avatar', '葛超烨', '当前接收人的联系人头像', 'avatar', { x: 0.09, y: 0.43, width: 0.08, height: 0.06 }, { interactive: true }),
    businessElement('recipient_name', '葛超烨', '接收人名称', 'static-label', { x: 0.09, y: 0.49, width: 0.12, height: 0.03 }),
    businessElement('group_section', '接收群', '已选接收群区域', 'section', { x: 0.08, y: 0.52, width: 0.84, height: 0.1 }),
    businessElement('group_avatar', '项目群', '当前接收群的群组头像', 'avatar-group', { x: 0.09, y: 0.55, width: 0.08, height: 0.06 }),
    businessElement('group_name', '项目群', '接收群名称', 'static-label', { x: 0.09, y: 0.61, width: 0.12, height: 0.03 }),
    businessElement('live_status', '审批任务状态', '实时审批任务状态值', 'status', { x: 0.1, y: 0.7, width: 0.2, height: 0.03 }),
  ];
  result.relationships = [
    { fromCandidateKey: 'recipient_section', type: 'contains', toCandidateKey: 'recipient_avatar' },
    { fromCandidateKey: 'recipient_section', type: 'contains', toCandidateKey: 'recipient_name' },
    { fromCandidateKey: 'group_section', type: 'contains', toCandidateKey: 'group_avatar' },
    { fromCandidateKey: 'group_section', type: 'contains', toCandidateKey: 'group_name' },
  ];
  result.actionCandidates = [];

  const prepared = prepareRecognitionForDraft(result);
  const recipientAvatar = prepared.elements.find((element) => element.candidateKey === 'recipient_avatar');
  const recipientName = prepared.elements.find((element) => element.candidateKey === 'recipient_name');
  const groupAvatar = prepared.elements.find((element) => element.candidateKey === 'group_avatar');
  const groupName = prepared.elements.find((element) => element.candidateKey === 'group_name');
  const liveStatus = prepared.elements.find((element) => element.candidateKey === 'live_status');
  for (const element of [recipientAvatar, recipientName, groupAvatar, groupName, liveStatus]) {
    assert.equal(element.dynamicContent, true);
    assert.equal(element.abstraction?.kind, 'dynamic-template');
    assert.equal(element.abstraction?.instanceCount, 1);
    assert.ok(element.riskSignals.includes('business-dynamic-semantic-inferred'));
  }
  assert.equal(recipientAvatar.abstraction.templateKey, 'business.recipient-person');
  assert.equal(groupAvatar.abstraction.templateKey, 'business.recipient-group');
  assert.equal(liveStatus.abstraction.templateKey, 'business.dynamic-content');
  assert.deepEqual(recipientName.approximateRegion, { x: 0.09, y: 0.49, width: 0.12, height: 0.03 });
});

test('直接描述接收对象时无需依赖分组结构也能稳定保留动态语义', () => {
  const result = sampleRecognition();
  result.page = {
    ...result.page,
    name: '工作日志日报填写页面',
    stateSummary: '当前页面用于填写并提交日报',
  };
  const base = result.elements[0];
  const makeElement = (candidateKey, label, elementType, visualDescription) => ({
    ...base,
    candidateKey,
    label,
    visualDescription,
    elementType,
    interactive: false,
    dynamicContent: false,
    abstraction: null,
    approximateRegion: { x: 0.1, y: 0.4, width: 0.2, height: 0.04 },
    meaning: { ...base.meaning, description: visualDescription, evidence: meaningEvidence({ visibleTexts: label ? [label] : [] }) },
  });
  result.elements = [
    makeElement('recipient_avatar', '葛超烨', 'avatar', '当前接收人的头像'),
    makeElement('recipient_name', '葛超烨', 'static-label', '当前接收人的名称'),
    makeElement('recipient_group_avatar', 'Onl...', 'avatar-group', '当前接收群的群组头像'),
    makeElement('recipient_group_name', 'Onl...', 'static-label', '当前接收群的名称'),
  ];
  result.relationships = [];
  result.actionCandidates = [];

  const prepared = prepareRecognitionForDraft(result);
  assert.deepEqual(prepared.elements.map((element) => element.abstraction?.templateKey), [
    'business.recipient-person', 'business.recipient-person',
    'business.recipient-group', 'business.recipient-group',
  ]);
  assert.ok(prepared.elements.every((element) => element.dynamicContent === true));
});

test('泛化实体和值词缺少运行时语义时不会提升普通说明文本', () => {
  const result = sampleRecognition();
  result.elements = [{
    ...result.elements[0],
    candidateKey: 'user_info_note',
    label: '用户信息',
    visualDescription: '用户信息展示文本',
    elementType: 'static-label',
    interactive: false,
    dynamicContent: false,
    abstraction: null,
    approximateRegion: { x: 0.1, y: 0.4, width: 0.3, height: 0.04 },
    meaning: {
      ...result.elements[0].meaning,
      description: '用于说明用户信息的静态文本',
      evidence: meaningEvidence({ visibleTexts: ['用户信息'] }),
    },
  }];
  result.relationships = [];
  result.actionCandidates = [];

  const prepared = prepareRecognitionForDraft(result);
  assert.equal(prepared.elements[0].dynamicContent, false);
  assert.equal(prepared.elements[0].abstraction, null);
  assert.equal(prepared.elements[0].riskSignals.includes('business-dynamic-semantic-inferred'), false);
});

test('日报列表中的泛化标题不会被误判为动态报告标题', () => {
  const result = sampleRecognition();
  result.page = {
    ...result.page,
    name: '我的日报列表',
    stateSummary: '展示报告列表及其列标题',
  };
  result.elements = [{
    ...result.elements[0],
    candidateKey: 'report_title_column',
    label: '日报标题',
    visualDescription: '列表区域标题',
    elementType: 'title',
    interactive: false,
    dynamicContent: false,
    abstraction: null,
    approximateRegion: { x: 0.08, y: 0.2, width: 0.3, height: 0.03 },
    meaning: {
      ...result.elements[0].meaning,
      description: '列表区域标题',
      evidence: meaningEvidence({ visibleTexts: ['日报标题'] }),
    },
  }];
  result.relationships = [];
  result.actionCandidates = [];

  const prepared = prepareRecognitionForDraft(result);
  assert.equal(prepared.elements[0].dynamicContent, false);
  assert.equal(prepared.elements[0].abstraction, null);
  assert.equal(prepared.elements[0].riskSignals.includes('business-dynamic-title-inferred'), false);
});

test('工作台中的普通用户信息说明不会仅凭泛化业务词被提升', () => {
  const result = sampleRecognition();
  result.page = {
    ...result.page,
    name: '工作台主页',
    stateSummary: '用户信息展示页',
  };
  result.elements = [{
    ...result.elements[0],
    candidateKey: 'user_info_note',
    label: '用户信息',
    visualDescription: '用户信息展示文本',
    elementType: 'static-label',
    interactive: false,
    dynamicContent: false,
    abstraction: null,
    approximateRegion: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 },
    meaning: {
      ...result.elements[0].meaning,
      description: '用户信息展示文本',
      evidence: meaningEvidence({ visibleTexts: ['用户信息'] }),
    },
  }];
  result.relationships = [];
  result.actionCandidates = [];

  const prepared = prepareRecognitionForDraft(result);
  assert.equal(prepared.elements[0].dynamicContent, false);
  assert.equal(prepared.elements[0].abstraction, null);
  assert.equal(prepared.elements[0].riskSignals.includes('business-dynamic-semantic-inferred'), false);
});

test('业务流程中的时间和状态实际值可通用识别为动态载荷，而裸标签保持静态', () => {
  const result = sampleRecognition();
  result.page = {
    ...result.page,
    name: '工作日志日报填写页面',
    stateSummary: '当前页面用于填写并提交日报',
  };
  const base = result.elements[0];
  const makeField = (candidateKey, label, description) => ({
    ...base,
    candidateKey,
    label,
    visualDescription: description,
    elementType: 'static-label',
    interactive: false,
    dynamicContent: false,
    abstraction: null,
    approximateRegion: { x: 0.1, y: 0.4, width: 0.45, height: 0.04 },
    meaning: {
      ...base.meaning,
      description,
      evidence: meaningEvidence({ visibleTexts: [label] }),
    },
  });
  result.elements = [
    makeField('submit_time_value', '提交时间：当日09:00-18:00', '报告卡片中的提交时间值'),
    makeField('report_status_value', '报告状态：已提交', '当前报告状态值'),
    makeField('submit_time_label', '提交时间', '提交时间字段标签'),
  ];
  result.relationships = [];
  result.actionCandidates = [];

  const prepared = prepareRecognitionForDraft(result);
  const submitTimeValue = prepared.elements.find((element) => element.candidateKey === 'submit_time_value');
  const reportStatusValue = prepared.elements.find((element) => element.candidateKey === 'report_status_value');
  const submitTimeLabel = prepared.elements.find((element) => element.candidateKey === 'submit_time_label');
  assert.equal(submitTimeValue.dynamicContent, true);
  assert.equal(reportStatusValue.dynamicContent, true);
  assert.equal(submitTimeLabel.dynamicContent, false);
  assert.equal(submitTimeLabel.abstraction, null);
});

test('工作台上下文和状态进度类型本身不能单独触发动态共相', () => {
  const result = sampleRecognition();
  result.page = {
    ...result.page,
    name: '工作台主页',
    stateSummary: '工作台首页，展示用户信息和任务状态',
  };
  const base = result.elements[0];
  const makeField = (candidateKey, label, visualDescription, elementType) => ({
    ...base,
    candidateKey,
    label,
    visualDescription,
    elementType,
    interactive: false,
    dynamicContent: false,
    abstraction: null,
    approximateRegion: { x: 0.1, y: 0.4, width: 0.45, height: 0.04 },
    meaning: {
      ...base.meaning,
      description: visualDescription,
      evidence: meaningEvidence({ visibleTexts: [label] }),
    },
  });
  result.elements = [
    makeField('workbench_user_info', '用户信息', '工作台中的用户信息说明', 'static-label'),
    makeField('workbench_status', '用户状态', '工作台中的状态字段标签', 'status'),
    makeField('workbench_progress', '任务进度', '工作台中的进度展示', 'progress-bar'),
  ];
  result.relationships = [];
  result.actionCandidates = [];

  const prepared = prepareRecognitionForDraft(result);
  assert.ok(prepared.elements.every((element) => element.dynamicContent === false));
  assert.ok(prepared.elements.every((element) => element.abstraction === null));
});

test('时间日期状态进度字段要求可见值或明确运行时证据，裸字段标签保持静态', () => {
  const result = sampleRecognition();
  result.page = {
    ...result.page,
    name: '工作日志日报填写页面',
    stateSummary: '当前页面用于填写并提交日报',
  };
  const base = result.elements[0];
  const makeField = (candidateKey, label, visualDescription, elementType = 'static-label') => ({
    ...base,
    candidateKey,
    label,
    visualDescription,
    elementType,
    interactive: false,
    dynamicContent: false,
    abstraction: null,
    approximateRegion: { x: 0.1, y: 0.4, width: 0.45, height: 0.04 },
    meaning: {
      ...base.meaning,
      description: visualDescription,
      evidence: meaningEvidence({ visibleTexts: [label] }),
    },
  });
  result.elements = [
    makeField('submit_time_value', '提交时间：当日09:00-18:00', '报告卡片中的提交时间实际值'),
    makeField('status_value', '任务状态：已完成', '报告卡片中的任务状态实际值'),
    makeField('progress_value', '任务进度 80%', '报告卡片中的任务进度实际值'),
    makeField('submit_date_value', '提交日期：2026-09-02', '报告卡片中的提交日期实际值'),
    makeField('submit_time_label', '提交时间', '提交时间字段标签'),
    makeField('status_label', '任务状态', '任务状态字段标签'),
    makeField('progress_label', '任务进度', '任务进度字段标签'),
    makeField('explicit_status', '审核状态', '实时状态来自服务端数据源'),
  ];
  result.relationships = [];
  result.actionCandidates = [];

  const prepared = prepareRecognitionForDraft(result);
  for (const key of ['submit_time_value', 'status_value', 'progress_value', 'submit_date_value', 'explicit_status']) {
    const element = prepared.elements.find((candidate) => candidate.candidateKey === key);
    assert.equal(element.dynamicContent, true, key);
    assert.equal(element.abstraction?.kind, 'dynamic-template', key);
  }
  for (const key of ['submit_time_label', 'status_label', 'progress_label']) {
    const element = prepared.elements.find((candidate) => candidate.candidateKey === key);
    assert.equal(element.dynamicContent, false, key);
    assert.equal(element.abstraction, null, key);
  }
});

test('日报列表或区域标题中的具体日报标题也保持静态', () => {
  const result = sampleRecognition();
  result.page = {
    ...result.page,
    name: '我的日报列表',
    stateSummary: '展示日报列表及其列标题',
  };
  const base = result.elements[0];
  const makeHeading = (candidateKey, label, visualDescription) => ({
    ...base,
    candidateKey,
    label,
    visualDescription,
    elementType: 'title',
    interactive: false,
    dynamicContent: false,
    abstraction: null,
    approximateRegion: { x: 0.1, y: 0.2, width: 0.45, height: 0.04 },
    meaning: {
      ...base.meaning,
      description: visualDescription,
      evidence: meaningEvidence({ visibleTexts: [label] }),
    },
  });
  result.elements = [
    makeHeading('report_column_heading', '日报标题', '列表区域标题'),
    makeHeading('report_region_heading', '张三的日报', '日报列表中的区域标题'),
  ];
  result.relationships = [];
  result.actionCandidates = [];

  const prepared = prepareRecognitionForDraft(result);
  assert.ok(prepared.elements.every((element) => element.dynamicContent === false));
  assert.ok(prepared.elements.every((element) => element.abstraction === null));
});

test('多重父关系按最具体语义容器解析而不受关系数组顺序影响', () => {
  const result = sampleRecognition();
  const base = result.elements[0];
  result.elements = [
    {
      ...base,
      candidateKey: 'report_form',
      label: '日报填写表单',
      visualDescription: '整体录入表单',
      elementType: 'form',
      approximateRegion: { x: 0.04, y: 0.2, width: 0.92, height: 0.6 },
    },
    {
      ...base,
      candidateKey: 'recipient_section',
      label: '接收人',
      visualDescription: '接收人区域',
      elementType: 'section',
      approximateRegion: { x: 0.08, y: 0.35, width: 0.84, height: 0.12 },
    },
    {
      ...base,
      candidateKey: 'recipient_name',
      label: '张三',
      visualDescription: '接收人名称',
      elementType: 'static-label',
      approximateRegion: { x: 0.12, y: 0.4, width: 0.2, height: 0.04 },
      meaning: {
        ...base.meaning,
        description: '接收人名称',
        evidence: meaningEvidence({ visibleTexts: ['张三'] }),
      },
    },
  ];
  // The broad form appears first intentionally; semantic ownership must be
  // invariant to this incidental relationship ordering.
  result.relationships = [
    { fromCandidateKey: 'report_form', type: 'contains', toCandidateKey: 'recipient_name' },
    { fromCandidateKey: 'recipient_section', type: 'contains', toCandidateKey: 'recipient_name' },
    { fromCandidateKey: 'report_form', type: 'contains', toCandidateKey: 'recipient_section' },
  ];
  result.actionCandidates = [];

  const prepared = prepareRecognitionForDraft(result);
  const recipient = prepared.elements.find((element) => element.candidateKey === 'recipient_name');
  assert.equal(recipient.dynamicContent, true);
  assert.equal(recipient.abstraction?.templateKey, 'business.recipient-person');
});

test('业务页面中的分组标题、附件说明和选项标签不会误判为动态载荷', () => {
  const result = sampleRecognition();
  result.page = {
    ...result.page,
    name: '工作日志日报填写页面',
    stateSummary: '当前页面用于填写并提交日报，已设置接收人和接收群',
  };
  const base = result.elements[0];
  const makeElement = (candidateKey, label, elementType, visualDescription) => ({
    ...base,
    candidateKey,
    label,
    visualDescription,
    elementType,
    interactive: false,
    dynamicContent: false,
    abstraction: null,
    approximateRegion: { x: 0.1, y: 0.4, width: 0.7, height: 0.04 },
    meaning: { ...base.meaning, description: visualDescription, evidence: meaningEvidence({ visibleTexts: [label] }) },
  });
  result.elements = [
    makeElement('recipient_heading', '接收人', 'static-label', '接收人设置区域的标题'),
    makeElement('group_heading', '接收群', 'title', '接收群设置区域顶部的大号标题'),
    makeElement('attachment_heading', '4. 图片和附件', 'static-label', '附件区域的字段标题'),
    makeElement('attachment_hint', '单个文件最大为400M', 'caption', '说明文件大小限制的辅助文字'),
    makeElement('more_heading', '更多', 'title', '附加设置区块顶部的大号标题'),
    makeElement('allow_forward_label', '允许转发', 'static-label', '未选中复选框右侧的选项文字'),
    makeElement('linked_report_heading', '关联汇报', 'title', '关联汇报规则列表区域的标题'),
  ];
  result.relationships = [];
  result.actionCandidates = [];

  const prepared = prepareRecognitionForDraft(result);
  assert.ok(prepared.elements.every((element) => element.dynamicContent === false));
  assert.ok(prepared.elements.every((element) => element.abstraction === null));
});

test('普通页面标题不会仅因包含标题文字而被推断为动态共相', () => {
  const result = sampleRecognition();
  result.elements = [{
    ...result.elements[0],
    candidateKey: 'page_heading',
    label: '设置页面标题',
    visualDescription: '页面顶部标题',
    elementType: 'title',
    interactive: false,
    dynamicContent: false,
    abstraction: null,
    approximateRegion: { x: 0.08, y: 0.04, width: 0.32, height: 0.03 },
    meaning: {
      ...result.elements[0].meaning,
      description: '页面标题',
      evidence: meaningEvidence({ visibleTexts: ['设置页面标题'] }),
    },
  }];
  result.relationships = [];
  result.actionCandidates = [];

  const prepared = prepareRecognitionForDraft(result);
  assert.equal(prepared.elements[0].dynamicContent, false);
  assert.equal(prepared.elements[0].abstraction, null);
  assert.equal(prepared.elements[0].riskSignals.includes('business-dynamic-title-inferred'), false);
});

test('静态分组容器不会仅凭标签和几何邻近被破坏性改写为动态共相', () => {
  const result = sampleRecognition();
  const makeElement = (candidateKey, label, elementType, approximateRegion) => ({
    ...result.elements[0], candidateKey, label, visualDescription: label, elementType,
    approximateRegion, interactive: false, dynamicContent: false,
  });
  result.elements = [
    makeElement('settings_cluster', '设置分组', 'section', { x: 0.08, y: 0.3, width: 0.84, height: 0.2 }),
    makeElement('leading_icon', '状态图标', 'avatar', { x: 0.1, y: 0.34, width: 0.08, height: 0.04 }),
    makeElement('cluster_description', '辅助说明', 'static-label', { x: 0.1, y: 0.4, width: 0.3, height: 0.03 }),
    makeElement('cluster_toggle', '启用选项', 'switch', { x: 0.75, y: 0.38, width: 0.12, height: 0.05 }),
  ];
  result.relationships = [
    { fromCandidateKey: 'settings_cluster', type: 'contains', toCandidateKey: 'leading_icon' },
    { fromCandidateKey: 'settings_cluster', type: 'contains', toCandidateKey: 'cluster_description' },
    { fromCandidateKey: 'settings_cluster', type: 'contains', toCandidateKey: 'cluster_toggle' },
  ];
  result.actionCandidates = [];

  const normalized = normalizeRecognitionOutput(result).recognitionResult;
  assert.deepEqual(normalized.elements.map((element) => element.candidateKey), [
    'settings_cluster', 'leading_icon', 'cluster_description', 'cluster_toggle',
  ]);
  assert.ok(normalized.elements.every((element) => element.abstraction === null));
  assert.equal(normalized.relationships.length, 3);
});

test('普通 *_group 键名不会单独触发动态共相归纳', () => {
  const result = sampleRecognition();
  const makeElement = (candidateKey, label, elementType, approximateRegion, dynamicContent = false) => ({
    ...result.elements[0], candidateKey, label, visualDescription: label, elementType,
    approximateRegion, interactive: false, dynamicContent,
  });
  result.elements = [
    makeElement('layout_group', '布局分组', 'section', { x: 0.08, y: 0.28, width: 0.84, height: 0.2 }),
    makeElement('layout_group_icon', '布局图标', 'avatar', { x: 0.1, y: 0.33, width: 0.08, height: 0.05 }),
    makeElement('layout_group_label', '布局说明', 'static-label', { x: 0.22, y: 0.34, width: 0.3, height: 0.03 }),
  ];
  result.relationships = [
    { fromCandidateKey: 'layout_group', type: 'contains', toCandidateKey: 'layout_group_icon' },
    { fromCandidateKey: 'layout_group', type: 'contains', toCandidateKey: 'layout_group_label' },
  ];
  result.actionCandidates = [];

  const prepared = prepareRecognitionForDraft(result);
  assert.deepEqual(prepared.elements.map((element) => element.candidateKey), [
    'layout_group', 'layout_group_icon', 'layout_group_label',
  ]);
  assert.ok(prepared.elements.every((element) => element.abstraction?.kind !== 'dynamic-template'));
  assert.ok(prepared.elements.every((element) => element.dynamicContent === false));
});

test('草稿合并选择最具体的 section 作为子元素父级', () => {
  const result = sampleRecognition();
  result.elements = [
    { ...result.elements[0], candidateKey: 'outer_form', label: '外层表单', elementType: 'form', approximateRegion: { x: 0, y: 0.1, width: 1, height: 0.8 } },
    { ...result.elements[0], candidateKey: 'inner_section', label: '内部区块', elementType: 'section', approximateRegion: { x: 0.08, y: 0.2, width: 0.84, height: 0.3 } },
    { ...result.elements[1], candidateKey: 'inner_button', label: '内部操作', elementType: 'text-button', interactive: true, approximateRegion: { x: 0.2, y: 0.3, width: 0.2, height: 0.05 } },
  ];
  result.relationships = [
    { fromCandidateKey: 'outer_form', type: 'contains', toCandidateKey: 'inner_section' },
    { fromCandidateKey: 'outer_form', type: 'contains', toCandidateKey: 'inner_button' },
    { fromCandidateKey: 'inner_section', type: 'contains', toCandidateKey: 'inner_button' },
  ];
  result.actionCandidates = [{ ...result.actionCandidates[0], triggerCandidateKey: 'inner_button' }];
  const draft = mergeRecognitionIntoDraft(createEmptyDraft(), result, 'nested.json');
  const section = draft.elements.find((element) => element.candidateKey === 'inner_section');
  const button = draft.elements.find((element) => element.candidateKey === 'inner_button');
  assert.equal(button.parentId, section.id);
  assert.equal(button.ownerRef, section.id);
});

test('轮播无需独立规则即可归纳为动态元素共相', () => {
  const result = sampleRecognition();
  result.elements = [{
    ...result.elements[0],
    candidateKey: 'home-carousel',
    label: '今日推荐',
    elementType: 'carousel',
    dynamicContent: true,
    approximateRegion: { x: 0.05, y: 0.2, width: 0.9, height: 0.25 },
  }];
  result.relationships = [];
  result.actionCandidates = [];

  const prepared = prepareRecognitionForDraft(result);
  const carousel = prepared.elements[0];
  assert.equal(carousel.abstraction?.kind, 'dynamic-template');
  assert.equal(carousel.abstraction?.instanceCount, 1);
  assert.equal(carousel.abstraction?.fields[0].elementType, 'carousel');
  const draft = mergeRecognitionIntoDraft(createEmptyDraft(), prepared, 'dynamic-carousel.json');
  assert.equal(draft.elements.length, 1);
  assert.equal(draft.elements[0].abstraction?.kind, 'dynamic-template');
});

test('录入表单不会因 dynamicContent 自动升级为动态模板', () => {
  const result = sampleRecognition();
  result.elements = [{
    ...result.elements[0], candidateKey: 'entry-form', elementType: 'form', dynamicContent: true,
    approximateRegion: { x: 0, y: 0.2, width: 1, height: 0.8 },
  }];
  result.relationships = [];
  result.actionCandidates = [];

  const prepared = prepareRecognitionForDraft(result);
  assert.equal(prepared.elements[0].abstraction ?? null, null);
});

test('模型误把录入表单归为 dynamic-template 时归一化为普通录入结构', () => {
  const result = sampleRecognition();
  result.elements = [{
    ...result.elements[0], candidateKey: 'entry-form', elementType: 'form', dynamicContent: true,
    abstraction: {
      kind: 'dynamic-template', templateKey: 'entry-form.dynamic', instanceCount: 1,
      fields: [{ key: 'payload', label: '录入内容', elementType: 'form', description: '用户填写内容', required: false }],
      instanceRegions: [{ x: 0, y: 0.2, width: 1, height: 0.8 }], bboxStyle: 'abstract',
    },
  }];
  result.relationships = [];
  result.actionCandidates = [];

  const { recognitionResult, normalizationIssues } = normalizeRecognitionOutput(result);
  assert.equal(recognitionResult.elements[0].abstraction, null);
  assert.equal(recognitionResult.elements[0].dynamicContent, false);
  assert.ok(recognitionResult.elements[0].riskSignals.includes('data-entry-cannot-be-dynamic-template'));
  assert.ok(normalizationIssues[0].messages.some((message) => message.includes('不能作为 dynamic-template')));
});

test('旧抽象结果中过滤无 bbox 的头像字段但保留有 bbox 的真实头像', () => {
  const result = sampleRecognition();
  result.elements = [{
    ...result.elements[0],
    candidateKey: 'people-list-item',
    label: '列表项元素共相',
    abstraction: {
      kind: 'repeated-template',
      templateKey: 'people.item',
      instanceCount: 2,
      fields: [
        { key: 'title', label: '主标题', elementType: 'title', description: '每项标题', required: true, instanceRegions: [{ x: 0.2, y: 0.2, width: 0.4, height: 0.04 }, { x: 0.2, y: 0.3, width: 0.4, height: 0.04 }] },
        { key: 'avatar', label: '头像占位', elementType: 'avatar', description: '不存在的头像', required: false, instanceRegions: [] },
        { key: 'avatar', label: '头像', elementType: 'avatar', description: '实际头像', required: false, instanceRegions: [{ x: 0.1, y: 0.2, width: 0.08, height: 0.08 }] },
      ],
      instanceRegions: [{ x: 0.1, y: 0.2, width: 0.8, height: 0.08 }, { x: 0.1, y: 0.3, width: 0.8, height: 0.08 }],
      bboxStyle: 'abstract',
    },
  }];
  result.relationships = [];
  result.actionCandidates = [];

  const normalized = normalizeRecognitionOutput(result).recognitionResult;
  const fields = normalized.elements[0].abstraction.fields;
  assert.equal(fields.length, 2);
  assert.equal(fields.filter((field) => field.key === 'avatar').length, 1);
  assert.equal(fields.find((field) => field.key === 'avatar')?.description, '实际头像');
});

test('共相字段父级必须引用当前识别结果中的 candidateKey', () => {
  const result = sampleRecognition();
  result.elements[0].abstraction = {
    kind: 'repeated-template',
    templateKey: 'settings.row.template',
    instanceCount: 2,
    fields: [{
      key: 'ordinal', label: '填写项序号', elementType: 'static-label', description: '字段序号',
      parentId: 'settings.row.template.0.settings.row.template.1'.repeat(100), required: false,
      instanceRegions: [{ x: 0.1, y: 0.2, width: 0.05, height: 0.04 }, { x: 0.1, y: 0.3, width: 0.05, height: 0.04 }],
    }],
    instanceRegions: [{ x: 0.1, y: 0.2, width: 0.8, height: 0.08 }, { x: 0.1, y: 0.3, width: 0.8, height: 0.08 }],
    bboxStyle: 'abstract',
  };

  assert.ok(validateRecognitionConsistency(result).some((issue) => issue.startsWith('共相字段父级引用了不可见候选')));

  const { recognitionResult, normalizationIssues } = normalizeRecognitionOutput(result);
  assert.equal(recognitionResult.elements[0].abstraction.fields[0].parentId, 'settings.row');
  assert.ok(normalizationIssues.some((issue) => issue.messages.some((message) => message.includes('不在当前识别候选中'))));
  assert.deepEqual(validateRecognitionConsistency(recognitionResult), []);
});

test('草稿归一化修复不存在的共相字段父级并兼容已有元素 ID', () => {
  const result = sampleRecognition();
  result.elements[0].abstraction = {
    kind: 'repeated-template', templateKey: 'settings.row.template', instanceCount: 2,
    fields: [{ key: 'title', label: '标题', elementType: 'static-label', description: '标题', parentId: null, required: false, instanceRegions: [] }],
    instanceRegions: [{ x: 0.1, y: 0.2, width: 0.8, height: 0.08 }, { x: 0.1, y: 0.3, width: 0.8, height: 0.08 }], bboxStyle: 'abstract',
  };
  const draft = mergeRecognitionIntoDraft(createEmptyDraft(), result, 'model.json');
  const row = draft.elements.find((element) => element.candidateKey === 'settings.row');
  row.abstraction.fields[0].parentId = 'missing-parent';
  assert.equal(normalizeDraftShape(draft).elements.find((element) => element.id === row.id).abstraction.fields[0].parentId, 'settings.row');

  row.abstraction.fields[0].parentId = row.id;
  assert.equal(normalizeDraftShape(draft).elements.find((element) => element.id === row.id).abstraction.fields[0].parentId, row.abstraction.fields[0].parentId);
});

test('模型把 abstraction 错放到 meaning 时仍恢复为顶层抽象模板', () => {
  const result = sampleRecognition();
  result.elements[0].elementType = 'list-item';
  result.elements[0].meaning.abstraction = {
    kind: 'repeated-template',
    templateKey: 'todo.item',
    instanceCount: 2,
    fields: [{ key: 'title', label: '主标题', elementType: 'static-label', description: '每项标题', required: true, instanceRegions: [{ x: 0.2, y: 0.2, width: 0.4, height: 0.04 }, { x: 0.2, y: 0.3, width: 0.4, height: 0.04 }] }],
    instanceRegions: [{ x: 0.1, y: 0.2, width: 0.8, height: 0.08 }, { x: 0.1, y: 0.3, width: 0.8, height: 0.08 }],
    bboxStyle: 'abstract',
  };

  const { recognitionResult, normalizationIssues } = normalizeRecognitionOutput(result);
  assert.equal(recognitionResult.elements[0].abstraction?.kind, 'repeated-template');
  assert.equal(recognitionResult.elements[0].meaning.evidence.unclassified.some((item) => item.type === 'meaning.abstraction'), false);
  assert.ok(normalizationIssues[0].messages.includes('meaning.abstraction 已上提到元素顶层'));
});

test('旧单页草稿升级后保留 Page、Frame 和 AI 模型来源', () => {
  const legacy = mergeRecognitionIntoDraft(createEmptyDraft(), sampleRecognition(), 'model.json', 'qwen3-vl-plus');
  delete legacy.pages;
  delete legacy.elements[0].pageId;
  delete legacy.elements[0].aiModel;
  const upgraded = normalizeDraftShape(legacy);
  assert.equal(upgraded.pages.length, 1);
  assert.deepEqual(upgraded.pages[0].frameIds, ['sha256:abc']);
  assert.equal(upgraded.pages[0].primaryFrameId, 'sha256:abc');
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

test('没有人工编辑记录的 单模型元素始终恢复为初始化状态', () => {
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

test('单模型归一化保留原始输出，并仅降级含未知证据的元素', () => {
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

test('归一化不会根据普通页面文本自行推断动态共相', () => {
  const raw = sampleRecognition();
  raw.elements.push({
    candidateKey: 'page_heading', label: '示例页面标题', visualDescription: '页面标题', elementType: 'title', interactive: false,
    enabled: true, state: null, approximateRegion: { x: 0.08, y: 0.04, width: 0.32, height: 0.03 }, geometryKind: 'boundary', geometryConfidence: 0.8,
    meaning: { status: 'known', description: '页面标题', evidence: meaningEvidence({ visibleTexts: ['示例页面标题'] }) }, dynamicContent: false, riskSignals: [], confidence: 0.9,
  });

  const { recognitionResult, normalizationIssues } = normalizeRecognitionOutput(raw);
  const title = recognitionResult.elements.find((element) => element.candidateKey === 'page_heading');
  assert.equal(title.dynamicContent, false);
  assert.equal(title.abstraction, null);
  assert.equal(normalizationIssues.some((issue) => issue.candidateKey === 'form_heading'), false);
});

test('单模型归一化强制排除系统栏、子元素及其关系和动作', () => {
  const raw = sampleRecognition();
  raw.elements.unshift({
    ...structuredClone(raw.elements[0]),
    candidateKey: 'system_status',
    label: '系统状态栏',
    elementType: 'status-bar',
  }, {
    ...structuredClone(raw.elements[1]),
    candidateKey: 'system_wifi',
    label: 'Wi-Fi 图标',
    elementType: 'image',
  });
  raw.relationships.unshift(
    { fromCandidateKey: 'system_status', type: 'contains', toCandidateKey: 'system_wifi' },
    { fromCandidateKey: 'settings.row', type: 'adjacent-to', toCandidateKey: 'system_status' },
  );
  raw.actionCandidates.unshift({ ...raw.actionCandidates[0], triggerCandidateKey: 'system_wifi' });

  const { recognitionResult, normalizationIssues } = normalizeRecognitionOutput(raw);

  assert.deepEqual(recognitionResult.elements.map((element) => element.candidateKey), ['settings.row', 'settings.toggle']);
  assert.deepEqual(recognitionResult.relationships, [{ fromCandidateKey: 'settings.row', type: 'contains', toCandidateKey: 'settings.toggle' }]);
  assert.deepEqual(recognitionResult.actionCandidates.map((action) => action.triggerCandidateKey), ['settings.toggle']);
  assert.ok(normalizationIssues.some((issue) => issue.messages.includes('已排除 2 个系统状态栏、系统导航栏或其子元素')));
});

test('未来模型证据字段进入待归类证据，归一化结果通过 单模型Schema', async () => {
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

test('qwen3.7-flash 的 meaning 顶层字段和 candidate_key 可归一化并通过 单模型Schema', async () => {
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

test('qwen3-vl-plus 的 visible-icon 动作依据可归一化并通过 单模型Schema', async () => {
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

test('模型误用 container 几何类型时归一化为 boundary 并通过 单模型Schema', async () => {
  const raw = sampleRecognition();
  raw.elements[0].geometryKind = 'container';

  const { recognitionResult, normalizationIssues } = normalizeRecognitionOutput(raw);
  const schema = JSON.parse(await readFile(new URL('./recognition-output.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  assert.equal(recognitionResult.elements[0].geometryKind, 'boundary');
  assert.ok(normalizationIssues.some((issue) => issue.messages.includes('geometryKind 已从 container 归一化为 boundary')));
  assert.equal(validate(recognitionResult), true, JSON.stringify(validate.errors));
});

test('模型返回未知元素类型时留空标红所需字段并通过 单模型Schema', async () => {
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

test('GPT-5 在未请求比较时返回文字 changes 可归一化并通过 单模型Schema', async () => {
  const raw = sampleRecognition();
  raw.comparison.changes = ['补充了结构容器', '调整了候选区域'];

  const { recognitionResult, normalizationIssues } = normalizeRecognitionOutput(raw);
  const schema = JSON.parse(await readFile(new URL('./recognition-output.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  assert.deepEqual(recognitionResult.comparison.changes, []);
  assert.ok(normalizationIssues.some((issue) => issue.messages.includes('comparison.status 为 not-requested，已移除 2 条模型说明')));
  assert.equal(validate(recognitionResult), true, JSON.stringify(validate.errors));
});

test('单模型支持完整操作枚举并通过 Schema', async () => {
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

test('单模型操作直接转换为元素支持操作', () => {
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
