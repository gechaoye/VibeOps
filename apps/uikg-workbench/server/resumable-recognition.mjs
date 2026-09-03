import { jsonrepair } from 'jsonrepair';

export const RECOGNITION_ERROR_RETRY_LIMIT = 5;

// Layout ancestors describe the page's containing surface, but do not prove
// that all of the content inside that surface was emitted by the model. They
// are therefore tracked separately from leaf/instance geometry when creating
// a continuation checkpoint.
const STRUCTURAL_ELEMENT_TYPES = new Set([
  'navigation-bar',
  'sidebar',
  'drawer',
  'list',
  'list-item',
  'grouped-list',
  'swipe-list',
  'expandable-list',
  'card',
  'panel',
  'section',
  'form',
  'table',
  'chart',
  'image-viewer',
  'file-preview',
]);

const UNRELIABLE_COVERAGE_GAP = 0.08;

function regionOf(value) {
  const region = value && typeof value === 'object' ? value : null;
  if (!region) return null;
  const x = Number(region.x);
  const y = Number(region.y);
  const width = Number(region.width);
  const height = Number(region.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
    width: Math.max(0, Math.min(1, width)),
    height: Math.max(0, Math.min(1 - Math.max(0, Math.min(1, y)), height)),
  };
}

function isBroadStructuralRegion(element, region) {
  if (!region) return false;
  const area = region.width * region.height;
  const structural = STRUCTURAL_ELEMENT_TYPES.has(element?.elementType);
  const rootLike = (
    region.x <= 0.02
    && region.width >= 0.97
    && region.y <= 0.1
    && region.height >= 0.45
    && element?.interactive !== true
  );
  // A near-full-width or large structural rectangle is normally an ancestor
  // (form/list/WebView-like surface), rather than evidence for its whole
  // vertical contents. The root-like check also catches a WebView/container
  // that was emitted with a generic element type. Keep the thresholds
  // geometry-based and business-agnostic.
  if (!structural && !rootLike) return false;
  return (
    (region.width >= 0.92 && region.height >= 0.12)
    || region.height >= 0.55
    || area >= 0.2
    || rootLike
  );
}

function instanceRegionsOf(element) {
  const regions = element?.abstraction?.instanceRegions;
  return Array.isArray(regions) ? regions.map(regionOf).filter(Boolean) : [];
}

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
    && typeof element?.elementType === 'string'
    && typeof element?.interactive === 'boolean'
    && element?.approximateRegion && typeof element.approximateRegion === 'object'
    && typeof element?.geometryKind === 'string'
    && typeof element?.geometryConfidence === 'number'
    && meaning && typeof meaning === 'object'
    && (typeof element?.dynamicContent === 'boolean' || typeof meaning.dynamicContent === 'boolean')
    && (typeof element?.confidence === 'number' || typeof meaning.confidence === 'number')
  );
}

export function recoverRecognitionCheckpointFromStream(accumulated) {
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

export function summarizeRecognitionCheckpoint(result) {
  const elements = Array.isArray(result?.elements) ? result.elements : [];
  const completedCandidates = elements.map((element) => {
    const region = regionOf(element?.approximateRegion);
    const regionBottom = region ? Math.min(1, region.y + region.height) : null;
    return {
      candidateKey: candidateKeyOf(element),
      label: typeof element?.label === 'string' ? element.label : null,
      elementType: typeof element?.elementType === 'string' ? element.elementType : null,
      regionBottom,
    };
  }).filter((element) => element.candidateKey);
  const coverageEntries = [];
  const broadCandidates = [];
  for (const element of elements) {
    const candidateKey = candidateKeyOf(element);
    if (!candidateKey) continue;
    const region = regionOf(element?.approximateRegion);
    if (!region) continue;
    const broad = isBroadStructuralRegion(element, region);
    if (broad) {
      broadCandidates.push({
        candidateKey,
        elementType: typeof element?.elementType === 'string' ? element.elementType : null,
        regionBottom: Math.min(1, region.y + region.height),
      });

      // A repeated template's individual instance rectangles are useful
      // progress evidence even when its outer template rectangle is large.
      const instanceRegions = instanceRegionsOf(element);
      if (instanceRegions.length > 0) {
        for (const instanceRegion of instanceRegions) {
          coverageEntries.push({
            candidateKey,
            regionBottom: Math.min(1, instanceRegion.y + instanceRegion.height),
            source: 'instance-region',
          });
        }
      }
      continue;
    }
    coverageEntries.push({
      candidateKey,
      regionBottom: Math.min(1, region.y + region.height),
      source: 'element-region',
    });
  }

  const coveredBottom = coverageEntries.reduce((maximum, element) => Math.max(maximum, element.regionBottom || 0), 0);
  const broadBottom = broadCandidates.reduce((maximum, element) => Math.max(maximum, element.regionBottom || 0), 0);
  const broadRegionGap = Math.max(0, broadBottom - coveredBottom);
  return {
    completedCandidates,
    coveredBottom,
    // These fields are deliberately diagnostic. They let the continuation
    // caller see why a large ancestor was not counted as page coverage.
    broadCandidates,
    broadBottom,
    broadRegionGap,
    hasUnreliableCoverage: broadCandidates.length > 0 && broadRegionGap > UNRELIABLE_COVERAGE_GAP,
    hasRelationships: Array.isArray(result?.relationships),
    hasActionCandidates: Array.isArray(result?.actionCandidates),
    hasComparison: Boolean(result?.comparison && typeof result.comparison === 'object'),
    hasUncertainties: Array.isArray(result?.uncertainties),
  };
}

function canResumeFromCheckpoint(checkpoint) {
  return checkpoint.completedCandidates.length > 0 && !checkpoint.hasUnreliableCoverage;
}

export function mergeRecognitionContinuation(baseResult, continuation) {
  const base = baseResult && typeof baseResult === 'object' ? structuredClone(baseResult) : {};
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

export async function runResumableRecognition({
  initialPrompt,
  initialResult,
  initialFallback,
  callModel,
  buildContinuationPrompt,
  isComplete,
  signal,
  onRetry = () => {},
  retryLimit = RECOGNITION_ERROR_RETRY_LIMIT,
}) {
  let rawResult = initialResult === undefined ? undefined : structuredClone(initialResult);
  let initialError = null;
  let lastError = null;
  let consecutiveFailures = 0;
  const initialCheckpoint = summarizeRecognitionCheckpoint(rawResult || initialFallback || {});
  // A paused session may contain an ancestor rectangle that reaches the
  // screenshot bottom while its children are missing. Continuing from that
  // synthetic frontier would skip the missing page region, so restart from
  // the full prompt in that case.
  let continuation = initialResult !== undefined && canResumeFromCheckpoint(initialCheckpoint);
  const retryAttempts = [];

  while (true) {
    signal?.throwIfAborted();
    const checkpoint = summarizeRecognitionCheckpoint(rawResult || initialFallback || {});
    const prompt = continuation
      ? buildContinuationPrompt(checkpoint, consecutiveFailures)
      : initialPrompt;
    try {
      const result = await callModel(prompt, {
        signal,
        attempt: consecutiveFailures,
        continuation,
      });
      rawResult = continuation
        ? mergeRecognitionContinuation(rawResult || initialFallback, result)
        : result;
      const mergedCheckpoint = summarizeRecognitionCheckpoint(rawResult);
      // A continuation's done flag is only trustworthy when the merged
      // checkpoint has no unexplained gap beneath a broad structural region.
      // This prevents `elements:[]; done:true` from completing a result whose
      // form/list ancestor was emitted before its lower-level children.
      const trustedContinuationCompletion = !continuation
        || result?.done !== true
        || !mergedCheckpoint.hasUnreliableCoverage;
      // A fresh full recognition is allowed to contain a broad form/list
      // ancestor: its completeness is established by the full model output.
      // The coverage guard is only needed for an incremental continuation,
      // where an ancestor can otherwise make `done=true` skip missing rows.
      const coverageTrusted = !continuation || !mergedCheckpoint.hasUnreliableCoverage;
      const completed = isComplete(rawResult)
        && coverageTrusted
        && (!continuation || (result?.done === true && trustedContinuationCompletion));
      return {
        rawResult,
        completed,
        retryAttempts,
        initialError,
        lastError: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const recovered = error && typeof error === 'object' ? error.recognitionCheckpoint : null;
      const receivedContent = Boolean(error && typeof error === 'object' && error.receivedContent);
      if (recovered) {
        rawResult = rawResult
          ? mergeRecognitionContinuation(rawResult, recovered)
          : structuredClone(recovered);
      } else if (rawResult === undefined && initialFallback !== undefined) {
        rawResult = structuredClone(initialFallback);
      }
      if (signal?.aborted) {
        if (error && typeof error === 'object') error.recognitionRawResult = rawResult;
        throw error;
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

      if (error && typeof error === 'object' && error.retryable === false) {
        return {
          rawResult,
          completed: false,
          retryAttempts,
          initialError,
          lastError,
        };
      }

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
      continuation = canResumeFromCheckpoint(summarizeRecognitionCheckpoint(rawResult));
      onRetry({
        attempt: consecutiveFailures,
        totalAttempt: retryAttempts.length,
        retryLimit,
        checkpoint: summarizeRecognitionCheckpoint(rawResult),
        error: message,
      });
    }
  }
}
