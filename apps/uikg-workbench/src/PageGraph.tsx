import { Check, Grip, ImageUp, PanelsTopLeft, PanelTopOpen, Pin, Plus, Smartphone, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
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

const showPageBboxesStorageKey = 'uikg-workbench.page-graph.show-element-bboxes';

function PageDetailImage({ frameId, page, elements, showElementBboxes }: { frameId: string; page: DraftPage; elements: Draft['elements']; showElementBboxes: boolean }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
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
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth > 0) {
      naturalSizeRef.current = { width: image.naturalWidth, height: image.naturalHeight };
      fitCanvas();
    }
    return () => observer.disconnect();
  }, [fitCanvas]);

  return <div ref={viewportRef} className="page-detail-image">
    <div className={`page-detail-canvas ${canvasSize ? '' : 'page-detail-canvas-loading'}`} style={canvasSize || undefined}>
      <img ref={imageRef} src={imageUrl} alt={`${page.name}大图`} onLoad={(event) => { naturalSizeRef.current = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }; fitCanvas(); }} />
      {canvasSize && showElementBboxes && elements.flatMap((element) => {
        const regions = element.abstraction?.instanceRegions || [];
        if (regions.length > 0) {
          return regions.map((region, index) => (
            <span key={`${element.id}-instance-${index}`} className="page-detail-bbox page-detail-bbox-abstract" style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }} title={`${element.label} · 第 ${index + 1} 项实例`} aria-label={`${element.label} 实例 bbox`} />
          ));
        }
        return [<span key={element.id} className={`page-detail-bbox page-detail-bbox-${element.reviewStatus}`} style={{ left: `${element.bbox.x * 100}%`, top: `${element.bbox.y * 100}%`, width: `${element.bbox.width * 100}%`, height: `${element.bbox.height * 100}%` }} title={`${element.label} · ${element.candidateKey}`} aria-label={`${element.label} bbox`} />];
      })}
    </div>
  </div>;
}

function PageEditor({ page, status, onUpdate, onChangeEnd }: { page: DraftPage; status: ReturnType<typeof pageWorkflowStatus>; onUpdate: (patch: Partial<DraftPage>, historyKey?: string) => void; onChangeEnd: () => void }) {
  const pendingRecognition = status === 'pending-recognition';
  const displayPage = pendingRecognition ? {
    ...page,
    name: '待识别页面',
    functionRef: '',
    implementationType: 'unknown' as const,
    surfaceType: 'unknown',
    stateSummary: '待识别',
    featurePath: ['待归类'],
    scrollableRegions: ['待识别'],
    elementIds: [],
    publishedAt: null,
  } : page;

  return (
    <div className={`graph-editor-form ${pendingRecognition ? 'page-editor-pending' : ''}`}>
      <div className="graph-editor-title"><div><strong>Page 属性</strong><code>{page.key}</code></div></div>
      <label className="field"><span>Page ID</span><input value={page.id} readOnly /></label>
      <label className="field"><span>页面名称</span><input value={displayPage.name} readOnly={pendingRecognition} onBlur={pendingRecognition ? undefined : onChangeEnd} onChange={pendingRecognition ? undefined : (event) => onUpdate({ name: event.target.value }, 'page:name')} /></label>
      <label className="field"><span>稳定键</span><input value={page.key} readOnly={pendingRecognition} onBlur={pendingRecognition ? undefined : onChangeEnd} onChange={pendingRecognition ? undefined : (event) => onUpdate({ key: event.target.value }, 'page:key')} /></label>
      <label className="field"><span>所属功能</span><input value={displayPage.functionRef || ''} placeholder="例如：特别关注、待办；也可填写功能 ID" readOnly={pendingRecognition} onBlur={pendingRecognition ? undefined : onChangeEnd} onChange={pendingRecognition ? undefined : (event) => onUpdate({ functionRef: event.target.value, featurePath: event.target.value.trim() ? [event.target.value.trim()] : ['待归类'] }, 'page:function')} /></label>
      <label className="field"><span>页面实现类型</span><select value={displayPage.implementationType || 'unknown'} disabled={pendingRecognition} onChange={(event) => onUpdate({ implementationType: event.target.value as DraftPage['implementationType'] })}><option value="native">原生</option><option value="rn">RN</option><option value="h5">H5</option><option value="mini-program">小程序</option><option value="unknown">待确认</option></select></label>
      <label className="field"><span>页面形态</span><select value={displayPage.surfaceType} disabled={pendingRecognition} onChange={(event) => onUpdate({ surfaceType: event.target.value })}><option value="page">页面</option><option value="dialog">对话框</option><option value="drawer">抽屉</option><option value="bottom-sheet">底部弹层</option><option value="menu">菜单</option><option value="shared-component">共享组件</option><option value="unknown">待确认</option></select></label>
      <label className="field field-textarea"><span>页面说明</span><textarea value={displayPage.stateSummary} readOnly={pendingRecognition} onBlur={pendingRecognition ? undefined : onChangeEnd} onChange={pendingRecognition ? undefined : (event) => onUpdate({ stateSummary: event.target.value }, 'page:summary')} /></label>
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
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewPinned, setPreviewPinned] = useState(false);
  const [previewPosition, setPreviewPosition] = useState<{ x: number; y: number } | null>(null);
  const [previewSize, setPreviewSize] = useState<{ width: number; height: number } | null>(null);
  const previewRef = useRef<HTMLElement>(null);
  const previewInteractionRef = useRef<{ kind: 'drag' | 'resize'; pointerId: number; startX: number; startY: number; originX: number; originY: number; originWidth: number; originHeight: number } | null>(null);
  const [showElementBboxes, setShowElementBboxes] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(showPageBboxesStorageKey) === 'true';
  });
  const selectedPage = selectedPageId ? draft.pages.find((page) => page.id === selectedPageId) : undefined;
  const selectedFrameId = selectedPage?.frameIds.at(-1);
  const selectedPageElements = selectedPage ? draft.elements.filter((element) => elementAvailableOnPage(element, selectedPage.id, draft.elements)) : [];
  const selectedPageStatus = selectedPage ? pageWorkflowStatus(draft, selectedPage) : null;

  useEffect(() => {
    window.localStorage.setItem(showPageBboxesStorageKey, String(showElementBboxes));
  }, [showElementBboxes]);

  useEffect(() => {
    if (!selectedPageId) return;
    if (draft.pages.some((page) => page.id === selectedPageId)) return;
    setSelectedPageId(null);
  }, [draft.pages, selectedPageId]);

  useEffect(() => {
    if (!selectedPageId || previewPinned || typeof window === 'undefined') return;
    const setFallbackSize = () => {
      const width = Math.min(520, Math.max(320, window.innerWidth * 0.42));
      const height = Math.min(820, Math.max(440, window.innerHeight * 0.78));
      setPreviewPosition({ x: 16, y: 72 });
      setPreviewSize({ width, height });
    };
    if (!selectedFrameId) {
      setFallbackSize();
      return;
    }
    const image = new Image();
    image.onload = () => {
      const titleHeight = 48;
      const maxWidth = Math.min(620, window.innerWidth - 24);
      const maxHeight = Math.min(820, window.innerHeight - 72);
      const scale = Math.min(maxWidth / image.naturalWidth, (maxHeight - titleHeight - 20) / image.naturalHeight, 0.62);
      const width = Math.max(Math.min(320, maxWidth), Math.round(image.naturalWidth * scale + 20));
      const height = Math.max(Math.min(420, maxHeight), Math.round(image.naturalHeight * scale + titleHeight + 20));
      setPreviewPosition({ x: 16, y: 72 });
      setPreviewSize({ width, height });
    };
    image.onerror = setFallbackSize;
    image.src = absoluteAssetUrl(`/workbench/api/frames/${encodeURIComponent(selectedFrameId)}/image`);
    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [previewPinned, selectedFrameId, selectedPageId]);

  useEffect(() => {
    if (!deleteConfirmPageId) return;
    if (draft.pages.some((page) => page.id === deleteConfirmPageId)) return;
    setDeleteConfirmPageId(null);
  }, [deleteConfirmPageId, draft.pages]);

  const selectPage = (pageId: string) => {
    if (pageId === selectedPageId) return;
    setPreviewVisible(true);
    setSelectedPageId(pageId);
  };

  const closePreview = () => {
    setPreviewVisible(false);
    setSelectedPageId(null);
    setPreviewPosition(null);
    setPreviewSize(null);
  };

  const handlePreviewPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (previewPinned) return;
    const target = event.target;
    if (target instanceof Element && target.closest('button, label, input, .page-detail-resize-handle')) return;
    const preview = previewRef.current;
    if (!preview) return;
    const rect = preview.getBoundingClientRect();
    previewInteractionRef.current = { kind: 'drag', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: rect.left, originY: rect.top, originWidth: rect.width, originHeight: rect.height };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events do not have an active pointer to capture.
    }
    event.preventDefault();
  };

  const handlePreviewPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const interaction = previewInteractionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    const preview = previewRef.current;
    if (!preview) return;
    if (interaction.kind === 'drag') {
      const maxX = Math.max(8, window.innerWidth - interaction.originWidth - 8);
      const maxY = Math.max(56, window.innerHeight - interaction.originHeight - 8);
      const nextX = Math.min(maxX, Math.max(8, interaction.originX + event.clientX - interaction.startX));
      const nextY = Math.min(maxY, Math.max(56, interaction.originY + event.clientY - interaction.startY));
      preview.style.left = `${nextX}px`;
      preview.style.top = `${nextY}px`;
      return;
    }
    const minWidth = Math.min(320, window.innerWidth - 24);
    const minHeight = Math.min(420, window.innerHeight - 72);
    const maxWidth = Math.min(760, window.innerWidth - 24);
    const maxHeight = Math.min(900, window.innerHeight - 72);
    const nextWidth = Math.min(maxWidth, Math.max(minWidth, interaction.originWidth + event.clientX - interaction.startX));
    const nextHeight = Math.min(maxHeight, Math.max(minHeight, interaction.originHeight + event.clientY - interaction.startY));
    preview.style.width = `${nextWidth}px`;
    preview.style.height = `${nextHeight}px`;
  };

  const handlePreviewPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const interaction = previewInteractionRef.current;
    if (interaction?.pointerId !== event.pointerId) return;
    const preview = previewRef.current;
    if (preview && interaction.kind === 'drag') setPreviewPosition({ x: preview.getBoundingClientRect().left, y: preview.getBoundingClientRect().top });
    if (preview && interaction.kind === 'resize') setPreviewSize({ width: preview.getBoundingClientRect().width, height: preview.getBoundingClientRect().height });
    previewInteractionRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handlePreviewResizePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (previewPinned) return;
    const preview = previewRef.current;
    if (!preview) return;
    const rect = preview.getBoundingClientRect();
    previewInteractionRef.current = { kind: 'resize', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: rect.left, originY: rect.top, originWidth: rect.width, originHeight: rect.height };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic pointer events cannot be captured. */ }
    event.stopPropagation();
    event.preventDefault();
  };

  const togglePreviewPinned = () => {
    if (previewPinned) {
      setPreviewPosition(null);
      setPreviewSize(null);
    }
    if (!previewPinned && previewRef.current) {
      const rect = previewRef.current.getBoundingClientRect();
      setPreviewPosition({ x: rect.left, y: rect.top });
      setPreviewSize({ width: rect.width, height: rect.height });
    }
    setPreviewPinned((value) => !value);
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
    <main className={`graph-workspace ${previewPinned ? 'graph-workspace-preview-pinned' : ''}`} onClickCapture={handleWorkspaceClickCapture}>
      <section className="graph-main">
        <div className="graph-toolbar"><div><PanelsTopLeft size={16} /><strong>Page 对象图</strong><span>{draft.pages.length} 个 Page</span></div></div>
        <div className="graph-board-scroll" onClick={(event) => { if (event.target === event.currentTarget) { setSelectedPageId(null); setCreateMenuOpen(false); } }}>
          <div className="graph-board" onClick={(event) => { if (event.target === event.currentTarget) { setSelectedPageId(null); setCreateMenuOpen(false); } }}>
            <div className={`page-node page-node-create ${createMenuOpen ? 'create-menu-open' : ''}`}>
              <button type="button" className="page-node-create-action" aria-label="创建页面对象" title="创建页面对象" onClick={() => setCreateMenuOpen((value) => !value)}><Plus size={28} /><span>创建页面对象</span></button>
              {createMenuOpen && <div className="page-node-create-menu" role="menu" aria-label="创建页面对象方式">
                <button type="button" title="上传图片" aria-label="上传图片" onClick={() => { setCreateMenuOpen(false); setUploadOpen(true); }}><ImageUp size={16} /></button>
                <button type="button" title="使用设备帧" aria-label="使用设备帧" onClick={() => { setCreateMenuOpen(false); onCreateFromDevice(); }}><Smartphone size={16} /></button>
              </div>}
            </div>
            {draft.pages.map((page, index) => {
              const status = pageWorkflowStatus(draft, page);
              const latestFrameId = page.frameIds.at(-1);
              const deleting = deleteConfirmPageId === page.id;
              return <div key={page.id} data-page-id={page.id} className={`page-node ${page.id === selectedPageId ? 'active' : ''}`}>
                <button type="button" className="page-node-select-target" aria-label={`选择 Page：${page.name}`} onClick={() => selectPage(page.id)} />
                <span className={`page-status page-status-${status}`}>{pageWorkflowStatusLabels[status]}</span>
                <span className="page-node-preview">{latestFrameId ? <img src={absoluteAssetUrl(`/workbench/api/frames/${encodeURIComponent(latestFrameId)}/image`)} alt={`${page.name || '待识别页面'}截图`} loading="lazy" /> : <span>暂无截图</span>}</span>
                <span className="page-node-content"><strong>{page.name}</strong><span className="page-node-meta">{page.functionRef || '待归类功能'} · {page.implementationType || '待确认'} · {page.frameIds.length} 帧</span><code>{page.key}</code></span>
                <button type="button" className={`page-node-action page-node-delete-action ${deleting ? 'confirming' : ''}`} title={deleting ? '再次点击确认删除页面及其元素' : '删除页面'} aria-label={deleting ? `确认删除 ${page.name}` : `删除 ${page.name}`} onClick={(event) => { event.stopPropagation(); if (deleting) { setDeleteConfirmPageId(null); onDeletePage(page.id); } else setDeleteConfirmPageId(page.id); }}>{deleting ? <Check size={13} /> : <Trash2 size={13} />}</button>
                <button type="button" className="page-node-action page-node-open-action" disabled={!latestFrameId} title={latestFrameId ? '在新标签页标注' : '暂无截图，无法标注'} aria-label={`在新标签页标注 ${page.name}`} onClick={(event) => { event.stopPropagation(); onOpenPage(page.id); }}><PanelTopOpen size={13} /></button>
              </div>;
            })}
          </div>
        </div>
      </section>
      {previewVisible && (previewPinned || (previewPosition && previewSize)) && <section ref={previewRef} className={`page-detail-preview page-detail-preview-pip ${previewPinned ? 'page-detail-preview-pinned' : 'page-detail-preview-floating'}`} style={!previewPinned && previewPosition && previewSize ? { left: previewPosition.x, top: previewPosition.y, width: previewSize.width, height: previewSize.height } : undefined} onPointerMove={handlePreviewPointerMove} onPointerUp={handlePreviewPointerUp} onPointerCancel={handlePreviewPointerUp} aria-label="选中页面浮动预览">
        <header onPointerDown={handlePreviewPointerDown}>
          <div className="page-detail-header-copy">
            <strong>{selectedPage?.name || '未选择页面'}</strong>
            {selectedPageStatus && <span className={`page-status page-status-${selectedPageStatus}`}>{pageWorkflowStatusLabels[selectedPageStatus]}</span>}
          </div>
          <div className="page-detail-header-actions">
            <label><input type="checkbox" checked={showElementBboxes} onChange={(event) => setShowElementBboxes(event.target.checked)} /><span>显示元素 bbox</span></label>
            <button type="button" className={`icon-button page-detail-pin ${previewPinned ? 'active' : ''}`} title={previewPinned ? '取消固定预览' : '固定到工作区'} aria-label={previewPinned ? '取消固定预览' : '固定到工作区'} onClick={togglePreviewPinned}><Pin size={15} /></button>
            {!previewPinned && <button type="button" className="icon-button page-detail-close" title="关闭页面预览" aria-label="关闭页面预览" onClick={closePreview}><X size={15} /></button>}
          </div>
        </header>
        {selectedPage && selectedFrameId ? <PageDetailImage frameId={selectedFrameId} page={selectedPage} elements={selectedPageElements} showElementBboxes={showElementBboxes} /> : <div className="page-detail-image"><div className="page-detail-empty">请选择一个页面卡片查看预览</div></div>}
        {!previewPinned && <button type="button" className="page-detail-resize-handle" aria-label="调整页面预览大小" title="拖动调整预览大小" onPointerDown={handlePreviewResizePointerDown}><Grip size={18} /></button>}
      </section>}
      <aside className="graph-editor">
        {selectedPage ? <PageEditor page={selectedPage} status={pageWorkflowStatus(draft, selectedPage)} onUpdate={(patch, key) => onUpdatePage(selectedPage.id, patch, key)} onChangeEnd={onChangeEnd} /> : <div className="empty-state">请选择一个页面卡片</div>}
      </aside>
      <PageUploadDialog open={uploadOpen} draftDirty={draftDirty} onClose={() => setUploadOpen(false)} onDraftChange={onUploadDraftChange} />
    </main>
  );
}
