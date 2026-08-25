import { createHash, randomUUID } from 'node:crypto';
import { ELEMENT_ACTIONS, ELEMENT_TYPES, RECOGNITION_ACTIONS } from './element-taxonomy.mjs';

const ELEMENT_TYPE_REPLACEMENTS = {
  'bottom-navigation': 'navigation-bar',
  back: 'icon-button',
  close: 'icon-button',
  menu: 'icon-button',
  stepper: 'pagination',
  button: 'text-button',
  'primary-button': 'text-button',
  'secondary-button': 'text-button',
  'menu-button': 'icon-button',
  'menu-item': 'text-button',
  'danger-button': 'text-button',
  'link-button': 'text-button',
  icon: 'image',
  'toggle-button': 'switch',
};

function normalizeElementType(value) {
  const candidate = ELEMENT_TYPE_REPLACEMENTS[value] || value;
  return ELEMENT_TYPES.includes(candidate) ? candidate : '';
}

export const DRAFT_SCHEMA_VERSION = 'uikg-workbench-draft/1.1';

const MEANING_EVIDENCE_FIELDS = ['visibleTexts', 'visibleIcons', 'visibleStates', 'visualCues'];

export function normalizeGridCount(value) {
  return Math.min(12, Math.max(1, Math.round(Number(value) || 1)));
}

export function inferGridForBox(bbox) {
  const grid = gridForBox(bbox);
  return { columns: grid.columns, rows: grid.rows };
}

function gridAxisForBox(offset, size, maximumCount) {
  const maximum = normalizeGridCount(maximumCount);
  const candidateFor = (count) => {
    const start = Math.floor(offset * count);
    const end = Math.ceil((offset + size) * count - 1e-9) - 1;
    if (start !== end || start < 0 || end >= count) return null;
    const leftMargin = offset * count - start;
    const rightMargin = start + 1 - (offset + size) * count;
    // Keep at least 10% of the element size clear on both sides when possible.
    const minimumMargin = Math.max(0.025, size * count * 0.1);
    return { count, index: start, hasTolerance: Math.min(leftMargin, rightMargin) >= minimumMargin };
  };

  let fallback = null;
  for (let count = maximum; count >= 1; count -= 1) {
    const candidate = candidateFor(count);
    if (!candidate) continue;
    fallback ||= candidate;
    if (candidate.hasTolerance) return candidate;
  }
  return fallback || { count: 1, index: 0, hasTolerance: false };
}

export function gridForBox(bbox, maximumColumns = 12, maximumRows = 12) {
  const column = gridAxisForBox(bbox.x, bbox.width, maximumColumns);
  const row = gridAxisForBox(bbox.y, bbox.height, maximumRows);
  return {
    columns: column.count,
    rows: row.count,
    region: row.index * column.count + column.index + 1,
  };
}

function normalizeCapabilities(capabilities) {
  const normalized = [...new Set((Array.isArray(capabilities) ? capabilities : [])
    .filter((capability) => typeof capability === 'string' && capability.trim())
    .map((capability) => capability.trim())
    .filter((capability) => ELEMENT_ACTIONS.includes(capability)))];
  const actions = normalized.filter((capability) => capability !== 'none');
  return actions.length > 0 ? actions : ['none'];
}

function defaultActionEffect(elementType, action) {
  if (action === 'none') return `${elementType} 仅展示或承载内容，不触发交互`;
  if (action === 'input') return `向 ${elementType} 输入文本或数值`;
  if (action === 'scroll_vertical') return `纵向滚动 ${elementType} 中的内容`;
  if (action === 'scroll_horizontal') return `横向滚动 ${elementType} 中的内容`;
  if (action === 'swipe') return `滑动 ${elementType} 以切换内容或状态`;
  if (action === 'drag') return `拖拽 ${elementType} 或其中的目标对象`;
  if (action === 'zoom') return `缩放 ${elementType} 中的内容`;
  if (action === 'multi_touch') return `在 ${elementType} 上执行多点触控`;
  if (action === 'double_tap') return `双击 ${elementType} 触发对应交互`;
  if (action === 'long_press') return `长按 ${elementType} 打开扩展操作或状态`;
  return `点击 ${elementType} 触发对应操作`;
}

function normalizeActionEffects(actionEffects, elementType, capabilities) {
  const current = Array.isArray(actionEffects) ? actionEffects : [];
  return capabilities.map((action) => ({
    action,
    effect: current.find((item) => item?.action === action && typeof item?.effect === 'string')?.effect || defaultActionEffect(elementType, action),
  }));
}

function normalizeInteractionBoundary(interactionBoundary, capabilities) {
  if (!capabilities.some((capability) => capability !== 'none')) return 'none';
  return interactionBoundary === 'none' || !interactionBoundary ? 'candidate_bbox' : interactionBoundary;
}

const LIST_CONTAINER_TYPES = new Set(['list', 'grouped-list', 'swipe-list', 'expandable-list']);

function isInheritedAbstractListItem(element, parent) {
  return element?.abstraction?.kind === 'repeated-template' && LIST_CONTAINER_TYPES.has(parent?.elementType);
}

function normalizeAbstraction(rawAbstraction, fallbackKey = '') {
  if (!rawAbstraction || typeof rawAbstraction !== 'object' || !['repeated-template', 'dynamic-template'].includes(rawAbstraction.kind)) return null;
  const kind = rawAbstraction.kind;
  const fields = Array.isArray(rawAbstraction.fields)
    ? rawAbstraction.fields.map((field, index) => ({
      key: typeof field?.key === 'string' && field.key.trim() ? field.key.trim() : `field-${index + 1}`,
      label: typeof field?.label === 'string' && field.label.trim() ? field.label.trim() : '重复字段',
      elementType: typeof field?.elementType === 'string' ? field.elementType : 'static-label',
      description: typeof field?.description === 'string' && field.description.trim() ? field.description.trim() : '同类列表项中的稳定字段',
      displayCondition: typeof field?.displayCondition === 'string' ? field.displayCondition : '',
      capabilities: normalizeCapabilities(field?.capabilities),
      interactionBoundary: normalizeInteractionBoundary(field?.interactionBoundary, normalizeCapabilities(field?.capabilities)),
      actionEffects: normalizeActionEffects(field?.actionEffects, typeof field?.elementType === 'string' && field.elementType ? field.elementType : 'static-label', normalizeCapabilities(field?.capabilities)),
      parentId: typeof field?.parentId === 'string' && field.parentId.trim() ? field.parentId.trim() : null,
      required: Boolean(field?.required),
      instanceRegions: Array.isArray(field?.instanceRegions)
        ? field.instanceRegions.filter((region) => region && typeof region === 'object').map(clampUnitBox)
        : [],
    })).filter((field) => {
      // Legacy recognition sometimes hallucinated an avatar role without any visual evidence.
      // Keep real avatars when the model supplied at least one field-level bbox.
      const key = field.key.toLowerCase();
      return !(field.instanceRegions.length === 0 && (key === 'avatar' || key === 'avatar-placeholder' || key === 'avatar-placeholder-icon'));
    })
    : [];
  const instanceRegions = Array.isArray(rawAbstraction.instanceRegions)
    ? rawAbstraction.instanceRegions.filter((region) => region && typeof region === 'object').map(clampUnitBox)
    : [];
  const instanceCount = kind === 'dynamic-template'
    ? 1
    : Math.max(2, Math.round(Number(rawAbstraction.instanceCount) || instanceRegions.length || 2));
  return {
    kind,
    templateKey: typeof rawAbstraction.templateKey === 'string' && rawAbstraction.templateKey.trim() ? rawAbstraction.templateKey.trim() : fallbackKey,
    instanceCount,
    fields,
    instanceRegions,
    bboxStyle: 'abstract',
  };
}

function evidenceDetail(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function uniqueUnclassified(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.type}\u0000${item.detail || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeMeaning(rawMeaning, onIssue = () => {}, captureUnexpectedBasis = true) {
  const meaning = rawMeaning && typeof rawMeaning === 'object' ? rawMeaning : {};
  const rawEvidence = meaning.evidence && typeof meaning.evidence === 'object' && !Array.isArray(meaning.evidence)
    ? meaning.evidence
    : {};
  const unclassified = [];
  const evidence = {};

  for (const field of MEANING_EVIDENCE_FIELDS) {
    const value = rawEvidence[field];
    if (Array.isArray(value)) {
      evidence[field] = [...new Set(value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];
      for (const invalid of value.filter((item) => typeof item !== 'string')) {
        unclassified.push({ type: `${field}-invalid`, detail: evidenceDetail(invalid) });
        onIssue(`${field} 包含非文字证据`);
      }
    } else if (typeof value === 'string' && value.trim()) {
      evidence[field] = [value.trim()];
      onIssue(`${field} 应为数组，已保留单个文字值`);
    } else {
      evidence[field] = [];
      if (value !== null && value !== undefined) {
        unclassified.push({ type: `${field}-invalid`, detail: evidenceDetail(value) });
        onIssue(`${field} 的结构无法识别`);
      }
    }
  }

  evidence.userContext = typeof rawEvidence.userContext === 'string' && rawEvidence.userContext.trim()
    ? rawEvidence.userContext.trim()
    : null;
  if (rawEvidence.userContext !== null && rawEvidence.userContext !== undefined && typeof rawEvidence.userContext !== 'string') {
    unclassified.push({ type: 'userContext-invalid', detail: evidenceDetail(rawEvidence.userContext) });
    onIssue('userContext 的结构无法识别');
  }

  if (Array.isArray(rawEvidence.unclassified)) {
    for (const item of rawEvidence.unclassified) {
      if (item && typeof item === 'object' && typeof item.type === 'string' && item.type.trim()) {
        unclassified.push({ type: item.type.trim(), detail: evidenceDetail(item.detail) });
      } else {
        unclassified.push({ type: 'unclassified-invalid', detail: evidenceDetail(item) });
        onIssue('unclassified 包含无法识别的证据');
      }
    }
  } else if (rawEvidence.unclassified !== null && rawEvidence.unclassified !== undefined) {
    unclassified.push({ type: 'unclassified-invalid', detail: evidenceDetail(rawEvidence.unclassified) });
    onIssue('unclassified 应为数组');
  }

  const knownEvidenceKeys = new Set([...MEANING_EVIDENCE_FIELDS, 'userContext', 'unclassified']);
  for (const [key, value] of Object.entries(rawEvidence)) {
    if (knownEvidenceKeys.has(key)) continue;
    unclassified.push({ type: key, detail: evidenceDetail(value) });
    onIssue(`发现未定义的证据字段 ${key}`);
  }
  if (captureUnexpectedBasis && meaning.basis !== null && meaning.basis !== undefined) {
    const detail = evidenceDetail(meaning.basis);
    unclassified.push({ type: 'model-basis', detail });
    onIssue(`模型返回了未定义的 basis${detail ? `：${detail}` : ''}`);
  }
  if (captureUnexpectedBasis) {
    const knownMeaningKeys = new Set(['status', 'description', 'evidence', 'basis']);
    for (const [key, value] of Object.entries(meaning)) {
      if (knownMeaningKeys.has(key)) continue;
      unclassified.push({ type: `meaning.${key}`, detail: evidenceDetail(value) });
      onIssue(`发现未定义的 meaning 字段 ${key}`);
    }
  }
  evidence.unclassified = uniqueUnclassified(unclassified);

  const status = ['known', 'candidate', 'unknown'].includes(meaning.status) ? meaning.status : 'unknown';
  if (status !== meaning.status) onIssue('meaning.status 无法识别，已降级为 unknown');
  const description = typeof meaning.description === 'string' || meaning.description === null
    ? meaning.description
    : null;
  if (description !== meaning.description) onIssue('meaning.description 无法识别，已清空');
  return { status, description, evidence };
}

function normalizeDraftMeaning(rawMeaning) {
  const hasEvidence = Boolean(rawMeaning?.evidence && typeof rawMeaning.evidence === 'object');
  const meaning = normalizeMeaning(rawMeaning, () => {}, false);
  if (!hasEvidence) meaning.status = 'unknown';
  return meaning;
}

function hasClassifiedMeaningEvidence(evidence) {
  return MEANING_EVIDENCE_FIELDS.some((field) => evidence[field].length > 0) || Boolean(evidence.userContext);
}

export function normalizeRecognitionOutput(rawRecognitionResult) {
  const recognitionResult = structuredClone(rawRecognitionResult);
  const normalizationIssues = [];
  if (!Array.isArray(recognitionResult?.elements)) return { recognitionResult, normalizationIssues };
  recognitionResult.elements = recognitionResult.elements.map((element, index) => {
    const repairIssues = [];
    const meaningIssues = [];
    const normalizedElement = { ...element };
    const rawMeaning = element?.meaning && typeof element.meaning === 'object' && !Array.isArray(element.meaning)
      ? element.meaning
      : {};
    const meaningInput = { ...rawMeaning };

    if (!normalizedElement.abstraction && rawMeaning.abstraction && typeof rawMeaning.abstraction === 'object' && !Array.isArray(rawMeaning.abstraction)) {
      normalizedElement.abstraction = rawMeaning.abstraction;
      delete meaningInput.abstraction;
      repairIssues.push('meaning.abstraction 已上提到元素顶层');
    }

    if (Object.hasOwn(normalizedElement, 'candidate_key')) {
      if ((!normalizedElement.candidateKey || typeof normalizedElement.candidateKey !== 'string')
        && typeof normalizedElement.candidate_key === 'string'
        && normalizedElement.candidate_key.trim()) {
        normalizedElement.candidateKey = normalizedElement.candidate_key.trim();
        repairIssues.push('candidate_key 已归一化为 candidateKey');
      } else {
        repairIssues.push('已移除 candidate_key 别名并保留 candidateKey');
      }
      delete normalizedElement.candidate_key;
    }

    if (normalizedElement.geometryKind === 'container') {
      normalizedElement.geometryKind = 'boundary';
      repairIssues.push('geometryKind 已从 container 归一化为 boundary');
    }

    if (typeof normalizedElement.elementType === 'string') {
      const rawElementType = normalizedElement.elementType.trim();
      const repairedElementType = ELEMENT_TYPE_REPLACEMENTS[rawElementType] || rawElementType;
      if (ELEMENT_TYPES.includes(repairedElementType)) {
        normalizedElement.elementType = repairedElementType;
        if (repairedElementType !== rawElementType) {
          repairIssues.push(`elementType 已从 ${rawElementType} 归一化为 ${repairedElementType}`);
        }
      } else {
        normalizedElement.elementType = '';
        normalizedElement.riskSignals = [...new Set([
          ...(Array.isArray(normalizedElement.riskSignals) ? normalizedElement.riskSignals : []),
          'element-type-needs-review',
        ])];
        repairIssues.push(`elementType ${rawElementType || '(empty)'} 未在当前分类中，已留空等待审核`);
      }
    }

    if (typeof rawMeaning.dynamicContent === 'boolean') {
      if (typeof normalizedElement.dynamicContent !== 'boolean') {
        normalizedElement.dynamicContent = rawMeaning.dynamicContent;
        repairIssues.push('meaning.dynamicContent 已上提到元素顶层');
      }
      delete meaningInput.dynamicContent;
    }
    if (typeof rawMeaning.confidence === 'number') {
      if (typeof normalizedElement.confidence !== 'number') {
        normalizedElement.confidence = rawMeaning.confidence;
        repairIssues.push('meaning.confidence 已上提到元素顶层');
      }
      delete meaningInput.confidence;
    }
    if (Array.isArray(rawMeaning.riskSignals)) {
      const topLevelRiskSignals = Array.isArray(normalizedElement.riskSignals) ? normalizedElement.riskSignals : [];
      normalizedElement.riskSignals = [...new Set([...topLevelRiskSignals, ...rawMeaning.riskSignals])];
      repairIssues.push('meaning.riskSignals 已上提到元素顶层');
      delete meaningInput.riskSignals;
    }

    const meaning = normalizeMeaning(meaningInput, (message) => meaningIssues.push(message));
    if (!hasClassifiedMeaningEvidence(meaning.evidence) && meaning.evidence.unclassified.length > 0 && meaning.status === 'known') {
      meaning.status = 'candidate';
      meaningIssues.push('只有待归类证据，语义状态已降级为 candidate');
    }
    const elementIssues = [...repairIssues, ...meaningIssues];
    const candidateKey = typeof normalizedElement.candidateKey === 'string' ? normalizedElement.candidateKey : `element-${index}`;
    if (elementIssues.length > 0) normalizationIssues.push({ elementIndex: index, candidateKey, messages: elementIssues });
    if (meaningIssues.length > 0) {
      normalizedElement.riskSignals = [...new Set([
        ...(Array.isArray(normalizedElement.riskSignals) ? normalizedElement.riskSignals : []),
        'meaning-evidence-needs-review',
      ])];
    }
    normalizedElement.abstraction = normalizeAbstraction(normalizedElement.abstraction, candidateKey);
    return { ...normalizedElement, meaning };
  });
  if (Array.isArray(recognitionResult.actionCandidates)) {
    recognitionResult.actionCandidates = recognitionResult.actionCandidates.map((actionCandidate, index) => {
      const messages = [];
      const normalized = { ...actionCandidate };
      if (actionCandidate?.basis === 'visible-icon') {
        normalized.basis = 'visible-affordance';
        messages.push('actionCandidates.basis 已从 visible-icon 归一化为 visible-affordance');
      }
      if (messages.length > 0) {
        normalizationIssues.push({
          actionCandidateIndex: index,
          candidateKey: typeof actionCandidate.triggerCandidateKey === 'string' ? actionCandidate.triggerCandidateKey : `action-${index}`,
          messages,
        });
      }
      return normalized;
    });
  }
  if (recognitionResult.comparison && typeof recognitionResult.comparison === 'object' && Array.isArray(recognitionResult.comparison.changes)) {
    const rawChanges = recognitionResult.comparison.changes;
    if (recognitionResult.comparison.status === 'not-requested' && rawChanges.length > 0) {
      recognitionResult.comparison.changes = [];
      normalizationIssues.push({
        section: 'comparison',
        messages: [`comparison.status 为 not-requested，已移除 ${rawChanges.length} 条模型说明`],
      });
    } else if (rawChanges.some((change) => typeof change === 'string')) {
      recognitionResult.comparison.changes = rawChanges.map((change) => (
        typeof change === 'string' ? { summary: change } : change
      ));
      normalizationIssues.push({
        section: 'comparison',
        messages: ['comparison.changes 中的文字说明已归一化为对象'],
      });
    }
  }
  return { recognitionResult, normalizationIssues };
}

function pageKeyFromName(name) {
  const ascii = String(name || 'page')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  const fallback = createHash('sha256').update(String(name || 'current')).digest('hex').slice(0, 12);
  return `page.${ascii || fallback}`;
}

function draftPageId() {
  return `draft-page-${randomUUID()}`;
}

function makeDraftPage(page, frameId = null, featurePath = []) {
  return {
    id: page.id || draftPageId(),
    key: page.key || pageKeyFromName(page.name),
    name: page.name || '当前页面',
    functionRef: page.functionRef || '',
    implementationType: page.implementationType || 'unknown',
    surfaceType: page.surfaceType || 'unknown',
    stateSummary: page.stateSummary || '',
    scrollableRegions: [...(page.scrollableRegions || [])],
    featurePath: featurePath.length ? [...featurePath] : [page.name || '待归类'],
    frameIds: frameId ? [frameId] : [],
    elementIds: [],
    publishedAt: null,
  };
}

export function beginFrameCapture(currentDraft, frameId, { forceNewPage = false, replacePageId = null } = {}) {
  const previous = normalizeDraftShape(currentDraft || createEmptyDraft());
  const existingPage = previous.pages.find((page) => page.id === (replacePageId || previous.currentPageId));
  const existingPageHasElements = Boolean(existingPage && previous.elements.some((element) => element.pageId === existingPage.id));
  const page = existingPage && !existingPageHasElements && !forceNewPage
    ? { ...existingPage, frameIds: [frameId], elementIds: [], publishedAt: null }
    : makeDraftPage({
        id: draftPageId(),
        key: `page.capture.${randomUUID().slice(0, 8)}`,
        name: '待识别页面',
        functionRef: '',
        implementationType: 'unknown',
        surfaceType: 'unknown',
        stateSummary: '',
        scrollableRegions: [],
      }, frameId, ['待归类']);
  const pages = previous.pages.filter((item) => item.id !== page.id);
  pages.push(page);
  return normalizeDraftShape({
    ...previous,
    revision: previous.revision + 1,
    currentFrameId: frameId,
    rawModelResultRef: null,
    currentPageId: page.id,
    page: {
      id: page.id,
      key: page.key,
      name: page.name,
      functionRef: page.functionRef,
      implementationType: page.implementationType,
      surfaceType: page.surfaceType,
      stateSummary: page.stateSummary,
      scrollableRegions: page.scrollableRegions,
    },
    pages,
    updatedAt: new Date().toISOString(),
  });
}

function pageSummaryFields(page) {
  return {
    id: page.id,
    key: page.key,
    name: page.name,
    functionRef: page.functionRef,
    implementationType: page.implementationType,
    surfaceType: page.surfaceType,
    stateSummary: page.stateSummary,
    scrollableRegions: page.scrollableRegions,
  };
}

// Append a newly captured/uploaded frame to an existing page while KEEPING its
// annotated elements. Unlike beginFrameCapture this never discards elementIds.
export function appendFrameToPage(currentDraft, frameId, { pageId = null } = {}) {
  const previous = normalizeDraftShape(currentDraft || createEmptyDraft());
  const targetPage = previous.pages.find((page) => page.id === (pageId || previous.currentPageId));
  if (!targetPage) {
    // No such page to append to — fall back to creating a fresh capture page.
    return beginFrameCapture(previous, frameId, { forceNewPage: true });
  }
  const frameIds = targetPage.frameIds.includes(frameId)
    ? [...targetPage.frameIds]
    : [...targetPage.frameIds, frameId];
  const nextPage = { ...targetPage, frameIds, publishedAt: null };
  const pages = previous.pages.map((page) => (page.id === nextPage.id ? nextPage : page));
  return normalizeDraftShape({
    ...previous,
    revision: previous.revision + 1,
    currentPageId: nextPage.id,
    currentFrameId: frameId,
    rawModelResultRef: null,
    page: pageSummaryFields(nextPage),
    pages,
    updatedAt: new Date().toISOString(),
  });
}

// Remove a single observation frame from a page. Refuses to remove the last
// remaining frame (a page must always keep at least one frame). Returns a flag
// so the route layer can surface a 4xx when the removal is rejected.
export function removeFrameFromPage(currentDraft, frameId, { pageId = null } = {}) {
  const previous = normalizeDraftShape(currentDraft || createEmptyDraft());
  const targetPage = previous.pages.find((page) => (pageId ? page.id === pageId : page.frameIds.includes(frameId)));
  if (!targetPage || !targetPage.frameIds.includes(frameId)) {
    return { draft: previous, removed: false, reason: 'not-found' };
  }
  if (targetPage.frameIds.length <= 1) {
    return { draft: previous, removed: false, reason: 'last-frame' };
  }
  const frameIds = targetPage.frameIds.filter((id) => id !== frameId);
  const nextPage = { ...targetPage, frameIds, publishedAt: null };
  const pages = previous.pages.map((page) => (page.id === nextPage.id ? nextPage : page));
  const wasCurrent = previous.currentPageId === nextPage.id;
  const currentFrameId = wasCurrent && previous.currentFrameId === frameId
    ? frameIds.at(-1)
    : previous.currentFrameId;
  return {
    draft: normalizeDraftShape({
      ...previous,
      revision: previous.revision + 1,
      currentFrameId,
      page: wasCurrent ? pageSummaryFields(nextPage) : previous.page,
      pages,
      updatedAt: new Date().toISOString(),
    }),
    removed: true,
  };
}

export function removePagesFromDraft(currentDraft, pageIds) {
  const previous = normalizeDraftShape(currentDraft || createEmptyDraft());
  const removedPageIds = new Set(pageIds || []);
  if (!previous.pages.some((page) => removedPageIds.has(page.id))) return previous;
  const removedElementIds = new Set(previous.elements
    .filter((element) => element.pageId && removedPageIds.has(element.pageId))
    .map((element) => element.id));
  const elements = previous.elements
    .filter((element) => !removedElementIds.has(element.id))
    .map((element) => element.ownerKind === 'application'
      ? { ...element, availableOnPageIds: element.availableOnPageIds.filter((id) => !removedPageIds.has(id)) }
      : element);
  const pages = previous.pages.filter((page) => !removedPageIds.has(page.id));
  const nextPage = pages.find((page) => page.id === previous.currentPageId) || pages[0];
  const emptyPage = {
    id: 'draft-page-empty',
    key: 'page.empty',
    name: '',
    functionRef: '',
    implementationType: 'unknown',
    surfaceType: 'unknown',
    stateSummary: '',
    scrollableRegions: [],
  };
  return normalizeDraftShape({
    ...previous,
    revision: previous.revision + 1,
    currentPageId: nextPage?.id || emptyPage.id,
    currentFrameId: nextPage?.frameIds.at(-1) || null,
    page: nextPage
      ? { id: nextPage.id, key: nextPage.key, name: nextPage.name, functionRef: nextPage.functionRef, implementationType: nextPage.implementationType, surfaceType: nextPage.surfaceType, stateSummary: nextPage.stateSummary, scrollableRegions: nextPage.scrollableRegions }
      : emptyPage,
    pages,
    elements,
    elementEditRecords: previous.elementEditRecords.filter((record) => !removedElementIds.has(record.elementId)),
    transitions: previous.transitions.filter((transition) => !removedPageIds.has(transition.sourcePageId) && !removedPageIds.has(transition.targetPageId) && !removedElementIds.has(transition.triggerElementId)),
    updatedAt: new Date().toISOString(),
  });
}

export function createEmptyDraft() {
  const now = new Date().toISOString();
  return {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    revision: 0,
    appKey: 'zto.connect',
    buildRef: '',
    featurePath: [],
    currentFrameId: null,
    rawModelResultRef: null,
    currentPageId: 'draft-page-current',
    page: {
      id: 'draft-page-current',
      key: 'page.current',
      name: '当前页面',
      functionRef: '',
      implementationType: 'unknown',
      surfaceType: 'unknown',
      stateSummary: '',
      scrollableRegions: [],
    },
    pages: [],
    elements: [],
    elementEditRecords: [],
    transitions: [],
    lastAiModel: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeDraftShape(value) {
  const draft = structuredClone(value || createEmptyDraft());
  draft.schemaVersion = DRAFT_SCHEMA_VERSION;
  draft.currentPageId ||= draft.page?.id || 'draft-page-current';
  draft.page ||= {
    id: draft.currentPageId,
    key: 'page.current',
    name: '当前页面',
    functionRef: '',
    implementationType: 'unknown',
    surfaceType: 'unknown',
    stateSummary: '',
    scrollableRegions: [],
  };
  draft.page.id = draft.currentPageId;
  draft.page.key ||= pageKeyFromName(draft.page.name);
  draft.pages = Array.isArray(draft.pages) ? draft.pages : [];
  if (draft.currentFrameId && !draft.pages.some((page) => page.id === draft.currentPageId)) {
    draft.pages.push(makeDraftPage(draft.page, draft.currentFrameId, draft.featurePath));
  }
  draft.elements = (draft.elements || []).map((element) => {
    const { actionable: _removedActionable, ...elementFields } = element;
    const elementType = normalizeElementType(element.elementType);
    const capabilities = normalizeCapabilities(element.capabilities);
    const grid = gridForBox(element.bbox, element.gridColumns ?? 12, element.gridRows ?? 12);
    return {
      ...elementFields,
      displayCondition: typeof element.displayCondition === 'string' ? element.displayCondition : '',
      abstraction: normalizeAbstraction(element.abstraction, element.candidateKey),
      elementType,
      capabilities,
      actionEffects: normalizeActionEffects(element.actionEffects, elementType, capabilities),
      interactionBoundary: normalizeInteractionBoundary(element.interactionBoundary, capabilities),
      gridColumns: grid.columns,
      gridRows: grid.rows,
      gridRegion: grid.region,
      meaning: normalizeDraftMeaning(element.meaning),
      pageId: element.pageId ?? (['application', 'shared_component'].includes(element.ownerKind) ? null : draft.currentPageId),
      availableOnPageIds: [...(element.availableOnPageIds || (element.ownerKind === 'application' ? [draft.currentPageId] : []))],
      aiModel: element.aiModel || draft.lastAiModel || null,
    };
  });
  // A repeated list-item template represents many rows, so its editable region is
  // the containing list's region rather than any one concrete instance.
  const elementsById = new Map(draft.elements.map((element) => [element.id, element]));
  draft.elements = draft.elements.map((element) => {
    const parent = element.parentId ? elementsById.get(element.parentId) : null;
    if (!isInheritedAbstractListItem(element, parent)) return element;
    return {
      ...element,
      bbox: { ...parent.bbox },
      gridColumns: parent.gridColumns,
      gridRows: parent.gridRows,
      gridRegion: parent.gridRegion,
    };
  });
  draft.elementEditRecords = Array.isArray(draft.elementEditRecords)
    ? draft.elementEditRecords.filter((record) => record && typeof record.elementId === 'string')
    : [];
  const editedElementIds = new Set(draft.elementEditRecords.map((record) => record.elementId));
  draft.elements = draft.elements.map((element) => {
    if (element.source === 'human' || editedElementIds.has(element.id)) return element;
    return {
      ...element,
      reviewStatus: element.reviewStatus === 'edited' ? 'pending' : element.reviewStatus,
      source: 'ai',
    };
  });
  draft.transitions = Array.isArray(draft.transitions) ? draft.transitions : [];
  draft.lastAiModel ||= null;
  const pageById = new Map(draft.pages.map((page) => [page.id, page]));
  for (const page of draft.pages) {
    page.key ||= pageKeyFromName(page.name);
    page.functionRef ||= '';
    page.implementationType ||= 'unknown';
    page.featurePath = page.featurePath?.length ? page.featurePath.slice(0, 3) : [page.name || '待归类'];
    page.frameIds = [...new Set(page.frameIds || [])];
    page.elementIds = [];
    page.publishedAt ||= null;
  }
  for (const element of draft.elements) {
    if (element.pageId && pageById.has(element.pageId)) pageById.get(element.pageId).elementIds.push(element.id);
    if (element.ownerKind === 'application') {
      for (const pageId of element.availableOnPageIds) {
        if (pageById.has(pageId)) pageById.get(pageId).elementIds.push(element.id);
      }
    }
  }
  for (const page of draft.pages) page.elementIds = [...new Set(page.elementIds)];
  return draft;
}

function draftElementId(candidateKey) {
  return `element-${candidateKey.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 72)}-${randomUUID().slice(0, 8)}`;
}

function inferRole(element) {
  if (element.elementType === 'container') return 'container';
  if (element.elementType === 'label') return 'label';
  if (element.elementType === 'status' || element.elementType === 'badge') {
    return 'status_indicator';
  }
  if (element.interactive) return 'action_trigger';
  return 'content_anchor';
}

function capabilitiesFor(candidateKey, actions) {
  const capabilities = [...new Set(
    actions
      .filter((action) => action.triggerCandidateKey === candidateKey)
      .map((action) => RECOGNITION_ACTIONS.includes(action.action) ? action.action : null)
      .filter(Boolean),
  )];
  return capabilities.length > 0 ? capabilities : ['none'];
}

function actionEffectsFor(candidateKey, actions, elementType, capabilities) {
  return capabilities.map((action) => ({
    action,
    effect: actions.find((candidate) => candidate.triggerCandidateKey === candidateKey && candidate.action === action)?.expectedOutcome || defaultActionEffect(elementType, action),
  }));
}

function nextElementFromRecognition(element, actions, pageId, model) {
  const capabilities = capabilitiesFor(element.candidateKey, actions);
  const grid = gridForBox(element.approximateRegion);
  return {
    id: draftElementId(element.candidateKey),
    candidateKey: element.candidateKey,
    label: element.label || element.visualDescription,
    visualDescription: element.visualDescription,
    displayCondition: typeof element.displayCondition === 'string' ? element.displayCondition : '',
    elementType: element.elementType,
    role: inferRole(element),
    capabilities,
    actionEffects: actionEffectsFor(element.candidateKey, actions, element.elementType, capabilities),
    enabled: element.enabled ?? null,
    state: element.state || '',
    dynamicContent: element.dynamicContent,
    abstraction: normalizeAbstraction(element.abstraction, element.candidateKey),
    bbox: { ...element.approximateRegion },
    gridColumns: grid.columns,
    gridRows: grid.rows,
    gridRegion: grid.region,
    geometryKind: element.geometryKind,
    geometryConfidence: element.geometryConfidence,
    confidence: element.confidence,
    meaning: { ...element.meaning },
    riskSignals: [...(element.riskSignals || [])],
    ownerKind: 'page',
    ownerRef: pageId,
    parentId: null,
    childrenIds: [],
    pageId,
    availableOnPageIds: [],
    interactionBoundary: normalizeInteractionBoundary(null, capabilities),
    reviewStatus: 'pending',
    source: 'ai',
    aiModel: model || null,
    lastModelProposal: null,
  };
}

function isHumanProtected(element, editedElementIds) {
  return element.reviewStatus === 'accepted' || editedElementIds.has(element.id) || element.source === 'human';
}

function clampUnitBox(box) {
  const stable = (value) => Number(value.toFixed(6));
  const x = Math.min(Math.max(Number(box.x) || 0, 0), 0.999);
  const y = Math.min(Math.max(Number(box.y) || 0, 0), 0.999);
  return {
    x: stable(x),
    y: stable(y),
    width: stable(Math.min(Math.max(Number(box.width) || 0.001, 0.001), 1 - x)),
    height: stable(Math.min(Math.max(Number(box.height) || 0.001, 0.001), 1 - y)),
  };
}

function repeatItemParts(candidateKey) {
  const match = String(candidateKey || '').match(/^(.+?)[._-](\d+)[._-](.+)$/);
  return match ? { prefix: match[1], index: match[2], suffix: match[3] } : null;
}

function unionCandidateBoxes(elements) {
  const left = Math.min(...elements.map((element) => element.approximateRegion.x));
  const top = Math.min(...elements.map((element) => element.approximateRegion.y));
  const right = Math.max(...elements.map((element) => element.approximateRegion.x + element.approximateRegion.width));
  const bottom = Math.max(...elements.map((element) => element.approximateRegion.y + element.approximateRegion.height));
  return clampUnitBox({ x: left, y: top, width: right - left, height: bottom - top });
}

function currentUserFieldRole(element) {
  const key = String(element?.candidateKey || '').toLowerCase();
  const description = [element?.label, element?.visualDescription, element?.meaning?.description].filter(Boolean).join(' ');
  const scoped = /(^|[._-])(?:self|current[._-]?(?:user|account)|user[._-]?profile)([._-]|$)/.test(key)
    || /当前(?:登录)?(?:用户|账号)|登录(?:用户|账号)|个人(?:头像|资料|信息)/.test(description);
  if (!scoped) return null;
  const source = `${key} ${description}`.toLowerCase();
  if (element.elementType === 'avatar' || /avatar|头像/.test(source)) return { key: 'avatar', label: '用户头像', required: true };
  if (/display[._-]?name|user[._-]?name|姓名|显示名称|用户名称|账号名称/.test(source)) return { key: 'display-name', label: '用户名称', required: true };
  if (/organization|company|department|[._-]org(?:[._-]|$)|所属组织|组织名称|企业名称|公司名称|部门名称/.test(source)) return { key: 'organization', label: '组织信息', required: false };
  if (/position|job[._-]?title|职位|岗位|职务/.test(source)) return { key: 'position', label: '职位信息', required: false };
  return null;
}

function inferDynamicUserProfile(proposal) {
  if ((proposal.elements || []).some((element) => element?.abstraction?.kind === 'dynamic-template')) return;
  const profileFields = (proposal.elements || []).map((element) => ({ element, role: currentUserFieldRole(element) })).filter((item) => item.role);
  if (profileFields.length < 2 || !profileFields.some((item) => item.role.key === 'avatar')) return;

  const candidateKey = 'current-user-profile-template';
  if ((proposal.elements || []).some((element) => element.candidateKey === candidateKey)) return;
  const elements = profileFields.map((item) => item.element);
  const instanceRegion = unionCandidateBoxes(elements);
  const fields = profileFields.map(({ element, role }) => {
    const actions = (proposal.actionCandidates || []).filter((action) => action.triggerCandidateKey === element.candidateKey);
    const capabilities = [...new Set(actions.map((action) => action.action).filter((action) => RECOGNITION_ACTIONS.includes(action)))];
    const normalizedCapabilities = capabilities.length > 0 ? capabilities : ['none'];
    return {
      ...role,
      elementType: element.elementType || 'static-label',
      description: `${role.label}随当前登录用户变化`,
      displayCondition: typeof element.displayCondition === 'string' ? element.displayCondition : '',
      capabilities: normalizedCapabilities,
      interactionBoundary: normalizedCapabilities.some((action) => action !== 'none') ? 'candidate_bbox' : 'none',
      actionEffects: normalizedCapabilities.map((action) => ({
        action,
        effect: actions.find((candidate) => candidate.action === action)?.expectedOutcome || defaultActionEffect(element.elementType || 'static-label', action),
      })),
      parentId: candidateKey,
      instanceRegions: [element.approximateRegion],
    };
  });
  proposal.elements.push({
    candidateKey,
    label: '当前用户资料共相',
    visualDescription: '由当前登录用户的头像和身份信息组成的单实例动态区域',
    elementType: 'section',
    interactive: elements.some((element) => element.interactive),
    enabled: elements.some((element) => element.enabled === true) ? true : null,
    state: null,
    approximateRegion: instanceRegion,
    geometryKind: elements.some((element) => element.geometryKind === 'boundary') ? 'boundary' : 'approximate',
    geometryConfidence: Math.min(...elements.map((element) => Number(element.geometryConfidence) || 0.5)),
    meaning: { status: 'known', description: '结构固定、内容随当前登录用户变化的个人资料区域', evidence: { visibleTexts: [], visibleIcons: [], visibleStates: [], visualCues: ['头像与身份信息相邻排列'], userContext: null, unclassified: [] } },
    dynamicContent: true,
    abstraction: {
      kind: 'dynamic-template',
      templateKey: 'current-user.profile',
      instanceCount: 1,
      fields,
      instanceRegions: [instanceRegion],
      bboxStyle: 'abstract',
    },
    riskSignals: [],
    confidence: Math.min(...elements.map((element) => Number(element.confidence) || 0.5)),
  });
  proposal.relationships = [
    ...(proposal.relationships || []),
    ...elements.map((element) => ({ fromCandidateKey: candidateKey, type: 'contains', toCandidateKey: element.candidateKey })),
  ];
}

function dynamicFieldForElement(element, parentId, actionCandidates = []) {
  const elementType = element.elementType || 'section';
  const fieldLabels = {
    carousel: '轮播内容', banner: '横幅内容', image: '图片内容', thumbnail: '缩略图内容', preview: '预览内容',
    avatar: '头像内容', 'avatar-group': '头像集合', badge: '状态角标', 'progress-bar': '进度值', loading: '加载状态',
    card: '卡片内容', panel: '面板内容', section: '动态区域', 'floating-card': '浮层内容', toast: '提示内容',
  };
  const capabilities = [...new Set(actionCandidates
    .filter((action) => action.triggerCandidateKey === element.candidateKey)
    .map((action) => action.action)
    .filter((action) => RECOGNITION_ACTIONS.includes(action)))];
  const normalizedCapabilities = capabilities.length > 0 ? capabilities : ['none'];
  return {
    key: `dynamic-${elementType}`,
    label: fieldLabels[elementType] || '动态字段',
    elementType,
    description: '内容可随运行时数据变化',
    displayCondition: typeof element.displayCondition === 'string' ? element.displayCondition : '',
    capabilities: normalizedCapabilities,
    interactionBoundary: normalizedCapabilities.some((action) => action !== 'none') ? 'candidate_bbox' : 'none',
    actionEffects: normalizeActionEffects(element.actionEffects, elementType, normalizedCapabilities),
    parentId,
    required: false,
    instanceRegions: [element.approximateRegion],
};
}

function inferDynamicElements(proposal) {
  const listKeys = new Set((proposal.elements || [])
    .filter((element) => LIST_CONTAINER_TYPES.has(element.elementType))
    .map((element) => element.candidateKey));
  const listDescendants = new Set();
  const pending = [...listKeys];
  const contains = (proposal.relationships || []).filter((relation) => relation.type === 'contains');
  while (pending.length > 0) {
    const parent = pending.pop();
    for (const relation of contains) {
      if (relation.fromCandidateKey !== parent || listDescendants.has(relation.toCandidateKey)) continue;
      listDescendants.add(relation.toCandidateKey);
      pending.push(relation.toCandidateKey);
    }
  }
  const candidates = (proposal.elements || []).filter((element) => element.dynamicContent === true
    && !element.abstraction && !listDescendants.has(element.candidateKey));
  if (candidates.length === 0) return;

  // A single stable dynamic slot is already a valid dynamic-element共相. Preserve its
  // concrete element type (carousel/banner/progress/etc.) and only abstract its payload.
  if (candidates.length === 1) {
    const element = candidates[0];
    const field = dynamicFieldForElement(element, element.candidateKey, proposal.actionCandidates || []);
    element.abstraction = {
      kind: 'dynamic-template',
      templateKey: `${element.candidateKey}.dynamic`,
      instanceCount: 1,
      fields: [field],
      instanceRegions: [element.approximateRegion],
      bboxStyle: 'abstract',
    };
    element.visualDescription = element.visualDescription || '结构稳定、内容随运行时数据变化的动态元素共相';
    return;
  }

  // Each explicitly dynamic candidate is an independent stable slot unless the
  // model already supplied a multi-field dynamic template or the dedicated user
  // profile inference above provided stronger grouping evidence.
  for (const element of candidates) {
    element.abstraction = {
      kind: 'dynamic-template',
      templateKey: `${element.candidateKey}.dynamic`,
      instanceCount: 1,
      fields: [dynamicFieldForElement(element, element.candidateKey, proposal.actionCandidates || [])],
      instanceRegions: [element.approximateRegion],
      bboxStyle: 'abstract',
    };
    element.visualDescription = element.visualDescription || '结构稳定、内容随运行时数据变化的动态元素共相';
  }
}

function abstractFieldForElement(element, suffix, actionCandidates = []) {
  const labels = {
    title: '主标题',
    description: '辅助描述',
    subtitle: '辅助描述',
    checkbox: '尾部复选框',
    switch: '尾部开关',
    time: '时间信息',
    badge: '状态角标',
    icon: '图标',
  };
  const key = String(suffix || element.elementType || 'field').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const actions = actionCandidates.filter((action) => action.triggerCandidateKey === element.candidateKey);
  const capabilities = [...new Set(actions.map((action) => action.action).filter((action) => RECOGNITION_ACTIONS.includes(action)))];
  const normalizedCapabilities = capabilities.length > 0 ? capabilities : ['none'];
  return {
    key,
    label: labels[key] || '重复字段',
    elementType: element.elementType || 'static-label',
    description: labels[key] ? `每个列表项中的${labels[key]}` : '每个列表项中重复出现的同类字段',
    displayCondition: typeof element.displayCondition === 'string' ? element.displayCondition : '',
    capabilities: normalizedCapabilities,
    interactionBoundary: normalizedCapabilities.some((action) => action !== 'none') ? 'candidate_bbox' : 'none',
    actionEffects: normalizedCapabilities.map((action) => ({
      action,
      effect: actions.find((candidate) => candidate.action === action)?.expectedOutcome || defaultActionEffect(element.elementType || 'static-label', action),
    })),
    parentId: null,
    required: key === 'title',
  };
}

function concreteListItemForGroup(elementsByKey, group) {
  const separators = ['_', '-', '.'];
  const candidateKeys = separators.flatMap((separator) => [
    `${group.prefix}${separator}${group.index}`,
    `${group.prefix}${separator}${group.index}${separator}item`,
  ]);
  return candidateKeys.map((key) => elementsByKey.get(key)).find((element) => element?.elementType === 'list-item') || null;
}

function inferRepeatedListItems(proposal) {
  const listKeys = new Set((proposal.elements || [])
    .filter((element) => ['list', 'grouped-list', 'swipe-list', 'expandable-list'].includes(element.elementType))
    .map((element) => element.candidateKey));
  if (!listKeys.size) return;
  const contains = (proposal.relationships || []).filter((relation) => relation.type === 'contains');
  const explicitListForChild = new Map(contains
    .filter((relation) => listKeys.has(relation.fromCandidateKey))
    .map((relation) => [relation.toCandidateKey, relation.fromCandidateKey]));
  const groups = new Map();
  for (const element of proposal.elements || []) {
    const parts = repeatItemParts(element.candidateKey);
    if (!parts || element.elementType === 'list-item') continue;
    const key = `${parts.prefix}:${parts.index}`;
    if (!groups.has(key)) groups.set(key, { ...parts, elements: [] });
    groups.get(key).elements.push(element);
  }
  const prefixGroups = new Map();
  for (const group of groups.values()) {
    if (group.elements.length < 2) continue;
    if (!prefixGroups.has(group.prefix)) prefixGroups.set(group.prefix, []);
    prefixGroups.get(group.prefix).push(group);
  }
  const existingKeys = new Set((proposal.elements || []).map((element) => element.candidateKey));
  const elementsByKey = new Map((proposal.elements || []).map((element) => [element.candidateKey, element]));
  const additions = [];
  const addedRelations = [];
  const groupedChildren = new Map();
  for (const [prefix, repeatedGroups] of prefixGroups) {
    if (repeatedGroups.length < 2) continue;
    const orderedGroups = [...repeatedGroups].sort((left, right) => Number(left.index) - Number(right.index));
    const allElements = orderedGroups.flatMap((group) => group.elements);
    const concreteItems = orderedGroups.map((group) => concreteListItemForGroup(elementsByKey, group)).filter(Boolean);
    const itemKey = `${prefix}-item-template`;
    if (existingKeys.has(itemKey)) continue;
    const relatedListKeys = [...new Set([...allElements, ...concreteItems].map((element) => explicitListForChild.get(element.candidateKey)).filter(Boolean))];
    const listKey = relatedListKeys.length === 1 ? relatedListKeys[0] : listKeys.size === 1 ? [...listKeys][0] : null;
    if (!listKey) continue;
    const fieldBuckets = new Map();
    orderedGroups.forEach((group) => {
      group.elements.forEach((element) => {
        const field = abstractFieldForElement(element, repeatItemParts(element.candidateKey)?.suffix || element.elementType, proposal.actionCandidates || []);
        const bucket = fieldBuckets.get(field.key) || { field, instanceRegions: [] };
        bucket.instanceRegions.push(element.approximateRegion);
        fieldBuckets.set(field.key, bucket);
      });
    });
    const fields = [...fieldBuckets.values()].map(({ field, instanceRegions }) => ({ ...field, parentId: itemKey, instanceRegions }));
    const instanceRegions = orderedGroups.map((group) => concreteListItemForGroup(elementsByKey, group)?.approximateRegion || unionCandidateBoxes(group.elements));
    additions.push({
      candidateKey: itemKey,
      label: '列表项元素共相',
      visualDescription: `由 ${orderedGroups.length} 个同构可见行归纳出的列表项元素共相`,
      elementType: 'list-item',
      interactive: false,
      enabled: true,
      state: null,
      approximateRegion: unionCandidateBoxes(instanceRegions.map((approximateRegion) => ({ approximateRegion }))),
      geometryKind: allElements.some((element) => (element.riskSignals || []).includes('geometry-grounded-by-runtime')) ? 'boundary' : 'approximate',
      geometryConfidence: Math.min(...allElements.map((element) => Number(element.geometryConfidence) || 0.5)),
      meaning: { status: 'known', description: '重复列表中同构条目的列表项元素共相', evidence: { visibleTexts: [], visibleIcons: [], visibleStates: [], visualCues: ['重复行布局'], userContext: null, unclassified: [] } },
      dynamicContent: true,
      abstraction: {
        kind: 'repeated-template',
        templateKey: `${prefix}.item`,
        instanceCount: orderedGroups.length,
        fields,
        instanceRegions,
        bboxStyle: 'abstract',
      },
      riskSignals: ['list-item-inferred-from-repeated-children'],
      confidence: Math.min(...allElements.map((element) => Number(element.confidence) || 0.5)),
    });
    existingKeys.add(itemKey);
    addedRelations.push({ fromCandidateKey: listKey, type: 'contains', toCandidateKey: itemKey });
    for (const child of [...concreteItems, ...allElements]) {
      groupedChildren.set(child.candidateKey, listKey);
      addedRelations.push({ fromCandidateKey: itemKey, type: 'contains', toCandidateKey: child.candidateKey });
    }
  }
  if (!additions.length) return;
  proposal.elements.push(...additions);
  proposal.relationships = [
    ...(proposal.relationships || []).filter((relation) => !(
      relation.type === 'contains'
      && groupedChildren.get(relation.toCandidateKey) === relation.fromCandidateKey
    )),
    ...addedRelations,
  ];
}

export function prepareRecognitionForDraft(recognitionResult) {
  const proposal = structuredClone(recognitionResult);
  inferDynamicUserProfile(proposal);
  inferDynamicElements(proposal);
  inferRepeatedListItems(proposal);
  const byKey = new Map(proposal.elements.map((element) => [element.candidateKey, element]));
  for (const element of proposal.elements) {
    const original = element.approximateRegion;
    const normalized = clampUnitBox(original);
    if (Object.keys(normalized).some((key) => normalized[key] !== original[key])) {
      element.approximateRegion = normalized;
      element.riskSignals = [...new Set([...(element.riskSignals || []), 'geometry-clamped-to-frame'])];
    }
  }
  proposal.actionCandidates = (proposal.actionCandidates || []).filter((action) => {
    const trigger = byKey.get(action.triggerCandidateKey);
    if (!trigger || trigger.interactive) return Boolean(trigger);
    trigger.riskSignals = [...new Set([...(trigger.riskSignals || []), 'model-action-inconsistent'])];
    return false;
  });
  return proposal;
}

function projectAbstractRecognition(recognitionResult) {
  const proposal = structuredClone(recognitionResult);
  const abstractKeys = new Set((proposal.elements || [])
    .filter((element) => ['repeated-template', 'dynamic-template'].includes(element?.abstraction?.kind))
    .map((element) => element.candidateKey));
  if (!abstractKeys.size) return proposal;
  const childKeys = new Set((proposal.relationships || [])
    .filter((relation) => relation.type === 'contains' && abstractKeys.has(relation.fromCandidateKey))
    .map((relation) => relation.toCandidateKey));
  const abstractParentByChild = new Map((proposal.relationships || [])
    .filter((relation) => relation.type === 'contains' && abstractKeys.has(relation.fromCandidateKey))
    .map((relation) => [relation.toCandidateKey, relation.fromCandidateKey]));
  const keepKeys = new Set((proposal.elements || []).map((element) => element.candidateKey));
  for (const key of childKeys) {
    if (!abstractKeys.has(key)) keepKeys.delete(key);
  }
  proposal.elements = (proposal.elements || []).filter((element) => keepKeys.has(element.candidateKey));
  proposal.relationships = (proposal.relationships || []).filter((relation) => keepKeys.has(relation.fromCandidateKey) && keepKeys.has(relation.toCandidateKey));
  proposal.actionCandidates = (proposal.actionCandidates || []).map((action) => {
    const parentKey = abstractParentByChild.get(action.triggerCandidateKey);
    return parentKey ? { ...action, triggerCandidateKey: parentKey } : action;
  }).filter((action, index, actions) => keepKeys.has(action.triggerCandidateKey)
    && actions.findIndex((candidate) => candidate.triggerCandidateKey === action.triggerCandidateKey && candidate.action === action.action) === index);
  return proposal;
}

export function mergeRecognitionIntoDraft(currentDraft, recognitionResult, modelResultRef, model = null) {
  recognitionResult = projectAbstractRecognition(recognitionResult);
  const previous = normalizeDraftShape(currentDraft || createEmptyDraft());
  const editedElementIds = new Set(previous.elementEditRecords.map((record) => record.elementId));
  const currentPageHasElements = previous.elements.some((item) => item.pageId === previous.currentPageId);
  const currentPageIsEmptyCapture = (
    previous.page.key?.startsWith('page.manual.')
    || previous.page.key?.startsWith('page.capture.')
  ) && !currentPageHasElements;
  const pageChanged = Boolean(
    previous.currentFrameId
    && !currentPageIsEmptyCapture
    && previous.page.name
    && previous.page.name !== '当前页面'
    && recognitionResult.page.name
    && recognitionResult.page.name !== previous.page.name,
  );
  const currentPageId = pageChanged ? draftPageId() : previous.currentPageId;
  const currentPageElements = previous.elements.filter((item) => item.pageId === previous.currentPageId || ['application', 'shared_component'].includes(item.ownerKind));
  const previousByKey = new Map(currentPageElements.map((item) => [item.candidateKey, item]));
  const nextElements = recognitionResult.elements.map((candidate) => {
    const generated = nextElementFromRecognition(candidate, recognitionResult.actionCandidates || [], currentPageId, model);
    const existing = previousByKey.get(candidate.candidateKey);
    if (!existing) return generated;
    if (['application', 'shared_component'].includes(existing.ownerKind)) {
      return {
        ...existing,
        availableOnPageIds: existing.ownerKind === 'application'
          ? [...new Set([...(existing.availableOnPageIds || []), currentPageId])]
          : existing.availableOnPageIds,
        lastModelProposal: isHumanProtected(existing, editedElementIds) ? {
          label: generated.label,
          elementType: generated.elementType,
          bbox: generated.bbox,
          confidence: generated.confidence,
          modelResultRef,
        } : null,
      };
    }
    if (!isHumanProtected(existing, editedElementIds)) {
      return {
        ...generated,
        id: existing.id,
        reviewStatus: existing.reviewStatus,
      };
    }
    return {
      ...existing,
      lastModelProposal: {
        label: generated.label,
        elementType: generated.elementType,
        bbox: generated.bbox,
        confidence: generated.confidence,
        modelResultRef,
      },
    };
  });

  const replacedIds = new Set(nextElements.map((item) => item.id));
  const preservedElements = previous.elements.filter((item) => {
    if (replacedIds.has(item.id)) return false;
    if (['application', 'shared_component'].includes(item.ownerKind)) return true;
    return pageChanged || item.pageId !== previous.currentPageId;
  });
  const mergedElements = [...preservedElements, ...nextElements];
  const byKey = new Map(nextElements.map((item) => [item.candidateKey, item]));
  for (const relation of recognitionResult.relationships || []) {
    if (relation.type !== 'contains') continue;
    const parent = byKey.get(relation.fromCandidateKey);
    const child = byKey.get(relation.toCandidateKey);
    if (!parent || !child || isHumanProtected(child, editedElementIds)) continue;
    child.parentId = parent.id;
    child.ownerKind = parent.ownerKind === 'application' || parent.ownerKind === 'shared_component' ? 'shared_component' : 'component';
    child.ownerRef = parent.id;
    child.pageId = child.ownerKind === 'shared_component' ? null : currentPageId;
  }

  const byId = new Map(mergedElements.map((item) => [item.id, item]));
  for (const element of mergedElements) element.childrenIds = [];
  for (const element of mergedElements) {
    if (!element.parentId) continue;
    const parent = byId.get(element.parentId);
    if (parent && !parent.childrenIds.includes(element.id)) {
      parent.childrenIds.push(element.id);
    }
  }

  const now = new Date().toISOString();
  const currentPage = {
    id: currentPageId,
    key: pageChanged || currentPageIsEmptyCapture
      ? pageKeyFromName(recognitionResult.page.name)
      : (previous.page.key || pageKeyFromName(recognitionResult.page.name)),
    name: recognitionResult.page.name || previous.page.name,
    surfaceType: recognitionResult.page.surfaceType,
    stateSummary: recognitionResult.page.stateSummary,
    scrollableRegions: recognitionResult.page.scrollableRegions,
  };
  const pages = previous.pages.filter((page) => page.id !== currentPageId);
  const existingPage = previous.pages.find((page) => page.id === currentPageId);
  pages.push({
    ...(existingPage || makeDraftPage(currentPage, recognitionResult.frameId, [currentPage.name || '待归类'])),
    ...currentPage,
    frameIds: [...new Set([...(existingPage?.frameIds || []), recognitionResult.frameId])],
    elementIds: mergedElements.filter((element) => element.pageId === currentPageId || (element.ownerKind === 'application' && element.availableOnPageIds.includes(currentPageId))).map((element) => element.id),
    publishedAt: null,
  });
  return normalizeDraftShape({
    ...previous,
    revision: previous.revision + 1,
    currentPageId,
    currentFrameId: recognitionResult.frameId,
    rawModelResultRef: modelResultRef,
    lastAiModel: model || previous.lastAiModel,
    page: currentPage,
    pages,
    elements: mergedElements,
    elementEditRecords: previous.elementEditRecords.filter((record) => byId.has(record.elementId)),
    updatedAt: now,
  });
}

export function validateRecognitionConsistency(recognitionResult) {
  const issues = [];
  const elements = Array.isArray(recognitionResult?.elements) ? recognitionResult.elements : [];
  const keys = new Set();
  for (const element of elements) {
    if (keys.has(element.candidateKey)) {
      issues.push(`候选键重复：${element.candidateKey}`);
    }
    keys.add(element.candidateKey);
    const box = element.approximateRegion;
    if (box && (box.x + box.width > 1 || box.y + box.height > 1)) {
      issues.push(`候选框超出截图边界：${element.candidateKey}`);
    }
  }
  for (const relation of recognitionResult?.relationships || []) {
    if (!keys.has(relation.fromCandidateKey) || !keys.has(relation.toCandidateKey)) {
      issues.push(`关系引用了不可见候选：${relation.fromCandidateKey} -> ${relation.toCandidateKey}`);
    }
  }
  for (const action of recognitionResult?.actionCandidates || []) {
    const trigger = elements.find((item) => item.candidateKey === action.triggerCandidateKey);
    if (!trigger) issues.push(`动作引用了不可见候选：${action.triggerCandidateKey}`);
    else if (!trigger.interactive) issues.push(`动作触发元素不可操作：${action.triggerCandidateKey}`);
  }
  if (recognitionResult?.comparison?.basisFrameId !== null || recognitionResult?.comparison?.status !== 'not-requested') {
    issues.push('第一阶段单帧分析必须使用 not-requested 比较状态');
  }
  return issues;
}

export function validateDraft(draft) {
  const issues = [];
  const elements = Array.isArray(draft?.elements) ? draft.elements : [];
  const byId = new Map(elements.map((item) => [item.id, item]));

  for (const element of elements) {
    if (!element.label?.trim() && element.reviewStatus !== 'rejected') {
      issues.push({ level: 'error', code: 'label_required', elementId: element.id, message: '元素名称不能为空' });
    }
    if (!element.candidateKey?.trim()) {
      issues.push({ level: 'error', code: 'candidate_key_required', elementId: element.id, message: '候选键不能为空' });
    }

    if (!ELEMENT_TYPES.includes(element.elementType)) {
      issues.push({ level: 'error', code: 'element_type_required', elementId: element.id, message: '元素类型未识别，请由 AI 重新识别或人工补齐' });
    }

    const box = element.bbox;
    const validBox = box && [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0 && box.x + box.width <= 1 && box.y + box.height <= 1;
    if (!validBox) {
      issues.push({ level: 'error', code: 'bbox_invalid', elementId: element.id, message: '元素边框必须位于截图范围内' });
    }
    const calculatedGrid = validBox ? gridForBox(element.bbox, element.gridColumns, element.gridRows) : null;
    const validGrid = Boolean(calculatedGrid)
      && Number.isInteger(element.gridColumns) && element.gridColumns >= 1 && element.gridColumns <= 12
      && Number.isInteger(element.gridRows) && element.gridRows >= 1 && element.gridRows <= 12
      && element.gridColumns === calculatedGrid.columns
      && element.gridRows === calculatedGrid.rows
      && element.gridRegion === calculatedGrid.region;
    if (!validGrid) {
      issues.push({ level: 'error', code: 'grid_region_invalid', elementId: element.id, message: '宫格分块必须为 1 至 12，且单一区域需完整覆盖元素边框' });
    }
    if (element.parentId && !byId.has(element.parentId)) {
      issues.push({ level: 'error', code: 'parent_missing', elementId: element.id, message: '父级元素不存在' });
    }
    if (element.parentId === element.id) {
      issues.push({ level: 'error', code: 'parent_self', elementId: element.id, message: '元素不能将自己设为父级' });
    }
    if (element.parentId && !['component', 'shared_component'].includes(element.ownerKind)) {
      issues.push({ level: 'error', code: 'nested_owner_kind', elementId: element.id, message: '有父级的元素必须使用页面内容器或共享容器归属' });
    }
    if (!element.parentId && ['component', 'shared_component'].includes(element.ownerKind)) {
      issues.push({ level: 'error', code: 'root_owner_kind', elementId: element.id, message: '容器后代必须选择父级元素' });
    }
    if (!element.capabilities.length) issues.push({ level: 'warning', code: 'capability_missing', elementId: element.id, message: '元素尚未设置动作' });
    if (element.reviewStatus === 'pending') {
      issues.push({ level: 'warning', code: 'review_pending', elementId: element.id, message: 'AI 候选尚未完成人工审核' });
    }
    if (element.riskSignals?.includes('geometry-clamped-to-frame')) {
      issues.push({ level: 'warning', code: 'model_bbox_clamped', elementId: element.id, message: 'AI 候选框超出截图边缘，已自动裁剪，请人工校准' });
    }
    if (element.riskSignals?.includes('model-action-inconsistent')) {
      issues.push({ level: 'warning', code: 'model_action_inconsistent', elementId: element.id, message: 'AI 对该元素的可操作性判断存在矛盾，请人工确认' });
    }
  }

  const pageIds = Array.isArray(draft?.pages) ? draft.pages.map((page) => page.id) : [];
  const pageName = (pageId) => draft.pages?.find((page) => page.id === pageId)?.name || pageId;
  const availableOnPage = (element, pageId) => {
    if (element.pageId === pageId) return true;
    let cursor = element;
    const visited = new Set();
    while (cursor && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      if (cursor.ownerKind === 'application' && cursor.availableOnPageIds?.includes(pageId)) return true;
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    return false;
  };
  const pageIdsByElement = new Map(elements.map((element) => [element.id, pageIds.filter((pageId) => availableOnPage(element, pageId))]));
  const candidateKeyGroups = new Map();
  for (const element of elements) {
    const candidateKey = element.candidateKey?.trim();
    if (!candidateKey) continue;
    const group = candidateKeyGroups.get(candidateKey) || [];
    group.push(element);
    candidateKeyGroups.set(candidateKey, group);
  }
  for (const [candidateKey, duplicateElements] of candidateKeyGroups) {
    if (duplicateElements.length < 2) continue;
    for (const element of duplicateElements) {
      const ownPageIds = pageIdsByElement.get(element.id) || [];
      const samePageElements = duplicateElements.filter((candidate) => candidate.id !== element.id && (pageIdsByElement.get(candidate.id) || []).some((pageId) => ownPageIds.includes(pageId)));
      if (samePageElements.length > 0) {
        const commonPageIds = [...new Set(samePageElements.flatMap((candidate) => (pageIdsByElement.get(candidate.id) || []).filter((pageId) => ownPageIds.includes(pageId))))];
        const pageLabel = commonPageIds.includes(draft.currentPageId)
          ? `本页面“${pageName(draft.currentPageId)}”`
          : `页面“${commonPageIds.map(pageName).join('、')}”`;
        issues.push({
          level: 'error', code: 'candidate_key_duplicate_current_page', elementId: element.id, candidateKey,
          relatedElementIds: [element.id, ...samePageElements.map((candidate) => candidate.id)], pageIds: commonPageIds,
          message: `${pageLabel}内有 ${samePageElements.length + 1} 个元素使用候选键：${candidateKey}`,
        });
      }
      const otherPageElements = duplicateElements.filter((candidate) => candidate.id !== element.id && !(pageIdsByElement.get(candidate.id) || []).some((pageId) => ownPageIds.includes(pageId)));
      if (otherPageElements.length > 0) {
        const otherPageIds = [...new Set(otherPageElements.flatMap((candidate) => pageIdsByElement.get(candidate.id) || []))];
        issues.push({
          level: 'error', code: 'candidate_key_duplicate_other_page', elementId: element.id, candidateKey,
          relatedElementIds: [element.id, ...otherPageElements.map((candidate) => candidate.id)], pageIds: [...new Set([...ownPageIds, ...otherPageIds])],
          message: `候选键 ${candidateKey} 与其他页面“${otherPageIds.map(pageName).join('、')}”的元素重复`,
        });
      }
    }
  }

  for (const element of elements) {
    const visited = new Set([element.id]);
    let cursor = element;
    while (cursor.parentId) {
      if (visited.has(cursor.parentId)) {
        issues.push({ level: 'error', code: 'owner_cycle', elementId: element.id, message: '元素父子关系存在循环' });
        break;
      }
      visited.add(cursor.parentId);
      cursor = byId.get(cursor.parentId);
      if (!cursor) break;
    }
  }
  return issues;
}

export function normalizeDraftForSave(draft) {
  const next = normalizeDraftShape(draft);
  const byId = new Map(next.elements.map((item) => [item.id, item]));
  for (const element of next.elements) element.childrenIds = [];
  for (const element of next.elements) {
    if (element.parentId && byId.has(element.parentId)) {
      element.ownerRef = element.parentId;
      const parent = byId.get(element.parentId);
      element.ownerKind = parent?.ownerKind === 'application' || parent?.ownerKind === 'shared_component' ? 'shared_component' : 'component';
      element.pageId = element.ownerKind === 'shared_component' ? null : parent?.pageId || next.currentPageId;
      byId.get(element.parentId).childrenIds.push(element.id);
    } else {
      element.parentId = null;
      element.ownerRef = element.ownerKind === 'application' ? next.appKey : element.pageId || next.currentPageId;
      if (element.ownerKind !== 'application') element.ownerKind = 'page';
    }
  }
  next.updatedAt = new Date().toISOString();
  return normalizeDraftShape(next);
}
