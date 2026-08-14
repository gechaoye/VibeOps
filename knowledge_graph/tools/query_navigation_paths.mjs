#!/usr/bin/env node

import {
  readFileSync,
  readdirSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_GRAPH_ROOT = resolve(SCRIPT_DIR, '..');
const YAML_LIBRARY_PATH = join(SCRIPT_DIR, 'vendor', 'js-yaml-4.1.1.js');
const require = createRequire(import.meta.url);
const ROUTING_PROFILES = new Set(['shortest', 'low-risk']);
const RISK_PENALTIES = new Map([
  ['safe', 0],
  ['low', 1],
  ['medium', 4],
  ['high', 16],
  ['critical', 64],
]);

function usage() {
  return `Usage:
  node knowledge_graph/tools/query_navigation_paths.mjs \\
    --from <page-key-or-id> \\
    --to <page-key-or-id> \\
    [--root <knowledge-graph-root>] \\
    [--profile shortest|low-risk] \\
    [--pretty]

Options:
  --from      Source Page key or stable ID.
  --to        Destination Page key or stable ID.
  --root      Knowledge graph root. Defaults to the repository knowledge_graph directory.
  --profile   Routing profile. Defaults to shortest.
  --pretty    Pretty-print the JSON result.
  --help      Show this help text.`;
}

function parseArguments(argv) {
  const parsed = {
    from: null,
    to: null,
    root: KNOWLEDGE_GRAPH_ROOT,
    profile: 'shortest',
    pretty: false,
    help: false,
  };
  const valueOptions = new Map([
    ['--from', 'from'],
    ['--to', 'to'],
    ['--root', 'root'],
    ['--profile', 'profile'],
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--pretty') {
      if (seen.has(argument)) throw new Error(`Duplicate option: ${argument}`);
      seen.add(argument);
      parsed.pretty = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      parsed.help = true;
      continue;
    }
    const property = valueOptions.get(argument);
    if (!property) throw new Error(`Unknown option: ${argument}`);
    if (seen.has(argument)) throw new Error(`Duplicate option: ${argument}`);
    seen.add(argument);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Option ${argument} requires a value`);
    }
    parsed[property] = value;
    index += 1;
  }
  if (!parsed.help) {
    if (!parsed.from) throw new Error('Missing required option: --from');
    if (!parsed.to) throw new Error('Missing required option: --to');
    if (!ROUTING_PROFILES.has(parsed.profile)) {
      throw new Error(`Unsupported routing profile: ${parsed.profile}`);
    }
  }
  return parsed;
}

function listYamlFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

function loadYamlLibrary() {
  const yaml = require(YAML_LIBRARY_PATH);
  if (typeof yaml.loadAll !== 'function') {
    throw new Error('Vendored js-yaml does not expose loadAll()');
  }
  return yaml;
}

function loadRecords(yaml, root, entityType) {
  const records = [];
  for (const file of listYamlFiles(root)) {
    yaml.loadAll(readFileSync(file, 'utf8'), (record) => {
      if (record?.entityType === entityType) records.push({ ...record, __file: file });
    });
  }
  return records;
}

function buildEntityIndex(records, label) {
  const byId = new Map();
  const byKey = new Map();
  for (const record of records) {
    if (!record.id || !record.key) throw new Error(`${label} is missing id or key: ${record.__file}`);
    if (byId.has(record.id)) throw new Error(`Duplicate ${label} ID: ${record.id}`);
    if (byKey.has(record.key)) throw new Error(`Duplicate ${label} key: ${record.key}`);
    byId.set(record.id, record);
    byKey.set(record.key, record);
  }
  return { byId, byKey };
}

function resolveEntity(input, index, label) {
  const record = index.byId.get(input) ?? index.byKey.get(input);
  if (!record) throw new Error(`${label} not found: ${input}`);
  return record;
}

function isClosedTransition(transition) {
  const evidence = transition.evidence ?? {};
  return Boolean(
    transition.sourceRef
    && transition.targetRef
    && transition.triggerElementRef
    && evidence.actionTraceRef
    && evidence.beforeFrameRef
    && evidence.afterFrameRef
    && evidence.postcondition === 'pass',
  );
}

function validateTransition(transition, pageIndex, elementIndex) {
  if (!pageIndex.byId.has(transition.sourceRef)) {
    throw new Error(`${transition.key}: sourceRef does not resolve to a Page`);
  }
  if (!pageIndex.byId.has(transition.targetRef)) {
    throw new Error(`${transition.key}: targetRef does not resolve to a Page`);
  }
  if (!elementIndex.byId.has(transition.triggerElementRef)) {
    throw new Error(`${transition.key}: triggerElementRef does not resolve to an Element`);
  }
}

function isRoutableAuthorityContract(contract) {
  return Boolean(
    contract.edgeKind === 'authority_contract'
    && contract.authorityStatus === 'authority_certified'
    && contract.planningEligible === true
    && contract.runtimeEvidenceStatus !== 'contradicted'
    && ['exact_page', 'shared_availability'].includes(contract.sourceSelector?.kind)
    && contract.expectedTarget?.kind === 'page'
  );
}

function validateAuthorityContract(contract, pageIndex, elementIndex) {
  if (contract.sourceSelector?.kind === 'exact_page') {
    if (!pageIndex.byId.has(contract.sourceSelector.ref)) {
      throw new Error(`${contract.key}: exact sourceSelector does not resolve to a Page`);
    }
  } else {
    const sharedRoot = elementIndex.byId.get(contract.sourceSelector?.ref);
    if (!sharedRoot || sharedRoot.owner?.kind !== 'application') {
      throw new Error(`${contract.key}: shared sourceSelector does not resolve to a top-level shared Element`);
    }
    if (!sharedRoot.availableOnPageRefs?.length) {
      throw new Error(`${contract.key}: shared sourceSelector has no available Pages`);
    }
    for (const pageRef of sharedRoot.availableOnPageRefs) {
      if (!pageIndex.byId.has(pageRef)) {
        throw new Error(`${contract.key}: shared sourceSelector references an unknown Page`);
      }
    }
  }
  if (!pageIndex.byId.has(contract.expectedTarget?.ref)) {
    throw new Error(`${contract.key}: expectedTarget does not resolve to a Page`);
  }
  if (!elementIndex.byId.has(contract.triggerElementRef)) {
    throw new Error(`${contract.key}: triggerElementRef does not resolve to an Element`);
  }
}

function transitionEdge(transition) {
  return {
    ...transition,
    edgeKind: 'verified_transition',
    runtimeEvidenceStatus: 'verified',
    authorityStatus: 'not_applicable',
  };
}

function authorityContractEdge(contract, sourceRef) {
  return {
    ...contract,
    sourceRef,
    targetRef: contract.expectedTarget.ref,
    verificationStatus: contract.runtimeEvidenceStatus,
    evidence: {
      authorityStatus: contract.authorityStatus,
      runtimeEvidenceStatus: contract.runtimeEvidenceStatus,
      verifiedTransitionRef: contract.verifiedTransitionRef ?? null,
      certifiedFact: contract.certifiedFact,
    },
  };
}

function authorityContractEdges(contract, elementIndex) {
  if (contract.sourceSelector.kind === 'exact_page') {
    return [authorityContractEdge(contract, contract.sourceSelector.ref)];
  }
  const sharedRoot = elementIndex.byId.get(contract.sourceSelector.ref);
  return sharedRoot.availableOnPageRefs.map((pageRef) => authorityContractEdge(contract, pageRef));
}

function transitionCost(transition, profile) {
  const actionCost = 1;
  const riskPenalty = RISK_PENALTIES.get(transition.risk) ?? 8;
  return {
    actionCost,
    riskPenalty,
    routingCost: profile === 'low-risk' ? actionCost + riskPenalty : actionCost,
  };
}

function compareRoutes(left, right) {
  if (left.routingCost !== right.routingCost) return left.routingCost - right.routingCost;
  if (left.steps.length !== right.steps.length) return left.steps.length - right.steps.length;
  return left.tieBreaker.localeCompare(right.tieBreaker);
}

function isBetterRoute(candidate, previous) {
  if (!previous) return true;
  return compareRoutes(candidate, previous) < 0;
}

function findRoute(startPage, goalPage, edges, profile) {
  if (startPage.id === goalPage.id) {
    return { pageRef: startPage.id, routingCost: 0, actionCost: 0, steps: [], tieBreaker: '' };
  }
  const outgoing = new Map();
  for (const edge of edges) {
    const values = outgoing.get(edge.sourceRef) ?? [];
    values.push(edge);
    outgoing.set(edge.sourceRef, values);
  }
  for (const values of outgoing.values()) {
    values.sort((left, right) => left.key.localeCompare(right.key));
  }

  const initial = {
    pageRef: startPage.id,
    routingCost: 0,
    actionCost: 0,
    steps: [],
    tieBreaker: '',
  };
  const queue = [initial];
  const best = new Map([[startPage.id, initial]]);
  while (queue.length > 0) {
    queue.sort(compareRoutes);
    const current = queue.shift();
    if (current !== best.get(current.pageRef)) continue;
    if (current.pageRef === goalPage.id) return current;
    for (const edge of outgoing.get(current.pageRef) ?? []) {
      const cost = transitionCost(edge, profile);
      const edgeTieBreaker = `${edge.edgeKind === 'verified_transition' ? '0' : '1'}:${edge.key}`;
      const candidate = {
        pageRef: edge.targetRef,
        routingCost: current.routingCost + cost.routingCost,
        actionCost: current.actionCost + cost.actionCost,
        steps: [...current.steps, { edge, cost }],
        tieBreaker: current.tieBreaker
          ? `${current.tieBreaker}>${edgeTieBreaker}`
          : edgeTieBreaker,
      };
      const previous = best.get(candidate.pageRef);
      if (!isBetterRoute(candidate, previous)) continue;
      best.set(candidate.pageRef, candidate);
      queue.push(candidate);
    }
  }
  throw new Error(
    `No verified route from ${startPage.key} to ${goalPage.key}; `
    + 'unreconciled shared-navigation records are not executable edges',
  );
}

function resultDocument(args, startPage, goalPage, route, pageIndex, elementIndex, graphStats) {
  const steps = route.steps.map(({ edge, cost }, index) => {
    const source = pageIndex.byId.get(edge.sourceRef);
    const target = pageIndex.byId.get(edge.targetRef);
    const trigger = elementIndex.byId.get(edge.triggerElementRef);
    return {
      index: index + 1,
      edgeKind: edge.edgeKind,
      edgeRef: edge.id,
      edgeKey: edge.key,
      source: { pageRef: source.id, pageKey: source.key, label: source.label },
      trigger: {
        elementRef: trigger.id,
        elementKey: trigger.key,
        label: trigger.label,
        action: edge.action,
        capability: edge.capability,
      },
      target: { pageRef: target.id, pageKey: target.key, label: target.label },
      risk: edge.risk ?? 'unknown',
      authorityStatus: edge.authorityStatus ?? 'not_applicable',
      runtimeEvidenceStatus: edge.runtimeEvidenceStatus ?? 'unknown',
      verificationStatus: edge.verificationStatus ?? 'unknown',
      cost,
      evidence: edge.evidence,
    };
  });
  return {
    schemaVersion: '3.0.0',
    entityType: 'NavigationPathQueryResult',
    routeMaterialization: 'on_demand',
    query: {
      from: { input: args.from, pageRef: startPage.id, pageKey: startPage.key },
      to: { input: args.to, pageRef: goalPage.id, pageKey: goalPage.key },
      profile: args.profile,
    },
    graph: graphStats,
    path: {
      actionCount: steps.length,
      totalActionCost: route.actionCost,
      totalRoutingCost: route.routingCost,
      steps,
    },
  };
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const yaml = loadYamlLibrary();
  const appRoot = join(resolve(args.root), 'apps', 'zto.connect');
  const manifestPath = join(appRoot, 'manifest.yaml');
  const pageRoot = join(appRoot, 'pages');
  const elementRoot = join(appRoot, 'elements');
  const transitionRoot = join(appRoot, 'transitions');
  const authorityContractRoot = join(appRoot, 'authority-contracts');
  const manifest = yaml.load(readFileSync(manifestPath, 'utf8'));
  if (!manifest?.graphRevision) {
    throw new Error('Canonical manifest is missing graphRevision');
  }
  const pages = loadRecords(yaml, pageRoot, 'Page');
  const elements = loadRecords(yaml, elementRoot, 'Element');
  const allTransitions = loadRecords(yaml, transitionRoot, 'Transition');
  const allAuthorityContracts = loadRecords(yaml, authorityContractRoot, 'AuthorityContract');
  const pageIndex = buildEntityIndex(pages, 'Page');
  const elementIndex = buildEntityIndex(elements, 'Element');
  buildEntityIndex(allTransitions, 'Transition');
  buildEntityIndex(allAuthorityContracts, 'AuthorityContract');
  const closedTransitions = allTransitions.filter(isClosedTransition);
  closedTransitions.forEach((transition) => validateTransition(transition, pageIndex, elementIndex));
  const routableAuthorityContracts = allAuthorityContracts.filter(isRoutableAuthorityContract);
  routableAuthorityContracts.forEach(
    (contract) => validateAuthorityContract(contract, pageIndex, elementIndex),
  );
  const routableEdges = [
    ...closedTransitions.map(transitionEdge),
    ...routableAuthorityContracts.flatMap(
      (contract) => authorityContractEdges(contract, elementIndex),
    ),
  ];
  const startPage = resolveEntity(args.from, pageIndex, 'Page');
  const goalPage = resolveEntity(args.to, pageIndex, 'Page');
  const route = findRoute(startPage, goalPage, routableEdges, args.profile);
  const result = resultDocument(
    args,
    startPage,
    goalPage,
    route,
    pageIndex,
    elementIndex,
    {
      graphRevision: manifest.graphRevision,
      rootHash: manifest.rootHash ?? null,
      pageCount: pages.length,
      canonicalTransitionCount: allTransitions.length,
      routableTransitionCount: closedTransitions.length,
      excludedTransitionCount: allTransitions.length - closedTransitions.length,
      authorityContractCount: allAuthorityContracts.length,
      routableAuthorityContractCount: routableAuthorityContracts.length,
      excludedAuthorityContractCount: allAuthorityContracts.length - routableAuthorityContracts.length,
    },
  );
  process.stdout.write(`${JSON.stringify(result, null, args.pretty ? 2 : 0)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`Navigation query failed: ${error.message}\n\n${usage()}\n`);
  process.exitCode = 1;
}
