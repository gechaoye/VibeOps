import { createHash, randomUUID } from 'node:crypto';
import { SCOUT_ACTIONS } from './element-taxonomy.mjs';

export const DRAFT_SCHEMA_VERSION = 'uikg-workbench-draft/1.1';

const MEANING_EVIDENCE_FIELDS = ['visibleTexts', 'visibleIcons', 'visibleStates', 'visualCues'];

function normalizeCapabilities(capabilities) {
  return [...new Set((Array.isArray(capabilities) ? capabilities : [])
    .filter((capability) => typeof capability === 'string' && capability.trim())
    .map((capability) => capability.trim()))];
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

export function normalizeScoutOutput(rawScout) {
  const scout = structuredClone(rawScout);
  const normalizationIssues = [];
  if (!Array.isArray(scout?.elements)) return { scout, normalizationIssues };
  scout.elements = scout.elements.map((element, index) => {
    const repairIssues = [];
    const meaningIssues = [];
    const normalizedElement = { ...element };
    const rawMeaning = element?.meaning && typeof element.meaning === 'object' && !Array.isArray(element.meaning)
      ? element.meaning
      : {};
    const meaningInput = { ...rawMeaning };

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
    return { ...normalizedElement, meaning };
  });
  if (Array.isArray(scout.actionCandidates)) {
    scout.actionCandidates = scout.actionCandidates.map((actionCandidate, index) => {
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
  return { scout, normalizationIssues };
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
    surfaceType: page.surfaceType || 'unknown',
    stateSummary: page.stateSummary || '',
    scrollableRegions: [...(page.scrollableRegions || [])],
    featurePath: featurePath.length ? [...featurePath] : [page.name || '待归类'],
    frameIds: frameId ? [frameId] : [],
    elementIds: [],
  };
}

export function beginFrameCapture(currentDraft, frameId) {
  const previous = normalizeDraftShape(currentDraft || createEmptyDraft());
  const existingPage = previous.pages.find((page) => page.id === previous.currentPageId);
  const currentPageHasElements = previous.elements.some((element) => element.pageId === previous.currentPageId);
  const page = existingPage && !currentPageHasElements
    ? { ...existingPage, frameIds: [frameId], elementIds: [] }
    : makeDraftPage({
        id: draftPageId(),
        key: `page.capture.${randomUUID().slice(0, 8)}`,
        name: '待识别页面',
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
      surfaceType: page.surfaceType,
      stateSummary: page.stateSummary,
      scrollableRegions: page.scrollableRegions,
    },
    pages,
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
      surfaceType: 'unknown',
      stateSummary: '',
      scrollableRegions: [],
    },
    pages: [],
    elements: [],
    elementEditRecords: [],
    transitions: [],
    lastScoutModel: null,
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
  draft.elements = (draft.elements || []).map((element) => ({
    ...element,
    capabilities: normalizeCapabilities(element.capabilities),
    meaning: normalizeDraftMeaning(element.meaning),
    pageId: element.pageId ?? (['application', 'shared_component'].includes(element.ownerKind) ? null : draft.currentPageId),
    availableOnPageIds: [...(element.availableOnPageIds || (element.ownerKind === 'application' ? [draft.currentPageId] : []))],
    scoutModel: element.scoutModel || draft.lastScoutModel || null,
    aiReview: element.aiReview || null,
  }));
  draft.elementEditRecords = Array.isArray(draft.elementEditRecords)
    ? draft.elementEditRecords.filter((record) => record && typeof record.elementId === 'string')
    : [];
  const editedElementIds = new Set(draft.elementEditRecords.map((record) => record.elementId));
  draft.elements = draft.elements.map((element) => {
    if (element.source === 'human' || editedElementIds.has(element.id)) return element;
    return {
      ...element,
      reviewStatus: element.reviewStatus === 'edited' ? 'pending' : element.reviewStatus,
      source: 'ai_scout',
    };
  });
  draft.transitions = Array.isArray(draft.transitions) ? draft.transitions.map((transition) => ({
    ...transition,
    capability: DRAFT_CAPABILITY_ALIASES[transition.capability] || transition.capability,
  })) : [];
  draft.lastScoutModel ||= null;
  const pageById = new Map(draft.pages.map((page) => [page.id, page]));
  for (const page of draft.pages) {
    page.key ||= pageKeyFromName(page.name);
    page.featurePath = page.featurePath?.length ? page.featurePath.slice(0, 3) : [page.name || '待归类'];
    page.frameIds = [...new Set(page.frameIds || [])];
    page.elementIds = [];
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
  if (element.controlType === 'container') return 'container';
  if (element.controlType === 'label') return 'label';
  if (element.controlType === 'status' || element.controlType === 'badge') {
    return 'status_indicator';
  }
  if (element.interactive) return 'action_trigger';
  return 'content_anchor';
}

function capabilitiesFor(candidateKey, actions) {
  return [...new Set(
    actions
      .filter((action) => action.triggerCandidateKey === candidateKey)
      .map((action) => SCOUT_ACTIONS.includes(action.action) ? action.action : 'other'),
  )];
}

function nextElementFromScout(element, actions, pageId, model) {
  return {
    id: draftElementId(element.candidateKey),
    candidateKey: element.candidateKey,
    label: element.label || element.visualDescription,
    visualDescription: element.visualDescription,
    controlType: element.controlType,
    role: inferRole(element),
    capabilities: capabilitiesFor(element.candidateKey, actions),
    actionable: element.interactive ? 'yes' : 'no',
    enabled: element.enabled ?? null,
    state: element.state || '',
    dynamicContent: element.dynamicContent,
    bbox: { ...element.approximateRegion },
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
    interactionBoundary: 'candidate_bbox',
    reviewStatus: 'pending',
    source: 'ai_scout',
    scoutModel: model || null,
    lastModelProposal: null,
    aiReview: null,
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

export function prepareScoutForDraft(scout) {
  const proposal = structuredClone(scout);
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

export function mergeScoutIntoDraft(currentDraft, scout, modelResultRef, model = null) {
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
    && scout.page.name
    && scout.page.name !== previous.page.name,
  );
  const currentPageId = pageChanged ? draftPageId() : previous.currentPageId;
  const currentPageElements = previous.elements.filter((item) => item.pageId === previous.currentPageId || ['application', 'shared_component'].includes(item.ownerKind));
  const previousByKey = new Map(currentPageElements.map((item) => [item.candidateKey, item]));
  const nextElements = scout.elements.map((candidate) => {
    const generated = nextElementFromScout(candidate, scout.actionCandidates || [], currentPageId, model);
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
          controlType: generated.controlType,
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
        controlType: generated.controlType,
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
  for (const relation of scout.relationships || []) {
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
      ? pageKeyFromName(scout.page.name)
      : (previous.page.key || pageKeyFromName(scout.page.name)),
    name: scout.page.name || previous.page.name,
    surfaceType: scout.page.surfaceType,
    stateSummary: scout.page.stateSummary,
    scrollableRegions: scout.page.scrollableRegions,
  };
  const pages = previous.pages.filter((page) => page.id !== currentPageId);
  const existingPage = previous.pages.find((page) => page.id === currentPageId);
  pages.push({
    ...(existingPage || makeDraftPage(currentPage, scout.frameId, [currentPage.name || '待归类'])),
    ...currentPage,
    frameIds: [...new Set([...(existingPage?.frameIds || []), scout.frameId])],
    elementIds: mergedElements.filter((element) => element.pageId === currentPageId || (element.ownerKind === 'application' && element.availableOnPageIds.includes(currentPageId))).map((element) => element.id),
  });
  return normalizeDraftShape({
    ...previous,
    revision: previous.revision + 1,
    currentPageId,
    currentFrameId: scout.frameId,
    rawModelResultRef: modelResultRef,
    lastScoutModel: model || previous.lastScoutModel,
    page: currentPage,
    pages,
    elements: mergedElements,
    elementEditRecords: previous.elementEditRecords.filter((record) => byId.has(record.elementId)),
    updatedAt: now,
  });
}

export function validateScoutConsistency(scout) {
  const issues = [];
  const elements = Array.isArray(scout?.elements) ? scout.elements : [];
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
  for (const relation of scout?.relationships || []) {
    if (!keys.has(relation.fromCandidateKey) || !keys.has(relation.toCandidateKey)) {
      issues.push(`关系引用了不可见候选：${relation.fromCandidateKey} -> ${relation.toCandidateKey}`);
    }
  }
  for (const action of scout?.actionCandidates || []) {
    const trigger = elements.find((item) => item.candidateKey === action.triggerCandidateKey);
    if (!trigger) issues.push(`动作引用了不可见候选：${action.triggerCandidateKey}`);
    else if (!trigger.interactive) issues.push(`动作触发元素不可操作：${action.triggerCandidateKey}`);
  }
  if (scout?.comparison?.basisFrameId !== null || scout?.comparison?.status !== 'not-requested') {
    issues.push('第一阶段单帧分析必须使用 not-requested 比较状态');
  }
  return issues;
}

export function validateDraft(draft) {
  const issues = [];
  const elements = Array.isArray(draft?.elements) ? draft.elements : [];
  const byId = new Map(elements.map((item) => [item.id, item]));
  const candidateKeys = new Set();

  for (const element of elements) {
    if (!element.label?.trim() && element.reviewStatus !== 'rejected') {
      issues.push({ level: 'error', code: 'label_required', elementId: element.id, message: '元素名称不能为空' });
    }
    if (!element.candidateKey?.trim()) {
      issues.push({ level: 'error', code: 'candidate_key_required', elementId: element.id, message: '候选键不能为空' });
    } else if (candidateKeys.has(element.candidateKey)) {
      issues.push({ level: 'error', code: 'candidate_key_duplicate', elementId: element.id, message: `候选键重复：${element.candidateKey}` });
    }
    candidateKeys.add(element.candidateKey);

    const box = element.bbox;
    const validBox = box && [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0 && box.x + box.width <= 1 && box.y + box.height <= 1;
    if (!validBox) {
      issues.push({ level: 'error', code: 'bbox_invalid', elementId: element.id, message: '元素边框必须位于截图范围内' });
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
    if (element.actionable === 'yes' && element.capabilities.length === 0) {
      issues.push({ level: 'warning', code: 'capability_missing', elementId: element.id, message: '可操作元素尚未设置支持操作' });
    }
    if (element.reviewStatus === 'pending') {
      issues.push({ level: 'warning', code: 'review_pending', elementId: element.id, message: 'AI 候选尚未完成人工审核' });
    }
    if (element.riskSignals?.includes('geometry-clamped-to-frame')) {
      issues.push({ level: 'warning', code: 'scout_bbox_clamped', elementId: element.id, message: 'AI 候选框超出截图边缘，已自动裁剪，请人工校准' });
    }
    if (element.riskSignals?.includes('model-action-inconsistent')) {
      issues.push({ level: 'warning', code: 'scout_action_inconsistent', elementId: element.id, message: 'AI 对该元素的可操作性判断存在矛盾，请人工确认' });
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
