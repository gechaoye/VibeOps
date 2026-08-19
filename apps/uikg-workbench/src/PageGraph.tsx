import { Check, ImageUp, PanelsTopLeft, PanelTopOpen, Plus, Smartphone, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { absoluteAssetUrl } from './api';
import { elementAvailableOnPage, pageWorkflowStatus, pageWorkflowStatusLabels } from './model';
import { PageUploadDialog } from './PageUploadDialog';
import type { Draft, DraftPage } from './types';

interface PageGraphProps {
  draft: Draft;
  draftDirty: boolean;
  onOpenPage: (pageId: string) => void;
  onCreateFromDevice: () => void;
  onUploadDraftChange: (draft: Draft) => void;
  onUpdatePage: (pageId: string, patch: Partial<DraftPage>, historyKey?: string) => void;
  onDeletePage: (pageId: string) => void;
  onChangeEnd: () => void;
}

const nodeWidth = 210;
const nodeHeight = 184;
const columnGap = 54;
const rowGap = 56;
const showPageBboxesStorageKey = 'uikg-workbench.page-graph.show-element-bboxes';

function pagePosition(index: number, columns: number) {
  return {
    x: (index % columns) * (nodeWidth + columnGap) + 24,
    y: Math.floor(index / columns) * (nodeHeight + rowGap) + 24,
  };
}

function PageDetailImage({ frameId, page, elements, showElementBboxes }: { frameId: string; page: DraftPage; elements: Draft['elements']; showElementBboxes: boolean }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const naturalSizeRef = useRef<{ width: number; height: number } | null>(null);
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number } | null>(null);
  const imageUrl = absoluteAssetUrl(`/workbench/api/frames/${encodeURIComponent(frameId)}/image`);

  const fitCanvas = useCallback(() => {
    const viewport = viewportRef.current;
    const naturalSize = naturalSizeRef.current;
    if (!viewport || !naturalSize) return;
    const availableWidth = Math.max(1, viewport.clientWidth - 20);
    const availableHeight = Math.max(1, viewport.clientHeight - 20);
    const scale = Math.min(1, availableWidth / naturalSize.width, availableHeight / naturalSize.height);
    setCanvasSize({ width: naturalSize.width * scale, height: naturalSize.height * scale });
  }, []);

  useEffect(() => {
    naturalSizeRef.current = null;
    setCanvasSize(null);
  }, [frameId]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const observer = new ResizeObserver(fitCanvas);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fitCanvas]);

  return <div ref={viewportRef} className="page-detail-image">
    <div className={`page-detail-canvas ${canvasSize ? '' : 'page-detail-canvas-loading'}`} style={canvasSize || undefined}>
      <img src={imageUrl} alt={`${page.name}大图`} onLoad={(event) => { naturalSizeRef.current = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }; fitCanvas(); }} />
      {canvasSize && showElementBboxes && elements.map((element) => <span key={element.id} className={`page-detail-bbox page-detail-bbox-${element.reviewStatus}`} style={{ left: `${element.bbox.x * 100}%`, top: `${element.bbox.y * 100}%`, width: `${element.bbox.width * 100}%`, height: `${element.bbox.height * 100}%` }} title={`${element.label} · ${element.candidateKey}`} aria-label={`${element.label} bbox`} />)}
    </div>
  </div>;
}

function PageEditor({ page, status, onUpdate, onChangeEnd }: { page: DraftPage; status: ReturnType<typeof pageWorkflowStatus>; onUpdate: (patch: Partial<DraftPage>, historyKey?: string) => void; onChangeEnd: () => void }) {
  const pendingRecognition = status === 'pending-recognition';
  const displayPage = pendingRecognition ? {
    ...page,
    name: '待识别页面',
    surfaceType: 'unknown',
    stateSummary: '待识别',
    featurePath: ['待归类'],
    scrollableRegions: ['待识别'],
    elementIds: [],
    publishedAt: null,
  } : page;

  return (
    <div className={`graph-editor-form ${pendingRecognition ? 'page-editor-pending' : ''}`}>
      <div className="graph-editor-title"><div><strong>Page 属性</strong><span className={`page-status page-status-${status}`}>{pageWorkflowStatusLabels[status]}</span><code>{page.key}</code></div></div>
      <label className="field"><span>Page ID</span><input value={page.id} readOnly /></label>
      <label className="field"><span>页面名称</span><input value={displayPage.name} readOnly={pendingRecognition} onBlur={pendingRecognition ? undefined : onChangeEnd} onChange={pendingRecognition ? undefined : (event) => onUpdate({ name: event.target.value }, 'page:name')} /></label>
      <label className="field"><span>稳定键</span><input value={page.key} readOnly={pendingRecognition} onBlur={pendingRecognition ? undefined : onChangeEnd} onChange={pendingRecognition ? undefined : (event) => onUpdate({ key: event.target.value }, 'page:key')} /></label>
      <label className="field"><span>页面类型</span><select value={displayPage.surfaceType} disabled={pendingRecognition} onChange={(event) => onUpdate({ surfaceType: event.target.value })}><option value="page">页面</option><option value="dialog">对话框</option><option value="drawer">抽屉</option><option value="bottom-sheet">底部弹层</option><option value="menu">菜单</option><option value="shared-component">共享组件</option><option value="unknown">待确认</option></select></label>
      <label className="field field-textarea"><span>页面说明</span><textarea value={displayPage.stateSummary} readOnly={pendingRecognition} onBlur={pendingRecognition ? undefined : onChangeEnd} onChange={pendingRecognition ? undefined : (event) => onUpdate({ stateSummary: event.target.value }, 'page:summary')} /></label>
      <label className="field"><span>功能路径</span><input value={displayPage.featurePath.join(' / ')} readOnly={pendingRecognition} onBlur={pendingRecognition ? undefined : onChangeEnd} onChange={pendingRecognition ? undefined : (event) => onUpdate({ featurePath: event.target.value.split('/').map((item) => item.trim()).filter(Boolean).slice(0, 3) }, 'page:path')} /></label>
      <label className="field field-textarea"><span>滚动区域</span><textarea value={displayPage.scrollableRegions.join('\n')} readOnly={pendingRecognition} placeholder="每行一个区域" onBlur={pendingRecognition ? undefined : onChangeEnd} onChange={pendingRecognition ? undefined : (event) => onUpdate({ scrollableRegions: event.target.value.split('\n').map((item) => item.trim()).filter(Boolean) }, 'page:scrollable-regions')} /></label>
      <label className="field field-textarea page-reference-field"><span>Frame IDs</span><textarea value={page.frameIds.join('\n')} readOnly /></label>
      <label className="field field-textarea page-reference-field"><span>Element IDs</span><textarea value={displayPage.elementIds.length ? displayPage.elementIds.join('\n') : '暂无元素'} readOnly /></label>
      <label className="field"><span>发布时间</span><input value={displayPage.publishedAt || '未发布'} readOnly /></label>
      <div className="page-meta-grid"><span>画面证据<strong>{page.frameIds.length}</strong></span><span>直接元素<strong>{displayPage.elementIds.length}</strong></span></div>
    </div>
  );
}

export function PageGraph({ draft, draftDirty, onOpenPage, onCreateFromDevice, onUploadDraftChange, onUpdatePage, onDeletePage, onChangeEnd }: PageGraphProps) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [deleteConfirmPageId, setDeleteConfirmPageId] = useState<string | null>(null);
  const [showElementBboxes, setShowElementBboxes] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(showPageBboxesStorageKey) === 'true';
  });
  const nodeCount = draft.pages.length + 1;
  const columns = Math.min(3, Math.max(1, nodeCount));
  const rows = Math.max(1, Math.ceil(nodeCount / columns));
  const width = columns * nodeWidth + (columns - 1) * columnGap + 48;
  const height = rows * nodeHeight + (rows - 1) * rowGap + 48;
  const selectedPage = selectedPageId ? draft.pages.find((page) => page.id === selectedPageId) : undefined;
  const selectedFrameId = selectedPage?.frameIds.at(-1);
  const selectedPageElements = selectedPage ? draft.elements.filter((element) => elementAvailableOnPage(element, selectedPage.id, draft.elements)) : [];

  useEffect(() => {
    window.localStorage.setItem(showPageBboxesStorageKey, String(showElementBboxes));
  }, [showElementBboxes]);

  useEffect(() => {
    if (!selectedPageId) return;
    if (draft.pages.some((page) => page.id === selectedPageId)) return;
    setSelectedPageId(null);
  }, [draft.pages, selectedPageId]);

  useEffect(() => {
    if (!deleteConfirmPageId) return;
    if (draft.pages.some((page) => page.id === deleteConfirmPageId)) return;
    setDeleteConfirmPageId(null);
  }, [deleteConfirmPageId, draft.pages]);

  const selectPage = (pageId: string) => {
    setSelectedPageId(pageId);
  };

  const handleWorkspaceClickCapture = (event: ReactMouseEvent<HTMLElement>) => {
    if (!deleteConfirmPageId) return;
    const target = event.target;
    const deleteAction = target instanceof Element ? target.closest<HTMLElement>('.page-node-delete-action') : null;
    const pageNode = deleteAction?.closest<HTMLElement>('.page-node');
    if (pageNode?.dataset.pageId === deleteConfirmPageId) return;
    setDeleteConfirmPageId(null);
  };

  return (
    <main className="graph-workspace" onClickCapture={handleWorkspaceClickCapture}>
      <section className="graph-main">
        <div className="graph-toolbar"><div><PanelsTopLeft size={16} /><strong>Page 对象图</strong><span>{draft.pages.length} 个 Page</span></div></div>
        <div className="graph-board-scroll" onClick={(event) => { if (event.target === event.currentTarget) { setSelectedPageId(null); setCreateMenuOpen(false); } }}>
          <div className="graph-board" style={{ width, height }} onClick={(event) => { if (event.target === event.currentTarget) { setSelectedPageId(null); setCreateMenuOpen(false); } }}>
            <div className={`page-node page-node-create ${createMenuOpen ? 'create-menu-open' : ''}`} style={{ left: pagePosition(0, columns).x, top: pagePosition(0, columns).y }}>
              <button type="button" className="page-node-create-action" aria-label="创建页面对象" title="创建页面对象" onClick={() => setCreateMenuOpen((value) => !value)}><Plus size={28} /><span>创建页面对象</span></button>
              {createMenuOpen && <div className="page-node-create-menu" role="menu" aria-label="创建页面对象方式">
                <button type="button" title="上传图片" aria-label="上传图片" onClick={() => { setCreateMenuOpen(false); setUploadOpen(true); }}><ImageUp size={16} /></button>
                <button type="button" title="使用设备画面" aria-label="使用设备画面" onClick={() => { setCreateMenuOpen(false); onCreateFromDevice(); }}><Smartphone size={16} /></button>
              </div>}
            </div>
            {draft.pages.map((page, index) => {
              const position = pagePosition(index + 1, columns);
              const status = pageWorkflowStatus(draft, page);
              const latestFrameId = page.frameIds.at(-1);
              const deleting = deleteConfirmPageId === page.id;
              return <div key={page.id} data-page-id={page.id} className={`page-node ${page.id === selectedPageId ? 'active' : ''}`} style={{ left: position.x, top: position.y }}>
                <button type="button" className="page-node-select-target" aria-label={`选择 Page：${page.name}`} onClick={() => selectPage(page.id)} />
                <span className={`page-status page-status-${status}`}>{pageWorkflowStatusLabels[status]}</span>
                <span className="page-node-preview">{latestFrameId ? <img src={absoluteAssetUrl(`/workbench/api/frames/${encodeURIComponent(latestFrameId)}/image`)} alt={`${page.name || '待识别页面'}截图`} loading="lazy" /> : <span>暂无截图</span>}</span>
                <span className="page-node-content"><strong>{page.name}</strong><span className="page-node-meta">{page.surfaceType} · {page.frameIds.length} 帧 · {page.elementIds.length} 个标注</span><code>{page.key}</code></span>
                <button type="button" className={`page-node-action page-node-delete-action ${deleting ? 'confirming' : ''}`} title={deleting ? '再次点击确认删除页面及其元素' : '删除页面'} aria-label={deleting ? `确认删除 ${page.name}` : `删除 ${page.name}`} onClick={(event) => { event.stopPropagation(); if (deleting) { setDeleteConfirmPageId(null); onDeletePage(page.id); } else setDeleteConfirmPageId(page.id); }}>{deleting ? <Check size={15} /> : <Trash2 size={15} />}</button>
                <button type="button" className="page-node-action page-node-open-action" disabled={!latestFrameId} title={latestFrameId ? '在新标签页标注' : '暂无截图，无法标注'} aria-label={`在新标签页标注 ${page.name}`} onClick={(event) => { event.stopPropagation(); onOpenPage(page.id); }}><PanelTopOpen size={15} /></button>
              </div>;
            })}
          </div>
        </div>
        <section className="page-detail-preview" aria-label="选中页面大图">
          <header>
            <div><strong>{selectedPage?.name || '未选择 Page'}</strong><span>{selectedFrameId ? `最新截图 · ${selectedPageElements.length} 个页面元素` : selectedPage ? '暂无截图' : '未选择页面'}</span></div>
            <label><input type="checkbox" checked={showElementBboxes} onChange={(event) => setShowElementBboxes(event.target.checked)} /><span>显示元素 bbox</span></label>
          </header>
          {selectedPage && selectedFrameId ? <PageDetailImage frameId={selectedFrameId} page={selectedPage} elements={selectedPageElements} showElementBboxes={showElementBboxes} /> : <div className="page-detail-image"><div className="page-detail-empty">{selectedPage ? '该页面暂无截图' : '请选择一个页面卡片'}</div></div>}
        </section>
      </section>
      <aside className="graph-editor">
        {selectedPage ? <PageEditor page={selectedPage} status={pageWorkflowStatus(draft, selectedPage)} onUpdate={(patch, key) => onUpdatePage(selectedPage.id, patch, key)} onChangeEnd={onChangeEnd} /> : <div className="empty-state">请选择一个页面卡片</div>}
      </aside>
      <PageUploadDialog open={uploadOpen} draftDirty={draftDirty} onClose={() => setUploadOpen(false)} onDraftChange={onUploadDraftChange} />
    </main>
  );
}
