import { ArrowRight, CheckCircle2, CircleAlert, ExternalLink, Eye, GitBranch, ImageUp, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { absoluteAssetUrl } from './api';
import { capabilityGroups, pageWorkflowStatus, pageWorkflowStatusLabels, transitionEvidenceIssues } from './model';
import { PageUploadDialog } from './PageUploadDialog';
import type { Draft, DraftPage, DraftTransition } from './types';

interface PageGraphProps {
  draft: Draft;
  selectedTransitionId: string | null;
  draftDirty: boolean;
  onSelectTransition: (id: string | null) => void;
  onOpenPage: (pageId: string) => void;
  onUploadDraftChange: (draft: Draft) => void;
  onUpdatePage: (pageId: string, patch: Partial<DraftPage>, historyKey?: string) => void;
  onDeletePage: (pageId: string) => void;
  onAddTransition: () => void;
  onUpdateTransition: (transitionId: string, patch: Partial<DraftTransition>, historyKey?: string) => void;
  onDeleteTransition: (transitionId: string) => void;
  onChangeEnd: () => void;
}

const nodeWidth = 210;
const nodeHeight = 184;
const columnGap = 54;
const rowGap = 56;

function pagePosition(index: number, columns: number) {
  return {
    x: (index % columns) * (nodeWidth + columnGap) + 24,
    y: Math.floor(index / columns) * (nodeHeight + rowGap) + 24,
  };
}

function PageEditor({ page, status, onUpdate, onDelete, onChangeEnd }: { page: DraftPage; status: ReturnType<typeof pageWorkflowStatus>; onUpdate: (patch: Partial<DraftPage>, historyKey?: string) => void; onDelete: () => void; onChangeEnd: () => void }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <div className="graph-editor-form">
      <div className="graph-editor-title"><div><strong>Page 属性</strong><span className={`page-status page-status-${status}`}>{pageWorkflowStatusLabels[status]}</span><code>{page.key}</code></div><button type="button" className={`icon-button danger-button ${confirmingDelete ? 'active' : ''}`} title="删除 Page" aria-label="删除 Page" onClick={() => setConfirmingDelete((value) => !value)}><Trash2 size={15} /></button></div>
      {confirmingDelete && <div className="inline-delete-confirm" role="alert"><span>确定删除此 Page 及其私有元素和关联 Transition？</span><div><button type="button" className="button danger-button" onClick={() => { setConfirmingDelete(false); onDelete(); }}>确认删除</button><button type="button" className="button" onClick={() => setConfirmingDelete(false)}>取消</button></div></div>}
      <label className="field"><span>页面名称</span><input value={page.name} onBlur={onChangeEnd} onChange={(event) => onUpdate({ name: event.target.value }, 'page:name')} /></label>
      <label className="field"><span>稳定键</span><input value={page.key} onBlur={onChangeEnd} onChange={(event) => onUpdate({ key: event.target.value }, 'page:key')} /></label>
      <label className="field"><span>页面类型</span><select value={page.surfaceType} onChange={(event) => onUpdate({ surfaceType: event.target.value })}><option value="page">页面</option><option value="dialog">对话框</option><option value="drawer">抽屉</option><option value="bottom-sheet">底部弹层</option><option value="menu">菜单</option><option value="shared-component">共享组件</option><option value="unknown">待确认</option></select></label>
      <label className="field field-textarea"><span>页面说明</span><textarea value={page.stateSummary} onBlur={onChangeEnd} onChange={(event) => onUpdate({ stateSummary: event.target.value }, 'page:summary')} /></label>
      <label className="field"><span>功能路径</span><input value={page.featurePath.join(' / ')} onBlur={onChangeEnd} onChange={(event) => onUpdate({ featurePath: event.target.value.split('/').map((item) => item.trim()).filter(Boolean).slice(0, 3) }, 'page:path')} /></label>
      <div className="page-meta-grid"><span>画面证据<strong>{page.frameIds.length}</strong></span><span>直接元素<strong>{page.elementIds.length}</strong></span></div>
    </div>
  );
}

function TransitionEditor({ draft, transition, onUpdate, onDelete, onChangeEnd }: { draft: Draft; transition: DraftTransition; onUpdate: (patch: Partial<DraftTransition>, historyKey?: string) => void; onDelete: () => void; onChangeEnd: () => void }) {
  const sourceElements = draft.elements.filter((element) => (element.pageId === transition.sourcePageId || element.availableOnPageIds.includes(transition.sourcePageId)) && element.capabilities.some((capability) => capability !== 'none'));
  const issues = transitionEvidenceIssues(transition, draft);
  const updateEvidence = (patch: Partial<DraftTransition['evidence']>, historyKey?: string) => onUpdate({ evidence: { ...transition.evidence, ...patch } }, historyKey);
  const allFrames = [...new Set(draft.pages.flatMap((page) => page.frameIds))];
  return (
    <div className="graph-editor-form">
      <div className="graph-editor-title"><div><GitBranch size={15} /><strong>Transition</strong></div><button type="button" className="icon-button danger-button" title="删除 Transition" onClick={onDelete}><Trash2 size={15} /></button></div>
      <label className="field"><span>稳定键</span><input value={transition.key} onBlur={onChangeEnd} onChange={(event) => onUpdate({ key: event.target.value }, 'transition:key')} /></label>
      <label className="field"><span>来源 Page</span><select value={transition.sourcePageId} onChange={(event) => onUpdate({ sourcePageId: event.target.value })}>{draft.pages.map((page) => <option key={page.id} value={page.id}>{page.name}</option>)}</select></label>
      <label className="field"><span>触发元素</span><select value={transition.triggerElementId} onChange={(event) => { const element = draft.elements.find((item) => item.id === event.target.value); onUpdate({ triggerElementId: event.target.value, capability: element?.capabilities.find((capability) => capability !== 'none') || transition.capability }); }}><option value="">请选择</option>{sourceElements.map((element) => <option key={element.id} value={element.id}>{element.label}</option>)}</select></label>
      <label className="field"><span>动作</span><select value={transition.action} onChange={(event) => onUpdate({ action: event.target.value })}><option value="aiTap">点击</option><option value="aiInput">输入</option><option value="aiScroll">纵向滚动</option><option value="aiSwipe">横向滑动</option><option value="aiLongPress">长按</option><option value="aiDragAndDrop">拖动</option><option value="aiToggle">切换</option><option value="aiBack">返回</option></select></label>
      <label className="field"><span>元素动作</span><select value={transition.capability} onChange={(event) => onUpdate({ capability: event.target.value })}>{capabilityGroups.map((group) => <optgroup key={group.label} label={group.label}>{group.options.filter(([value]) => value !== 'none').map(([value, label]) => <option key={value} value={value}>{label}</option>)}</optgroup>)}</select></label>
      <label className="field"><span>目标 Page</span><select value={transition.targetPageId} onChange={(event) => onUpdate({ targetPageId: event.target.value })}>{draft.pages.map((page) => <option key={page.id} value={page.id}>{page.name}</option>)}</select></label>
      <div className="inline-fields"><label><span>可逆</span><input type="checkbox" checked={transition.reversible} onChange={(event) => onUpdate({ reversible: event.target.checked })} /></label><label><span>风险</span><select value={transition.risk} onChange={(event) => onUpdate({ risk: event.target.value as DraftTransition['risk'] })}><option value="safe">安全</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="critical">严重</option></select></label></div>

      <fieldset className="field-group evidence-fields">
        <legend>完整动作证据</legend>
        <label><span>操作前画面</span><select value={transition.evidence.beforeFrameId} onChange={(event) => updateEvidence({ beforeFrameId: event.target.value, locatorFrameId: event.target.value })}><option value="">请选择</option>{allFrames.map((frameId) => <option key={frameId} value={frameId}>{frameId.slice(0, 24)}...</option>)}</select></label>
        <label><span>定位器画面</span><select value={transition.evidence.locatorFrameId} onChange={(event) => updateEvidence({ locatorFrameId: event.target.value })}><option value="">请选择</option>{allFrames.map((frameId) => <option key={frameId} value={frameId}>{frameId.slice(0, 24)}...</option>)}</select></label>
        <label><span>动作轨迹</span><input value={transition.evidence.actionTraceRef} placeholder="trace ID 或证据路径" onBlur={onChangeEnd} onChange={(event) => updateEvidence({ actionTraceRef: event.target.value }, 'transition:trace')} /></label>
        <label><span>操作后画面</span><select value={transition.evidence.afterFrameId} onChange={(event) => updateEvidence({ afterFrameId: event.target.value })}><option value="">请选择</option>{allFrames.map((frameId) => <option key={frameId} value={frameId}>{frameId.slice(0, 24)}...</option>)}</select></label>
        <label><span>后置条件</span><select value={transition.evidence.postcondition} onChange={(event) => updateEvidence({ postcondition: event.target.value as DraftTransition['evidence']['postcondition'] })}><option value="pending">待验证</option><option value="pass">通过</option><option value="failed">失败</option></select></label>
        <label className="evidence-assertions"><span>语义断言</span><textarea value={transition.evidence.semanticAssertions.join('\n')} placeholder="每行一条可验证断言" onBlur={onChangeEnd} onChange={(event) => updateEvidence({ semanticAssertions: event.target.value.split('\n') }, 'transition:assertions')} /></label>
      </fieldset>
      <div className={`evidence-check ${issues.length ? 'evidence-incomplete' : 'evidence-complete'}`}>{issues.length ? <CircleAlert size={16} /> : <CheckCircle2 size={16} />}<span>{issues.length ? issues.join('；') : '动作证据完整，可进入 staging 校验'}</span></div>
    </div>
  );
}

export function PageGraph({ draft, draftDirty, selectedTransitionId, onSelectTransition, onOpenPage, onUploadDraftChange, onUpdatePage, onDeletePage, onAddTransition, onUpdateTransition, onDeleteTransition, onChangeEnd }: PageGraphProps) {
  const [previewPage, setPreviewPage] = useState<DraftPage | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedPageId, setSelectedPageId] = useState(draft.currentPageId);
  const columns = Math.min(3, Math.max(1, draft.pages.length));
  const rows = Math.max(1, Math.ceil(draft.pages.length / columns));
  const width = columns * nodeWidth + (columns - 1) * columnGap + 48;
  const height = rows * nodeHeight + (rows - 1) * rowGap + 48;
  const pageIndex = new Map(draft.pages.map((page, index) => [page.id, index]));
  const selectedTransition = draft.transitions.find((transition) => transition.id === selectedTransitionId) || null;
  const currentPage = draft.pages.find((page) => page.id === selectedPageId) || draft.pages[0];
  const previewFrameId = previewPage?.frameIds.at(-1);

  useEffect(() => {
    if (!previewPage) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewPage(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [previewPage]);

  useEffect(() => {
    if (draft.pages.some((page) => page.id === selectedPageId)) return;
    setSelectedPageId(draft.pages.find((page) => page.id === draft.currentPageId)?.id || draft.pages[0]?.id || '');
  }, [draft.currentPageId, draft.pages, selectedPageId]);

  const selectPage = (pageId: string) => {
    setSelectedPageId(pageId);
    onSelectTransition(null);
  };

  return (
    <main className="graph-workspace">
      <section className="graph-main">
        <div className="graph-toolbar"><div><GitBranch size={16} /><strong>Page / Transition 图</strong><span>{draft.pages.length} 个 Page · {draft.transitions.length} 条边</span></div><div><button type="button" className="button" onClick={() => setUploadOpen(true)}><ImageUp size={15} />新增 Page</button><button type="button" className="button button-primary" disabled={draft.pages.length < 2 || draft.elements.length === 0} onClick={onAddTransition}><Plus size={15} />新增 Transition</button></div></div>
        <div className="graph-board-scroll">
          <div className="graph-board" style={{ width, height }}>
            <svg className="graph-edges" width={width} height={height} aria-label="页面跳转关系">
              <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
              {draft.transitions.map((transition) => {
                const sourceIndex = pageIndex.get(transition.sourcePageId);
                const targetIndex = pageIndex.get(transition.targetPageId);
                if (sourceIndex === undefined || targetIndex === undefined) return null;
                const source = pagePosition(sourceIndex, columns);
                const target = pagePosition(targetIndex, columns);
                const x1 = source.x + nodeWidth / 2;
                const y1 = source.y + nodeHeight / 2;
                const x2 = target.x + nodeWidth / 2;
                const y2 = target.y + nodeHeight / 2;
                const curve = Math.max(38, Math.abs(x2 - x1) * 0.35);
                return <path key={transition.id} className={selectedTransitionId === transition.id ? 'selected' : ''} d={`M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`} markerEnd="url(#arrow)" />;
              })}
            </svg>
            {draft.pages.map((page, index) => {
              const position = pagePosition(index, columns);
              const status = pageWorkflowStatus(draft, page);
              const latestFrameId = page.frameIds.at(-1);
              return <div key={page.id} className={`page-node ${page.id === selectedPageId ? 'active' : ''}`} style={{ left: position.x, top: position.y }}>
                <button type="button" className="page-node-select-target" aria-label={`选择 Page：${page.name}`} onClick={() => selectPage(page.id)} />
                <span className={`page-status page-status-${status}`}>{pageWorkflowStatusLabels[status]}</span>
                <span className="page-node-preview">{latestFrameId ? <img src={absoluteAssetUrl(`/workbench/api/frames/${encodeURIComponent(latestFrameId)}/image`)} alt={`${page.name || '待识别页面'}截图`} loading="lazy" /> : <span>暂无截图</span>}</span>
                <button type="button" className="page-node-action page-node-preview-action" disabled={!latestFrameId} title={latestFrameId ? '预览大图' : '暂无截图'} aria-label={`预览 ${page.name} 大图`} onClick={(event) => { event.stopPropagation(); setPreviewPage(page); }}><Eye size={15} /></button>
                <span className="page-node-content"><strong>{page.name}</strong><span className="page-node-meta">{page.surfaceType} · {page.frameIds.length} 帧 · {page.elementIds.length} 个标注</span><code>{page.key}</code></span>
                <button type="button" className="page-node-action page-node-open-action" disabled={!latestFrameId} title={latestFrameId ? '进入标注页面' : '暂无截图，无法标注'} aria-label={`进入 ${page.name} 标注页面`} onClick={(event) => { event.stopPropagation(); onOpenPage(page.id); }}><ExternalLink size={15} /></button>
              </div>;
            })}
          </div>
        </div>
        <div className="transition-list">
          {draft.transitions.length === 0 ? <div className="empty-state">尚未建立页面跳转关系</div> : draft.transitions.map((transition) => {
            const source = draft.pages.find((page) => page.id === transition.sourcePageId);
            const target = draft.pages.find((page) => page.id === transition.targetPageId);
            const complete = transitionEvidenceIssues(transition, draft).length === 0;
            return <button key={transition.id} type="button" className={selectedTransitionId === transition.id ? 'active' : ''} onClick={() => onSelectTransition(transition.id)}><span>{source?.name || '缺失'}</span><ArrowRight size={14} /><strong>{target?.name || '缺失'}</strong><i className={complete ? 'complete' : ''}>{complete ? '证据完整' : '待补证据'}</i></button>;
          })}
        </div>
      </section>
      <aside className="graph-editor">
        {selectedTransition ? <TransitionEditor draft={draft} transition={selectedTransition} onUpdate={(patch, key) => onUpdateTransition(selectedTransition.id, patch, key)} onDelete={() => onDeleteTransition(selectedTransition.id)} onChangeEnd={onChangeEnd} /> : currentPage ? <PageEditor page={currentPage} status={pageWorkflowStatus(draft, currentPage)} onUpdate={(patch, key) => onUpdatePage(currentPage.id, patch, key)} onDelete={() => onDeletePage(currentPage.id)} onChangeEnd={onChangeEnd} /> : <div className="empty-state">先新增一个 Page</div>}
      </aside>
      {previewPage && previewFrameId && <div className="page-preview-backdrop" role="presentation" onMouseDown={() => setPreviewPage(null)}>
        <section className="page-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="page-preview-title" onMouseDown={(event) => event.stopPropagation()}>
          <header><div><strong id="page-preview-title">{previewPage.name}</strong><span>{previewPage.frameIds.length} 帧 · 当前展示最新截图</span></div><button type="button" className="icon-button" title="关闭预览" aria-label="关闭预览" onClick={() => setPreviewPage(null)}><X size={17} /></button></header>
          <div className="page-preview-image"><img src={absoluteAssetUrl(`/workbench/api/frames/${encodeURIComponent(previewFrameId)}/image`)} alt={`${previewPage.name}大图预览`} /></div>
        </section>
      </div>}
      <PageUploadDialog open={uploadOpen} draftDirty={draftDirty} onClose={() => setUploadOpen(false)} onDraftChange={onUploadDraftChange} />
    </main>
  );
}
