import '@xyflow/react/dist/style.css';
import { ArrowRight, Braces, CircleAlert, LoaderCircle, LocateFixed, Network, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { absoluteAssetUrl, workbenchApi } from './api';
import { ForceKnowledgeGraph } from './ForceKnowledgeGraph';
import { buildKnowledgeGraphView, type KnowledgeGraphNodeType, type KnowledgeGraphViewEdge, type KnowledgeGraphViewNode } from './knowledge-graph-view';
import type { CanonicalGraph, CanonicalGraphElementPreview, CanonicalGraphPage, CanonicalGraphPreview } from './types';

interface KnowledgeGraphProps {
  appKey: string;
  onGoToWorkbench: () => void;
  onOpenModel: () => void;
}

const nodeTypeMeta: Record<KnowledgeGraphNodeType, { label: string; className: string }> = {
  nav: { label: '系统导航页', className: 'nav' },
  feature: { label: '功能', className: 'feature' },
  page: { label: '功能页面', className: 'page' },
  shared: { label: '共享组件', className: 'shared' },
  entry: { label: '功能入口集合', className: 'entry' },
};

function statusLabel(status: string) {
  if (status === 'complete') return '完整';
  if (status === 'incomplete') return '待补全';
  if (status.includes('success') || status.includes('verified')) return '已审核';
  if (status.includes('pending')) return '待确认';
  return status.replaceAll('_', ' ');
}

function PagePreview({ preview, page, contextLabel }: { preview: CanonicalGraphPreview | CanonicalGraphElementPreview | null; page: CanonicalGraphPage | null; contextLabel: string }) {
  if (!preview) return <section className="kg-preview"><div className="kg-preview-empty">该节点暂无可用页面证据</div></section>;
  const elementPreview = 'element' in preview ? preview : null;
  const rect = elementPreview?.element.rect;
  const overlayStyle = rect ? {
    left: `${(rect.left / preview.viewport.width) * 100}%`, top: `${(rect.top / preview.viewport.height) * 100}%`,
    width: `${(rect.width / preview.viewport.width) * 100}%`, height: `${(rect.height / preview.viewport.height) * 100}%`,
  } as CSSProperties : undefined;
  return <section className="kg-preview">
    <div className="kg-preview-heading"><div><span>{contextLabel}</span><strong>{page?.label || '页面证据'}</strong></div><code>{preview.frameRef}</code></div>
    <div className="kg-preview-stage" style={{ aspectRatio: `${preview.viewport.width} / ${preview.viewport.height}` }}>
      <img src={absoluteAssetUrl(preview.imageUrl)} alt={`${page?.label || '页面'}截图`} />
      {overlayStyle && <span className="kg-active-element-box" style={overlayStyle}><i /></span>}
    </div>
    {elementPreview && <div className="kg-active-element"><span>已激活元素</span><strong>{elementPreview.element.label}</strong><code>{elementPreview.element.key}</code></div>}
  </section>;
}

function ViewRelationRow({ edge, nodesById, active, onClick }: { edge: KnowledgeGraphViewEdge; nodesById: Map<string, KnowledgeGraphViewNode>; active: boolean; onClick: () => void }) {
  return <button type="button" className={`kg-relation-row ${active ? 'active' : ''}`} onClick={onClick}>
    <span className={`kg-relation-kind kg-relation-${edge.kind}`}>{edge.kind === 'placement' ? '可配置收纳' : edge.kind === 'navigation' ? '导航入口' : '页面关系'}</span>
    <strong>{edge.label}</strong>
    <span>{nodesById.get(edge.source)?.label || edge.source}<ArrowRight size={12} />{nodesById.get(edge.target)?.label || edge.target}</span>
  </button>;
}

export function KnowledgeGraph({ appKey, onGoToWorkbench, onOpenModel }: KnowledgeGraphProps) {
  const [graph, setGraph] = useState<CanonicalGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [fitGraph, setFitGraph] = useState<(() => void) | null>(null);
  const handleFitReady = useCallback((fit: (duration?: number) => void) => {
    setFitGraph(() => () => fit(300));
  }, []);

  const loadGraph = async () => {
    setLoading(true); setError(null);
    try {
      const next = await workbenchApi.knowledgeGraph(appKey || 'zto.connect');
      setGraph(next); setSelectedNodeId(null); setSelectedEdgeId(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally { setLoading(false); }
  };
  useEffect(() => { void loadGraph(); }, [appKey]);

  const view = useMemo(() => graph ? buildKnowledgeGraphView(graph) : { nodes: [], edges: [] }, [graph]);
  const nodesById = useMemo(() => new Map(view.nodes.map((node) => [node.id, node])), [view.nodes]);
  const pagesById = useMemo(() => new Map(graph?.pages.map((page) => [page.id, page]) || []), [graph]);
  const canonicalEdgesById = useMemo(() => new Map(graph?.edges.map((edge) => [edge.id, edge]) || []), [graph]);
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  const matchedNodeIds = useMemo(() => new Set(view.nodes.filter((node) => !normalizedQuery || [node.label, node.summary, ...node.featurePath]
    .some((value) => value.toLocaleLowerCase('zh-CN').includes(normalizedQuery))).map((node) => node.id)), [normalizedQuery, view.nodes]);

  const selectedNode = selectedNodeId ? nodesById.get(selectedNodeId) || null : null;
  const selectedViewEdge = selectedEdgeId ? view.edges.find((edge) => edge.id === selectedEdgeId) || null : null;
  const selectedCanonicalEdge = selectedViewEdge?.canonicalEdgeId ? canonicalEdgesById.get(selectedViewEdge.canonicalEdgeId) || null : null;
  const activeCanonicalEdge = selectedNode?.activeEdgeId ? canonicalEdgesById.get(selectedNode.activeEdgeId) || null : null;
  const selectedPage = selectedNode?.pageId ? pagesById.get(selectedNode.pageId) || null : null;
  const detailPreview = selectedCanonicalEdge?.preview || activeCanonicalEdge?.preview || selectedPage?.preview || null;
  const previewPageId = selectedCanonicalEdge?.preview?.pageId || activeCanonicalEdge?.preview?.pageId || selectedPage?.id || null;
  const previewPage = previewPageId ? pagesById.get(previewPageId) || null : null;
  const directRelations = selectedNode ? view.edges.filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id) : [];
  const activeNode = (hoveredNodeId && nodesById.get(hoveredNodeId)) || selectedNode;

  const clearSelection = () => { setSelectedNodeId(null); setSelectedEdgeId(null); };
  const selectNode = (nodeId: string) => { setSelectedNodeId(nodeId); setSelectedEdgeId(null); };
  const selectEdge = (edgeId: string) => { setSelectedEdgeId(edgeId); setSelectedNodeId(null); };

  if (loading) return <main className="kg-state"><LoaderCircle className="spin" size={22} /><strong>正在加载 Canonical 图谱</strong></main>;
  if (error || !graph) return <main className="kg-state kg-state-error"><CircleAlert size={22} /><strong>{error || '图谱加载失败'}</strong><button type="button" className="button" onClick={() => void loadGraph()}><RefreshCw size={15} />重新加载</button></main>;
  if (graph.pages.length === 0) return <main className="kg-state kg-state-empty">
    <Network size={34} />
    <strong>还没有知识图谱</strong>
    <p>前往工作台创建页面对象，上传页面图片或使用设备帧开始构建知识图谱。</p>
    <button type="button" className="button button-primary" onClick={onGoToWorkbench}>前往工作台<ArrowRight size={15} /></button>
  </main>;

  const detailOpen = Boolean(selectedNode || selectedViewEdge);

  return <main className={`kg-workspace ${detailOpen ? 'kg-workspace-detail-open' : ''}`}>
    <aside className="kg-filter-panel">
      <header><strong>图谱概览</strong><span>Canonical · {graph.revision || '未发布'}</span></header>
      <div className="kg-overview-summary">
        <img className="kg-brand-icon kg-brand-icon-overview" src="/graphrag-line-icon.svg?v=4" alt="" />
        <div className="kg-app-summary"><div><strong>{graph.application?.label || graph.appKey}</strong><span>{graph.appKey}</span></div><span className={`kg-graph-status kg-graph-status-${graph.status}`}><i />{statusLabel(graph.status)}</span></div>
        <p>以底部导航为第一层、功能为第二层、具体页面与共享组件为第三层。</p>
      </div>
      <div className="kg-stats"><span><strong>{view.nodes.length}</strong>节点</span><span><strong>{graph.stats.pages}</strong>页面</span><span><strong>{view.edges.length}</strong>关系</span></div>
      <label className="kg-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索节点、功能或页面" />{query && <button type="button" title="清空搜索" onClick={() => setQuery('')}><X size={13} /></button>}</label>
      <div className="kg-filter-note"><ShieldCheck size={14} /><span>总览只展示功能入口关系；页面内部状态变更、取消和返回关系不进入该层。</span></div>
      <div className="kg-filter-actions"><button type="button" className="button" onClick={onOpenModel}><Braces size={14} />打开图谱模型</button><span>维护对象、字段和关联规则</span></div>
    </aside>

    <section className="kg-canvas-panel kg-demo-canvas-panel">
      <div className="kg-toolbar"><div className="kg-canvas-title"><img className="kg-brand-icon kg-brand-icon-toolbar" src="/graphrag-line-icon.svg?v=4" alt="" /><strong>导航与功能关系图</strong></div><span className="kg-toolbar-hint">悬停节点查看一跳关系，拖动节点调整布局</span><button type="button" className="icon-button" title="适应画布" onClick={() => fitGraph?.()}><LocateFixed size={15} /></button></div>
      <div className="kg-graph-legend">{(Object.keys(nodeTypeMeta) as KnowledgeGraphNodeType[]).map((type) => <span key={type}><i className={`kg-legend-dot ${nodeTypeMeta[type].className}`} />{nodeTypeMeta[type].label}</span>)}<span><i className="kg-legend-line" />入口关系</span><span><i className="kg-legend-line placement" />可配置收纳</span></div>
      <div className="kg-flow-wrap">
        <ForceKnowledgeGraph graphNodes={view.nodes} graphEdges={view.edges} matchedNodeIds={matchedNodeIds} selectedNodeId={selectedNodeId} selectedEdgeId={selectedEdgeId} hoveredNodeId={hoveredNodeId} hoveredEdgeId={hoveredEdgeId} onNodeClick={selectNode} onEdgeClick={selectEdge} onNodeHover={setHoveredNodeId} onEdgeHover={setHoveredEdgeId} onPaneClick={clearSelection} onFitReady={handleFitReady} />
        <div className="kg-graph-selection-bar"><strong>{activeNode?.label || '全图'}</strong><span>{activeNode ? `${nodeTypeMeta[activeNode.type].label} · ${activeNode.layer}` : '悬停节点后显示其一跳关系'}</span><i /> <span>{activeNode?.summary || '点击节点可固定当前范围'}</span></div>
      </div>
    </section>

    {detailOpen && <aside className="kg-detail-panel"><header><strong>{selectedViewEdge ? '关系详情' : '节点详情'}</strong><button type="button" className="icon-button" title="关闭详情" onClick={clearSelection}><X size={14} /></button></header>
      {selectedNode ? <div className="kg-detail-body"><div className="kg-detail-heading"><span>{nodeTypeMeta[selectedNode.type].label}</span><h2>{selectedNode.label}</h2><code>{selectedPage?.key || selectedNode.id}</code></div><PagePreview preview={detailPreview} page={previewPage} contextLabel={activeCanonicalEdge ? '入口所在页面' : '节点对应页面'} /><p>{selectedNode.summary}</p><dl className="kg-detail-facts"><div><dt>架构层级</dt><dd>{selectedNode.layer}</dd></div><div><dt>功能路径</dt><dd>{selectedNode.featurePath.join(' / ')}</dd></div><div><dt>对应页面</dt><dd>{selectedPage?.label || '当前知识库尚未收录'}</dd></div><div><dt>直接关系</dt><dd>{directRelations.length} 条</dd></div></dl><section className="kg-detail-section"><h3>一跳关系 <span>{directRelations.length}</span></h3><div className="kg-relation-list">{directRelations.map((edge) => <ViewRelationRow key={edge.id} edge={edge} nodesById={nodesById} active={false} onClick={() => selectEdge(edge.id)} />)}</div></section></div>
        : <div className="kg-detail-body"><div className="kg-detail-heading"><span>{selectedViewEdge?.kind === 'placement' ? '可配置收纳' : selectedViewEdge?.kind === 'navigation' ? '导航入口' : '页面关系'}</span><h2>{selectedViewEdge?.label}</h2><code>{selectedCanonicalEdge?.key || selectedViewEdge?.id}</code></div><PagePreview preview={detailPreview} page={previewPage} contextLabel="触发元素所在页面" /><div className="kg-edge-route"><button type="button" onClick={() => selectedViewEdge && selectNode(selectedViewEdge.source)}>{selectedViewEdge && nodesById.get(selectedViewEdge.source)?.label}</button><ArrowRight size={16} /><button type="button" onClick={() => selectedViewEdge && selectNode(selectedViewEdge.target)}>{selectedViewEdge && nodesById.get(selectedViewEdge.target)?.label}</button></div><dl className="kg-detail-facts"><div><dt>关系类型</dt><dd>{selectedViewEdge?.kind}</dd></div><div><dt>触发控件</dt><dd>{selectedCanonicalEdge?.trigger?.label || '架构配置关系'}</dd></div><div><dt>动作</dt><dd>{selectedCanonicalEdge?.action || selectedViewEdge?.label.split('：')[0]}</dd></div><div><dt>证据状态</dt><dd>{selectedCanonicalEdge ? statusLabel(selectedCanonicalEdge.status) : '待实际数据补充'}</dd></div></dl></div>}
    </aside>}
  </main>;
}
