import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

async function listYamlFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) files.push(target);
    }
  }
  return files.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function safeAppKey(value) {
  const appKey = String(value || '').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(appKey)) {
    const error = new Error('无效的 App Key');
    error.status = 400;
    throw error;
  }
  return appKey;
}

function safeFrameRef(value) {
  const frameRef = String(value || '').trim();
  if (!/^[a-zA-Z0-9:_-]+$/.test(frameRef)) {
    const error = new Error('无效的 Frame Ref');
    error.status = 400;
    throw error;
  }
  return frameRef;
}

export function canonicalFullPageAssetPath({ graphRoot, appKey: requestedAppKey, frameRef: requestedFrameRef }) {
  const appKey = safeAppKey(requestedAppKey);
  const frameRef = safeFrameRef(requestedFrameRef);
  return path.join(graphRoot, 'obsidian', appKey, 'assets', 'full-pages', `${frameRef}.png`);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function owningPageId(element, elementsById) {
  let current = element;
  const visited = new Set();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.owner?.kind === 'page') return current.owner.ref;
    const parentRef = current.parentElementRef || current.owner?.ref;
    current = parentRef ? elementsById.get(parentRef) : null;
  }
  return null;
}

function contractSourceRefs(contract, elementsById) {
  if (contract.sourceSelector?.kind === 'exact_page') return [contract.sourceSelector.ref];
  if (contract.sourceSelector?.kind !== 'shared_availability') return [];
  return elementsById.get(contract.sourceSelector.ref)?.availableOnPageRefs || [];
}

function previewUrl(appKey, frameRef) {
  return `/workbench/api/knowledge-graph/assets/${encodeURIComponent(appKey)}/full-pages/${encodeURIComponent(frameRef)}`;
}

function observationPreview(appKey, observation, availableFrames) {
  const frameRef = observation?.frameRef;
  const viewport = observation?.viewport;
  if (!frameRef || !availableFrames.has(frameRef) || !viewport?.width || !viewport?.height) return null;
  return {
    frameRef,
    imageUrl: previewUrl(appKey, frameRef),
    viewport: { width: viewport.width, height: viewport.height },
  };
}

function pagePreview(appKey, page, availableFrames) {
  const observations = page.observations || [];
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const preview = observationPreview(appKey, observations[index], availableFrames);
    if (preview) return preview;
  }
  return null;
}

function edgePreview(appKey, edge, trigger, elementsById, availableFrames) {
  if (!trigger) return null;
  const pageId = owningPageId(trigger, elementsById) || edge.source;
  const observations = trigger.observations || [];
  const preferred = observations.find((observation) => observation.frameRef === edge.beforeFrameRef && observation.locator?.rect);
  const fallback = [...observations].reverse().find((observation) => observation.locator?.rect && availableFrames.has(observation.frameRef));
  const observation = preferred && availableFrames.has(preferred.frameRef) ? preferred : fallback;
  const preview = observationPreview(appKey, observation, availableFrames);
  if (!preview) return null;
  const rect = observation.locator.rect;
  return {
    ...preview,
    pageId,
    element: {
      id: trigger.id,
      key: trigger.key,
      label: trigger.label,
      elementType: trigger.elementType,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    },
  };
}

export async function loadCanonicalGraph({ graphRoot, yaml, appKey: requestedAppKey }) {
  const appKey = safeAppKey(requestedAppKey);
  const appRoot = path.join(graphRoot, 'apps', appKey);
  let manifest;
  try {
    manifest = yaml.load(await readFile(path.join(appRoot, 'manifest.yaml'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const notFound = new Error(`Canonical 图谱不存在：${appKey}`);
      notFound.status = 404;
      throw notFound;
    }
    throw error;
  }

  const records = [];
  for (const file of await listYamlFiles(appRoot)) {
    if (path.basename(file) === 'manifest.yaml') continue;
    const value = yaml.load(await readFile(file, 'utf8'));
    if (value?.entityType) records.push(value);
  }

  const application = records.find((record) => record.entityType === 'Application');
  const pages = records.filter((record) => record.entityType === 'Page');
  const elements = records.filter((record) => record.entityType === 'Element');
  const transitions = records.filter((record) => record.entityType === 'Transition');
  const contracts = records.filter((record) => record.entityType === 'AuthorityContract');
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const elementsById = new Map(elements.map((element) => [element.id, element]));
  let availableFrames = new Set();
  try {
    availableFrames = new Set((await readdir(path.join(graphRoot, 'obsidian', appKey, 'assets', 'full-pages')))
      .filter((name) => name.endsWith('.png'))
      .map((name) => name.slice(0, -4)));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const ownedElementCounts = new Map();
  for (const element of elements) {
    const pageId = owningPageId(element, elementsById);
    if (pageId) ownedElementCounts.set(pageId, (ownedElementCounts.get(pageId) || 0) + 1);
  }

  const edgeRecords = [
    ...transitions.map((transition) => ({
      id: transition.id,
      key: transition.key,
      kind: 'transition',
      source: transition.sourceRef,
      target: transition.targetRef,
      sourceStateKey: transition.sourceStateKey || null,
      targetStateKey: transition.targetStateKey || null,
      action: transition.action,
      capability: transition.capability,
      triggerElementId: transition.triggerElementRef,
      reversible: transition.reversible,
      risk: transition.risk,
      status: transition.verificationStatus,
      planningEligible: true,
      beforeFrameRef: transition.evidence?.beforeFrameRef || null,
    })),
    ...contracts.flatMap((contract) => contractSourceRefs(contract, elementsById).map((sourceRef) => ({
      id: `${contract.id}:${sourceRef}`,
      canonicalId: contract.id,
      key: contract.key,
      kind: 'authority_contract',
      source: sourceRef,
      target: contract.expectedTarget?.ref,
      sourceStateKey: contract.sourceSelector?.stateKey || null,
      targetStateKey: contract.expectedTarget?.stateKey || null,
      action: contract.action,
      capability: contract.capability,
      triggerElementId: contract.triggerElementRef,
      reversible: null,
      risk: contract.risk,
      status: contract.runtimeEvidenceStatus,
      planningEligible: contract.planningEligible === true,
      beforeFrameRef: null,
    }))),
  ].filter((edge) => pagesById.has(edge.source) && pagesById.has(edge.target));

  const edges = edgeRecords.map((edge) => {
    const trigger = elementsById.get(edge.triggerElementId);
    const { beforeFrameRef: _beforeFrameRef, ...projection } = edge;
    return {
      ...projection,
      trigger: trigger ? { id: trigger.id, key: trigger.key, label: trigger.label, elementType: trigger.elementType } : null,
      preview: edgePreview(appKey, edge, trigger, elementsById, availableFrames),
    };
  });

  const pageProjection = pages.map((page) => {
    const inboundEdges = edges.filter((edge) => edge.target === page.id);
    const outboundEdges = edges.filter((edge) => edge.source === page.id);
    const sharedElementCount = elements.filter((element) => element.owner?.kind === 'application' && element.availableOnPageRefs?.includes(page.id)).length;
    return {
      id: page.id,
      key: page.key,
      label: page.label,
      featurePath: page.featurePath || [],
      surfaceType: page.surfaceType,
      status: page.status,
      summary: page.summary,
      states: (page.states || []).map((state) => ({ key: state.key, summary: state.summary })),
      elementCount: ownedElementCounts.get(page.id) || 0,
      sharedElementCount,
      inboundCount: inboundEdges.length,
      outboundCount: outboundEdges.length,
      preview: pagePreview(appKey, page, availableFrames),
    };
  }).sort((left, right) => left.key.localeCompare(right.key));

  return {
    appKey,
    application: application ? { id: application.id, key: application.key, label: application.label, platform: application.platform } : null,
    revision: manifest?.graphRevision || null,
    status: manifest?.status || 'unknown',
    generatedAt: manifest?.generatedAt || null,
    stats: {
      pages: pageProjection.length,
      elements: elements.length,
      transitions: transitions.length,
      authorityContracts: contracts.length,
    },
    featureDomains: unique(pageProjection.map((page) => page.featurePath[0])).sort((left, right) => left.localeCompare(right, 'zh-CN')),
    pages: pageProjection,
    edges,
  };
}
