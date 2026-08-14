import { jsonrepair } from 'jsonrepair';

export const SCOUT_ERROR_RETRY_LIMIT = 5;

function candidateKeyOf(element) {
  const value = element?.candidateKey ?? element?.candidate_key;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function uniqueBy(items, keyOf) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyOf(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function completeRecoveredElement(element) {
  const meaning = element?.meaning;
  return Boolean(
    candidateKeyOf(element)
    && typeof element?.visualDescription === 'string'
    && typeof element?.controlType === 'string'
    && typeof element?.interactive === 'boolean'
    && element?.approximateRegion && typeof element.approximateRegion === 'object'
    && typeof element?.geometryKind === 'string'
    && typeof element?.geometryConfidence === 'number'
    && meaning && typeof meaning === 'object'
    && (typeof element?.dynamicContent === 'boolean' || typeof meaning.dynamicContent === 'boolean')
    && (typeof element?.confidence === 'number' || typeof meaning.confidence === 'number')
  );
}

export function recoverScoutCheckpointFromStream(accumulated) {
  if (typeof accumulated !== 'string' || !accumulated.trim()) return null;
  const dataTagIndex = accumulated.lastIndexOf('<data-json>');
  const source = dataTagIndex >= 0 ? accumulated.slice(dataTagIndex + '<data-json>'.length) : accumulated;
  const closingTagIndex = source.indexOf('</data-json>');
  const withoutClosingTag = closingTagIndex >= 0 ? source.slice(0, closingTagIndex) : source;
  const objectStart = withoutClosingTag.indexOf('{');
  if (objectStart < 0) return null;
  try {
    const recovered = JSON.parse(jsonrepair(withoutClosingTag.slice(objectStart)));
    if (!recovered || typeof recovered !== 'object') return null;
    if (Array.isArray(recovered.elements)) recovered.elements = recovered.elements.filter(completeRecoveredElement);
    return recovered;
  } catch {
    return null;
  }
}

export function summarizeScoutCheckpoint(scout) {
  const elements = Array.isArray(scout?.elements) ? scout.elements : [];
  const completedCandidates = elements.map((element) => {
    const region = element?.approximateRegion;
    const regionBottom = region && Number.isFinite(region.y) && Number.isFinite(region.height)
      ? Math.min(1, region.y + region.height)
      : null;
    return {
      candidateKey: candidateKeyOf(element),
      label: typeof element?.label === 'string' ? element.label : null,
      controlType: typeof element?.controlType === 'string' ? element.controlType : null,
      regionBottom,
    };
  }).filter((element) => element.candidateKey);
  return {
    completedCandidates,
    coveredBottom: completedCandidates.reduce((maximum, element) => Math.max(maximum, element.regionBottom || 0), 0),
    hasRelationships: Array.isArray(scout?.relationships),
    hasActionCandidates: Array.isArray(scout?.actionCandidates),
    hasComparison: Boolean(scout?.comparison && typeof scout.comparison === 'object'),
    hasUncertainties: Array.isArray(scout?.uncertainties),
  };
}

export function mergeScoutContinuation(baseScout, continuation) {
  const base = baseScout && typeof baseScout === 'object' ? structuredClone(baseScout) : {};
  const delta = continuation && typeof continuation === 'object' ? continuation : {};

  if (!base.frameId && typeof delta.frameId === 'string') base.frameId = delta.frameId;
  if (!base.page && delta.page && typeof delta.page === 'object') base.page = structuredClone(delta.page);

  const existingElements = Array.isArray(base.elements) ? base.elements : [];
  const addedElements = Array.isArray(delta.elements) ? delta.elements : [];
  base.elements = uniqueBy([...existingElements, ...addedElements], candidateKeyOf);

  if (Array.isArray(base.relationships) || Array.isArray(delta.relationships)) {
    base.relationships = uniqueBy(
      [...(Array.isArray(base.relationships) ? base.relationships : []), ...(Array.isArray(delta.relationships) ? delta.relationships : [])],
      (relationship) => `${relationship?.fromCandidateKey || ''}\u0000${relationship?.type || ''}\u0000${relationship?.toCandidateKey || ''}`,
    );
  }
  if (Array.isArray(base.actionCandidates) || Array.isArray(delta.actionCandidates)) {
    base.actionCandidates = uniqueBy(
      [...(Array.isArray(base.actionCandidates) ? base.actionCandidates : []), ...(Array.isArray(delta.actionCandidates) ? delta.actionCandidates : [])],
      (action) => `${action?.triggerCandidateKey || ''}\u0000${action?.action || ''}\u0000${action?.expectedOutcome || ''}`,
    );
  }
  if (delta.comparison && typeof delta.comparison === 'object') base.comparison = structuredClone(delta.comparison);
  if (Array.isArray(base.uncertainties) || Array.isArray(delta.uncertainties)) {
    base.uncertainties = [...new Set([
      ...(Array.isArray(base.uncertainties) ? base.uncertainties : []),
      ...(Array.isArray(delta.uncertainties) ? delta.uncertainties : []),
    ].filter((item) => typeof item === 'string'))];
  }
  return base;
}

export async function runResumableScout({
  initialPrompt,
  initialResult,
  initialFallback,
  callScout,
  buildContinuationPrompt,
  isComplete,
  signal,
  onRetry = () => {},
  retryLimit = SCOUT_ERROR_RETRY_LIMIT,
}) {
  let rawResult = initialResult === undefined ? undefined : structuredClone(initialResult);
  let initialError = null;
  let lastError = null;
  let consecutiveFailures = 0;
  let continuation = initialResult !== undefined;
  const retryAttempts = [];

  while (true) {
    signal?.throwIfAborted();
    const checkpoint = summarizeScoutCheckpoint(rawResult || initialFallback || {});
    const prompt = continuation
      ? buildContinuationPrompt(checkpoint, consecutiveFailures)
      : initialPrompt;
    try {
      const result = await callScout(prompt, {
        signal,
        attempt: consecutiveFailures,
        continuation,
      });
      rawResult = continuation
        ? mergeScoutContinuation(rawResult || initialFallback, result)
        : result;
      const completed = isComplete(rawResult) && (!continuation || result?.done === true);
      return {
        rawResult,
        completed,
        retryAttempts,
        initialError,
        lastError: null,
      };
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      const recovered = error && typeof error === 'object' ? error.scoutCheckpoint : null;
      const receivedContent = Boolean(error && typeof error === 'object' && error.receivedContent);
      if (recovered) {
        rawResult = rawResult
          ? mergeScoutContinuation(rawResult, recovered)
          : structuredClone(recovered);
      } else if (rawResult === undefined && initialFallback !== undefined) {
        rawResult = structuredClone(initialFallback);
      }
      if (initialError === null) initialError = message;
      lastError = message;

      if (receivedContent) consecutiveFailures = 0;
      retryAttempts.push({
        attempt: consecutiveFailures + 1,
        completed: false,
        receivedContent,
        recoveredElements: Array.isArray(recovered?.elements) ? recovered.elements.length : 0,
        error: message,
      });

      if (consecutiveFailures >= retryLimit) {
        return {
          rawResult,
          completed: false,
          retryAttempts,
          initialError,
          lastError,
        };
      }

      consecutiveFailures += 1;
      continuation = summarizeScoutCheckpoint(rawResult).completedCandidates.length > 0;
      onRetry({
        attempt: consecutiveFailures,
        retryLimit,
        checkpoint: summarizeScoutCheckpoint(rawResult),
        error: message,
      });
    }
  }
}
