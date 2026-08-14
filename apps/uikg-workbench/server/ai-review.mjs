import { ELEMENT_TYPES, SCOUT_ACTIONS, stringUnion } from './element-taxonomy.mjs';

const STATUS_ALIASES = new Map([
  ['pass', 'pass'], ['passed', 'pass'], ['approve', 'pass'], ['approved', 'pass'], ['accept', 'pass'], ['accepted', 'pass'], ['ok', 'pass'],
  ['reject', 'reject'], ['rejected', 'reject'], ['fail', 'reject'], ['failed', 'reject'],
  ['needs_review', 'needs_review'], ['needs-review', 'needs_review'], ['review', 'needs_review'], ['warning', 'needs_review'], ['uncertain', 'needs_review'],
]);

function stringArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function normalizeStatus(value) {
  return STATUS_ALIASES.get(String(value || '').trim().toLowerCase()) || 'needs_review';
}

function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const normalized = number > 1 && number <= 100 ? number / 100 : number;
  return Math.min(Math.max(normalized, 0), 1);
}

function reviewEntries(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.elements)) return raw.elements;
  if (Array.isArray(raw?.reviews)) return raw.reviews;
  if (Array.isArray(raw?.results)) return raw.results;
  return [];
}

export function normalizeAIReviewOutput(raw, elements, model, reviewedAt = new Date().toISOString()) {
  const byKey = new Map();
  for (const entry of reviewEntries(raw)) {
    if (!entry || typeof entry !== 'object') continue;
    const candidateKey = String(entry.candidateKey || entry.candidate_key || entry.key || '').trim();
    if (!candidateKey || byKey.has(candidateKey)) continue;
    const status = normalizeStatus(entry.status || entry.verdict || entry.result || entry.decision);
    const issues = stringArray(entry.issues || entry.risks || entry.problems || entry.reasons);
    const summary = String(entry.summary || entry.comment || entry.reason || entry.message || '').trim()
      || (status === 'pass' ? '未发现明显问题' : status === 'reject' ? 'AI 建议忽略该候选' : '需要人工重点复核');
    byKey.set(candidateKey, {
      status,
      confidence: clampConfidence(entry.confidence ?? entry.score),
      summary,
      issues,
      model,
      reviewedAt,
    });
  }

  return elements.map((element) => ({
    elementId: element.id,
    candidateKey: element.candidateKey,
    review: byKey.get(element.candidateKey) || {
      status: 'needs_review',
      confidence: 0,
      summary: '审核模型未返回该元素的结论',
      issues: ['missing-review-result'],
      model,
      reviewedAt,
    },
  }));
}

export function applyAIReviews(draft, normalizedReviews) {
  const byId = new Map(normalizedReviews.map((item) => [item.elementId, item.review]));
  return {
    ...draft,
    revision: draft.revision + 1,
    elements: draft.elements.map((element) => byId.has(element.id) ? { ...element, aiReview: byId.get(element.id) } : element),
    updatedAt: new Date().toISOString(),
  };
}

export function reviewCandidates(draft) {
  return draft.elements.filter((element) => (
    element.pageId === draft.currentPageId
    || (element.ownerKind === 'application' && element.availableOnPageIds.includes(draft.currentPageId))
  ) && element.source !== 'human');
}

export function buildAIReviewDemand(draft, elements) {
  const candidates = elements.map((element) => ({
    candidateKey: element.candidateKey,
    label: element.label,
    visualDescription: element.visualDescription,
    controlType: element.controlType,
    bbox: element.bbox,
  }));
  const elementTypeUnion = stringUnion(ELEMENT_TYPES);
  const actionUnion = stringUnion(SCOUT_ACTIONS);
  return `你是独立的 UI 知识图谱识别模型。请重新查看当前冻结截图，独立盘点截图中所有可见元素、文本、图标、状态、结构容器、稳定内容锚点及它们的关系。不要只审核 Scout 候选，也不要假定 Scout 候选全部正确；请补充漏识别、删除截图中不存在的候选，并用新的完整识别结果与参考结果对照。

所有自然语言字段必须使用简体中文。不要执行任何操作，不要输出 Markdown 代码块，只返回一个 JSON 对象，结构如下：
{
  "frameId": string,
  "page": {"name": string|null, "surfaceType": "page"|"dialog"|"drawer"|"bottom-sheet"|"menu"|"shared-component"|"unknown", "stateSummary": string, "scrollableRegions": string[]},
  "elements": [{"candidateKey": string, "label": string|null, "visualDescription": string, "controlType": ${elementTypeUnion}, "interactive": boolean, "enabled": boolean|null, "state": string|null, "approximateRegion": {"x":number,"y":number,"width":number,"height":number}, "geometryKind":"boundary"|"tap-target"|"approximate", "geometryConfidence":number, "meaning":{"status":"known"|"candidate"|"unknown","description":string|null,"evidence":{"visibleTexts":string[],"visibleIcons":string[],"visibleStates":string[],"visualCues":string[],"userContext":string|null,"unclassified":{"type":string,"detail":string|null}[]}}, "dynamicContent":boolean, "riskSignals":string[], "confidence":number}],
  "relationships": [{"fromCandidateKey":string,"type":"contains"|"labels"|"controls"|"belongs-to"|"adjacent-to","toCandidateKey":string}],
  "actionCandidates": [{"triggerCandidateKey":string,"action":${actionUnion},"expectedOutcome":string|null,"basis":"visible-affordance"|"user-context"|"requirement-document"|"existing-graph"|"authority-contract"|"unknown","riskSignals":string[],"confidence":number}],
  "comparison": {"basisFrameId":null,"status":"not-requested","changes":[]},
  "uncertainties": string[]
}
候选 key 必须是稳定且唯一的 ASCII 语义 key，所有区域坐标必须是 0 到 1 的归一化比例。没有动作的元素不要返回 actionCandidate；每个 expectedOutcome 必须描述该动作在当前元素上的具体效果。不要编造不可见含义；无法确认时使用 unknown。参考 Scout 候选仅用于对照，不限制你的识别范围：${JSON.stringify(candidates)}
frameId 必须严格等于 ${JSON.stringify(draft.currentFrameId)}。当前页面上下文：${JSON.stringify({ name: draft.page.name, stateSummary: draft.page.stateSummary })}`;
}
