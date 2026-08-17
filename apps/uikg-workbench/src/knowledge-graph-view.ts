import type { CanonicalGraph, CanonicalGraphEdge, CanonicalGraphPage } from './types';

export type KnowledgeGraphNodeType = 'nav' | 'feature' | 'page' | 'shared' | 'entry';
export type KnowledgeGraphViewEdgeKind = 'navigation' | 'relationship' | 'placement';

export interface KnowledgeGraphViewNode {
  id: string;
  label: string;
  type: KnowledgeGraphNodeType;
  layer: string;
  summary: string;
  featurePath: string[];
  pageId: string | null;
  activeEdgeId: string | null;
  order?: number;
}

export interface KnowledgeGraphViewEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: KnowledgeGraphViewEdgeKind;
  canonicalEdgeId: string | null;
}

export interface KnowledgeGraphView {
  nodes: KnowledgeGraphViewNode[];
  edges: KnowledgeGraphViewEdge[];
}

const navDefinitions = [
  { id: 'nav.workbench', label: '工作台', pageKey: 'workbench.root', summary: '系统固定导航页，仅允许调整底部位置' },
  { id: 'nav.messages', label: '消息', pageKey: 'messages.root', summary: '系统固定导航页，仅允许调整底部位置' },
  { id: 'nav.contacts', label: '通讯录', pageKey: 'contacts.root', summary: '可显示在底部导航，也可收纳到“更多”' },
  { id: 'nav.news', label: '资讯', pageKey: 'news.root', summary: '可显示在底部导航，也可收纳到“更多”' },
  { id: 'nav.more', label: '更多', pageKey: null, summary: '底部导航入口，承载其他功能及可收纳页面' },
];

function preferredEdge(edges: CanonicalGraphEdge[], source: string, target: string) {
  return edges.find((edge) => edge.source === source && edge.target === target && edge.kind === 'transition' && edge.capability.startsWith('open_'))
    || edges.find((edge) => edge.source === source && edge.target === target && edge.kind === 'transition')
    || null;
}

function incomingOpenEdge(edges: CanonicalGraphEdge[], pageId: string) {
  return edges.find((edge) => edge.target === pageId && edge.source !== pageId && edge.kind === 'transition' && edge.capability.startsWith('open_') && edge.preview)
    || edges.find((edge) => edge.target === pageId && edge.source !== pageId && edge.kind === 'transition' && edge.preview)
    || null;
}

function pageLabel(page: CanonicalGraphPage, feature: string) {
  if (page.key.split('.').length === 2) return `${feature}首页`;
  if (page.key.endsWith('.settings')) return `${page.label.split('-').at(-1) || page.label}设置`;
  if (page.key.endsWith('.people')) return '全部成员';
  if (page.key.endsWith('.remove_confirmation')) return '移除确认';
  if (page.key.endsWith('.popup_interval_selector')) return '弹窗提醒间隔选择';
  if (page.key.endsWith('.reminder_method_selector')) return '提醒方式选择';
  if (page.key.endsWith('.sms_phone_interval_selector')) return '短信/电话提醒间隔';
  if (page.key.endsWith('.sound_selector')) return '提示音选择';
  return page.label.split('-').at(-1) || page.label;
}

function edgeLabel(edge: CanonicalGraphEdge, targetLabel: string) {
  const triggerLabel = edge.trigger?.label.split('-').at(-1);
  return `点击：${triggerLabel || targetLabel}`;
}

export function buildKnowledgeGraphView(graph: CanonicalGraph): KnowledgeGraphView {
  const nodes: KnowledgeGraphViewNode[] = [];
  const edges: KnowledgeGraphViewEdge[] = [];
  const pagesByKey = new Map(graph.pages.map((page) => [page.key, page]));
  const pageNodeIds = new Map<string, string>();
  const navByDomain = new Map<string, KnowledgeGraphViewNode>();

  navDefinitions.forEach((definition, order) => {
    const page = definition.pageKey ? pagesByKey.get(definition.pageKey) || null : null;
    const node: KnowledgeGraphViewNode = {
      id: definition.id,
      label: definition.label,
      type: 'nav',
      layer: '第一层',
      summary: definition.summary,
      featurePath: [definition.label],
      pageId: page?.id || null,
      activeEdgeId: null,
      order,
    };
    nodes.push(node);
    navByDomain.set(definition.label, node);
    if (page) pageNodeIds.set(page.id, node.id);
  });

  const featureGroups = new Map<string, { domain: string; feature: string; pages: CanonicalGraphPage[] }>();
  for (const page of graph.pages) {
    const [domain, feature] = page.featurePath;
    if (!domain || !feature || domain === '通用组件') continue;
    const key = `${domain}\u0000${feature}`;
    const group = featureGroups.get(key) || { domain, feature, pages: [] };
    group.pages.push(page);
    featureGroups.set(key, group);
  }

  for (const group of featureGroups.values()) {
    const navNode = navByDomain.get(group.domain);
    const defaultPage = [...group.pages].sort((left, right) => left.key.split('.').length - right.key.split('.').length)[0];
    const entryEdge = navNode?.pageId ? preferredEdge(graph.edges, navNode.pageId, defaultPage.id) : null;
    const featureNode: KnowledgeGraphViewNode = {
      id: `feature.${group.domain}.${group.feature}`,
      label: group.feature,
      type: 'feature',
      layer: '第二层',
      summary: `${group.domain}中的${group.feature}功能，包含 ${group.pages.length} 个已收录页面`,
      featurePath: [group.domain, group.feature],
      pageId: defaultPage.id,
      activeEdgeId: entryEdge?.id || null,
    };
    nodes.push(featureNode);
    if (navNode) edges.push({
      id: `view.entry.${featureNode.id}`,
      source: navNode.id,
      target: featureNode.id,
      label: `点击：${group.feature}入口`,
      kind: 'navigation',
      canonicalEdgeId: entryEdge?.id || null,
    });

    for (const page of group.pages) {
      const node: KnowledgeGraphViewNode = {
        id: `page.${page.key}`,
        label: pageLabel(page, group.feature),
        type: 'page',
        layer: '第三层',
        summary: page.summary,
        featurePath: page.featurePath,
        pageId: page.id,
        activeEdgeId: page.id === defaultPage.id ? entryEdge?.id || null : incomingOpenEdge(graph.edges, page.id)?.id || null,
      };
      nodes.push(node);
      pageNodeIds.set(page.id, node.id);
    }
    edges.push({
      id: `view.default.${featureNode.id}`,
      source: featureNode.id,
      target: pageNodeIds.get(defaultPage.id)!,
      label: '进入：默认入口页',
      kind: 'relationship',
      canonicalEdgeId: entryEdge?.id || null,
    });
  }

  for (const page of graph.pages.filter((candidate) => candidate.featurePath[0] === '通用组件')) {
    const activeEdge = incomingOpenEdge(graph.edges, page.id);
    const node: KnowledgeGraphViewNode = {
      id: `shared.${page.key}`,
      label: page.label.replace(/^通用组件-/, ''),
      type: 'shared',
      layer: '共享层',
      summary: page.summary,
      featurePath: page.featurePath,
      pageId: page.id,
      activeEdgeId: activeEdge?.id || null,
    };
    nodes.push(node);
    pageNodeIds.set(page.id, node.id);
  }

  const pairKeys = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'transition' || !edge.capability.startsWith('open_') || edge.source === edge.target) continue;
    const source = pageNodeIds.get(edge.source);
    const target = pageNodeIds.get(edge.target);
    if (!source || !target || source.startsWith('nav.') || target.startsWith('nav.')) continue;
    const pairKey = `${source}\u0000${target}`;
    if (pairKeys.has(pairKey)) continue;
    pairKeys.add(pairKey);
    const targetNode = nodes.find((node) => node.id === target)!;
    edges.push({
      id: `view.relation.${edge.id}`,
      source,
      target,
      label: edgeLabel(edge, targetNode.label),
      kind: 'relationship',
      canonicalEdgeId: edge.id,
    });
  }

  const moreEntry: KnowledgeGraphViewNode = {
    id: 'entry.more_features',
    label: '更多功能入口',
    type: 'entry',
    layer: '入口集合',
    summary: '当前 Canonical 尚未收录“更多”中的其他功能，后续将按真实数据自动展开',
    featurePath: ['更多'],
    pageId: null,
    activeEdgeId: null,
  };
  nodes.push(moreEntry);
  edges.push({ id: 'view.more.entry', source: 'nav.more', target: moreEntry.id, label: '展开：更多功能入口', kind: 'navigation', canonicalEdgeId: null });
  edges.push({ id: 'view.placement.contacts', source: 'nav.contacts', target: 'nav.more', label: '收纳：通讯录', kind: 'placement', canonicalEdgeId: null });
  edges.push({ id: 'view.placement.news', source: 'nav.news', target: 'nav.more', label: '收纳：资讯', kind: 'placement', canonicalEdgeId: null });

  return { nodes, edges };
}
