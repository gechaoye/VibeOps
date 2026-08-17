import dagre from '@dagrejs/dagre';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ArrowRight,
  CircleAlert,
  CircleDot,
  GitBranch,
  Layers3,
  LoaderCircle,
  LocateFixed,
  Network,
  RefreshCw,
  Route,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { workbenchApi } from './api';
import type { CanonicalGraph, CanonicalGraphEdge, CanonicalGraphPage } from './types';

interface KnowledgeGraphProps {
  appKey: string;
}

interface PageNodeData extends Record<string, unknown> {
  page: CanonicalGraphPage;
  dimmed: boolean;
  pathRole: 'start' | 'end' | 'middle' | null;
}

interface GraphEdgeData extends Record<string, unknown> {
  edge: CanonicalGraphEdge;
}

const nodeWidth = 236;
const nodeHeight = 120;
const riskCost: Record<string, number> = { safe: 0, low: 1, medium: 4, high: 12, critical: 40 };

function statusLabel(status: string) {
  if (status === 'complete') return '完整';
  if (status === 'incomplete') return '待补全';
  if (status.includes('success') || status.includes('verified')) return '已审核';
  if (status.includes('pending')) return '待确认';
  return status.replaceAll('_', ' ');
}

function surfaceLabel(surfaceType: string) {
  const labels: Record<string, string> = {
    page: '页面', dialog: '对话框', overlay: '浮层', drawer: '抽屉', menu: '菜单', 'bottom-sheet': '底部弹层', shared_component: '共享组件',
  };
  return labels[surfaceType] || surfaceType;
}

function PageNode({ data: rawData, selected }: NodeProps) {
  const data = rawData as PageNodeData;
  const page = data.page;
  return (
    <div className={`kg-page-node ${selected ? 'selected' : ''} ${data.dimmed ? 'dimmed' : ''} ${data.pathRole ? `path-${data.pathRole}` : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="kg-page-node-topline">
        <span className="kg-surface-badge">{surfaceLabel(page.surfaceType)}</span>
        <span className="kg-node-status"><i />{statusLabel(page.status)}</span>
      </div>
      <strong title={page.label}>{page.label}</strong>
      <span className="kg-node-path">{page.featurePath.join(' / ') || '未归类'}</span>
      <div className="kg-node-metrics">
        <span><Layers3 size={12} />{page.elementCount + page.sharedElementCount} 元素</span>
        <span><GitBranch size={12} />{page.outboundCount} 出口</span>
      </div>
      {data.pathRole && <span className="kg-path-role">{data.pathRole === 'start' ? '起点' : data.pathRole === 'end' ? '终点' : '路径'}</span>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { page: PageNode };

function layoutNodes(pages: CanonicalGraphPage[], edges: CanonicalGraphEdge[]) {
  const layout = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  layout.setGraph({ rankdir: 'LR', ranksep: 110, nodesep: 42, edgesep: 24, marginx: 36, marginy: 36 });
  for (const page of pages) layout.setNode(page.id, { width: nodeWidth, height: nodeHeight });
  for (const edge of edges) if (edge.source !== edge.target) layout.setEdge(edge.source, edge.target);
  dagre.layout(layout);
  return new Map(pages.map((page) => {
    const position = layout.node(page.id);
    return [page.id, { x: position.x - nodeWidth / 2, y: position.y - nodeHeight / 2 }];
  }));
}

function findPath(edges: CanonicalGraphEdge[], from: string, to: string, profile: 'shortest' | 'low-risk') {
  if (!from || !to) return [];
  const queue: Array<{ pageId: string; cost: number; edgeIds: string[] }> = [{ pageId: from, cost: 0, edgeIds: [] }];
  const best = new Map([[from, 0]]);
  while (queue.length) {
    queue.sort((left, right) => left.cost - right.cost || left.edgeIds.length - right.edgeIds.length);
    const current = queue.shift()!;
    if (current.cost !== best.get(current.pageId)) continue;
    if (current.pageId === to) return current.edgeIds;
    for (const edge of edges.filter((candidate) => candidate.source === current.pageId && candidate.planningEligible)) {
      const cost = current.cost + 1 + (profile === 'low-risk' ? riskCost[edge.risk] ?? 8 : 0);
      if (cost >= (best.get(edge.target) ?? Number.POSITIVE_INFINITY)) continue;
      best.set(edge.target, cost);
      queue.push({ pageId: edge.target, cost, edgeIds: [...current.edgeIds, edge.id] });
    }
  }
  return [];
}

function RelationRow({ edge, pagesById, active, onClick }: { edge: CanonicalGraphEdge; pagesById: Map<string, CanonicalGraphPage>; active?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`kg-relation-row ${active ? 'active' : ''}`} onClick={onClick}>
      <span className={`kg-relation-kind kg-relation-${edge.kind}`}><CircleDot size={12} />{edge.kind === 'transition' ? 'Transition' : 'Authority'}</span>
      <strong>{edge.capability}</strong>
      <span>{pagesById.get(edge.source)?.label || edge.source}<ArrowRight size={12} />{pagesById.get(edge.target)?.label || edge.target}</span>
    </button>
  );
}

export function KnowledgeGraph({ appKey }: KnowledgeGraphProps) {
  const [graph, setGraph] = useState<CanonicalGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [featureDomain, setFeatureDomain] = useState('all');
  const [showTransitions, setShowTransitions] = useState(true);
  const [showContracts, setShowContracts] = useState(true);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [pathMode, setPathMode] = useState(false);
  const [pathFrom, setPathFrom] = useState('');
  const [pathTo, setPathTo] = useState('');
  const [pathProfile, setPathProfile] = useState<'shortest' | 'low-risk'>('shortest');
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null);

  const loadGraph = async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await workbenchApi.knowledgeGraph(appKey || 'zto.connect');
      setGraph(next);
      const primaryDomain = [...next.featureDomains]
        .sort((left, right) => next.pages.filter((page) => page.featurePath[0] === right).length - next.pages.filter((page) => page.featurePath[0] === left).length)[0];
      setFeatureDomain(primaryDomain || 'all');
      setSelectedPageId((current) => current && next.pages.some((page) => page.id === current) ? current : null);
      setSelectedEdgeId(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadGraph(); }, [appKey]);

  const pagesById = useMemo(() => new Map(graph?.pages.map((page) => [page.id, page]) || []), [graph]);
  const visiblePages = useMemo(() => graph?.pages.filter((page) => featureDomain === 'all' || page.featurePath[0] === featureDomain) || [], [featureDomain, graph]);
  const visiblePageIds = useMemo(() => new Set(visiblePages.map((page) => page.id)), [visiblePages]);
  const visibleEdges = useMemo(() => graph?.edges.filter((edge) => visiblePageIds.has(edge.source)
    && visiblePageIds.has(edge.target)
    && (edge.kind === 'transition' ? showTransitions : showContracts)) || [], [graph, showContracts, showTransitions, visiblePageIds]);
  const pathEdgeIds = useMemo(() => new Set(findPath(visibleEdges, pathFrom, pathTo, pathProfile)), [pathFrom, pathProfile, pathTo, visibleEdges]);
  const pathPageIds = useMemo(() => {
    const ids = new Set<string>();
    for (const edge of visibleEdges) if (pathEdgeIds.has(edge.id)) { ids.add(edge.source); ids.add(edge.target); }
    return ids;
  }, [pathEdgeIds, visibleEdges]);
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  const matchedPageIds = useMemo(() => new Set(visiblePages.filter((page) => !normalizedQuery || [page.label, page.key, page.summary, ...page.featurePath]
    .some((value) => value.toLocaleLowerCase('zh-CN').includes(normalizedQuery))).map((page) => page.id)), [normalizedQuery, visiblePages]);
  const positions = useMemo(() => layoutNodes(visiblePages, visibleEdges), [visibleEdges, visiblePages]);

  const nodes = useMemo<Node<PageNodeData>[]>(() => visiblePages.map((page) => ({
    id: page.id,
    type: 'page',
    position: positions.get(page.id) || { x: 0, y: 0 },
    data: {
      page,
      dimmed: Boolean(normalizedQuery && !matchedPageIds.has(page.id)) || Boolean(pathEdgeIds.size && !pathPageIds.has(page.id)),
      pathRole: page.id === pathFrom ? 'start' : page.id === pathTo ? 'end' : pathPageIds.has(page.id) ? 'middle' : null,
    },
    selected: page.id === selectedPageId,
  })), [matchedPageIds, normalizedQuery, pathEdgeIds.size, pathFrom, pathPageIds, pathTo, positions, selectedPageId, visiblePages]);

  const flowEdges = useMemo<Edge<GraphEdgeData>[]>(() => visibleEdges.map((edge) => {
    const inPath = pathEdgeIds.has(edge.id);
    const connected = selectedPageId ? edge.source === selectedPageId || edge.target === selectedPageId : true;
    const selected = edge.id === selectedEdgeId;
    const muted = Boolean(pathEdgeIds.size && !inPath) || Boolean(selectedPageId && !connected);
    const contract = edge.kind === 'authority_contract';
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: edge.source === edge.target ? 'default' : 'smoothstep',
      data: { edge },
      label: selected || inPath || (!pathEdgeIds.size && selectedPageId && connected) ? edge.capability : undefined,
      labelStyle: { fill: '#30453c', fontSize: 10, fontWeight: 600 },
      labelBgStyle: { fill: '#ffffff', fillOpacity: 0.92 },
      labelBgPadding: [5, 3],
      labelBgBorderRadius: 3,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: inPath ? '#087f5b' : contract ? '#b25b00' : '#71837a' },
      style: {
        stroke: inPath ? '#087f5b' : contract ? '#b25b00' : '#71837a',
        strokeWidth: inPath || selected ? 2.8 : 1.5,
        strokeDasharray: contract ? '6 4' : undefined,
        opacity: muted ? 0.13 : 1,
      },
      animated: inPath,
      selected,
    };
  }), [pathEdgeIds, selectedEdgeId, selectedPageId, visibleEdges]);

  useEffect(() => {
    if (!flow || loading) return;
    const primaryPage = visiblePages.find((page) => page.featurePath.length === 1) || visiblePages[0];
    const primaryPosition = primaryPage ? positions.get(primaryPage.id) : null;
    const timer = window.setTimeout(() => {
      if (primaryPosition) {
        void flow.setCenter(primaryPosition.x + nodeWidth / 2, primaryPosition.y + nodeHeight / 2, { zoom: 0.68, duration: 350 });
      } else {
        void flow.fitView({ padding: 0.18, duration: 350, maxZoom: 1.15 });
      }
    }, 40);
    return () => window.clearTimeout(timer);
  }, [featureDomain, flow, loading, positions, visiblePages]);

  useEffect(() => {
    if (!flow || !pathEdgeIds.size) return;
    const timer = window.setTimeout(() => {
      void flow.fitView({ nodes: nodes.filter((node) => pathPageIds.has(node.id)), padding: 0.28, maxZoom: 0.88, duration: 350 });
    }, 40);
    return () => window.clearTimeout(timer);
  }, [flow, nodes, pathEdgeIds.size, pathPageIds]);

  const selectedPage = selectedPageId ? pagesById.get(selectedPageId) || null : null;
  const selectedEdge = selectedEdgeId ? graph?.edges.find((edge) => edge.id === selectedEdgeId) || null : null;
  const selectedRelations = selectedPage ? visibleEdges.filter((edge) => edge.source === selectedPage.id || edge.target === selectedPage.id) : [];

  const selectPage = (pageId: string) => {
    setSelectedPageId(pageId);
    setSelectedEdgeId(null);
    if (!pathMode) return;
    if (!pathFrom || pathTo) { setPathFrom(pageId); setPathTo(''); }
    else if (pageId !== pathFrom) setPathTo(pageId);
  };

  if (loading) return <main className="kg-state"><LoaderCircle className="spin" size={22} /><strong>正在加载 Canonical 图谱</strong></main>;
  if (error || !graph) return <main className="kg-state kg-state-error"><CircleAlert size={22} /><strong>{error || '图谱加载失败'}</strong><button type="button" className="button" onClick={() => void loadGraph()}><RefreshCw size={15} />重新加载</button></main>;

  return (
    <main className="kg-workspace">
      <aside className="kg-filter-panel">
        <header><div><Network size={17} /><strong>知识图谱</strong></div><span>Canonical · {graph.revision || '未发布'}</span></header>
        <div className="kg-app-summary">
          <div><strong>{graph.application?.label || graph.appKey}</strong><span>{graph.appKey}</span></div>
          <span className={`kg-graph-status kg-graph-status-${graph.status}`}><i />{statusLabel(graph.status)}</span>
        </div>
        <div className="kg-stats">
          <span><strong>{graph.stats.pages}</strong>页面</span>
          <span><strong>{graph.stats.elements}</strong>元素</span>
          <span><strong>{graph.stats.transitions}</strong>关系</span>
        </div>
        <label className="kg-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索页面、路径或稳定键" />{query && <button type="button" title="清空搜索" onClick={() => setQuery('')}><X size={13} /></button>}</label>
        <section className="kg-filter-section">
          <h3>功能域</h3>
          <button type="button" className={featureDomain === 'all' ? 'active' : ''} onClick={() => setFeatureDomain('all')}><span>全部页面</span><em>{graph.pages.length}</em></button>
          {graph.featureDomains.map((domain) => <button type="button" key={domain} className={featureDomain === domain ? 'active' : ''} onClick={() => setFeatureDomain(domain)}><span>{domain}</span><em>{graph.pages.filter((page) => page.featurePath[0] === domain).length}</em></button>)}
        </section>
        <section className="kg-filter-section kg-relation-filter">
          <h3>关系</h3>
          <label><input type="checkbox" checked={showTransitions} onChange={(event) => setShowTransitions(event.target.checked)} /><span><i className="transition" />已验证 Transition</span><em>{graph.stats.transitions}</em></label>
          <label><input type="checkbox" checked={showContracts} onChange={(event) => setShowContracts(event.target.checked)} /><span><i className="contract" />Authority Contract</span><em>{graph.stats.authorityContracts}</em></label>
        </section>
        <div className="kg-filter-note"><ShieldCheck size={14} /><span>该视图只读取已发布 Canonical，不包含页面草稿。</span></div>
      </aside>

      <section className="kg-canvas-panel">
        <div className="kg-toolbar">
          <div className="kg-mode-segment">
            <button type="button" className={!pathMode ? 'active' : ''} onClick={() => setPathMode(false)}><Network size={14} />总览</button>
            <button type="button" className={pathMode ? 'active' : ''} onClick={() => { setPathMode(true); setSelectedPageId(null); setSelectedEdgeId(null); }}><Route size={14} />路径查询</button>
          </div>
          {pathMode ? <div className="kg-route-controls">
            <select aria-label="路径起点" value={pathFrom} onChange={(event) => setPathFrom(event.target.value)}><option value="">选择起点</option>{visiblePages.map((page) => <option key={page.id} value={page.id}>{page.label}</option>)}</select>
            <ArrowRight size={14} />
            <select aria-label="路径终点" value={pathTo} onChange={(event) => setPathTo(event.target.value)}><option value="">选择终点</option>{visiblePages.map((page) => <option key={page.id} value={page.id}>{page.label}</option>)}</select>
            <select aria-label="路径策略" value={pathProfile} onChange={(event) => setPathProfile(event.target.value as 'shortest' | 'low-risk')}><option value="shortest">最少步骤</option><option value="low-risk">低风险优先</option></select>
            {pathFrom && pathTo && <span className={`kg-route-result ${pathEdgeIds.size ? '' : 'missing'}`}>{pathEdgeIds.size ? `${pathEdgeIds.size} 步` : '无可用路径'}</span>}
          </div> : <span className="kg-toolbar-hint">选择页面查看上下游关系</span>}
          <button type="button" className="icon-button" title="适应画布" onClick={() => flow?.fitView({ padding: 0.18, duration: 300, maxZoom: 1.15 })}><LocateFixed size={15} /></button>
        </div>
        <div className="kg-flow-wrap">
          <ReactFlow
            nodes={nodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            onInit={setFlow}
            onNodeClick={(_event, node) => selectPage(node.id)}
            onEdgeClick={(_event, edge) => { setSelectedEdgeId(edge.id); setSelectedPageId(null); }}
            onPaneClick={() => { setSelectedPageId(null); setSelectedEdgeId(null); }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            minZoom={0.25}
            maxZoom={1.8}
            fitView
            fitViewOptions={{ padding: 0.18, maxZoom: 1.15 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#c8d2cd" />
            <MiniMap pannable zoomable nodeColor={(node) => pathPageIds.has(node.id) ? '#087f5b' : '#9aaba2'} maskColor="rgb(239 243 241 / 74%)" />
            <Controls showInteractive={false} />
          </ReactFlow>
          {!visiblePages.length && <div className="kg-empty">当前筛选条件下没有页面</div>}
        </div>
      </section>

      <aside className="kg-detail-panel">
        <header><strong>{selectedEdge ? '关系详情' : selectedPage ? '页面详情' : '图谱概览'}</strong>{(selectedPage || selectedEdge) && <button type="button" className="icon-button" title="关闭详情" onClick={() => { setSelectedPageId(null); setSelectedEdgeId(null); }}><X size={14} /></button>}</header>
        {selectedPage ? <div className="kg-detail-body">
          <div className="kg-detail-heading"><span>{surfaceLabel(selectedPage.surfaceType)}</span><h2>{selectedPage.label}</h2><code>{selectedPage.key}</code></div>
          <p>{selectedPage.summary}</p>
          <dl className="kg-detail-facts"><div><dt>功能路径</dt><dd>{selectedPage.featurePath.join(' / ')}</dd></div><div><dt>页面元素</dt><dd>{selectedPage.elementCount} 私有 · {selectedPage.sharedElementCount} 共享</dd></div><div><dt>关系数量</dt><dd>{selectedPage.inboundCount} 入站 · {selectedPage.outboundCount} 出站</dd></div><div><dt>审核状态</dt><dd>{statusLabel(selectedPage.status)}</dd></div></dl>
          <section className="kg-detail-section"><h3>页面状态 <span>{selectedPage.states.length}</span></h3>{selectedPage.states.length ? <div className="kg-state-list">{selectedPage.states.map((state) => <div key={state.key}><strong>{state.key}</strong><span>{state.summary}</span></div>)}</div> : <div className="kg-detail-empty">未定义稳定页面状态</div>}</section>
          <section className="kg-detail-section"><h3>上下游关系 <span>{selectedRelations.length}</span></h3><div className="kg-relation-list">{selectedRelations.map((edge) => <RelationRow key={edge.id} edge={edge} pagesById={pagesById} onClick={() => { setSelectedEdgeId(edge.id); setSelectedPageId(null); }} />)}</div></section>
        </div> : selectedEdge ? <div className="kg-detail-body">
          <div className="kg-detail-heading"><span>{selectedEdge.kind === 'transition' ? 'Transition' : 'Authority Contract'}</span><h2>{selectedEdge.capability}</h2><code>{selectedEdge.key}</code></div>
          <div className="kg-edge-route"><button type="button" onClick={() => selectPage(selectedEdge.source)}>{pagesById.get(selectedEdge.source)?.label}</button><ArrowRight size={16} /><button type="button" onClick={() => selectPage(selectedEdge.target)}>{pagesById.get(selectedEdge.target)?.label}</button></div>
          <dl className="kg-detail-facts"><div><dt>触发控件</dt><dd>{selectedEdge.trigger?.label || '未解析'}</dd></div><div><dt>动作</dt><dd>{selectedEdge.action}</dd></div><div><dt>风险</dt><dd>{selectedEdge.risk}</dd></div><div><dt>可逆</dt><dd>{selectedEdge.reversible === null ? '由契约定义' : selectedEdge.reversible ? '是' : '否'}</dd></div><div><dt>关系状态</dt><dd>{statusLabel(selectedEdge.status)}</dd></div></dl>
        </div> : <div className="kg-overview-body">
          <Network size={28} />
          <strong>{graph.application?.label || graph.appKey}</strong>
          <p>选择任意页面或关系，查看它在 Canonical 图谱中的结构与上下游。</p>
          <dl><div><dt>Graph Revision</dt><dd>{graph.revision || '未发布'}</dd></div><div><dt>功能域</dt><dd>{graph.featureDomains.length}</dd></div><div><dt>页面</dt><dd>{graph.stats.pages}</dd></div><div><dt>可规划关系</dt><dd>{graph.edges.filter((edge) => edge.planningEligible).length}</dd></div></dl>
          <div className="kg-overview-tip"><Route size={15} /><span>切换到路径查询，选择两个页面即可计算导航路线。</span></div>
        </div>}
      </aside>
    </main>
  );
}
