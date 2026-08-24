import { ChevronLeft, ChevronRight, CircleDot, Globe2, Pencil, Play, Plus, Repeat2, Save, Search, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { capabilityLabel, elementAvailableOnPage } from './model';
import type { DraftElement, DraftPage, DraftRelationInterface, DraftTransition } from './types';

interface RelationWorkspaceProps {
  sourceElement: DraftElement;
  sourcePage: DraftPage;
  sourceFrameId: string | null;
  sourceFrameUrl: string | null;
  pages: DraftPage[];
  elements: DraftElement[];
  transitions: DraftTransition[];
  frameUrlFor: (frameId: string) => string;
  onSaveRelation: (relation: { targetPageId: string; targetFrameId: string | null; action: string; effect: string; interfaces: DraftRelationInterface[] }) => void;
  onDeleteRelation: (transitionId: string) => void;
  onClose: () => void;
}

type PageNodeProps = {
  page: DraftPage;
  elements: DraftElement[];
  expanded: boolean;
  selectedElementId?: string;
  target?: boolean;
  onToggle: () => void;
};

const emptyInterface = (): Omit<DraftRelationInterface, 'id'> => ({ method: '', path: '', service: '', description: '' });

function ObservationFrame({ imageUrl, element, label }: { imageUrl: string | null; element?: DraftElement; label: string }) {
  return <div className="relation-observation-frame">
    {imageUrl ? <img src={imageUrl} alt={`${label}观测帧`} /> : <div className="relation-observation-empty">暂无观测帧</div>}
    {element && <span className="relation-observation-bbox" style={{ left: `${element.bbox.x * 100}%`, top: `${element.bbox.y * 100}%`, width: `${element.bbox.width * 100}%`, height: `${element.bbox.height * 100}%` }}><span>{element.label}</span></span>}
  </div>;
}

function PageNode({ page, elements, expanded, selectedElementId, onToggle, target }: PageNodeProps) {
  const actionElements = elements.filter((element) => element.actionEffects.some((item) => item.action !== 'none' && item.effect.trim()));
  const columns = actionElements.length > 7 ? 2 : 1;
  const rows = Math.max(1, Math.ceil(actionElements.length / columns));
  const rowHeight = Math.min(31, 164 / rows);

  return <g className={`relation-page-node ${target ? 'target' : 'source'} ${expanded ? 'expanded' : 'collapsed'}`}>
    <rect className="relation-page-shell" width="250" height="246" rx="7" />
    <text className="relation-page-title" x="16" y="25">{page.name || '未命名页面'}</text>
    <text className="relation-page-meta" x="16" y="43">页面 · {actionElements.length} 个动作效果元素</text>
    <g className="relation-page-toggle" role="button" tabIndex={0} aria-expanded={expanded} onClick={onToggle} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onToggle(); }} transform="translate(226 25)">
      <circle r="10" /><text y="4">{expanded ? '−' : '+'}</text>
    </g>
    {expanded && <g className="relation-element-layer">
      {actionElements.map((element, index) => {
        const column = Math.floor(index / rows);
        const row = index % rows;
        const x = 27 + column * 120;
        const y = 72 + row * rowHeight;
        return <g key={element.id} className="relation-growing-node"><title>{element.label}</title><circle className={`relation-node-dot ${element.id === selectedElementId ? 'source-dot' : ''}`} cx={x} cy={y} r={element.id === selectedElementId ? 9 : 7} /><text className="relation-node-label" x={x + 14} y={y + 4}>{element.label.length > 11 ? `${element.label.slice(0, 10)}…` : element.label}</text></g>;
      })}
      {actionElements.length === 0 && <text className="relation-page-empty" x="125" y="135">暂无动作效果元素</text>}
    </g>}
  </g>;
}

function transitionDescription(transition: DraftTransition, pages: DraftPage[], elements: DraftElement[]) {
  const source = pages.find((page) => page.id === transition.sourcePageId);
  const target = pages.find((page) => page.id === transition.targetPageId);
  const trigger = elements.find((element) => element.id === transition.triggerElementId);
  const effect = transition.evidence.semanticAssertions.find((item) => item.trim()) || '未记录关系语义';
  const interfaceText = transition.triggeredInterfaces?.map((item) => `${item.method} ${item.path}`).join('、');
  return {
    title: `${source?.name || transition.sourcePageId} · ${trigger?.label || transition.triggerElementId} → ${target?.name || transition.targetPageId}`,
    detail: `${capabilityLabel(transition.capability || transition.action)} · ${effect}${interfaceText ? ` · ${interfaceText}` : ''}`,
  };
}

export function RelationWorkspace({ sourceElement, sourcePage, sourceFrameId, sourceFrameUrl, pages, elements, transitions, frameUrlFor, onSaveRelation, onDeleteRelation, onClose }: RelationWorkspaceProps) {
  const availableActions = useMemo(() => [...new Set(sourceElement.capabilities.filter((item) => item !== 'none'))], [sourceElement.capabilities]);
  const [targetPageId, setTargetPageId] = useState<string | null>(null);
  const [targetDrawerOpen, setTargetDrawerOpen] = useState(false);
  const [targetQuery, setTargetQuery] = useState('');
  const [targetFilter, setTargetFilter] = useState('');
  const [expanded, setExpanded] = useState({ source: true, target: true });
  const [action, setAction] = useState<string | null>(availableActions[0] || null);
  const [interfaces, setInterfaces] = useState<DraftRelationInterface[]>([]);
  const [interfaceEditorOpen, setInterfaceEditorOpen] = useState(false);
  const [interfaceDraft, setInterfaceDraft] = useState(emptyInterface);
  const [editingInterfaceId, setEditingInterfaceId] = useState<string | null>(null);
  const [activeInterfaceId, setActiveInterfaceId] = useState<string | null>(null);
  const [looping, setLooping] = useState(false);
  const [animationRun, setAnimationRun] = useState(0);
  const [deletingTransitionId, setDeletingTransitionId] = useState<string | null>(null);

  const selectedActionEffect = sourceElement.actionEffects.find((item) => item.action === action);
  const effect = selectedActionEffect?.effect.trim() || '';
  const targetPage = targetPageId ? pages.find((page) => page.id === targetPageId) || null : null;
  const sourceElements = elements.filter((element) => elementAvailableOnPage(element, sourcePage.id, elements));
  const targetElements = targetPage ? elements.filter((element) => elementAvailableOnPage(element, targetPage.id, elements)) : [];
  const targetFrameId = targetPage?.frameIds.at(-1) || null;
  const targetFrameUrl = targetFrameId ? frameUrlFor(targetFrameId) : null;
  const activeInterface = interfaces.find((item) => item.id === activeInterfaceId) || null;
  const featureFilters = useMemo(() => [...new Set(pages.flatMap((page) => page.featurePath).filter((item) => item.trim()))], [pages]);
  const relevantTransitions = useMemo(() => {
    const connectedPageIds = new Set([sourcePage.id, ...(targetPageId ? [targetPageId] : [])]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const transition of transitions) {
        if (!connectedPageIds.has(transition.sourcePageId) && !connectedPageIds.has(transition.targetPageId)) continue;
        const previousSize = connectedPageIds.size;
        connectedPageIds.add(transition.sourcePageId);
        connectedPageIds.add(transition.targetPageId);
        if (connectedPageIds.size !== previousSize) grew = true;
      }
    }
    return transitions.filter((transition) => connectedPageIds.has(transition.sourcePageId) && connectedPageIds.has(transition.targetPageId));
  }, [sourcePage.id, targetPageId, transitions]);
  const duplicateExists = Boolean(targetPage && action && transitions.some((transition) => transition.sourcePageId === sourcePage.id
    && transition.targetPageId === targetPage.id
    && transition.triggerElementId === sourceElement.id
    && (transition.capability === action || transition.action === action)
    && transition.evidence.semanticAssertions.includes(effect)));
  const canSave = Boolean(targetPage && action && effect && !duplicateExists);
  const filteredTargets = pages.filter((page) => {
    const text = `${page.name} ${page.key} ${page.featurePath.join(' ')}`.toLocaleLowerCase('zh-CN');
    const queryMatch = !targetQuery.trim() || text.includes(targetQuery.trim().toLocaleLowerCase('zh-CN'));
    return queryMatch && (!targetFilter || page.featurePath.includes(targetFilter));
  });

  useEffect(() => { setAnimationRun((value) => value + 1); }, [targetPageId, action, expanded.source, expanded.target]);
  useEffect(() => {
    if (!looping) return undefined;
    const timer = window.setInterval(() => setAnimationRun((value) => value + 1), 2200);
    return () => window.clearInterval(timer);
  }, [looping]);
  useEffect(() => {
    if (!deletingTransitionId) return undefined;
    const timer = window.setTimeout(() => { onDeleteRelation(deletingTransitionId); setDeletingTransitionId(null); }, 2000);
    return () => window.clearTimeout(timer);
  }, [deletingTransitionId, onDeleteRelation]);

  const openInterfaceEditor = (item?: DraftRelationInterface) => {
    setEditingInterfaceId(item?.id || null);
    setInterfaceDraft(item ? { method: item.method, path: item.path, service: item.service, description: item.description } : emptyInterface());
    setInterfaceEditorOpen(true);
  };
  const commitInterface = () => {
    const method = interfaceDraft.method.trim().toUpperCase();
    const path = interfaceDraft.path.trim();
    if (!method || !path) return;
    if (editingInterfaceId) setInterfaces((current) => current.map((item) => item.id === editingInterfaceId ? { ...item, ...interfaceDraft, method, path } : item));
    else setInterfaces((current) => [...current, { id: `relation-interface-${crypto.randomUUID()}`, ...interfaceDraft, method, path }]);
    setInterfaceEditorOpen(false);
  };

  const sourceGraphElements = sourceElements.filter((element) => element.actionEffects.some((item) => item.action !== 'none' && item.effect.trim()));
  const sourceColumns = sourceGraphElements.length > 7 ? 2 : 1;
  const sourceRows = Math.max(1, Math.ceil(sourceGraphElements.length / sourceColumns));
  const sourceIndex = Math.max(0, sourceGraphElements.findIndex((element) => element.id === sourceElement.id));
  const sourcePoint = expanded.source ? {
    x: 42 + 27 + Math.floor(sourceIndex / sourceRows) * 120,
    y: 122 + 72 + (sourceIndex % sourceRows) * Math.min(31, 164 / sourceRows),
  } : { x: 292, y: 227 };
  const targetPoint = { x: 628, y: 227 };
  const interfaceSummary = interfaces.length > 0 ? interfaces.map((item) => `${item.method} ${item.path}`).join('、') : '未添加触发接口';

  return <main className="relation-workspace-page">
    <header className="relation-workspace-header"><button type="button" className="button" onClick={onClose}><ChevronLeft size={15} />返回页面标注</button><div><strong>关系工作区</strong><span>由当前标注元素的真实动作效果创建关系</span></div><span className="relation-header-spacer" /><span className="relation-preview-note">关系先写入当前页面草稿</span></header>

    <section className="relation-context-strip">
      <div className="relation-context-block"><span>源对象 · 当前观测帧</span><div className="relation-context-object"><span className="relation-kind element">元素</span><strong>{sourceElement.label}</strong></div><div className="relation-context-frame"><ObservationFrame imageUrl={sourceFrameUrl} element={sourceElement} label={`${sourcePage.name} ${sourceFrameId || ''}`} /><div><strong>{sourcePage.name}</strong><span>{sourceFrameId || '暂无帧标识'} · bbox 已框选</span></div></div></div>
      <ChevronRight className="relation-context-arrow" size={20} />
      <div className="relation-context-block"><span>目标对象 · 页面观测帧</span><button type="button" className={`relation-context-object relation-target-button ${targetPage ? '' : 'empty'}`} onClick={() => setTargetDrawerOpen(true)}><span className="relation-kind page">页面</span><strong>{targetPage?.name || '选择目标页面'}</strong><ChevronRight size={15} /></button>{targetPage ? <div className="relation-context-frame"><ObservationFrame imageUrl={targetFrameUrl} label={targetPage.name} /><div><strong>{targetPage.name}</strong><span>{targetFrameId || '暂无观测帧'} · {targetElements.length} 个元素</span></div></div> : <button type="button" className="relation-target-empty-frame" onClick={() => setTargetDrawerOpen(true)}>选择页面后展示其最新观测帧</button>}</div>
      <div className={`relation-effect-field ${effect ? '' : 'invalid'}`}><span>关系语义 · 来自动作效果</span><strong>{effect || (action ? '当前动作尚未填写动作效果' : '当前元素没有可执行动作')}</strong></div>
    </section>

    <section className="relation-workspace-body">
      <aside className="relation-config-panel">
        <header><strong>关系配置</strong><span>源元素真实数据</span></header>
        <section><h3>选择动作</h3><div className="relation-action-list">{availableActions.map((capability) => <button key={capability} type="button" aria-pressed={action === capability} onClick={() => setAction(capability)}>{capabilityLabel(capability)}</button>)}</div>{availableActions.length === 0 && <div className="relation-inline-empty">当前元素未配置可执行动作，请返回元素属性补充。</div>}{action && <div className="relation-selected-action"><span>动作效果</span><strong>{effect || '未填写'}</strong></div>}</section>
        <section><h3>动作触发接口</h3>{interfaces.length === 0 ? <div className="relation-inline-empty">尚未添加接口。接口仅在填写并确认后进入本条关系。</div> : interfaces.map((item) => <div className="relation-interface-item" key={item.id}><span className="relation-interface-dot" /><div><strong>{item.method} {item.path}</strong><span>{item.service || '未填写服务'}{item.description ? ` · ${item.description}` : ''}</span></div><span className="relation-interface-actions"><button type="button" aria-label={`编辑接口 ${item.method} ${item.path}`} onClick={() => openInterfaceEditor(item)}><Pencil size={13} /></button><button type="button" aria-label={`移除接口 ${item.method} ${item.path}`} onClick={() => { setInterfaces((current) => current.filter((candidate) => candidate.id !== item.id)); if (activeInterfaceId === item.id) setActiveInterfaceId(null); }}><Trash2 size={13} /></button></span></div>)}<button type="button" className="button" onClick={() => openInterfaceEditor()}><Plus size={14} />添加接口</button></section>
        <section><h3>关系摘要</h3><dl className="relation-facts"><div><dt>源元素</dt><dd>{sourceElement.label}</dd></div><div><dt>目标页面</dt><dd>{targetPage?.name || '未选择'}</dd></div><div><dt>动作</dt><dd>{action ? capabilityLabel(action) : '未配置'}</dd></div><div><dt>语义</dt><dd>{effect || '未配置'}</dd></div><div><dt>接口</dt><dd>{interfaceSummary}</dd></div></dl></section>
      </aside>

      <section className="relation-graph-panel">
        <header><div><strong>关系图谱预览</strong><span>页面包裹动作效果元素，展开时从元素节点引出关系</span></div><div className="relation-graph-actions"><button type="button" className={`button ${looping ? 'button-primary' : ''}`} aria-pressed={looping} onClick={() => setLooping((value) => !value)}><Repeat2 size={15} />{looping ? '停止循环' : '循环播放'}</button><button type="button" className="icon-button" title="播放一次生长动画" aria-label="播放一次生长动画" onClick={() => setAnimationRun((value) => value + 1)}><Play size={15} /></button></div></header>
        <div className="relation-graph-canvas">
          <svg key={animationRun} className="relation-graph-svg relation-graph-growing" viewBox="0 0 920 470" role="img" aria-label="关系图谱预览">
            {targetPage && <><path className="relation-edge relation-edge-element" d={`M${sourcePoint.x} ${sourcePoint.y} C370 112 548 112 ${targetPoint.x} ${targetPoint.y}`} /><g className="relation-edge-label" transform="translate(460 108)"><rect x="-174" y="-29" width="348" height="58" rx="5" /><text y="-8">{sourceElement.label} · {action ? capabilityLabel(action) : '未配置动作'} · {effect || '未配置语义'}</text><text y="12">触发接口：{interfaceSummary}</text></g></>}
            <g transform="translate(42 122)"><PageNode page={sourcePage} elements={sourceElements} expanded={expanded.source} selectedElementId={sourceElement.id} onToggle={() => setExpanded((value) => ({ ...value, source: !value.source }))} /></g>
            {targetPage ? <g transform="translate(628 122)"><PageNode page={targetPage} elements={targetElements} expanded={expanded.target} target onToggle={() => setExpanded((value) => ({ ...value, target: !value.target }))} /></g> : <g className="relation-target-placeholder" role="button" tabIndex={0} onClick={() => setTargetDrawerOpen(true)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setTargetDrawerOpen(true); }} transform="translate(628 122)"><rect width="250" height="246" rx="7" /><circle cx="125" cy="105" r="24" /><text x="125" y="110">+</text><text className="placeholder-title" x="125" y="150">选择目标页面</text></g>}
            {interfaces.map((item, index) => <g key={item.id} className="relation-interface-node relation-growing-interface" role="button" tabIndex={0} aria-label={`查看接口 ${item.method} ${item.path}`} onClick={() => setActiveInterfaceId((current) => current === item.id ? null : item.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setActiveInterfaceId((current) => current === item.id ? null : item.id); }} transform={`translate(${410 + index * 54} 330)`}><circle r="22" /><text y="-2">接口</text><text y="11">{item.method}</text></g>)}
            <g className="relation-collapse-all" role="button" tabIndex={0} aria-label="展开或折叠页面节点" onClick={() => setExpanded((value) => ({ source: !value.source, target: !value.target }))} transform="translate(460 430)"><rect x="-43" y="-14" width="86" height="28" rx="4" /><text y="4">{expanded.source && expanded.target ? '折叠页面' : '展开页面'}</text></g>
          </svg>
          <aside className={`relation-interface-popover ${activeInterface ? 'open' : ''}`} aria-hidden={!activeInterface}><header><div><strong>接口信息</strong><span>当前关系中显式添加的接口</span></div><button type="button" aria-label="关闭接口信息" onClick={() => setActiveInterfaceId(null)}><X size={15} /></button></header>{activeInterface && <div className="relation-interface-body"><div className="relation-interface-title"><CircleDot size={17} /><strong>{activeInterface.method} {activeInterface.path}</strong></div><dl className="relation-facts"><div><dt>服务</dt><dd>{activeInterface.service || '未填写'}</dd></div><div><dt>说明</dt><dd>{activeInterface.description || '未填写'}</dd></div><div><dt>触发动作</dt><dd>{action ? capabilityLabel(action) : '未配置'}</dd></div><div><dt>关系语义</dt><dd>{effect || '未配置'}</dd></div></dl></div>}</aside>
        </div>
        <section className="relation-list"><header><strong>关系列表</strong><span>仅展示当前草稿中的真实关系 · {relevantTransitions.length} 条</span></header>{relevantTransitions.length > 0 ? relevantTransitions.map((transition) => { const description = transitionDescription(transition, pages, elements); return <div key={transition.id} className={`relation-list-row ${deletingTransitionId === transition.id ? 'deleting' : ''}`}><span className="relation-list-dot" /><div><strong>{description.title}</strong><span>{description.detail}</span></div><button type="button" className="icon-button" aria-label={`删除关系 ${description.title}`} disabled={Boolean(deletingTransitionId)} onClick={() => setDeletingTransitionId(transition.id)}><Trash2 size={14} /></button></div>; }) : <div className="relation-list-empty">暂无已有关联关系</div>}</section>
        <footer className="relation-workspace-footer"><span>{duplicateExists ? '当前关系已存在于草稿中' : canSave ? '关系配置完整，可添加到当前草稿' : '请选择目标页面，并确保动作效果已填写'}</span><span className="relation-header-spacer" /><button type="button" className="button" onClick={onClose}>取消</button><button type="button" className="button button-primary" disabled={!canSave} onClick={() => { if (targetPage && action && effect) onSaveRelation({ targetPageId: targetPage.id, targetFrameId, action, effect, interfaces }); }}><Save size={15} />添加到草稿</button></footer>
      </section>
    </section>

    {targetDrawerOpen && <div className="relation-target-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setTargetDrawerOpen(false); }}><aside className="relation-target-drawer" role="dialog" aria-modal="true" aria-labelledby="relation-target-drawer-title"><header><div><strong id="relation-target-drawer-title">选择目标页面</strong><span>来自当前草稿的全部页面对象</span></div><button type="button" aria-label="关闭目标页面选择" onClick={() => setTargetDrawerOpen(false)}><X size={16} /></button></header><div className="relation-target-filters"><label><Search size={14} /><input autoFocus value={targetQuery} onChange={(event) => setTargetQuery(event.target.value)} placeholder="搜索页面名称、键或功能路径" /></label><select aria-label="按功能路径筛选" value={targetFilter} onChange={(event) => setTargetFilter(event.target.value)}><option value="">全部功能路径</option>{featureFilters.map((item) => <option key={item} value={item}>{item}</option>)}</select></div><div className="relation-target-list">{filteredTargets.length > 0 ? filteredTargets.map((page) => <button key={page.id} type="button" aria-selected={page.id === targetPage?.id} onClick={() => { setTargetPageId(page.id); setTargetDrawerOpen(false); }}><span className="relation-target-icon"><Globe2 size={15} /></span><span><strong>{page.name || '未命名页面'}</strong><small>{page.key} · {page.frameIds.length} 个观测帧</small></span><span className="relation-target-status">{page.id === targetPage?.id ? '已选' : '选择'}</span></button>) : <div className="relation-target-empty">没有匹配的真实页面对象</div>}</div><footer><button type="button" className="button" onClick={() => setTargetDrawerOpen(false)}>取消</button></footer></aside></div>}

    {interfaceEditorOpen && <div className="relation-target-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setInterfaceEditorOpen(false); }}><aside className="relation-interface-editor" role="dialog" aria-modal="true" aria-labelledby="relation-interface-editor-title"><header><div><strong id="relation-interface-editor-title">{editingInterfaceId ? '编辑触发接口' : '添加触发接口'}</strong><span>接口内容由你显式填写，不自动生成</span></div><button type="button" aria-label="关闭接口编辑" onClick={() => setInterfaceEditorOpen(false)}><X size={16} /></button></header><div className="relation-interface-form"><label><span>请求方法</span><select value={interfaceDraft.method} onChange={(event) => setInterfaceDraft((current) => ({ ...current, method: event.target.value }))}><option value="">请选择</option>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => <option key={method}>{method}</option>)}</select></label><label><span>接口路径</span><input value={interfaceDraft.path} onChange={(event) => setInterfaceDraft((current) => ({ ...current, path: event.target.value }))} placeholder="/path" /></label><label><span>服务名称（可选）</span><input value={interfaceDraft.service} onChange={(event) => setInterfaceDraft((current) => ({ ...current, service: event.target.value }))} placeholder="输入服务名称" /></label><label><span>接口说明（可选）</span><textarea value={interfaceDraft.description} onChange={(event) => setInterfaceDraft((current) => ({ ...current, description: event.target.value }))} placeholder="输入与当前动作有关的接口说明" /></label></div><footer><button type="button" className="button" onClick={() => setInterfaceEditorOpen(false)}>取消</button><button type="button" className="button button-primary" disabled={!interfaceDraft.method.trim() || !interfaceDraft.path.trim()} onClick={commitInterface}>确认添加</button></footer></aside></div>}
  </main>;
}
