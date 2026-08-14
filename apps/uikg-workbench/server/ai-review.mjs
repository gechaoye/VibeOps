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
    role: element.role,
    actionable: element.actionable,
    capabilities: element.capabilities,
    state: element.state,
    bbox: element.bbox,
    confidence: element.confidence,
    riskSignals: element.riskSignals,
    parentCandidateKey: draft.elements.find((candidate) => candidate.id === element.parentId)?.candidateKey || null,
  }));
  return `Act as the independent first-pass reviewer for a UI knowledge graph. Compare every Scout candidate below against the current frozen screenshot. Check missing or duplicate elements, label and control-type accuracy, actionability, supported actions, state, approximate boundary, and parent relationship. Do not perform actions. Human confirmation is always required after this review.

Return one JSON object: {"summary":string,"elements":[{"candidateKey":string,"status":"pass"|"needs_review"|"reject","confidence":number,"summary":string,"issues":string[]}]}. Return exactly one result for every supplied candidateKey and do not invent keys. Use pass only when the candidate is visibly supported; use needs_review for uncertainty or fixable issues; use reject only for false or duplicate candidates.

Page: ${JSON.stringify({ name: draft.page.name, stateSummary: draft.page.stateSummary })}
Scout candidates: ${JSON.stringify(candidates)}`;
}
