import { CircleAlert, FileImage, Link2, ListChecks, LoaderCircle, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { workbenchApi } from './api';
import type { Draft, PageUploadTask } from './types';

interface PageUploadDialogProps {
  open: boolean;
  draftDirty: boolean;
  purpose?: 'create' | 'history';
  targetPageId?: string | null;
  onClose: () => void;
  onDraftChange: (draft: Draft) => void;
}

const MAX_BATCH_SIZE = 20;
const CHUNK_SIZE = 1024 * 1024;

function formatBytes(value: number | null) {
  if (value === null) return '大小未知';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function taskStatusLabel(task: PageUploadTask, active: boolean) {
  if (task.status === 'queued') return '等待上传';
  if (task.status === 'uploading') return active ? '上传中' : '等待续传';
  if (task.status === 'completed') return '已完成';
  return '上传失败';
}

function taskProgress(task: PageUploadTask) {
  if (task.status === 'completed') return 100;
  if (!task.totalBytes) return 0;
  return Math.min(100, Math.round((task.uploadedBytes / task.totalBytes) * 100));
}

export function PageUploadDialog({ open, draftDirty, purpose = 'create', targetPageId = null, onClose, onDraftChange }: PageUploadDialogProps) {
  const [mode, setMode] = useState<'file' | 'url'>('file');
  const [historyTab, setHistoryTab] = useState<'uploading' | 'completed' | 'incomplete'>('uploading');
  const [tasks, setTasks] = useState<PageUploadTask[]>([]);
  const [existingPageIds, setExistingPageIds] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set());
  const [urlText, setUrlText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteIds, setDeleteIds] = useState<Set<string> | null>(null);
  const [deletePages, setDeletePages] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const resumeInputRef = useRef<HTMLInputElement | null>(null);
  const resumeTaskIdRef = useRef<string | null>(null);
  const localFilesRef = useRef(new Map<string, File>());
  const cancelledIdsRef = useRef(new Set<string>());
  const currentTaskIdsRef = useRef(new Set<string>());

  const active = activeIds.size > 0;
  const uploadingTasks = useMemo(() => tasks.filter((task) => task.status === 'queued' || task.status === 'uploading'), [tasks]);
  const completedTasks = useMemo(() => tasks.filter((task) => task.status === 'completed'), [tasks]);
  const incompleteTasks = useMemo(() => tasks.filter((task) => task.status === 'failed'), [tasks]);
  const visibleTasks = purpose === 'history'
    ? historyTab === 'uploading' ? uploadingTasks : historyTab === 'completed' ? completedTasks : incompleteTasks
    : tasks;
  const selectedTasks = useMemo(() => visibleTasks.filter((task) => selectedIds.has(task.id)), [selectedIds, visibleTasks]);
  const allSelected = visibleTasks.length > 0 && visibleTasks.every((task) => selectedIds.has(task.id));

  const replaceTask = (nextTask: PageUploadTask) => {
    setTasks((current) => current.map((task) => task.id === nextTask.id ? nextTask : task));
  };

  const applyDraftChange = (nextDraft: Draft) => {
    setExistingPageIds(new Set(nextDraft.pages.map((page) => page.id)));
    onDraftChange(nextDraft);
  };

  const refreshTasks = async () => {
    if (purpose === 'history') {
      const [uploadResult, draftResult] = await Promise.all([workbenchApi.pageUploads(), workbenchApi.draft()]);
      setTasks(uploadResult.tasks);
      setExistingPageIds(new Set(draftResult.draft.pages.map((page) => page.id)));
      return uploadResult.tasks;
    }
    const result = await workbenchApi.pageUploads();
    const currentTasks = result.tasks.filter((task) => currentTaskIdsRef.current.has(task.id));
    setTasks(currentTasks);
    return currentTasks;
  };

  useEffect(() => {
    if (!open) return;
    setSelectionMode(false);
    setHistoryTab('uploading');
    setSelectedIds(new Set());
    setDeleteIds(null);
    setDeletePages(false);
    setError(null);
    if (purpose === 'create') {
      currentTaskIdsRef.current.clear();
      localFilesRef.current.clear();
      cancelledIdsRef.current.clear();
      resumeTaskIdRef.current = null;
      setTasks([]);
      setActiveIds(new Set());
      setUrlText('');
      setLoading(false);
      return;
    }
    setTasks([]);
    setExistingPageIds(new Set());
    setLoading(true);
    void refreshTasks()
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoading(false));
    const refreshInterval = window.setInterval(() => {
      void refreshTasks().catch(() => {});
    }, 3000);
    return () => window.clearInterval(refreshInterval);
  }, [open, purpose]);

  const markActive = (taskId: string, value: boolean) => {
    setActiveIds((current) => {
      const next = new Set(current);
      if (value) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  };

  const runLocalUpload = async (initialTask: PageUploadTask, file: File) => {
    if (file.name !== initialTask.name || file.size !== initialTask.totalBytes) {
      setError(`请选择原文件“${initialTask.name}”（${formatBytes(initialTask.totalBytes)}）继续上传`);
      return;
    }
    localFilesRef.current.set(initialTask.id, file);
    cancelledIdsRef.current.delete(initialTask.id);
    markActive(initialTask.id, true);
    setError(null);
    try {
      let task = initialTask;
      let offset = task.uploadedBytes;
      if (offset >= file.size) {
        const result = await workbenchApi.processPageUpload(task.id);
        replaceTask(result.task);
        if (result.draft) applyDraftChange(result.draft);
        return;
      }
      while (offset < file.size && !cancelledIdsRef.current.has(task.id)) {
        const result = await workbenchApi.uploadPageChunk(task.id, file.slice(offset, Math.min(file.size, offset + CHUNK_SIZE)), offset);
        task = result.task;
        offset = task.uploadedBytes;
        replaceTask(task);
        if (result.draft) applyDraftChange(result.draft);
      }
    } catch (reason) {
      if (!cancelledIdsRef.current.has(initialTask.id)) {
        setError(reason instanceof Error ? reason.message : String(reason));
        await refreshTasks().catch(() => {});
      }
    } finally {
      markActive(initialTask.id, false);
    }
  };

  const runUrlUpload = async (initialTask: PageUploadTask) => {
    cancelledIdsRef.current.delete(initialTask.id);
    markActive(initialTask.id, true);
    setError(null);
    try {
      const result = await workbenchApi.processPageUpload(initialTask.id);
      replaceTask(result.task);
      if (result.draft) applyDraftChange(result.draft);
    } catch (reason) {
      if (!cancelledIdsRef.current.has(initialTask.id)) {
        setError(reason instanceof Error ? reason.message : String(reason));
        await refreshTasks().catch(() => {});
      }
    } finally {
      markActive(initialTask.id, false);
    }
  };

  const runWithConcurrency = async <T,>(items: T[], operation: (item: T) => Promise<void>) => {
    let index = 0;
    const uploadRunners = Array.from({ length: Math.min(3, items.length) }, async () => {
      while (index < items.length) {
        const item = items[index];
        index += 1;
        await operation(item);
      }
    });
    await Promise.all(uploadRunners);
  };

  const addLocalFiles = async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (images.length !== files.length) return setError('只能上传图片文件');
    if (images.length === 0) return;
    if (images.length > MAX_BATCH_SIZE) return setError('单次最多上传 20 张图片');
    if (draftDirty) return setError('当前草稿有未保存修改，请先保存后再上传图片');
    setLoading(true);
    setError(null);
    try {
      const result = await workbenchApi.createPageUploads(images.map((file) => ({ sourceType: 'file', name: file.name, mimeType: file.type, size: file.size, targetPageId: targetPageId || undefined })), targetPageId);
      result.tasks.forEach((task) => currentTaskIdsRef.current.add(task.id));
      setTasks((current) => [...result.tasks, ...current]);
      result.tasks.forEach((task, index) => localFilesRef.current.set(task.id, images[index]));
      setLoading(false);
      await runWithConcurrency(result.tasks, (task) => runLocalUpload(task, localFilesRef.current.get(task.id)!));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const addUrlTasks = async () => {
    const urls = urlText.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (urls.length === 0) return setError('请填写至少一个图片下载链接');
    if (urls.length > MAX_BATCH_SIZE) return setError('单次最多上传 20 张图片');
    if (draftDirty) return setError('当前草稿有未保存修改，请先保存后再上传图片');
    setLoading(true);
    setError(null);
    try {
      const result = await workbenchApi.createPageUploads(urls.map((url) => ({ sourceType: 'url', name: decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || '链接图片', url, targetPageId: targetPageId || undefined })), targetPageId);
      result.tasks.forEach((task) => currentTaskIdsRef.current.add(task.id));
      setTasks((current) => [...result.tasks, ...current]);
      setUrlText('');
      setLoading(false);
      await runWithConcurrency(result.tasks, runUrlUpload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const retryTask = (task: PageUploadTask) => {
    if (draftDirty) return setError('当前草稿有未保存修改，请先保存后再重试');
    if (task.sourceType === 'url') return void runUrlUpload(task);
    const file = localFilesRef.current.get(task.id);
    if (file) return void runLocalUpload(task, file);
    resumeTaskIdRef.current = task.id;
    resumeInputRef.current?.click();
  };

  const requestDelete = (ids: Iterable<string>) => {
    const next = new Set(ids);
    if (next.size === 0) return;
    setDeletePages(false);
    setDeleteIds(next);
  };

  const confirmDelete = async () => {
    if (!deleteIds?.size) return;
    if (deletePages && draftDirty) return setError('当前草稿有未保存修改，不能同时删除 Page');
    const ids = [...deleteIds];
    ids.forEach((id) => {
      cancelledIdsRef.current.add(id);
      markActive(id, false);
    });
    setLoading(true);
    setError(null);
    try {
      const result = await workbenchApi.deletePageUploads(ids, deletePages);
      setTasks((current) => current.filter((task) => !result.deletedIds.includes(task.id)));
      setSelectedIds((current) => new Set([...current].filter((id) => !result.deletedIds.includes(id))));
      result.deletedIds.forEach((id) => {
        localFilesRef.current.delete(id);
        currentTaskIdsRef.current.delete(id);
      });
      if (deletePages) applyDraftChange(result.draft);
      setDeleteIds(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      await refreshTasks().catch(() => {});
    } finally {
      setLoading(false);
    }
  };

  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

  const changeHistoryTab = (nextTab: 'uploading' | 'completed' | 'incomplete') => {
    setHistoryTab(nextTab);
    exitSelectionMode();
    setDeleteIds(null);
  };

  const renderTask = (task: PageUploadTask) => {
    const progress = taskProgress(task);
    const isActive = activeIds.has(task.id) || task.processing === true;
    const pageDeleted = purpose === 'history' && task.status === 'completed' && Boolean(task.pageId) && !existingPageIds.has(task.pageId!);
    return <article key={task.id} className={`page-upload-task page-upload-task-${task.status} ${pageDeleted ? 'page-upload-task-page-missing' : ''} ${selectionMode ? 'page-upload-task-selecting' : ''}`}>
      {selectionMode && <input type="checkbox" aria-label={`选择 ${task.name}`} checked={selectedIds.has(task.id)} onChange={(event) => setSelectedIds((current) => { const next = new Set(current); if (event.target.checked) next.add(task.id); else next.delete(task.id); return next; })} />}
      <div className="page-upload-task-icon">{task.sourceType === 'url' ? <Link2 size={16} /> : <FileImage size={16} />}</div>
      <div className="page-upload-task-main"><div><strong title={task.name}>{task.name}</strong><span className={`upload-status upload-status-${task.status}`}>{isActive && <LoaderCircle className="spin" size={11} />}{taskStatusLabel(task, isActive)}</span></div><div className="page-upload-progress"><i style={{ width: `${progress}%` }} /></div><small>{formatBytes(task.uploadedBytes)} / {formatBytes(task.totalBytes)}{task.pageId ? ' · 已创建 Page' : ''}</small>{pageDeleted && <p className="page-upload-page-missing"><CircleAlert size={12} />关联的页面对象已删除</p>}{task.errorReason && <p><CircleAlert size={12} />{task.errorReason}</p>}</div>
      <div className="page-upload-task-actions">{task.status !== 'completed' && !isActive && <button type="button" className="icon-button" disabled={loading} title={task.sourceType === 'file' && !localFilesRef.current.has(task.id) ? '选择原文件续传' : '重试'} aria-label={`重试 ${task.name}`} onClick={() => retryTask(task)}><RefreshCw size={14} /></button>}<button type="button" className="icon-button danger-button" disabled={loading} title="删除上传记录" aria-label={`删除 ${task.name} 上传记录`} onClick={() => requestDelete([task.id])}><Trash2 size={14} /></button></div>
    </article>;
  };

  if (!open) return null;
  return <div className="page-upload-backdrop" role="presentation" onMouseDown={() => { if (!active && !loading) onClose(); }}>
    <section className={`page-upload-dialog ${purpose === 'history' ? 'page-upload-dialog-history' : ''}`} role="dialog" aria-modal="true" aria-labelledby="page-upload-title" onMouseDown={(event) => event.stopPropagation()}>
      <header className="page-upload-header"><div><strong id="page-upload-title">{purpose === 'history' ? '传输中心' : '上传 Page 图片'}</strong><span>{purpose === 'history' ? '历史 Page 图片上传记录' : '每张图片创建一个待识别 Page · 单次最多 20 张'}</span></div><button type="button" className="icon-button" disabled={active || loading} title={active || loading ? '任务处理完成后可关闭' : '关闭'} aria-label={purpose === 'history' ? '关闭传输中心' : '关闭上传窗口'} onClick={onClose}><X size={17} /></button></header>
      {purpose === 'create' && <div className="page-upload-source">
        <div className="page-upload-mode" aria-label="图片来源"><button type="button" className={mode === 'file' ? 'active' : ''} onClick={() => setMode('file')}><FileImage size={14} />本地图片</button><button type="button" className={mode === 'url' ? 'active' : ''} onClick={() => setMode('url')}><Link2 size={14} />图片链接</button></div>
        {mode === 'file' ? <div className="page-upload-file-picker"><input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(event) => void addLocalFiles([...event.target.files || []])} /><button type="button" className="button button-primary" disabled={loading || draftDirty} title={draftDirty ? '请先保存草稿' : '选择本地图片'} onClick={() => fileInputRef.current?.click()}><Upload size={15} />选择图片</button><span>PNG / JPEG / WebP，支持分片断点续传</span></div> : <div className="page-upload-url-picker"><textarea value={urlText} placeholder={'每行一个图片下载链接\nhttps://example.com/page.png'} onChange={(event) => setUrlText(event.target.value)} /><button type="button" className="button button-primary" disabled={loading || draftDirty} title={draftDirty ? '请先保存草稿' : '添加链接任务'} onClick={() => void addUrlTasks()}><Link2 size={15} />添加并上传</button></div>}
        <input ref={resumeInputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => { const task = tasks.find((item) => item.id === resumeTaskIdRef.current); const file = event.target.files?.[0]; if (task && file) void runLocalUpload(task, file); event.target.value = ''; }} />
        {draftDirty && <div className="page-upload-dirty-warning"><CircleAlert size={14} />当前草稿有未保存修改，请先保存后再新增或重试上传任务。</div>}
        {error && <div className="page-upload-error" role="alert"><CircleAlert size={14} /><span>{error}</span><button type="button" title="关闭提示" aria-label="关闭错误提示" onClick={() => setError(null)}><X size={13} /></button></div>}
      </div>}
      {purpose === 'history' && <div className="page-upload-history-feedback">
        <input ref={resumeInputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => { const task = tasks.find((item) => item.id === resumeTaskIdRef.current); const file = event.target.files?.[0]; if (task && file) void runLocalUpload(task, file); event.target.value = ''; }} />
        {draftDirty && <div className="page-upload-dirty-warning"><CircleAlert size={14} />当前草稿有未保存修改，请先保存后再重试上传任务。</div>}
        {error && <div className="page-upload-error" role="alert"><CircleAlert size={14} /><span>{error}</span><button type="button" title="关闭提示" aria-label="关闭错误提示" onClick={() => setError(null)}><X size={13} /></button></div>}
      </div>}
      <div className={`page-upload-history-tabs ${purpose === 'create' ? 'page-upload-current-tabs' : ''}`}>
        {purpose === 'history' ? <div className="page-upload-history-tablist" role="tablist" aria-label="传输记录状态">
          <button type="button" role="tab" aria-selected={historyTab === 'uploading'} className={historyTab === 'uploading' ? 'active' : ''} onClick={() => changeHistoryTab('uploading')}>上传中<em>{uploadingTasks.length}</em></button>
          <button type="button" role="tab" aria-selected={historyTab === 'completed'} className={historyTab === 'completed' ? 'active' : ''} onClick={() => changeHistoryTab('completed')}>已完成<em>{completedTasks.length}</em></button>
          <button type="button" role="tab" aria-selected={historyTab === 'incomplete'} className={historyTab === 'incomplete' ? 'active' : ''} onClick={() => changeHistoryTab('incomplete')}>未完成<em>{incompleteTasks.length}</em></button>
        </div> : <div className="page-upload-current-title"><span>本次上传</span><em>{tasks.length}</em></div>}
        <div className="page-upload-list-actions">
          {selectionMode ? <><label><input type="checkbox" checked={allSelected} disabled={visibleTasks.length === 0} onChange={(event) => setSelectedIds(event.target.checked ? new Set(visibleTasks.map((task) => task.id)) : new Set())} /><span>全选</span></label><button type="button" className="button danger-button" disabled={selectedTasks.length === 0 || loading} onClick={() => requestDelete(selectedIds)}><Trash2 size={14} />删除所选</button><button type="button" className="icon-button" title="退出选择" aria-label="退出选择模式" onClick={exitSelectionMode}><X size={14} /></button></> : <button type="button" className="icon-button" disabled={visibleTasks.length === 0} title="选择上传记录" aria-label="选择上传记录" onClick={() => setSelectionMode(true)}><ListChecks size={15} /></button>}
        </div>
      </div>
      <div className="page-upload-list">
        {loading && tasks.length === 0 ? <div className="page-upload-empty"><LoaderCircle className="spin" size={20} />正在加载上传记录</div> : visibleTasks.length === 0 ? <div className="page-upload-empty"><FileImage size={24} /><strong>{purpose === 'history' ? historyTab === 'uploading' ? '暂无上传中的记录' : historyTab === 'completed' ? '暂无已完成记录' : '暂无未完成记录' : '请选择要上传的图片'}</strong></div> : visibleTasks.map(renderTask)}
      </div>
      {deleteIds && <div className="page-upload-delete-confirm" role="alertdialog" aria-label="确认删除上传记录"><div><strong>删除 {deleteIds.size} 条上传记录？</strong><span>上传中的任务将被取消。</span></div><label><input type="checkbox" checked={deletePages} disabled={draftDirty || !tasks.some((task) => deleteIds.has(task.id) && task.pageId)} onChange={(event) => setDeletePages(event.target.checked)} /><span>同时删除对应 Page</span></label><div><button type="button" className="button danger-button" disabled={loading} onClick={() => void confirmDelete()}>确认删除</button><button type="button" className="button" disabled={loading} onClick={() => setDeleteIds(null)}>取消</button></div></div>}
      <footer><span>{active ? `正在处理 ${activeIds.size} 个任务，完成后可关闭` : purpose === 'history' ? `上传中 ${uploadingTasks.length} · 已完成 ${completedTasks.length} · 未完成 ${incompleteTasks.length}` : '失败任务可保留断点并重试'}</span><button type="button" className="button" disabled={active || loading} onClick={onClose}>完成</button></footer>
    </section>
  </div>;
}
