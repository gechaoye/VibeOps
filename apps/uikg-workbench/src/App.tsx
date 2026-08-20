import { App as AntdApp, ConfigProvider } from 'antd';
import {
  Camera,
  Braces,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Check,
  CloudCog,
  Eye,
  EyeOff,
  Feather,
  FileDiff,
  History,
  ImageUp,
  ListChecks,
  ListFilter,
  LoaderCircle,
  MonitorSmartphone,
  MousePointer2,
  PanelsTopLeft,
  PanelRight,
  Pencil,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  RotateCcw,
  Save,
  ScanSearch,
  Settings2,
  Smartphone,
  SquareDashed,
  Undo2,
  Unplug,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnnotationCanvas } from './AnnotationCanvas';
import { createAnnotationSessionId, draftForAnnotationTarget, type AnnotationTarget } from './annotation-tabs';
import { clearUnsavedAnnotationRecoveries, readUnsavedAnnotationRecoveries, removeUnsavedAnnotationRecovery, upsertUnsavedAnnotationRecovery, type UnsavedAnnotationRecovery } from './annotation-recovery';
import { absoluteAssetUrl, serverUrl, workbenchApi, type RecognitionStreamResult } from './api';
import { DeviceClient } from './device-client';
import { EditHistoryPanel } from './EditHistoryPanel';
import { ElementTree } from './ElementTree';
import { Inspector } from './Inspector';
import { KnowledgeGraph } from './KnowledgeGraph';
import { LiveDevicePreview } from './LiveDevicePreview';
import { ModelSettings } from './ModelSettings';
import { createHumanElement, elementAvailableOnPage, gridForBox, normalizeGridCount, reviewStatusLabels, validateDraftClient } from './model';
import { PageGraph } from './PageGraph';
import { PageUploadDialog } from './PageUploadDialog';
import { ProjectModelSettings } from './ProjectModelSettings';
import { RecognitionProgressPanel, type RecognitionActivity } from './RecognitionProgressPanel';
import { UltraModelComparisonPanel } from './UltraModelComparisonPanel';
import { StagingPanel } from './StagingPanel';
import type { AnalysisSession, BBox, DeviceState, Draft, DraftElement, DraftPage, ElementActivityRecord, ElementEditRecord, FrameMetadata, RecognitionResult, UltraModelElementMergeSelection, RecognitionResumeSession, StagingResult, ValidationIssue, WorkbenchStatus } from './types';
import './styles.css';

type ViewMode = 'live' | 'frozen' | 'review';
type SideTab = 'elements' | 'validation' | 'history';
type WorkspaceMode = 'annotation' | 'graph' | 'knowledge' | 'staging';
type ExplorationMode = 'ultra' | 'manual';
type InternalTabKind = 'knowledge' | 'workspace' | 'model' | 'settings' | 'annotation';
type PendingRecognitionReplacement =
  | { kind: 'manual'; result: RecognitionStreamResult }
  | { kind: 'ultra'; selections: UltraModelElementMergeSelection[] };

const MAX_PAGE_TABS = 10;

interface InternalTab {
  id: string;
  title: string;
  sessionId: string;
  kind: InternalTabKind;
  annotationTarget: AnnotationTarget | null;
}

const validationIssueTypeLabels: Record<string, string> = {
  action_effect_missing: '动作效果不完整',
  bbox_invalid: '元素边框异常',
  grid_region_invalid: '宫格定位异常',
  candidate_key_duplicate_current_page: '同页候选键重复',
  candidate_key_duplicate_other_page: '跨页候选键重复',
  candidate_key_required: '缺少候选键',
  capability_missing: '缺少元素动作',
  capability_none_conflict: '元素动作冲突',
  element_type_required: '缺少元素类型',
  label_required: '缺少元素名称',
  nested_owner_kind: '嵌套元素归属异常',
  owner_cycle: '元素层级循环',
  parent_missing: '父级元素不存在',
  parent_self: '父级元素指向自身',
  review_pending: '元素待审核',
  root_owner_kind: '根元素归属异常',
  transition_evidence_incomplete: '跳转证据不完整',
  model_action_inconsistent: '识别动作不一致',
  model_bbox_clamped: '识别边框已裁剪',
};

function validationGroupItems(group: { code: string; issues: ValidationIssue[] }): ValidationIssue[][] {
  if (!group.code.startsWith('candidate_key_duplicate_')) return group.issues.map((issue) => [issue]);
  const byCandidateKey = new Map<string, ValidationIssue[]>();
  for (const issue of group.issues) {
    const pageScope = group.code === 'candidate_key_duplicate_current_page' ? `:${[...(issue.pageIds || [])].sort().join(',')}` : '';
    const key = `${issue.candidateKey || issue.elementId || issue.message}${pageScope}`;
    const items = byCandidateKey.get(key) || [];
    items.push(issue);
    byCandidateKey.set(key, items);
  }
  return [...byCandidateKey.values()];
}

function removePageFromDraft(current: Draft, pageId: string): Draft {
  const removedElementIds = new Set(current.elements.filter((element) => element.pageId === pageId).map((element) => element.id));
  const elements = current.elements
    .filter((element) => !removedElementIds.has(element.id))
    .map((element) => element.ownerKind === 'application'
      ? { ...element, availableOnPageIds: element.availableOnPageIds.filter((id) => id !== pageId) }
      : element);
  const pages = current.pages.filter((page) => page.id !== pageId).map((page) => ({
    ...page,
    elementIds: page.elementIds.filter((id) => !removedElementIds.has(id)),
  }));
  const nextPage = current.currentPageId === pageId ? pages[0] : pages.find((page) => page.id === current.currentPageId) || pages[0];
  const emptyPage = {
    id: 'draft-page-empty',
    key: 'page.empty',
    name: '',
    functionRef: '',
    implementationType: 'unknown' as const,
    surfaceType: 'unknown' as const,
    stateSummary: '',
    scrollableRegions: [],
  };
  return {
    ...current,
    currentPageId: nextPage?.id || emptyPage.id,
    currentFrameId: nextPage?.frameIds.at(-1) || null,
    page: nextPage
      ? { id: nextPage.id, key: nextPage.key, name: nextPage.name, functionRef: nextPage.functionRef, implementationType: nextPage.implementationType, surfaceType: nextPage.surfaceType, stateSummary: nextPage.stateSummary, scrollableRegions: nextPage.scrollableRegions }
      : emptyPage,
    pages,
    elements,
    elementEditRecords: current.elementEditRecords.filter((record) => !removedElementIds.has(record.elementId)),
    transitions: current.transitions.filter((transition) => transition.sourcePageId !== pageId && transition.targetPageId !== pageId && !removedElementIds.has(transition.triggerElementId)),
  };
}

function aggregateUltraRecognitionStatus(modelAStatus?: RecognitionActivity['status'], modelBStatus?: RecognitionActivity['status']): RecognitionActivity['status'] {
  const statuses = [modelAStatus, modelBStatus].filter(Boolean) as RecognitionActivity['status'][];
  if (statuses.some((status) => status === 'running')) return 'running';
  if (statuses.some((status) => status === 'cancelling')) return 'cancelling';
  if (statuses.some((status) => status === 'paused')) return 'paused';
  if (statuses.some((status) => status === 'error')) return 'error';
  if (statuses.some((status) => status === 'cancelled')) return 'cancelled';
  return 'completed';
}

function pageContentSignature(draft: Draft, pageId: string) {
  const page = draft.pages.find((candidate) => candidate.id === pageId);
  if (!page) return '';
  const { publishedAt: _publishedAt, ...pageContent } = page;
  const elements = draft.elements.filter((element) => element.pageId === pageId || element.availableOnPageIds.includes(pageId));
  const transitions = draft.transitions.filter((transition) => transition.sourcePageId === pageId || transition.targetPageId === pageId);
  return JSON.stringify({ page: pageContent, elements, transitions });
}

function invalidateChangedPagePublications(previous: Draft, next: Draft): Draft {
  const pages = next.pages.map((page) => {
    const previousPage = previous.pages.find((candidate) => candidate.id === page.id);
    if (!page.publishedAt || !previousPage?.publishedAt) return page;
    return pageContentSignature(previous, page.id) === pageContentSignature(next, page.id) ? page : { ...page, publishedAt: null };
  });
  return pages.some((page, index) => page !== next.pages[index]) ? { ...next, pages } : next;
}

const emptyDevice: DeviceState = { online: false, session: null, runtimeInfo: null, targets: [] };

function createEmptyWorkingPage(): DraftPage {
  return {
    id: 'draft-page-current',
    key: 'page.current',
    name: '当前页面',
    functionRef: '',
    implementationType: 'unknown',
    surfaceType: 'unknown',
    stateSummary: '',
    scrollableRegions: [],
    featurePath: [],
    frameIds: [],
    elementIds: [],
    publishedAt: null,
  };
}

const editableElementFields: Array<keyof DraftElement> = [
  'label', 'elementType', 'visualDescription', 'displayCondition', 'capabilities', 'actionEffects', 'state', 'parentId',
  'ownerKind', 'ownerRef', 'pageId', 'availableOnPageIds', 'interactionBoundary', 'bbox', 'gridColumns', 'gridRows', 'gridRegion',
];

function editableElementValuesEqual(current: DraftElement, initial: DraftElement) {
  return editableElementFields.every((field) => {
    if (field === 'capabilities' || field === 'availableOnPageIds') {
      const currentValues = [...(current[field] as string[])].sort();
      const initialValues = [...(initial[field] as string[])].sort();
      return JSON.stringify(currentValues) === JSON.stringify(initialValues);
    }
    return JSON.stringify(current[field]) === JSON.stringify(initial[field]);
  });
}

function pausedUltraModelAActivity(session: RecognitionResumeSession): RecognitionActivity {
  const manuallyInterrupted = session.errorMessage === '用户中断 Model A';
  return {
    status: 'paused',
    phase: 'paused',
    phaseMessage: manuallyInterrupted ? 'Model A 已中断，可从断点继续' : '自动续写 5 次仍未完成，可从断点继续',
    reasoningContent: session.reasoningContent || '',
    outputContent: session.outputContent || '',
    errorMessage: manuallyInterrupted ? undefined : session.errorMessage,
    resumeSessionId: session.id,
    resumeKind: 'ultra_a',
    completedCandidates: session.completedCandidates,
    startedAt: session.createdAt,
    modelAStartedAt: session.createdAt,
    modelAStatus: 'paused',
    modelAPhaseMessage: manuallyInterrupted ? 'Model A 已中断，可从断点继续' : 'Model A 已暂停，可从断点继续',
    modelAResumeSessionId: session.id,
  };
}

function pausedManualRecognitionActivity(session: RecognitionResumeSession): RecognitionActivity {
  const manuallyInterrupted = session.errorMessage === '用户中断 Manual 页面识别模型';
  return {
    status: 'paused',
    phase: 'paused',
    phaseMessage: manuallyInterrupted ? '页面识别已中断，可从断点继续' : '自动续写 5 次仍未完成，可从断点继续',
    reasoningContent: session.reasoningContent || '',
    outputContent: session.outputContent || '',
    errorMessage: manuallyInterrupted ? undefined : session.errorMessage,
    resumeSessionId: session.id,
    resumeKind: 'manual',
    completedCandidates: session.completedCandidates,
    startedAt: session.createdAt,
  };
}

function pausedUltraModelBActivity(session: RecognitionResumeSession): RecognitionActivity {
  return {
    status: 'paused',
    phase: 'ultra-b-paused',
    phaseMessage: 'Model B 已中断，可从断点继续',
    reasoningContent: session.reasoningContent || '',
    outputContent: session.outputContent || '',
    errorMessage: undefined,
    resumeSessionId: session.id,
    resumeKind: 'ultra_b',
    modelBStatus: 'paused',
    modelBPhaseMessage: 'Model B 已中断，可从断点继续',
    modelBResumeSessionId: session.id,
    startedAt: session.createdAt,
    modelBStartedAt: session.createdAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formatRecognitionSchemaError(error: unknown): string | null {
  if (typeof error === 'string') return error.trim() || null;
  if (!isRecord(error)) return null;
  const instancePath = typeof error.instancePath === 'string' ? error.instancePath : '';
  const message = typeof error.message === 'string' ? error.message : '';
  const params = isRecord(error.params) ? error.params : {};
  if (error.keyword === 'required' && typeof params.missingProperty === 'string') {
    return `${instancePath || '根对象'}：缺少必填属性「${params.missingProperty}」`;
  }
  if (message) return `${instancePath || '根对象'}：${message}`;
  return null;
}

function recognitionErrorInfo(error: unknown): { message: string; details: string[] } {
  const message = error instanceof Error ? error.message : String(error);
  const payload = error instanceof Error && isRecord((error as Error & { details?: unknown }).details)
    ? (error as Error & { details: Record<string, unknown> }).details
    : {};
  const nested = isRecord(payload.details) ? payload.details : {};
  const schemaErrors = Array.isArray(payload.schemaErrors) ? payload.schemaErrors : Array.isArray(nested.schemaErrors) ? nested.schemaErrors : [];
  const consistencyIssues = Array.isArray(payload.consistencyIssues) ? payload.consistencyIssues : Array.isArray(nested.consistencyIssues) ? nested.consistencyIssues : [];
  const normalizationIssues = Array.isArray(payload.normalizationIssues) ? payload.normalizationIssues : Array.isArray(nested.normalizationIssues) ? nested.normalizationIssues : [];
  const details = [
    ...schemaErrors.map((item) => {
      const formatted = formatRecognitionSchemaError(item);
      return formatted ? `结构检查：${formatted}` : null;
    }),
    ...consistencyIssues.map((item) => typeof item === 'string' && item.trim() ? `一致性检查：${item.trim()}` : null),
    ...normalizationIssues.map((item) => typeof item === 'string' && item.trim() ? `归一化检查：${item.trim()}` : null),
  ].filter((item): item is string => Boolean(item));
  return { message, details: [...new Set(details)] };
}

interface InternalTabBarProps {
  tabs: InternalTab[];
  activeTabId: string;
  dirtyTabIds: Set<string>;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onUploadPage: () => void;
  onCreateFromDevice: () => void;
}

function InternalTabBar({ tabs, activeTabId, dirtyTabIds, onSelectTab, onCloseTab, onUploadPage, onCreateFromDevice }: InternalTabBarProps) {
  const navRef = useRef<HTMLElement>(null);
  const fixedGroupRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const [visiblePageCount, setVisiblePageCount] = useState(MAX_PAGE_TABS);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const fixedTabs = tabs
    .filter((tab) => tab.kind !== 'annotation')
    .sort((left, right) => ['knowledge', 'workspace', 'model', 'settings'].indexOf(left.kind) - ['knowledge', 'workspace', 'model', 'settings'].indexOf(right.kind));
  const pageTabs = tabs.filter((tab) => tab.kind === 'annotation');

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return undefined;
    const updateVisibleCount = () => {
      const fixedWidth = fixedGroupRef.current?.offsetWidth || 0;
      const actionsWidth = actionsRef.current?.offsetWidth || 0;
      const availableWidth = Math.max(0, nav.clientWidth - fixedWidth - actionsWidth - 30);
      setVisiblePageCount(Math.min(MAX_PAGE_TABS, Math.max(0, Math.floor(availableWidth / 104))));
    };
    const observer = new ResizeObserver(updateVisibleCount);
    observer.observe(nav);
    if (fixedGroupRef.current) observer.observe(fixedGroupRef.current);
    if (actionsRef.current) observer.observe(actionsRef.current);
    updateVisibleCount();
    return () => observer.disconnect();
  }, [fixedTabs.length, pageTabs.length]);

  useEffect(() => {
    const closePopoversOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      const menuAnchor = target instanceof Element ? target.closest('.internal-tab-menu-anchor') : null;
      if (menuAnchor && navRef.current?.contains(menuAnchor)) return;
      setOverflowOpen(false);
      setCreateMenuOpen(false);
    };
    document.addEventListener('pointerdown', closePopoversOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closePopoversOnOutsidePointer);
  }, []);

  let visiblePageTabs = pageTabs.slice(0, visiblePageCount);
  const activePageTab = pageTabs.find((tab) => tab.id === activeTabId);
  if (activePageTab && visiblePageCount > 0 && !visiblePageTabs.some((tab) => tab.id === activePageTab.id)) {
    visiblePageTabs = [...visiblePageTabs.slice(0, -1), activePageTab];
  }
  const visiblePageIds = new Set(visiblePageTabs.map((tab) => tab.id));
  const hiddenPageTabs = pageTabs.filter((tab) => !visiblePageIds.has(tab.id));

  const tabIcon = (tab: InternalTab) => tab.kind === 'knowledge'
    ? <img className="internal-tab-icon internal-tab-icon-knowledge" src="/graphrag-line-icon.svg?v=4" alt="" />
    : tab.kind === 'workspace'
      ? <PanelsTopLeft size={14} />
      : tab.kind === 'model'
        ? <Braces size={14} />
      : tab.kind === 'settings'
        ? <Settings2 size={14} />
        : <Camera size={14} />;
  const renderTab = (tab: InternalTab, group: 'fixed' | 'page') => <div key={tab.id} className={`internal-tab internal-tab-${group} ${dirtyTabIds.has(tab.id) ? 'dirty' : ''} ${activeTabId === tab.id ? 'active' : ''}`} role="presentation">
    <button type="button" role="tab" aria-selected={activeTabId === tab.id} className="internal-tab-select" onClick={() => { setOverflowOpen(false); setCreateMenuOpen(false); onSelectTab(tab.id); }}>
      {tabIcon(tab)}
      <span>{tab.title}</span>
      {tab.annotationTarget && <code>{tab.annotationTarget.pageId.slice(-6)}</code>}
    </button>
    {(tab.kind === 'annotation' || tab.kind === 'settings' || tab.kind === 'model') && <button type="button" className="icon-button internal-tab-close" aria-label={`关闭 ${tab.title} 标签页`} title="关闭标签页" onClick={() => onCloseTab(tab.id)}><X size={13} /></button>}
    {tab.kind === 'annotation' && tab.annotationTarget?.frameId && <div className="internal-tab-preview" role="tooltip">
      <img src={absoluteAssetUrl(`/workbench/api/frames/${encodeURIComponent(tab.annotationTarget.frameId)}/image`)} alt={`${tab.title}页面预览`} />
      <strong>{tab.title}</strong>
    </div>}
  </div>;

  return <nav ref={navRef} className="internal-tabs" aria-label="工作台标签页" role="tablist">
    <div ref={fixedGroupRef} className="internal-tab-group internal-tab-group-fixed">{fixedTabs.map((tab) => renderTab(tab, 'fixed'))}</div>
    <span className="internal-tab-group-divider" aria-hidden="true" />
    <div className="internal-tab-group internal-tab-group-pages">{visiblePageTabs.map((tab) => renderTab(tab, 'page'))}</div>
    <div ref={actionsRef} className="internal-tab-actions">
      {hiddenPageTabs.length > 0 && <div className="internal-tab-menu-anchor">
        <button type="button" className="icon-button internal-tab-overflow" aria-label="更多页面标签" title="更多页面标签" onClick={() => { setOverflowOpen((value) => !value); setCreateMenuOpen(false); }}><ChevronDown size={15} /></button>
        {overflowOpen && <div className="internal-tab-popover internal-tab-overflow-menu" role="menu">
          {hiddenPageTabs.map((tab) => <div key={tab.id} className={activeTabId === tab.id ? 'active' : ''}><button type="button" role="menuitem" onClick={() => { setOverflowOpen(false); onSelectTab(tab.id); }}><Camera size={14} /><span>{tab.title}</span></button><button type="button" className="icon-button" aria-label={`关闭 ${tab.title} 标签页`} onClick={() => onCloseTab(tab.id)}><X size={13} /></button></div>)}
        </div>}
      </div>}
      <div className="internal-tab-menu-anchor">
        <button type="button" className="icon-button internal-tab-create" aria-label="创建页面对象" title="创建页面对象" onClick={() => { setCreateMenuOpen((value) => !value); setOverflowOpen(false); }}><Plus size={17} /></button>
        {createMenuOpen && <div className="internal-tab-popover internal-tab-create-menu" role="menu" aria-label="创建页面对象方式">
          <button type="button" role="menuitem" onClick={() => { setCreateMenuOpen(false); onUploadPage(); }}><ImageUp size={15} /><span>上传图片</span></button>
          <button type="button" role="menuitem" onClick={() => { setCreateMenuOpen(false); onCreateFromDevice(); }}><Smartphone size={15} /><span>使用设备帧</span></button>
        </div>}
      </div>
    </div>
  </nav>;
}

interface AppContentProps {
  tabId: string;
  tabTitle: string;
  tabKind: InternalTabKind;
  annotationTarget: AnnotationTarget | null;
  annotationSessionId: string;
  recoveryDraft: Draft | null;
  pageNameOverrides: Record<string, string>;
  active: boolean;
  tabRefreshKey: number;
  onOpenAnnotationTab: (pageId: string, frameId: string, title?: string) => void;
  onOpenDeviceAnnotationTab: () => void;
  onOpenSettingsTab: () => void;
  onOpenModelTab: () => void;
  onPromoteAnnotationTab: (tabId: string, pageId: string, frameId: string, title?: string) => void;
  onRenameAnnotationTab: (tabId: string, title: string) => void;
  onPageNameChange: (pageId: string, name: string | null) => void;
  tabs: InternalTab[];
  activeTabId: string;
  dirtyTabIds: Set<string>;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onTabDirtyChange: (tabId: string, dirty: boolean) => void;
  onRegisterSaveHandler: (tabId: string, handler: (() => Promise<boolean>) | null) => void;
}

function AppContent({ tabId, tabTitle, tabKind, annotationTarget, annotationSessionId, recoveryDraft, pageNameOverrides, active, tabRefreshKey, onOpenAnnotationTab, onOpenDeviceAnnotationTab, onOpenSettingsTab, onOpenModelTab, onPromoteAnnotationTab, onRenameAnnotationTab, onPageNameChange, tabs, activeTabId, dirtyTabIds, onSelectTab, onCloseTab, onTabDirtyChange, onRegisterSaveHandler }: AppContentProps) {
  const deviceClient = useMemo(() => new DeviceClient(serverUrl), []);
  const [status, setStatus] = useState<WorkbenchStatus | null>(null);
  const [device, setDevice] = useState<DeviceState>(emptyDevice);
  const [selectedDevice, setSelectedDevice] = useState('');
  const [deviceDiscoveryError, setDeviceDiscoveryError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([]);
  const [frame, setFrame] = useState<FrameMetadata | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(() => annotationTarget ? 'review' : 'live');
  const [sideTab, setSideTab] = useState<SideTab>('elements');
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(() => tabKind === 'workspace' ? 'graph' : tabKind === 'knowledge' ? 'knowledge' : 'annotation');
  const [explorationMode, setExplorationMode] = useState<ExplorationMode>(() => {
    const savedMode = window.localStorage.getItem('uikg-exploration-mode');
    return savedMode === 'manual' || savedMode === 'ai_assist' ? 'manual' : 'ultra';
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [multiSelect, setMultiSelect] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [drawing, setDrawing] = useState(false);
  const [showRejected, setShowRejected] = useState(false);
  const [showGridGuides, setShowGridGuides] = useState(() => window.localStorage.getItem('uikg-workbench.annotation.show-grid-guides') !== 'false');
  const [duplicateCandidateKeyFilter, setDuplicateCandidateKeyFilter] = useState<string | null>(null);
  const [pageNameEditing, setPageNameEditing] = useState(false);
  const [pageNameDraft, setPageNameDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [autoSaveState, setAutoSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [pageUploadOpen, setPageUploadOpen] = useState(false);
  const [transferCenterOpen, setTransferCenterOpen] = useState(false);
  const [recognitionControlBusy, setRecognitionControlBusy] = useState<'ultra-a' | 'ultra-b' | null>(null);
  const [notice, setNotice] = useState<{ type: 'info' | 'error' | 'success'; text: string } | null>(null);
  const [modelActivity, setRecognitionActivity] = useState<RecognitionActivity | null>(null);
  const [recognitionDialogOpen, setRecognitionDialogOpen] = useState(false);
  const [pendingRecognitionReplacement, setPendingRecognitionReplacement] = useState<PendingRecognitionReplacement | null>(null);
  const [completedRecognitionReplacement, setCompletedRecognitionReplacement] = useState<PendingRecognitionReplacement | null>(null);
  const [recognitionReplacementBusy, setRecognitionReplacementBusy] = useState(false);
  const [analysisSessions, setAnalysisSessions] = useState<AnalysisSession[]>([]);
  const [ultraModelComparison, setUltraModelComparison] = useState<{ modelAResult: RecognitionResult; modelBResult: RecognitionResult; modelResultRef: string } | null>(null);
  const [ultraModelCandidatePortal, setUltraModelCandidatePortal] = useState<HTMLDivElement | null>(null);
  const [staging, setStaging] = useState<StagingResult | null>(null);
  const [stagingVersions, setStagingVersions] = useState<StagingResult[]>([]);
  const [elementActivities, setElementActivities] = useState<ElementActivityRecord[]>([]);
  const draftRef = useRef<Draft | null>(null);
  const pastRef = useRef<Draft[]>([]);
  const futureRef = useRef<Draft[]>([]);
  const historyGroupRef = useRef<string | null>(null);
  const initialElementsRef = useRef(new Map<string, DraftElement>());
  const initialAllElementsRef = useRef<DraftElement[]>([]);
  const initialElementEditRecordsRef = useRef<ElementEditRecord[]>([]);
  const elementActivitiesRef = useRef<ElementActivityRecord[]>([]);
  const preAcceptStatusRef = useRef(new Map<string, DraftElement['reviewStatus']>());
  const preRejectStatusRef = useRef(new Map<string, DraftElement['reviewStatus']>());
  const connectionRefreshInFlightRef = useRef(false);
  const activeRef = useRef(active);
  const autoSaveInFlightRef = useRef(false);
  const autoSaveQueuedRef = useRef(false);
  const reviewCompletionRequestedRef = useRef(false);
  const reviewCompletionInFlightRef = useRef(false);
  const annotationEntryDraftRef = useRef<Draft | null>(null);
  const annotationEntryWorkspaceRef = useRef<WorkspaceMode>('annotation');
  const lastSavedDraftRef = useRef<Draft | null>(null);
  const modelAResultRef = useRef<RecognitionResult | null>(null);
  const modelBResultRef = useRef<RecognitionResult | null>(null);
  const ultraReplacementConfirmationRequiredRef = useRef(false);
  const ultraApplyAsReplacementRef = useRef(false);
  const recoveryStorageErrorShownRef = useRef(false);
  const saveCurrentPageRef = useRef<() => Promise<boolean>>(async () => false);

  useEffect(() => {
    if (tabKind === 'annotation') onTabDirtyChange(tabId, dirty);
  }, [dirty, onTabDirtyChange, tabId, tabKind]);

  const issues = useMemo(() => draft ? validateDraftClient(draft) : serverIssues, [draft, serverIssues]);
  const validationIssueGroups = useMemo(() => {
    const grouped = new Map<string, { code: string; level: ValidationIssue['level']; issues: ValidationIssue[] }>();
    for (const issue of issues) {
      const key = `${issue.level}:${issue.code}`;
      const group = grouped.get(key);
      if (group) group.issues.push(issue);
      else grouped.set(key, { code: issue.code, level: issue.level, issues: [issue] });
    }
    return [...grouped.values()].sort((left, right) => {
      if (left.level !== right.level) return left.level === 'error' ? -1 : 1;
      return right.issues.length - left.issues.length || left.code.localeCompare(right.code);
    });
  }, [issues]);
  const selectedElement = draft?.elements.find((element) => element.id === selectedId) || null;
  const initialSelectedElement = selectedId ? initialElementsRef.current.get(selectedId) || null : null;
  const canRestoreSelectedElement = Boolean(selectedElement && initialSelectedElement && JSON.stringify(selectedElement) !== JSON.stringify(initialSelectedElement));
  const canRestoreAllElements = Boolean(draft && JSON.stringify(draft.elements) !== JSON.stringify(initialAllElementsRef.current));
  const currentElements = useMemo(() => draft ? draft.elements.filter((element) => elementAvailableOnPage(element, draft.currentPageId, draft.elements)) : [], [draft]);
  const treeElements = useMemo(() => duplicateCandidateKeyFilter
    ? currentElements.filter((element) => element.candidateKey.trim() === duplicateCandidateKeyFilter)
    : currentElements, [currentElements, duplicateCandidateKeyFilter]);
  const currentPageHasPrivateElements = Boolean(draft?.elements.some((element) => element.pageId === draft.currentPageId));
  const historyBlockedForPendingPage = Boolean(draft?.currentFrameId && !currentPageHasPrivateElements && draft.pages.find((page) => page.id === draft.currentPageId)?.frameIds.includes(draft.currentFrameId));
  const allCurrentChecked = treeElements.length > 0 && treeElements.every((element) => checkedIds.has(element.id));
  const checkedCurrentElements = treeElements.filter((element) => checkedIds.has(element.id));
  const allCheckedAccepted = checkedCurrentElements.length > 0 && checkedCurrentElements.every((element) => element.reviewStatus === 'accepted');
  const frameUrl = draft?.currentFrameId
    ? absoluteAssetUrl(`/workbench/api/frames/${encodeURIComponent(draft.currentFrameId)}/image`)
    : null;
  const pageGraphDraft = useMemo(() => {
    if (!draft || Object.keys(pageNameOverrides).length === 0) return draft;
    const pages = draft.pages.map((page) => Object.prototype.hasOwnProperty.call(pageNameOverrides, page.id)
      ? { ...page, name: pageNameOverrides[page.id] }
      : page);
    const currentPage = pages.find((page) => page.id === draft.currentPageId);
    return currentPage
      ? { ...draft, pages, page: { ...draft.page, name: currentPage.name } }
      : { ...draft, pages };
  }, [draft, pageNameOverrides]);
  const pageHistorySessions = useMemo(() => {
    if (!draft) return [];
    const currentPage = draft.pages.find((page) => page.id === draft.currentPageId);
    if (!currentPage) return [];
    // Page IDs are authoritative. Falling back to frame IDs makes identical screenshots
    // from different pages appear in the current page's history.
    return analysisSessions.filter((session) => session.pageId === draft.currentPageId);
  }, [analysisSessions, draft]);
  const hasAnalyzedCurrentFrame = Boolean(draft?.currentFrameId && pageHistorySessions.some((session) => session.frameId === draft.currentFrameId && session.status !== 'running'));
  const acceptedHistorySessionId = useMemo(() => {
    if (!draft?.rawModelResultRef) return null;
    return pageHistorySessions.find((session) => draft.rawModelResultRef?.includes(session.id))?.id || null;
  }, [pageHistorySessions, draft?.rawModelResultRef]);

  const refreshAnalysisSessions = async () => {
    try {
      setAnalysisSessions((await workbenchApi.sessions()).sessions);
    } catch {}
  };

  const showNotice = (type: 'info' | 'error' | 'success', text: string) => {
    setNotice({ type, text });
    window.setTimeout(() => setNotice((current) => current?.text === text ? null : current), 4200);
  };

  useEffect(() => {
    if (tabKind !== 'annotation' || !draft) return;
    if (!dirty) {
      removeUnsavedAnnotationRecovery(tabId);
      return;
    }
    const effectiveTarget = annotationTarget || (draft.currentPageId && draft.currentPageId !== 'draft-page-empty'
      ? { pageId: draft.currentPageId, frameId: draft.currentFrameId, sessionId: annotationSessionId }
      : null);
    const stored = upsertUnsavedAnnotationRecovery({
      version: 1,
      tabId,
      title: draft.page.name || tabTitle || '未保存页面',
      sessionId: annotationSessionId,
      annotationTarget: effectiveTarget,
      draft,
      savedAt: new Date().toISOString(),
    });
    if (!stored && !recoveryStorageErrorShownRef.current) {
      recoveryStorageErrorShownRef.current = true;
      showNotice('error', '未保存内容无法写入浏览器恢复存储，请尽快保存页面');
    }
  }, [annotationSessionId, annotationTarget, dirty, draft, tabId, tabKind, tabTitle]);

  useEffect(() => {
    if (tabKind !== 'annotation' || !dirty || !draft) return undefined;
    const persistBeforeClose = () => {
      const latest = draftRef.current;
      if (!latest) return;
      const effectiveTarget = annotationTarget || (latest.currentPageId && latest.currentPageId !== 'draft-page-empty'
        ? { pageId: latest.currentPageId, frameId: latest.currentFrameId, sessionId: annotationSessionId }
        : null);
      upsertUnsavedAnnotationRecovery({
        version: 1,
        tabId,
        title: latest.page.name || tabTitle || '未保存页面',
        sessionId: annotationSessionId,
        annotationTarget: effectiveTarget,
        draft: latest,
        savedAt: new Date().toISOString(),
      });
    };
    window.addEventListener('beforeunload', persistBeforeClose);
    return () => window.removeEventListener('beforeunload', persistBeforeClose);
  }, [annotationSessionId, annotationTarget, dirty, draft, tabId, tabKind, tabTitle]);

  const changeExplorationMode = async (nextMode: ExplorationMode) => {
    const previousMode = explorationMode;
    setExplorationMode(nextMode);
    try {
      await workbenchApi.saveModelMode(nextMode);
      window.dispatchEvent(new CustomEvent('uikg-mode-change', { detail: nextMode }));
    } catch (error) {
      setExplorationMode(previousMode);
      showNotice('error', error instanceof Error ? error.message : String(error));
    }
  };

  const cloneDraft = (value: Draft) => structuredClone(value);

  const resetDraftState = (nextDraft: Draft, markDirty = false, preserveActivities = false) => {
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    setDirty(markDirty);
    if (!annotationEntryDraftRef.current
      || annotationEntryDraftRef.current.currentPageId !== nextDraft.currentPageId
      || annotationEntryDraftRef.current.currentFrameId !== nextDraft.currentFrameId) {
      annotationEntryDraftRef.current = structuredClone(nextDraft);
    }
    lastSavedDraftRef.current = structuredClone(nextDraft);
    pastRef.current = [];
    futureRef.current = [];
    historyGroupRef.current = null;
    initialElementsRef.current = new Map(nextDraft.elements.map((element) => [element.id, structuredClone(element)]));
    initialAllElementsRef.current = structuredClone(nextDraft.elements);
    initialElementEditRecordsRef.current = structuredClone(nextDraft.elementEditRecords);
    if (!preserveActivities) {
      const restoredActivities = nextDraft.elementEditRecords.map((record) => {
        const element = nextDraft.elements.find((candidate) => candidate.id === record.elementId);
        return {
          id: `existing-${record.elementId}-${record.editedAt}`,
          action: record.kind === 'created' ? '已有新建记录' : '已有编辑记录',
          createdAt: record.editedAt,
          elementIds: [record.elementId],
          elementLabels: element ? [element.label] : [],
          fields: record.fields,
        } satisfies ElementActivityRecord;
      }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      elementActivitiesRef.current = restoredActivities;
      setElementActivities(restoredActivities);
    }
    preAcceptStatusRef.current.clear();
    preRejectStatusRef.current.clear();
    setCheckedIds(new Set());
    setStaging(null);
  };

  useEffect(() => {
    if (tabKind !== 'workspace' || !active || tabRefreshKey === 0 || dirty) return;
    let cancelled = false;
    void workbenchApi.draft().then((result) => {
      if (cancelled) return;
      resetDraftState(structuredClone(result.draft), false, true);
      setServerIssues(result.issues);
    }).catch((error) => {
      if (!cancelled) showNotice('error', `工作台数据刷新失败：${error instanceof Error ? error.message : String(error)}`);
    });
    return () => { cancelled = true; };
  }, [active, dirty, tabKind, tabRefreshKey]);

  const endHistoryGroup = () => {
    historyGroupRef.current = null;
  };

  const summarizeElementChanges = (before: Draft, after: Draft) => {
    const beforeById = new Map(before.elements.map((element) => [element.id, element]));
    const afterById = new Map(after.elements.map((element) => [element.id, element]));
    const elementIds = [...new Set([...before.elements.map((element) => element.id), ...after.elements.map((element) => element.id)])];
    const fields = new Set<string>();
    const changedIds: string[] = [];
    const labels: string[] = [];
    const comparedFields: Array<keyof DraftElement> = [...editableElementFields, 'reviewStatus', 'source', 'childrenIds'];
    for (const id of elementIds) {
      const previous = beforeById.get(id);
      const next = afterById.get(id);
      if (!previous && next) { fields.add('added'); changedIds.push(id); labels.push(next.label); continue; }
      if (previous && !next) { fields.add('removed'); changedIds.push(id); labels.push(previous.label); continue; }
      if (!previous || !next) continue;
      const changedFields = comparedFields.filter((field) => {
        if (field === 'capabilities' || field === 'availableOnPageIds' || field === 'childrenIds') {
          return JSON.stringify([...(previous[field] as string[])].sort()) !== JSON.stringify([...(next[field] as string[])].sort());
        }
        return JSON.stringify(previous[field]) !== JSON.stringify(next[field]);
      });
      if (changedFields.length > 0) {
        changedIds.push(id);
        labels.push(next.label);
        changedFields.forEach((field) => fields.add(field));
      }
    }
    return { elementIds: changedIds, elementLabels: labels, fields: [...fields] };
  };

  const appendElementActivity = (action: string, before: Draft, after: Draft, groupKey?: string, mergeWithLatest = false) => {
    const changes = summarizeElementChanges(before, after);
    if (changes.elementIds.length === 0) return;
    const now = new Date().toISOString();
    const previousActivities = elementActivitiesRef.current;
    let nextActivities: ElementActivityRecord[];
    if (mergeWithLatest && groupKey && previousActivities[0]?.groupKey === groupKey && previousActivities[0]?.action === action) {
      nextActivities = [{ ...previousActivities[0], createdAt: now, elementIds: changes.elementIds, elementLabels: changes.elementLabels, fields: changes.fields }, ...previousActivities.slice(1)];
    } else {
      nextActivities = [{ id: `activity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, action, createdAt: now, ...changes, ...(groupKey ? { groupKey } : {}) }, ...previousActivities].slice(0, 500);
    }
    elementActivitiesRef.current = nextActivities;
    setElementActivities(nextActivities);
  };

  const commitDraft = (updater: (current: Draft) => Draft, historyKey?: string, activityLabel = '编辑元素') => {
    const current = draftRef.current;
    if (!current) return;
    const next = invalidateChangedPagePublications(current, updater(current));
    if (next === current) return;
    const mergeActivity = Boolean(historyKey && historyGroupRef.current === historyKey);
    if (!historyKey || historyGroupRef.current !== historyKey) {
      pastRef.current = [...pastRef.current.slice(-99), cloneDraft(current)];
      futureRef.current = [];
      historyGroupRef.current = historyKey || null;
    }
    draftRef.current = next;
    setDraft(next);
    setDirty(true);
    setStaging(null);
    appendElementActivity(activityLabel, current, next, historyKey, mergeActivity);
  };

  const undo = () => {
    const current = draftRef.current;
    const previous = pastRef.current.at(-1);
    if (!current || !previous || historyBlockedForPendingPage) return;
    appendElementActivity('撤销', current, previous);
    endHistoryGroup();
    pastRef.current = pastRef.current.slice(0, -1);
    futureRef.current = [cloneDraft(current), ...futureRef.current].slice(0, 100);
    draftRef.current = previous;
    setDraft(previous);
    setDirty(true);
  };

  const redo = () => {
    const current = draftRef.current;
    const next = futureRef.current[0];
    if (!current || !next || historyBlockedForPendingPage) return;
    appendElementActivity('取消撤销', current, next);
    endHistoryGroup();
    futureRef.current = futureRef.current.slice(1);
    pastRef.current = [...pastRef.current.slice(-99), cloneDraft(current)];
    draftRef.current = next;
    setDraft(next);
    setDirty(true);
  };

  const refreshConnection = useCallback(async (forceTargetRefresh = false) => {
    if (connectionRefreshInFlightRef.current) return;
    connectionRefreshInFlightRef.current = true;
    try {
      const online = await deviceClient.checkStatus();
      if (!online) throw new Error('设备服务未启动，请使用 pnpm dev 同时启动前端和设备服务');
      const [workbenchStatus, session, targets] = await Promise.all([
        workbenchApi.status(annotationSessionId),
        deviceClient.getSessionInfo(),
        deviceClient.listSessionTargets(forceTargetRefresh),
      ]);
      const sessionDeviceId = typeof session?.metadata?.deviceId === 'string' ? session.metadata.deviceId : null;
      const currentDeviceAvailable = Boolean(
        workbenchStatus.agentConnected
        && session?.connected
        && sessionDeviceId
        && targets.some((target) => target.id === sessionDeviceId),
      );
      const runtimeInfo = currentDeviceAvailable ? await deviceClient.getRuntimeInfo() : null;
      setStatus(currentDeviceAvailable ? workbenchStatus : { ...workbenchStatus, agentConnected: false });
      if (workbenchStatus.manualSession) {
        setRecognitionActivity((current) => current || pausedManualRecognitionActivity(workbenchStatus.manualSession!));
      }
      if (workbenchStatus.ultraModelASession) {
        setRecognitionActivity((current) => current || pausedUltraModelAActivity(workbenchStatus.ultraModelASession!));
      }
      if (workbenchStatus.ultraModelBSession) {
        setRecognitionActivity((current) => current || pausedUltraModelBActivity(workbenchStatus.ultraModelBSession!));
      }
      setDevice({ online, session: currentDeviceAvailable ? session : null, runtimeInfo, targets });
      setDeviceDiscoveryError(null);
      setSelectedDevice((current) => targets.some((target) => target.id === current) ? current : targets[0]?.id || '');
    } catch (error) {
      setDevice((current) => ({ ...current, online: false }));
      const message = error instanceof Error ? error.message : String(error);
      setDeviceDiscoveryError(message);
      showNotice('error', message);
    } finally {
      connectionRefreshInFlightRef.current = false;
    }
  }, [annotationSessionId, deviceClient]);

  useEffect(() => {
    activeRef.current = active;
    if (active) void refreshConnection(true);
  }, [active, refreshConnection]);

  useEffect(() => {
    Promise.all([
      refreshConnection(),
      workbenchApi.draft(),
      workbenchApi.recognitionSession('manual', annotationSessionId),
      workbenchApi.recognitionSession('ultra_a', annotationSessionId),
      workbenchApi.recognitionSession('ultra_b', annotationSessionId),
      workbenchApi.sessions(),
      workbenchApi.modelSettings(),
    ])
      .then(([, result, manualSessionResult, modelASessionResult, modelBSessionResult, sessionHistory, modelSettings]) => {
        const targetedDraft = annotationTarget ? draftForAnnotationTarget(result.draft, annotationTarget) : null;
        const loadedDraft = recoveryDraft || targetedDraft || result.draft;
        resetDraftState(structuredClone(loadedDraft), Boolean(recoveryDraft));
        if (recoveryDraft || targetedDraft) {
          setWorkspaceMode('annotation');
          setViewMode(loadedDraft.currentFrameId ? 'review' : 'live');
        } else if (annotationTarget) {
          showNotice('error', '链接中的标注页面不存在或已被删除');
        }
        setServerIssues(result.issues);
        if (manualSessionResult.session) setRecognitionActivity(pausedManualRecognitionActivity(manualSessionResult.session));
        else if (modelBSessionResult.session) setRecognitionActivity(pausedUltraModelBActivity(modelBSessionResult.session));
        else if (modelASessionResult.session) setRecognitionActivity(pausedUltraModelAActivity(modelASessionResult.session));
        setAnalysisSessions(sessionHistory.sessions);
        const configuredMode = modelSettings.modeConfiguration?.mode;
        if (configuredMode === 'manual' || configuredMode === 'ultra') setExplorationMode(configuredMode);
      })
      .catch((error) => showNotice('error', error instanceof Error ? error.message : String(error)));
    const timer = window.setInterval(() => {
      if (activeRef.current) void refreshConnection(true);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [recoveryDraft, refreshConnection]);

  useEffect(() => {
    window.localStorage.setItem('uikg-exploration-mode', explorationMode);
  }, [explorationMode]);

  useEffect(() => {
    window.localStorage.setItem('uikg-workbench.annotation.show-grid-guides', String(showGridGuides));
  }, [showGridGuides]);

  useEffect(() => {
    const syncConfiguredMode = (event: Event) => {
      const configuredMode = (event as CustomEvent<ExplorationMode>).detail;
      if (configuredMode === 'manual' || configuredMode === 'ultra') setExplorationMode(configuredMode);
    };
    window.addEventListener('uikg-mode-change', syncConfiguredMode);
    return () => window.removeEventListener('uikg-mode-change', syncConfiguredMode);
  }, []);

  useEffect(() => {
    if (duplicateCandidateKeyFilter && treeElements.length < 2) setDuplicateCandidateKeyFilter(null);
  }, [duplicateCandidateKeyFilter, treeElements.length]);

  useEffect(() => {
    if (workspaceMode !== 'staging') return;
    workbenchApi.stagingVersions()
      .then(({ versions }) => {
        setStagingVersions(versions);
        setStaging((current) => current ? versions.find((version) => version.stageId === current.stageId) || current : versions[0] || null);
      })
      .catch((error) => showNotice('error', error instanceof Error ? error.message : String(error)));
  }, [workspaceMode]);

  const showInitialLiveView = () => {
    endHistoryGroup();
    setViewMode('live');
    setSelectedId(null);
    setCheckedIds(new Set());
    setMultiSelect(false);
    setDrawing(false);
    setShowRejected(false);
    setDuplicateCandidateKeyFilter(null);
    setFrame(null);
    setUltraModelComparison(null);
  };

  const connectDevice = async () => {
    if (!selectedDevice) return;
    setBusy('connect');
    try {
      const result = await deviceClient.createSession(selectedDevice);
      setDevice((current) => ({ ...current, session: result.session, runtimeInfo: result.runtimeInfo }));
      setViewMode('live');
      await refreshConnection();
      showNotice('success', 'Android 设备已连接');
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const disconnectDevice = async () => {
    setBusy('disconnect');
    try {
      await deviceClient.destroySession();
      setDevice((current) => ({ ...current, session: null, runtimeInfo: null }));
      setViewMode('review');
      await refreshConnection();
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const captureFrame = async () => {
    setBusy('freeze');
    try {
      const result = await workbenchApi.freezeFrame(true);

      resetDraftState(result.draft);
      modelAResultRef.current = null;
      modelBResultRef.current = null;
      setUltraModelComparison(null);
      setSelectedId(null);
      setWorkspaceMode('annotation');
      setViewMode('frozen');
      setDrawing(false);
      setFrame(null);
      showNotice('success', '画面已冻结，请确认后开始标注');
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const discardFrozenCapture = async () => {
    const beforeDiscard = draftRef.current;
    const pageId = beforeDiscard?.currentPageId;
    if (!beforeDiscard || !pageId || !beforeDiscard.currentFrameId) {
      showInitialLiveView();
      return;
    }
    setBusy('discard-freeze');
    try {
      const result = await workbenchApi.saveDraft(removePageFromDraft(beforeDiscard, pageId));
      resetDraftState(result.draft, false, true);
      setServerIssues(result.issues);
      showInitialLiveView();
      showNotice('success', '已丢弃当前截图，请重新冻结画面');
    } catch (error) {
      showNotice('error', `丢弃当前截图失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const startAnnotation = () => {
    if (!draft?.currentFrameId) return;
    const page = draft.pages.find((candidate) => candidate.id === draft.currentPageId);
    if (!annotationTarget && page) onPromoteAnnotationTab(tabId, page.id, draft.currentFrameId, page.name || '待识别页面');
    setViewMode('review');
  };

  const startEditingPageName = () => {
    if (!draft || !annotationTarget) return;
    setPageNameDraft(draft.page.name || '');
    setPageNameEditing(true);
  };

  const commitPageName = () => {
    if (!draft || !annotationTarget) return;
    const nextName = pageNameDraft.trim() || draft.page.name || '待识别页面';
    if (nextName !== draft.page.name) {
      updatePage(draft.currentPageId, { name: nextName }, 'page:name');
      onRenameAnnotationTab(tabId, nextName);
      onPageNameChange(draft.currentPageId, nextName);
    }
    endHistoryGroup();
    setPageNameEditing(false);
  };

  const handleRecognitionEvent = (event: { type: string; [key: string]: unknown }) => {
    if (event.type === 'stage') {
      setRecognitionActivity((current) => current ? {
        ...current,
        phase: String(event.phase || current.phase),
        phaseMessage: String(event.message || current.phaseMessage),
        retryAttempt: typeof event.totalAttempt === 'number' ? event.totalAttempt : current.retryAttempt,
        retryLimit: typeof event.retryLimit === 'number' ? event.retryLimit : current.retryLimit,
        ...(event.phase === 'retry' || event.phase === 'resume' ? { outputContent: '', reasoningContent: '' } : {}),
      } : current);
    }
    if (event.type === 'chunk') {
      setRecognitionActivity((current) => current ? {
        ...current,
        phase: current.phase === 'retry' ? 'model' : current.phase,
        phaseMessage: current.phase === 'retry' ? '页面识别模型正在继续输出' : current.phaseMessage,
        reasoningContent: current.reasoningContent + String(event.reasoningContent || ''),
        outputContent: current.outputContent + String(event.content || ''),
      } : current);
    }
  };

  const handleUltraModelAEvent = (event: { type: string; [key: string]: unknown }) => {
    if (event.type === 'stage') {
      setRecognitionActivity((current) => current ? {
        ...current,
        modelAPhaseMessage: String(event.message || current.modelAPhaseMessage || 'Model A 正在分析'),
        retryAttempt: typeof event.totalAttempt === 'number' ? event.totalAttempt : current.retryAttempt,
        retryLimit: typeof event.retryLimit === 'number' ? event.retryLimit : current.retryLimit,
        ...(event.phase === 'retry' || event.phase === 'resume' ? { modelAOutputContent: '', modelAReasoningContent: '' } : {}),
      } : current);
    }
    if (event.type === 'chunk') {
      setRecognitionActivity((current) => current ? {
        ...current,
        phase: current.phase === 'retry' ? 'ultra_a' : current.phase,
        phaseMessage: current.phase === 'retry' ? 'Model A 正在继续输出' : current.phaseMessage,
        modelAPhaseMessage: current.modelAPhaseMessage?.includes('正在重试') ? 'Model A 正在继续输出' : current.modelAPhaseMessage,
        modelAReasoningContent: (current.modelAReasoningContent || '') + String(event.reasoningContent || ''),
        modelAOutputContent: (current.modelAOutputContent || '') + String(event.content || ''),
      } : current);
    }
  };

  const handleUltraModelBEvent = (event: { type: string; [key: string]: unknown }) => {
    if (event.type === 'stage') {
      setRecognitionActivity((current) => current ? {
        ...current,
        modelBPhaseMessage: String(event.message || current.modelBPhaseMessage || 'Model B 正在分析'),
        retryAttempt: typeof event.totalAttempt === 'number' ? event.totalAttempt : current.retryAttempt,
        retryLimit: typeof event.retryLimit === 'number' ? event.retryLimit : current.retryLimit,
        ...(event.phase === 'retry' || event.phase === 'resume' ? { outputContent: '', reasoningContent: '' } : {}),
      } : current);
    }
    if (event.type === 'chunk') {
      setRecognitionActivity((current) => current ? {
        ...current,
        phase: current.phase === 'retry' ? 'ultra_b' : current.phase,
        phaseMessage: current.phase === 'retry' ? 'Model B 正在继续输出' : current.phaseMessage,
        modelBPhaseMessage: current.modelBPhaseMessage?.includes('正在重试') ? 'Model B 正在继续输出' : current.modelBPhaseMessage,
        reasoningContent: current.reasoningContent + String(event.reasoningContent || ''),
        outputContent: current.outputContent + String(event.content || ''),
      } : current);
    }
  };

  const finishManualRecognition = async (result: Awaited<ReturnType<typeof workbenchApi.recognitionStream>>) => {
    if (!result.draft || !result.issues) {
      setCompletedRecognitionReplacement({ kind: 'manual', result });
      setStatus((current) => current ? { ...current, manualSession: null } : current);
      setRecognitionActivity((current) => current ? { ...current, status: 'completed', phase: 'replacement-pending', phaseMessage: '新的页面识别结果已完成，等待确认是否替换', errorMessage: undefined, completedAt: new Date().toISOString(), resumeSessionId: undefined, resumeKind: undefined } : current);
      await refreshAnalysisSessions();
      return;
    }
    resetDraftState(result.draft);
    setServerIssues(result.issues);
    setSelectedId(result.draft.elements[0]?.id || null);
    setStatus((current) => current ? { ...current, manualSession: null } : current);
    setRecognitionActivity((current) => current ? { ...current, status: 'completed', phase: 'complete', phaseMessage: '页面识别完成', errorMessage: undefined, completedAt: new Date().toISOString(), resumeSessionId: undefined, resumeKind: undefined } : current);
    showNotice('success', `已识别 ${result.draft.elements.length} 个候选元素`);
    await refreshAnalysisSessions();
  };

  const retryUltraModelB = async () => {
    const currentDraft = draftRef.current;
    if (!currentDraft?.currentFrameId) return;
    ultraApplyAsReplacementRef.current = false;
    ultraReplacementConfirmationRequiredRef.current = currentDraft.elements.some((element) => element.pageId === currentDraft.currentPageId) || Boolean(currentDraft.rawModelResultRef);
    setRecognitionControlBusy('ultra-b');
    setRecognitionDialogOpen(true);
    setUltraModelComparison(null);
    setRecognitionActivity((current) => current ? { ...current, status: 'running', modelBStatus: 'running', phase: 'ultra_b', phaseMessage: 'Model B 正在重新识别画面', modelBPhaseMessage: 'Model B 正在重新识别画面', reasoningContent: '', outputContent: '', errorMessage: undefined, errorDetails: undefined, modelBErrorMessage: undefined, modelBErrorDetails: undefined, modelBCompletedAt: undefined, resumeSessionId: undefined, resumeKind: undefined, modelBResumeSessionId: undefined } : current);
    try {
      const pageContext = [currentDraft.page.name, currentDraft.page.stateSummary].filter(Boolean).join('；');
      const result = await workbenchApi.recognitionStream('ultra_b', currentDraft.currentFrameId, pageContext, false, handleUltraModelBEvent, currentDraft.currentPageId, annotationSessionId);
      modelBResultRef.current = result.recognitionResult;
      if (modelAResultRef.current) setUltraModelComparison({ modelAResult: modelAResultRef.current, modelBResult: result.recognitionResult, modelResultRef: result.modelResultRef });
      setStatus((current) => current ? { ...current, ultraModelBSession: null } : current);
      setRecognitionActivity((current) => current ? { ...current, status: aggregateUltraRecognitionStatus(current.modelAStatus, 'completed'), modelBStatus: 'completed', modelBCompletedAt: new Date().toISOString(), completedAt: current.modelAStatus && ['running', 'cancelling'].includes(current.modelAStatus) ? current.completedAt : new Date().toISOString(), phase: modelAResultRef.current ? 'compare' : 'complete', phaseMessage: 'Model B 识别完成', modelBPhaseMessage: 'Model B 识别完成', errorMessage: undefined, errorDetails: undefined, modelBErrorMessage: undefined, modelBErrorDetails: undefined } : current);
      showNotice('success', 'Model B 识别完成，可在冻结区域选择元素');
    } catch (error) {
      handleModelBFailure(error, 'Model B 重新识别失败');
    } finally {
      setRecognitionControlBusy(null);
      await refreshAnalysisSessions();
    }
  };

  const retryUltraModelA = async () => {
    const currentDraft = draftRef.current;
    if (!currentDraft?.currentFrameId) return;
    ultraApplyAsReplacementRef.current = false;
    ultraReplacementConfirmationRequiredRef.current = currentDraft.elements.some((element) => element.pageId === currentDraft.currentPageId) || Boolean(currentDraft.rawModelResultRef);
    setRecognitionControlBusy('ultra-a');
    setRecognitionDialogOpen(true);
    setUltraModelComparison(null);
    setRecognitionActivity((current) => current ? { ...current, status: 'running', modelAStatus: 'running', phase: 'ultra_a', phaseMessage: 'Model A 正在重新识别画面', modelAPhaseMessage: 'Model A 正在重新识别画面', modelAReasoningContent: '', modelAOutputContent: '', errorMessage: undefined, errorDetails: undefined, modelAErrorMessage: undefined, modelAErrorDetails: undefined, modelACompletedAt: undefined, resumeSessionId: undefined, resumeKind: undefined, modelAResumeSessionId: undefined } : current);
    try {
      const pageContext = [currentDraft.page.name, currentDraft.page.stateSummary].filter(Boolean).join('；');
      const result = await workbenchApi.recognitionStream('ultra_a', currentDraft.currentFrameId, pageContext, false, handleUltraModelAEvent, currentDraft.currentPageId, annotationSessionId);
      modelAResultRef.current = result.recognitionResult;
      if (modelBResultRef.current) setUltraModelComparison({ modelAResult: result.recognitionResult, modelBResult: modelBResultRef.current, modelResultRef: result.modelResultRef });
      setStatus((current) => current ? { ...current, ultraModelASession: null } : current);
      setRecognitionActivity((current) => current ? { ...current, status: aggregateUltraRecognitionStatus('completed', current.modelBStatus), modelAStatus: 'completed', modelACompletedAt: new Date().toISOString(), completedAt: current.modelBStatus && ['running', 'cancelling'].includes(current.modelBStatus) ? current.completedAt : new Date().toISOString(), phase: modelBResultRef.current ? 'compare' : 'complete', phaseMessage: 'Model A 识别完成', modelAPhaseMessage: 'Model A 识别完成', errorMessage: undefined, errorDetails: undefined, modelAErrorMessage: undefined, modelAErrorDetails: undefined } : current);
      showNotice('success', 'Model A 已完成重新识别');
    } catch (error) {
      handleModelAFailure(error);
    } finally {
      setRecognitionControlBusy(null);
      await refreshAnalysisSessions();
    }
  };

  const handleModelAFailure = (error: unknown) => {
    const cancelled = error instanceof Error && error.name === 'AnalysisCancelledError';
    const errorInfo = recognitionErrorInfo(error);
    const details = error instanceof Error ? (error as Error & { details?: Record<string, unknown> }).details : undefined;
    const resumeSession = details?.resumableSession as RecognitionResumeSession | undefined;
    if (resumeSession?.id) {
      if (explorationMode === 'ultra') {
        setRecognitionActivity((current) => current ? {
          ...current,
          status: aggregateUltraRecognitionStatus('paused', current.modelBStatus),
          modelAStatus: 'paused',
          modelAResumeSessionId: resumeSession.id,
          modelAPhaseMessage: cancelled ? 'Model A 已中断，可从断点继续' : 'Model A 已暂停，可从断点继续',
          phase: 'ultra-a-paused',
          phaseMessage: cancelled ? 'Model A 已中断，可从断点继续' : 'Model A 已暂停，可从断点继续',
          errorMessage: cancelled ? undefined : resumeSession.errorMessage,
          modelAErrorMessage: cancelled ? undefined : errorInfo.message || resumeSession.errorMessage,
          modelAErrorDetails: cancelled ? undefined : errorInfo.details,
          resumeSessionId: resumeSession.id,
          resumeKind: 'ultra_a',
          completedCandidates: resumeSession.completedCandidates,
        } : current);
        setStatus((current) => current ? { ...current, ultraModelASession: resumeSession } : current);
        showNotice('info', `Model A 已保留 ${resumeSession.completedCandidates} 个候选的断点`);
        return;
      }
      setRecognitionActivity((current) => ({
        ...(current || pausedManualRecognitionActivity(resumeSession)),
        status: 'paused',
        phase: 'paused',
        phaseMessage: cancelled ? '页面识别已中断，可从断点继续' : '自动续写 5 次仍未完成，可从断点继续',
        errorMessage: cancelled ? undefined : resumeSession.errorMessage,
        resumeSessionId: resumeSession.id,
        resumeKind: 'manual',
        completedCandidates: resumeSession.completedCandidates,
      }));
      setStatus((current) => current ? { ...current, manualSession: resumeSession } : current);
      showNotice('info', `页面识别已保留 ${resumeSession.completedCandidates} 个候选的断点`);
      return;
    }
    if (explorationMode === 'ultra') {
      setRecognitionActivity((current) => current ? {
        ...current,
        status: aggregateUltraRecognitionStatus(cancelled ? 'cancelled' : 'error', current.modelBStatus),
        modelAStatus: cancelled ? 'cancelled' : 'error',
        modelAPhaseMessage: cancelled ? 'Model A 已中断' : 'Model A 分析失败',
        phase: cancelled ? 'ultra-a-cancelled' : 'ultra-a-error',
        phaseMessage: cancelled ? 'Model A 已中断' : 'Model A 分析失败',
        errorMessage: cancelled ? undefined : errorInfo.message,
        modelAErrorMessage: cancelled ? undefined : errorInfo.message,
        modelAErrorDetails: cancelled ? undefined : errorInfo.details,
        modelACompletedAt: new Date().toISOString(),
      } : current);
      showNotice(cancelled ? 'info' : 'error', cancelled ? 'Model A 已中断' : error instanceof Error ? error.message : String(error));
      return;
    }
    setRecognitionActivity((current) => current ? {
      ...current,
      status: cancelled ? 'cancelled' : 'error',
      phase: cancelled ? 'cancelled' : 'error',
      phaseMessage: cancelled ? '页面识别已中断' : '页面识别失败',
      errorMessage: cancelled ? undefined : errorInfo.message,
      errorDetails: cancelled ? undefined : errorInfo.details,
      completedAt: new Date().toISOString(),
    } : current);
    showNotice(cancelled ? 'info' : 'error', cancelled ? '页面识别已中断，草稿未更新' : error instanceof Error ? error.message : String(error));
  };

  const handleModelBFailure = (error: unknown, fallbackMessage: string) => {
    const cancelled = error instanceof Error && error.name === 'AnalysisCancelledError';
    const errorInfo = recognitionErrorInfo(error);
    const details = error instanceof Error ? (error as Error & { details?: Record<string, unknown> }).details : undefined;
    const resumeSession = details?.resumableSession as RecognitionResumeSession | undefined;
    const message = errorInfo.message || fallbackMessage;
    if (resumeSession?.id) {
      if (explorationMode === 'ultra') {
        setRecognitionActivity((current) => current ? {
          ...current,
          status: aggregateUltraRecognitionStatus(current.modelAStatus, 'paused'),
          modelBStatus: 'paused',
          modelBResumeSessionId: resumeSession.id,
          modelBPhaseMessage: 'Model B 已暂停，可从断点继续',
          phase: 'ultra-b-paused',
          phaseMessage: 'Model B 已暂停，可从断点继续',
          errorMessage: undefined,
          modelBErrorMessage: cancelled ? undefined : message,
          modelBErrorDetails: cancelled ? undefined : errorInfo.details,
          resumeSessionId: resumeSession.id,
          resumeKind: 'ultra_b',
        } : current);
        setStatus((current) => current ? { ...current, ultraModelBSession: resumeSession } : current);
        showNotice('info', 'Model B 已中断并保存当前输出断点');
        return;
      }
      setRecognitionActivity((current) => ({
        ...(current || pausedUltraModelBActivity(resumeSession)),
        status: 'paused',
        phase: 'ultra-b-paused',
        phaseMessage: 'Model B 已中断，可从断点继续',
        errorMessage: undefined,
        errorDetails: undefined,
        resumeSessionId: resumeSession.id,
        resumeKind: 'ultra_b',
      }));
      setStatus((current) => current ? { ...current, ultraModelBSession: resumeSession } : current);
      showNotice('info', 'Model B 已中断并保存当前输出断点');
      return;
    }
    if (explorationMode === 'ultra') {
      setRecognitionActivity((current) => current ? {
        ...current,
        status: aggregateUltraRecognitionStatus(current.modelAStatus, cancelled ? 'cancelled' : 'error'),
        modelBStatus: cancelled ? 'cancelled' : 'error',
        modelBPhaseMessage: cancelled ? 'Model B 已中断' : fallbackMessage,
        phase: cancelled ? 'ultra-b-cancelled' : 'ultra-b-error',
        phaseMessage: cancelled ? 'Model B 已中断' : fallbackMessage,
        errorMessage: cancelled ? undefined : message,
        modelBErrorMessage: cancelled ? undefined : message,
        modelBErrorDetails: cancelled ? undefined : errorInfo.details,
        modelBCompletedAt: new Date().toISOString(),
      } : current);
      showNotice(cancelled ? 'info' : 'error', cancelled ? 'Model B 已中断' : message);
      return;
    }
    setRecognitionActivity((current) => current ? {
      ...current,
      status: cancelled ? 'cancelled' : 'error',
      phase: cancelled ? 'ultra-b-cancelled' : 'ultra-b-error',
      phaseMessage: cancelled ? 'Model B 已中断' : fallbackMessage,
      errorMessage: cancelled ? undefined : message,
      errorDetails: cancelled ? undefined : errorInfo.details,
      completedAt: new Date().toISOString(),
    } : current);
    showNotice(cancelled ? 'info' : 'error', cancelled ? 'Model B 已中断' : message);
  };

  const runRecognition = async () => {
    const recognitionDraft = draftRef.current || draft;
    if (!recognitionDraft?.currentFrameId) return;
    const replacementRequired = recognitionDraft.elements.some((element) => element.pageId === recognitionDraft.currentPageId) || Boolean(recognitionDraft.rawModelResultRef);
    setBusy('recognition');
    setRecognitionDialogOpen(true);
    setPendingRecognitionReplacement(null);
    setCompletedRecognitionReplacement(null);
    ultraApplyAsReplacementRef.current = false;
    setUltraModelComparison(null);
    modelAResultRef.current = null;
    modelBResultRef.current = null;
    const ultraMode = explorationMode === 'ultra';
    ultraReplacementConfirmationRequiredRef.current = ultraMode && replacementRequired;
    const recognitionStartedAt = new Date().toISOString();
    setRecognitionActivity({ status: 'running', phase: ultraMode ? 'ultra-running' : 'starting', phaseMessage: ultraMode ? 'Model A 与 Model B 正在并发识别画面' : '正在启动页面识别模型', reasoningContent: '', outputContent: '', modelAReasoningContent: '', modelAOutputContent: '', modelAPhaseMessage: ultraMode ? 'Model A 正在启动' : undefined, modelBPhaseMessage: ultraMode ? 'Model B 正在启动' : undefined, modelAStatus: ultraMode ? 'running' : undefined, modelBStatus: ultraMode ? 'running' : undefined, startedAt: recognitionStartedAt, modelAStartedAt: ultraMode ? recognitionStartedAt : undefined, modelBStartedAt: ultraMode ? recognitionStartedAt : undefined });
    try {
      const pageContext = [recognitionDraft.page.name, recognitionDraft.page.stateSummary].filter(Boolean).join('；');
      if (!ultraMode) {
        await finishManualRecognition(await workbenchApi.recognitionStream('manual', recognitionDraft.currentFrameId, pageContext, !replacementRequired, handleRecognitionEvent, recognitionDraft.currentPageId, annotationSessionId));
        return;
      }
      const modelAPromise = workbenchApi.recognitionStream('ultra_a', recognitionDraft.currentFrameId, pageContext, false, handleUltraModelAEvent, recognitionDraft.currentPageId, annotationSessionId).then((result) => {
        modelAResultRef.current = result.recognitionResult;
        if (modelBResultRef.current) setUltraModelComparison({ modelAResult: result.recognitionResult, modelBResult: modelBResultRef.current, modelResultRef: result.modelResultRef });
        setStatus((current) => current ? { ...current, ultraModelASession: null } : current);
        setRecognitionActivity((current) => current ? { ...current, status: aggregateUltraRecognitionStatus('completed', current.modelBStatus), modelAStatus: 'completed', modelACompletedAt: new Date().toISOString(), modelAPhaseMessage: 'Model A 识别完成', modelAResumeSessionId: undefined, completedAt: current.modelBStatus && ['running', 'cancelling'].includes(current.modelBStatus) ? current.completedAt : new Date().toISOString() } : current);
        return result;
      }, (error) => { handleModelAFailure(error); throw error; });
      const modelBPromise = workbenchApi.recognitionStream('ultra_b', recognitionDraft.currentFrameId, pageContext, false, handleUltraModelBEvent, recognitionDraft.currentPageId, annotationSessionId).then((result) => {
        modelBResultRef.current = result.recognitionResult;
        if (modelAResultRef.current) setUltraModelComparison({ modelAResult: modelAResultRef.current, modelBResult: result.recognitionResult, modelResultRef: result.modelResultRef });
        setStatus((current) => current ? { ...current, ultraModelBSession: null } : current);
        setRecognitionActivity((current) => current ? { ...current, status: aggregateUltraRecognitionStatus(current.modelAStatus, 'completed'), modelBStatus: 'completed', modelBCompletedAt: new Date().toISOString(), modelBPhaseMessage: 'Model B 识别完成', modelBResumeSessionId: undefined, completedAt: current.modelAStatus && ['running', 'cancelling'].includes(current.modelAStatus) ? current.completedAt : new Date().toISOString() } : current);
        return result;
      }, (error) => { handleModelBFailure(error, 'Model B 识别失败'); throw error; });
      const [modelAOutcome, modelBOutcome] = await Promise.allSettled([modelAPromise, modelBPromise]);
      if (modelAOutcome.status === 'fulfilled' && modelBOutcome.status === 'fulfilled') {
        setRecognitionActivity((current) => current ? { ...current, status: 'completed', modelAStatus: 'completed', modelBStatus: 'completed', modelACompletedAt: current.modelACompletedAt || new Date().toISOString(), modelBCompletedAt: current.modelBCompletedAt || new Date().toISOString(), completedAt: new Date().toISOString(), phase: 'compare', phaseMessage: '双模型 并发识别完成', modelAPhaseMessage: 'Model A 识别完成', modelBPhaseMessage: 'Model B 识别完成', errorMessage: undefined } : current);
        showNotice('success', '两份并列识别结果已完成，可在双画面或页面元素区域选择');
      }
    } catch (error) {
      handleModelAFailure(error);
    } finally {
      setBusy(null);
      await refreshAnalysisSessions();
    }
  };

  const applyUltraModelComparison = async (selections: UltraModelElementMergeSelection[]) => {
    if (!draft?.currentFrameId || !ultraModelComparison) return;
    await commitUltraModelComparison(selections);
  };

  const commitUltraModelComparison = async (selections: UltraModelElementMergeSelection[]) => {
    const currentDraft = draftRef.current;
    const comparison = ultraModelComparison;
    if (!currentDraft?.currentFrameId || !comparison) return;
    if (ultraReplacementConfirmationRequiredRef.current && !ultraApplyAsReplacementRef.current) {
      setPendingRecognitionReplacement({ kind: 'ultra', selections });
      return;
    }
    setBusy('ultra-model-merge');
    try {
      const result = await workbenchApi.mergeUltraModelResults({
        frameId: currentDraft.currentFrameId,
        pageId: currentDraft.currentPageId,
        modelAResult: comparison.modelAResult,
        modelBResult: comparison.modelBResult,
        selections,
        modelResultRef: comparison.modelResultRef,
        replaceExisting: ultraApplyAsReplacementRef.current,
      });
      resetDraftState(result.draft);
      setServerIssues(result.issues);
      setSelectedId(result.draft.elements[0]?.id || null);
      setUltraModelComparison(null);
      ultraReplacementConfirmationRequiredRef.current = false;
      ultraApplyAsReplacementRef.current = false;
      setRecognitionActivity((current) => current ? { ...current, status: 'completed', phase: 'complete', phaseMessage: '识别结果已合并，可在页面元素区域编辑审核' } : current);
      showNotice('success', `已合并 ${result.draft.elements.length} 个候选元素`);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const confirmRecognitionReplacement = async () => {
    const pending = pendingRecognitionReplacement;
    const currentDraft = draftRef.current;
    if (!pending || !currentDraft?.currentFrameId || recognitionReplacementBusy) return;
    setRecognitionReplacementBusy(true);
    try {
      if (pending.kind === 'manual') {
        const result = await workbenchApi.applyRecognitionResult({
          frameId: currentDraft.currentFrameId,
          pageId: currentDraft.currentPageId,
          recognitionResult: pending.result.recognitionResult,
          modelResultRef: pending.result.modelResultRef,
          model: pending.result.model,
        });
        resetDraftState(result.draft);
        setServerIssues(result.issues);
        setSelectedId(result.draft.elements[0]?.id || null);
        setRecognitionActivity((current) => current ? { ...current, status: 'completed', phase: 'complete', phaseMessage: '已使用新的页面识别结果替换原有结果' } : current);
        showNotice('success', `已使用新结果替换，共 ${result.draft.elements.length} 个候选元素`);
      } else {
        ultraReplacementConfirmationRequiredRef.current = false;
        ultraApplyAsReplacementRef.current = true;
        const selections = pending.selections;
        setPendingRecognitionReplacement(null);
        await commitUltraModelComparison(selections);
        return;
      }
      setPendingRecognitionReplacement(null);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setRecognitionReplacementBusy(false);
    }
  };

  const keepExistingRecognitionResult = () => {
    setPendingRecognitionReplacement(null);
    setCompletedRecognitionReplacement(null);
    ultraReplacementConfirmationRequiredRef.current = false;
    ultraApplyAsReplacementRef.current = false;
    if (pendingRecognitionReplacement?.kind === 'ultra') setUltraModelComparison(null);
    setRecognitionActivity((current) => current ? { ...current, status: 'completed', phase: 'complete', phaseMessage: '已保留原有识别结果' } : current);
    showNotice('info', '已保留原有识别结果');
  };

  const closeRecognitionDialog = () => {
    if (completedRecognitionReplacement) {
      setRecognitionDialogOpen(false);
      setPendingRecognitionReplacement(completedRecognitionReplacement);
      setCompletedRecognitionReplacement(null);
      return;
    }
    setRecognitionDialogOpen(false);
    if (modelActivity?.status !== 'paused') setRecognitionActivity(null);
  };

  const resumeUltraModelA = async () => {
    const sessionId = modelActivity?.modelAResumeSessionId || (modelActivity?.resumeKind === 'ultra_a' ? modelActivity.resumeSessionId : undefined);
    if (!sessionId) return;
    setRecognitionControlBusy('ultra-a');
    setRecognitionDialogOpen(true);
    setRecognitionActivity((current) => current ? {
      ...current,
      status: 'running',
      modelAStatus: 'running',
      phase: 'resume',
      phaseMessage: '正在继续 Model A 识别',
      modelAPhaseMessage: '正在继续 Model A 识别',
      errorMessage: undefined,
      errorDetails: undefined,
      modelAErrorMessage: undefined,
      modelAErrorDetails: undefined,
      modelACompletedAt: undefined,
    } : current);
    try {
      const result = await workbenchApi.resumeRecognitionStream('ultra_a', sessionId, annotationSessionId, handleUltraModelAEvent);
      modelAResultRef.current = result.recognitionResult;
      if (modelBResultRef.current) setUltraModelComparison({ modelAResult: result.recognitionResult, modelBResult: modelBResultRef.current, modelResultRef: result.modelResultRef });
      setStatus((current) => current ? { ...current, ultraModelASession: null } : current);
      setRecognitionActivity((current) => current ? { ...current, status: aggregateUltraRecognitionStatus('completed', current.modelBStatus), modelAStatus: 'completed', modelACompletedAt: new Date().toISOString(), modelAPhaseMessage: 'Model A 已从断点完成', modelAResumeSessionId: undefined, phase: modelBResultRef.current ? 'compare' : 'complete', phaseMessage: 'Model A 已从断点完成', errorMessage: undefined, errorDetails: undefined, modelAErrorMessage: undefined, modelAErrorDetails: undefined, completedAt: current.modelBStatus && ['running', 'cancelling'].includes(current.modelBStatus) ? current.completedAt : new Date().toISOString(), resumeSessionId: undefined, resumeKind: undefined } : current);
    } catch (error) {
      handleModelAFailure(error);
    } finally {
      setRecognitionControlBusy(null);
    }
  };

  const resumeManualRecognition = async () => {
    const sessionId = modelActivity?.resumeKind === 'manual' ? modelActivity.resumeSessionId : undefined;
    if (!sessionId) return;
    setRecognitionDialogOpen(true);
    setRecognitionActivity((current) => current ? {
      ...current,
      status: 'running',
      phase: 'resume',
      phaseMessage: '正在继续页面识别',
      errorMessage: undefined,
    } : current);
    try {
      await finishManualRecognition(await workbenchApi.resumeRecognitionStream('manual', sessionId, annotationSessionId, handleRecognitionEvent));
    } catch (error) {
      handleModelAFailure(error);
    }
  };

  const resumeUltraModelB = async () => {
    const sessionId = modelActivity?.modelBResumeSessionId || (modelActivity?.resumeKind === 'ultra_b' ? modelActivity.resumeSessionId : undefined);
    if (!sessionId) return;
    setRecognitionControlBusy('ultra-b');
    setRecognitionDialogOpen(true);
    setRecognitionActivity((current) => current ? {
      ...current,
      status: 'running',
      modelBStatus: 'running',
      phase: 'ultra_b-resume',
      phaseMessage: '正在继续 Model B 识别',
      modelBPhaseMessage: '正在继续 Model B 识别',
      errorMessage: undefined,
      errorDetails: undefined,
      modelBErrorMessage: undefined,
      modelBErrorDetails: undefined,
      modelBCompletedAt: undefined,
    } : current);
    try {
      const result = await workbenchApi.resumeRecognitionStream('ultra_b', sessionId, annotationSessionId, handleUltraModelBEvent);
      modelBResultRef.current = result.recognitionResult;
      if (modelAResultRef.current) setUltraModelComparison({ modelAResult: modelAResultRef.current, modelBResult: result.recognitionResult, modelResultRef: result.modelResultRef });
      setStatus((current) => current ? { ...current, ultraModelBSession: null } : current);
      setRecognitionActivity((current) => current ? { ...current, status: aggregateUltraRecognitionStatus(current.modelAStatus, 'completed'), modelBStatus: 'completed', modelBCompletedAt: new Date().toISOString(), modelBPhaseMessage: 'Model B 已从断点完成识别', modelBResumeSessionId: undefined, phase: modelAResultRef.current ? 'compare' : 'complete', phaseMessage: 'Model B 已从断点完成识别', errorMessage: undefined, errorDetails: undefined, modelBErrorMessage: undefined, modelBErrorDetails: undefined, completedAt: current.modelAStatus && ['running', 'cancelling'].includes(current.modelAStatus) ? current.completedAt : new Date().toISOString(), resumeSessionId: undefined, resumeKind: undefined } : current);
      showNotice('success', 'Model B 已从断点完成识别');
    } catch (error) {
      handleModelBFailure(error, 'Model B 断点续写失败');
    } finally {
      setRecognitionControlBusy(null);
      await refreshAnalysisSessions();
    }
  };

  const cancelUltraModel = async (kind: 'ultra_a' | 'ultra_b') => {
    const busyKey = kind === 'ultra_a' ? 'ultra-a' : 'ultra-b';
    setRecognitionControlBusy(busyKey);
    setRecognitionActivity((current) => current ? {
      ...current,
      [`${kind === 'ultra_a' ? 'modelA' : 'modelB'}Status`]: 'cancelling',
      [`${kind === 'ultra_a' ? 'modelA' : 'modelB'}PhaseMessage`]: `${kind === 'ultra_a' ? 'Model A' : 'Model B'} 正在中断`,
      phaseMessage: `${kind === 'ultra_a' ? 'Model A' : 'Model B'} 正在中断`,
    } : current);
    try {
      const result = await workbenchApi.cancelRecognition(kind, annotationSessionId);
      if (!result.cancelled) showNotice('info', `${kind === 'ultra_a' ? 'Model A' : 'Model B'} 已结束，无需中断`);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setRecognitionControlBusy(null);
    }
  };

  const cancelUltraModels = async () => {
    setRecognitionActivity((current) => current ? { ...current, status: 'cancelling', phaseMessage: '正在中断模型请求' } : current);
    try {
      const results = explorationMode === 'ultra'
        ? await Promise.all([workbenchApi.cancelRecognition('ultra_a', annotationSessionId), workbenchApi.cancelRecognition('ultra_b', annotationSessionId)])
        : [await workbenchApi.cancelRecognition('manual', annotationSessionId)];
      if (!results.some((result) => result.cancelled)) {
        setRecognitionActivity((current) => current ? { ...current, phaseMessage: '模型已结束，正在接收最终结果' } : current);
      }
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
    }
  };

  const openRecognitionHistory = () => {
    const latest = pageHistorySessions[0];
    if (!latest) return;
    setUltraModelComparison(null);
    setRecognitionActivity({
      status: latest.status === 'completed' ? 'completed' : latest.status === 'cancelled' ? 'cancelled' : latest.status === 'running' ? 'running' : 'error',
      phase: 'history',
      phaseMessage: latest.kind === 'manual' ? 'Manual 页面识别会话' : latest.kind === 'ultra_a' ? 'Model A 识别会话' : 'Model B 识别会话',
      reasoningContent: latest.reasoningContent || '',
      outputContent: latest.outputContent || '',
      errorMessage: latest.errorMessage || undefined,
    });
    setRecognitionDialogOpen(true);
  };

  const persistDraft = async (draftToSave: Draft) => {
    const result = annotationTarget
      ? await workbenchApi.savePageDraft(annotationTarget.pageId, draftToSave)
      : await workbenchApi.saveDraft(draftToSave);
    lastSavedDraftRef.current = structuredClone(result.draft);
    // Autosave replaces the server-normalized draft without resetting the
    // undo/redo snapshots or the current review baseline.
    const savedLatestDraft = draftRef.current === draftToSave;
    if (savedLatestDraft) {
      draftRef.current = result.draft;
      setDraft(result.draft);
      setDirty(false);
    }
    setServerIssues(result.issues);
    return savedLatestDraft;
  };

  const runAutoSave = async (draftToSave: Draft) => {
    if (autoSaveInFlightRef.current) {
      autoSaveQueuedRef.current = true;
      return;
    }
    autoSaveInFlightRef.current = true;
    setAutoSaveState('saving');
    try {
      await persistDraft(draftToSave);
      setAutoSaveState('saved');
    } catch (error) {
      setAutoSaveState('error');
      showNotice('error', `自动保存失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      autoSaveInFlightRef.current = false;
      if (autoSaveQueuedRef.current && draftRef.current && draftRef.current !== draftToSave) {
        autoSaveQueuedRef.current = false;
        void runAutoSave(draftRef.current);
      } else {
        autoSaveQueuedRef.current = false;
      }
    }
  };

  const saveCurrentPage = async (): Promise<boolean> => {
    if (!draftRef.current || busy) return false;
    if (pageNameEditing) commitPageName();
    const current = draftRef.current;
    setBusy('save-page');
    try {
      const savedLatestDraft = await persistDraft(current);
      setAutoSaveState('saved');
      showNotice('success', '页面已保存');
      return savedLatestDraft;
    } catch (error) {
      setAutoSaveState('error');
      showNotice('error', `页面保存失败：${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      setBusy(null);
    }
  };

  saveCurrentPageRef.current = saveCurrentPage;

  useEffect(() => {
    if (tabKind !== 'annotation') return undefined;
    const handler = () => saveCurrentPageRef.current();
    onRegisterSaveHandler(tabId, handler);
    return () => onRegisterSaveHandler(tabId, null);
  }, [onRegisterSaveHandler, tabId, tabKind]);

  useEffect(() => {
    if (tabKind === 'annotation' || workspaceMode !== 'annotation' || !dirty || !draft?.currentFrameId) return undefined;
    const timer = window.setTimeout(() => {
      const latestDraft = draftRef.current;
      if (latestDraft?.currentFrameId) void runAutoSave(latestDraft);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [draft, dirty, tabKind, workspaceMode]);

  const reviewReady = currentElements.length > 0 && currentElements.every((element) => element.reviewStatus === 'accepted');

  const completeReview = async () => {
    const current = draftRef.current;
    if (!current || !reviewReady || autoSaveInFlightRef.current || reviewCompletionInFlightRef.current) return;
    reviewCompletionInFlightRef.current = true;
    setBusy('review-complete');
    try {
      const emptyPage = createEmptyWorkingPage();
      const clearedDraft: Draft = {
        ...current,
        currentPageId: emptyPage.id,
        currentFrameId: null,
        rawModelResultRef: null,
        page: emptyPage,
        pages: [...current.pages.filter((page) => page.id !== emptyPage.id), emptyPage],
      };
      // Persist the approved elements together with the cleared working page
      // so a reload starts from the same empty annotation state.
      const result = annotationTarget
        ? await workbenchApi.savePageDraft(annotationTarget.pageId, clearedDraft)
        : await workbenchApi.saveDraft(clearedDraft);
      setServerIssues(result.issues);
      // Approval is the only operation that clears undo/redo history and
      // returns the annotation workspace to its empty initial state.
      resetDraftState(result.draft, false, true);
      setSelectedId(null);
      setCheckedIds(new Set());
      setDrawing(false);
      setShowRejected(false);
      setFrame(null);
      setUltraModelComparison(null);
      setViewMode('live');
      setAutoSaveState('idle');
      showNotice('success', '审核已完成，标注工作区已清空');
    } catch (error) {
      showNotice('error', `完成审核失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      reviewCompletionInFlightRef.current = false;
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!reviewCompletionRequestedRef.current
      || workspaceMode !== 'annotation'
      || viewMode !== 'review'
      || !draft?.currentFrameId
      || !reviewReady
      || busy
      || autoSaveInFlightRef.current
      || autoSaveState === 'saving') return;
    reviewCompletionRequestedRef.current = false;
    void completeReview();
  }, [autoSaveState, busy, draft?.currentFrameId, reviewReady, viewMode, workspaceMode]);

  const requestCancelAnnotation = () => {
    if (!draftRef.current?.currentFrameId) return;
    setCancelDialogOpen(true);
  };

  const restoreAnnotationEntry = async (action: 'frozen' | 'close') => {
    const snapshot = annotationEntryDraftRef.current;
    if (!snapshot) return;
    setCancelDialogOpen(false);
    setBusy('cancel-annotation');
    let closeAfterRestore = false;
    try {
      const restoredDraft = structuredClone(snapshot);
      const result = annotationTarget
        ? await workbenchApi.savePageDraft(annotationTarget.pageId, restoredDraft)
        : await workbenchApi.saveDraft(restoredDraft);
      lastSavedDraftRef.current = structuredClone(result.draft);
      setServerIssues(result.issues);
      resetDraftState(result.draft, false, true);
      setSelectedId(null);
      setCheckedIds(new Set());
      setDrawing(false);
      setShowRejected(false);
      setFrame(null);
      setUltraModelComparison(null);
      setAutoSaveState('idle');
      if (action === 'frozen') {
        setViewMode('frozen');
        showNotice('success', '已回退到冻结画面');
      } else if (tabKind === 'annotation') {
        closeAfterRestore = true;
      } else {
        setViewMode('live');
        setWorkspaceMode(annotationEntryWorkspaceRef.current);
      }
    } catch (error) {
      showNotice('error', `放弃标注变更失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
      if (closeAfterRestore) onCloseTab(tabId);
    }
  };

  const updateDraft = (updater: (draft: Draft) => Draft, historyKey?: string, activityLabel = '编辑元素') => {
    commitDraft(updater, historyKey, activityLabel);
  };

  const updateElement = (id: string, patch: Partial<DraftElement>, historyKey?: string, markEdited = true, activityLabel = '编辑元素') => {
    commitDraft((current) => {
      const updatesSpatialGrid = patch.bbox !== undefined || patch.gridColumns !== undefined || patch.gridRows !== undefined;
      const patchFields = [...new Set([
        ...Object.keys(patch).filter((field) => !['reviewStatus', 'source'].includes(field)),
        ...(updatesSpatialGrid ? ['gridColumns', 'gridRows', 'gridRegion'] : []),
      ])];
      const previousRecord = current.elementEditRecords.find((record) => record.elementId === id);
      const initialElement = initialElementsRef.current.get(id);
      let matchesInitial = false;
      const updated = current.elements.map((element) => {
        if (element.id !== id) return element;
        const parentId = patch.parentId !== undefined ? patch.parentId : element.parentId;
        let ownerRef = patch.ownerRef || element.ownerRef;
        if (patch.parentId !== undefined) ownerRef = parentId || current.currentPageId;
        if (patch.ownerKind === 'page') ownerRef = current.currentPageId;
        if (patch.ownerKind === 'application') ownerRef = current.appKey;
        let nextElement = {
          ...element,
          ...patch,
          ownerRef,
        };
        if (updatesSpatialGrid) {
          const grid = patch.bbox !== undefined
            ? gridForBox(nextElement.bbox)
            : gridForBox(nextElement.bbox, normalizeGridCount(nextElement.gridColumns), normalizeGridCount(nextElement.gridRows));
          nextElement = {
            ...nextElement,
            gridColumns: grid.columns,
            gridRows: grid.rows,
            gridRegion: grid.region,
          };
        }
        matchesInitial = Boolean(initialElement && editableElementValuesEqual(nextElement, initialElement));
        const keepExplicitReview = ['accepted', 'rejected'].includes(element.reviewStatus);
        return {
          ...nextElement,
          reviewStatus: patch.reviewStatus || (markEdited
            ? matchesInitial && initialElement && !keepExplicitReview
              ? initialElement.reviewStatus
              : keepExplicitReview ? element.reviewStatus : 'edited'
            : element.reviewStatus),
          source: markEdited
            ? matchesInitial && initialElement ? initialElement.source : element.source === 'human' ? 'human' : 'mixed'
            : element.source,
        };
      });
      let elementEditRecords = current.elementEditRecords;
      if (markEdited && matchesInitial) {
        elementEditRecords = elementEditRecords.filter((record) => record.elementId !== id);
        const initialRecord = initialElementEditRecordsRef.current.find((record) => record.elementId === id);
        if (initialRecord) elementEditRecords = [...elementEditRecords, structuredClone(initialRecord)];
        else if (initialElement?.source === 'human') {
          elementEditRecords = [...elementEditRecords, { elementId: id, kind: 'created', fields: ['bbox'], editedAt: new Date().toISOString() }];
        }
      } else if (markEdited) {
        const nextRecord: ElementEditRecord = {
          elementId: id,
          kind: previousRecord?.kind || 'updated',
          fields: [...new Set([...(previousRecord?.fields || []), ...patchFields])],
          editedAt: new Date().toISOString(),
        };
        elementEditRecords = [...elementEditRecords.filter((record) => record.elementId !== id), nextRecord];
      }
      return {
        ...current,
        elementEditRecords,
        elements: patch.parentId === undefined ? updated : updated.map((element) => ({
          ...element,
          childrenIds: updated.filter((candidate) => candidate.parentId === element.id).map((candidate) => candidate.id),
        })),
      };
    }, historyKey, activityLabel);
  };

  const addElement = (bbox: BBox) => {
    if (!draft) return;
    const element = createHumanElement(bbox, draft.currentPageId);
    updateDraft((current) => ({
      ...current,
      elements: [...current.elements, element],
      elementEditRecords: [...current.elementEditRecords, {
        elementId: element.id,
        kind: 'created',
        fields: ['bbox'],
        editedAt: new Date().toISOString(),
      }],
    }), undefined, '新增元素');
    initialElementsRef.current.set(element.id, structuredClone(element));
    setSelectedId(element.id);
    setDrawing(false);
  };

  const bulkAccept = () => {
    if (checkedIds.size === 0) return;
    if (workspaceMode === 'annotation' && viewMode === 'review' && currentElements.length > 0 && currentElements.every((element) => checkedIds.has(element.id) || element.reviewStatus === 'accepted')) {
      reviewCompletionRequestedRef.current = true;
    }
    for (const element of draft?.elements || []) if (checkedIds.has(element.id) && element.reviewStatus !== 'accepted') preAcceptStatusRef.current.set(element.id, element.reviewStatus);
    updateDraft((current) => ({ ...current, elements: current.elements.map((element) => checkedIds.has(element.id) ? { ...element, reviewStatus: 'accepted' } : element) }), undefined, '批量审核通过');
  };

  const bulkCancelAccept = () => {
    if (checkedIds.size === 0) return;
    updateDraft((current) => ({ ...current, elements: current.elements.map((element) => {
      if (!checkedIds.has(element.id) || element.reviewStatus !== 'accepted') return element;
      return { ...element, reviewStatus: preAcceptStatusRef.current.get(element.id) || (element.source === 'ai' ? 'pending' : 'edited') };
    }) }), undefined, '取消批量审核通过');
    for (const id of checkedIds) preAcceptStatusRef.current.delete(id);
  };

  const createContainerFromSelection = () => {
    if (!draft || checkedIds.size === 0) return;
    const selected = draft.elements.filter((element) => checkedIds.has(element.id));
    if (selected.some((element) => element.ownerKind === 'application' || element.pageId === null)) {
      showNotice('error', '应用共享元素不能直接组合，请先调整为当前页面元素');
      return;
    }
    const left = Math.min(...selected.map((element) => element.bbox.x));
    const top = Math.min(...selected.map((element) => element.bbox.y));
    const right = Math.max(...selected.map((element) => element.bbox.x + element.bbox.width));
    const bottom = Math.max(...selected.map((element) => element.bbox.y + element.bbox.height));
    const parentIds = new Set(selected.map((element) => element.parentId));
    const parentId = parentIds.size === 1 ? selected[0].parentId : null;
    const container = {
      ...createHumanElement({ x: left, y: top, width: right - left, height: bottom - top }, draft.currentPageId),
      label: '新组合容器',
      visualDescription: `由 ${selected.length} 个所选元素组成的容器`,
      elementType: 'section',
      role: 'container',
      actionEffects: [{ action: 'none', effect: '容器仅组织所选元素，不触发交互' }],
      interactionBoundary: 'none',
      parentId,
      ownerKind: parentId ? 'component' as const : 'page' as const,
      ownerRef: parentId || draft.currentPageId,
      childrenIds: selected.map((element) => element.id),
    };
    const selectedSet = new Set(selected.map((element) => element.id));
    commitDraft((current) => {
      const nextElements = [...current.elements.map((element) => {
        if (!selectedSet.has(element.id)) return element;
        return {
          ...element,
          parentId: container.id,
          ownerKind: 'component' as const,
          ownerRef: container.id,
          reviewStatus: element.reviewStatus === 'accepted' ? 'accepted' as const : 'edited' as const,
          source: element.source === 'human' ? 'human' as const : 'mixed' as const,
        };
      }), container];
      const normalizedElements = nextElements.map((element) => ({
        ...element,
        childrenIds: nextElements.filter((candidate) => candidate.parentId === element.id).map((candidate) => candidate.id),
      }));
      const nextRecords = current.elementEditRecords.filter((record) => !selectedSet.has(record.elementId));
      for (const element of selected) nextRecords.push({ elementId: element.id, kind: 'updated', fields: ['parentId', 'ownerKind', 'ownerRef'], editedAt: new Date().toISOString() });
      nextRecords.push({ elementId: container.id, kind: 'created', fields: ['bbox', 'parentId', 'childrenIds'], editedAt: new Date().toISOString() });
      return { ...current, elements: normalizedElements, elementEditRecords: nextRecords };
    }, undefined, '创建组合容器');
    initialElementsRef.current.set(container.id, structuredClone(container));
    setSelectedId(container.id);
    setMultiSelect(false);
    setCheckedIds(new Set());
    setDuplicateCandidateKeyFilter(null);
    showNotice('success', `已用 ${selected.length} 个元素创建组合容器`);
  };

  const deleteCheckedElements = () => {
    if (!draft || checkedIds.size === 0) return;
    const deletedIds = new Set(checkedIds);
    commitDraft((current) => {
      const currentById = new Map(current.elements.map((element) => [element.id, element]));
      const survivingParentId = (element: DraftElement) => {
        let parentId = element.parentId;
        const visited = new Set<string>();
        while (parentId && deletedIds.has(parentId) && !visited.has(parentId)) {
          visited.add(parentId);
          parentId = currentById.get(parentId)?.parentId || null;
        }
        return parentId && !deletedIds.has(parentId) ? parentId : null;
      };
      const remaining = current.elements
        .filter((element) => !deletedIds.has(element.id))
        .map((element) => {
          if (!element.parentId || !deletedIds.has(element.parentId)) return element;
          const parentId = survivingParentId(element);
          return {
            ...element,
            parentId,
            ownerKind: parentId ? 'component' as const : 'page' as const,
            ownerRef: parentId || current.currentPageId,
          };
        });
      const elements = remaining.map((element) => ({
        ...element,
        childrenIds: remaining.filter((candidate) => candidate.parentId === element.id).map((candidate) => candidate.id),
      }));
      return {
        ...current,
        pages: current.pages.map((page) => ({ ...page, elementIds: page.elementIds.filter((id) => !deletedIds.has(id)) })),
        elements,
        elementEditRecords: current.elementEditRecords.filter((record) => !deletedIds.has(record.elementId)),
        transitions: current.transitions.filter((transition) => !deletedIds.has(transition.triggerElementId)),
      };
    }, undefined, '批量删除元素');
    for (const id of deletedIds) {
      preAcceptStatusRef.current.delete(id);
      preRejectStatusRef.current.delete(id);
    }
    if (selectedId && deletedIds.has(selectedId)) setSelectedId(null);
    setCheckedIds(new Set());
  };

  const toggleAccept = (element: DraftElement) => {
    if (element.reviewStatus === 'accepted') {
      const previous = preAcceptStatusRef.current.get(element.id);
      const reviewStatus = previous || (element.source === 'ai' ? 'pending' : 'edited');
      updateElement(element.id, { reviewStatus }, undefined, false, '取消审核通过元素');
      preAcceptStatusRef.current.delete(element.id);
      return;
    }
    if (workspaceMode === 'annotation' && viewMode === 'review' && currentElements.length > 0 && currentElements.every((candidate) => candidate.id === element.id || candidate.reviewStatus === 'accepted')) {
      reviewCompletionRequestedRef.current = true;
    }
    preAcceptStatusRef.current.set(element.id, element.reviewStatus);
    updateElement(element.id, { reviewStatus: 'accepted' }, undefined, false, '审核通过元素');
  };

  const toggleReject = (element: DraftElement) => {
    if (element.reviewStatus === 'rejected') {
      const previous = preRejectStatusRef.current.get(element.id);
      const reviewStatus = previous || (element.source === 'ai' ? 'pending' : 'edited');
      updateElement(element.id, { reviewStatus }, undefined, false, '取消忽略元素');
      preRejectStatusRef.current.delete(element.id);
      return;
    }
    preRejectStatusRef.current.set(element.id, element.reviewStatus);
    updateElement(element.id, { reviewStatus: 'rejected' }, undefined, false, '忽略元素');
  };

  const restoreSelectedElement = () => {
    if (!selectedId) return;
    const initial = initialElementsRef.current.get(selectedId);
    if (!initial) return;
    const initialEditRecord = initialElementEditRecordsRef.current.find((record) => record.elementId === selectedId);
    commitDraft((current) => {
      const restored = current.elements.map((element) => element.id === selectedId ? structuredClone(initial) : element);
      const elementEditRecords = current.elementEditRecords.filter((record) => record.elementId !== selectedId);
      if (initialEditRecord) elementEditRecords.push(structuredClone(initialEditRecord));
      else if (initial.source === 'human') {
        elementEditRecords.push({ elementId: selectedId, kind: 'created', fields: ['bbox'], editedAt: new Date().toISOString() });
      }
      return {
        ...current,
        elementEditRecords,
        elements: restored.map((element) => ({
          ...element,
          childrenIds: restored.filter((candidate) => candidate.parentId === element.id).map((candidate) => candidate.id),
        })),
      };
    }, undefined, '恢复元素');
    preAcceptStatusRef.current.delete(selectedId);
    preRejectStatusRef.current.delete(selectedId);
  };

  const restoreAllElements = () => {
    if (!window.confirm('恢复全部元素到本轮初始状态？该操作可以撤销。')) return;
    const initialElements = structuredClone(initialAllElementsRef.current);
    commitDraft((current) => ({
      ...current,
      elements: initialElements,
      elementEditRecords: structuredClone(initialElementEditRecordsRef.current),
    }), undefined, '恢复全部元素');
    preAcceptStatusRef.current.clear();
    preRejectStatusRef.current.clear();
    setCheckedIds(new Set());
    if (selectedId && !initialElements.some((element) => element.id === selectedId)) setSelectedId(null);
  };

  const deleteSelectedElement = () => {
    if (!draft || !selectedId) return;
    const deleted = draft.elements.find((element) => element.id === selectedId);
    if (!deleted) return;
    const remainingIds = new Set(draft.elements.filter((element) => element.id !== selectedId).map((element) => element.id));
    const parentId = deleted.parentId && remainingIds.has(deleted.parentId) ? deleted.parentId : null;
    commitDraft((current) => {
      const reparented = current.elements
        .filter((element) => element.id !== selectedId)
        .map((element) => element.parentId === selectedId
          ? {
              ...element,
              parentId,
              ownerKind: parentId ? 'component' as const : 'page' as const,
              ownerRef: parentId || current.currentPageId,
            }
          : element);
      return {
        ...current,
        elementEditRecords: current.elementEditRecords.filter((record) => record.elementId !== selectedId),
        elements: reparented.map((element) => ({
          ...element,
          childrenIds: reparented.filter((candidate) => candidate.parentId === element.id).map((candidate) => candidate.id),
        })),
      };
    }, undefined, '删除元素');
  };

  const selectPage = (pageId: string) => {
    if (!draft) return;
    const page = draft.pages.find((item) => item.id === pageId);
    if (!page) return;
    commitDraft((current) => ({
      ...current,
      currentPageId: page.id,
      currentFrameId: page.frameIds.at(-1) || null,
      page: { id: page.id, key: page.key, name: page.name, functionRef: page.functionRef, implementationType: page.implementationType, surfaceType: page.surfaceType, stateSummary: page.stateSummary, scrollableRegions: page.scrollableRegions },
    }));
    setSelectedId(null);
    setCheckedIds(new Set());
  };

  const openPage = (pageId: string) => {
    const page = draft?.pages.find((item) => item.id === pageId);
    if (!page) return;
    annotationEntryWorkspaceRef.current = workspaceMode;
    selectPage(pageId);
    if (draftRef.current) annotationEntryDraftRef.current = structuredClone(draftRef.current);
    setWorkspaceMode('annotation');
    setViewMode(page.frameIds.length > 0 ? 'review' : 'live');
  };

  const openPageInNewTab = (pageId: string) => {
    const page = draft?.pages.find((item) => item.id === pageId);
    const frameId = page?.frameIds.at(-1);
    if (!page || !frameId) return;
    onOpenAnnotationTab(page.id, frameId, page.name || '待识别页面');
  };

  const showDuplicateCandidateKey = (candidateKey: string, pageIds: string[]) => {
    if (!draft) return;
    const targetPageId = pageIds.includes(draft.currentPageId) ? draft.currentPageId : pageIds[0];
    if (targetPageId && targetPageId !== draft.currentPageId) openPage(targetPageId);
    setDuplicateCandidateKeyFilter(candidateKey);
    setSelectedId(null);
    setCheckedIds(new Set());
    setMultiSelect(false);
    setSideTab('elements');
  };

  const showValidationElement = (issue: ValidationIssue) => {
    if (!draft || !issue.elementId) return;
    const element = draft.elements.find((candidate) => candidate.id === issue.elementId);
    const targetPageId = element?.pageId
      || (element && elementAvailableOnPage(element, draft.currentPageId, draft.elements) ? draft.currentPageId : issue.pageIds?.[0]);
    if (targetPageId && targetPageId !== draft.currentPageId) openPage(targetPageId);
    setDuplicateCandidateKeyFilter(null);
    setSelectedId(issue.elementId);
    setSideTab('elements');
  };

  const updatePage = (pageId: string, patch: Partial<DraftPage>, historyKey?: string) => {
    commitDraft((current) => {
      const pages = current.pages.map((page) => page.id === pageId ? { ...page, ...patch } : page);
      const page = pages.find((item) => item.id === current.currentPageId);
      return { ...current, pages, page: page ? { id: page.id, key: page.key, name: page.name, functionRef: page.functionRef, implementationType: page.implementationType, surfaceType: page.surfaceType, stateSummary: page.stateSummary, scrollableRegions: page.scrollableRegions } : current.page };
    }, historyKey ? `${pageId}:${historyKey}` : undefined);
  };

  const deletePage = async (pageId: string) => {
    const beforeDelete = draftRef.current;
    const wasDirty = dirty;
    if (!beforeDelete || !beforeDelete.pages.some((page) => page.id === pageId)) return;
    commitDraft((current) => removePageFromDraft(current, pageId));
    setSelectedId(null);
    setCheckedIds(new Set());
    setBusy('delete-page');
    try {
      const nextDraft = draftRef.current;
      if (!nextDraft) return;
      const result = await workbenchApi.saveDraft(nextDraft);
      resetDraftState(result.draft, false, true);
      setServerIssues(result.issues);
      showNotice('success', '页面已删除');
    } catch (error) {
      resetDraftState(beforeDelete, wasDirty, true);
      showNotice('error', error instanceof Error ? `页面删除失败：${error.message}` : `页面删除失败：${String(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const prepareStaging = async () => {
    setBusy('staging');
    try {
      const result = await workbenchApi.prepareStaging();
      setStaging(result);
      setStagingVersions((current) => [result, ...current.filter((version) => version.stageId !== result.stageId)]);
      showNotice(result.validation.valid ? 'success' : 'info', result.validation.valid ? 'staging 校验通过' : `staging 有 ${result.validation.errors.length} 个阻断项`);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const publishStaging = async (stageId: string) => {
    setBusy('publish');
    try {
      const result = await workbenchApi.publish(stageId);
      resetDraftState(result.draft, false, true);
      setServerIssues(result.issues);
      showNotice('success', `已发布 ${result.graphRevision}`);
      setStaging(result.version);
      setStagingVersions((await workbenchApi.stagingVersions()).versions);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const mergeStaging = async (stageIds: string[]) => {
    setBusy('merge-staging');
    try {
      const result = await workbenchApi.mergeStaging(stageIds);
      setStaging(result);
      setStagingVersions((current) => [result, ...current.filter((version) => version.stageId !== result.stageId)]);
      showNotice('success', `已合并 ${stageIds.length} 个版本`);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const deleteStaging = async (stageId: string) => {
    if (!window.confirm('删除这个未发布版本？该操作无法撤销。')) return;
    setBusy('delete-staging');
    try {
      await workbenchApi.deleteStaging(stageId);
      const versions = stagingVersions.filter((version) => version.stageId !== stageId);
      setStagingVersions(versions);
      if (staging?.stageId === stageId) setStaging(versions[0] || null);
      showNotice('success', 'Staging 版本已删除');
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const archiveStaging = async (stageId: string) => {
    if (!window.confirm('归档后该版本将永久不能回退，确认归档？')) return;
    setBusy('archive-staging');
    try {
      const version = await workbenchApi.archiveStaging(stageId);
      setStagingVersions((current) => current.map((item) => item.stageId === stageId ? version : item));
      if (staging?.stageId === stageId) setStaging(version);
      showNotice('success', '版本已归档');
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const rollbackStaging = async (stageId: string) => {
    if (!window.confirm('将活动图谱回退到这个版本？系统会保留当前版本并生成一条新的发布记录。')) return;
    setBusy('rollback-staging');
    try {
      const result = await workbenchApi.rollbackStaging(stageId);
      resetDraftState(result.draft, false, true);
      setServerIssues(result.issues);
      setStaging(result.version);
      setStagingVersions((await workbenchApi.stagingVersions()).versions);
      showNotice('success', `已回退并发布 ${result.graphRevision}`);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const connected = Boolean(device.runtimeInfo && status?.agentConnected);

  return (
    <div className={`app-shell app-shell-${tabKind} ${active ? '' : 'app-shell-hidden'}`} aria-hidden={!active}>
      <header className="topbar">
        <div className="brand"><img className="brand-icon" src="/graphrag-icon.svg?v=3" alt="" /><div><strong>VibeOps</strong><span>{tabKind === 'model' ? 'Project Graph 1.0' : status?.spec.version || 'UIKG'}</span></div></div>
        <label className="topbar-app-field"><span>{tabKind === 'model' ? '项目' : '应用'}</span><input value={tabKind === 'model' ? '宝盒' : draft?.appKey || ''} disabled={tabKind === 'model'} onBlur={endHistoryGroup} onChange={(event) => updateDraft((current) => ({ ...current, appKey: event.target.value }), 'draft:appKey')} /></label>
        <div className="device-controls">
          <div className={`connection-dot ${connected ? 'connected' : deviceDiscoveryError ? 'error' : ''}`} title={deviceDiscoveryError || (connected ? '设备已连接' : '设备未连接')} />
          <select value={selectedDevice} disabled={connected || busy === 'connect'} onChange={(event) => setSelectedDevice(event.target.value)} aria-label="Android 设备">
            {device.targets.length === 0 && <option value="">{deviceDiscoveryError ? '设备服务不可用' : '未发现 Android 设备'}</option>}
            {device.targets.map((target) => <option key={target.id} value={target.id}>{target.description || target.label}</option>)}
          </select>
          <button type="button" className="icon-button" title="刷新设备列表" onClick={() => void refreshConnection(true)}><RefreshCw size={16} /></button>
          {!connected ? (
            <button type="button" className="button" disabled={!selectedDevice || busy === 'connect'} onClick={() => void connectDevice()}>{busy === 'connect' ? <LoaderCircle className="spin" size={16} /> : <Smartphone size={16} />}连接设备</button>
          ) : (
            <button type="button" className="icon-button" title="断开设备" disabled={busy === 'disconnect'} onClick={() => void disconnectDevice()}><Unplug size={16} /></button>
          )}
        </div>
        <div className="header-actions">
          <button type="button" className={`button global-model-button ${tabKind === 'settings' ? 'active' : ''}`} onClick={onOpenSettingsTab}><Settings2 size={15} />设置</button>
        </div>
      </header>

      <InternalTabBar tabs={tabs} activeTabId={activeTabId} dirtyTabIds={dirtyTabIds} onSelectTab={onSelectTab} onCloseTab={onCloseTab} onUploadPage={() => setPageUploadOpen(true)} onCreateFromDevice={onOpenDeviceAnnotationTab} />

      {tabKind !== 'knowledge' && tabKind !== 'model' && tabKind !== 'settings' && <div className={`contextbar contextbar-${tabKind}`}>
        {tabKind === 'annotation' && viewMode === 'review' && <div className="contextbar-mode-model">
          <div className="mode-segment" aria-label="探索模式">
            <button type="button" className={explorationMode === 'ultra' ? 'active' : ''} title="Model A 与 Model B 并发识别，再按元素和字段选择合并" onClick={() => void changeExplorationMode('ultra')}>Ultra</button>
            <button type="button" className={explorationMode === 'manual' ? 'active' : ''} title="使用 Manual 页面识别模型识别后进入人工维护与审核" onClick={() => void changeExplorationMode('manual')}>Manual</button>
          </div>
          <span className="recognition-model" title={explorationMode === 'ultra' ? `配置模型：${status?.ultraModelA || '未配置'} + ${status?.ultraModelB || '未配置'}` : `配置模型：${status?.manualModel || '未配置'}`}>
            <strong>配置模型：</strong>{explorationMode === 'ultra' ? `${status?.ultraModelA || '未配置'} + ${status?.ultraModelB || '未配置'}` : status?.manualModel || '未配置'}
          </span>
        </div>}
        {tabKind === 'annotation' && annotationTarget && <div className={`page-name-control ${pageNameEditing ? 'editing' : ''}`}>
          <span>页面名称：</span>
          {pageNameEditing ? (
            <input
              autoFocus
              aria-label="页面名称"
              value={pageNameDraft}
              onChange={(event) => setPageNameDraft(event.target.value)}
              onBlur={commitPageName}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') {
                  setPageNameDraft(draft?.page.name || '');
                  setPageNameEditing(false);
                }
              }}
            />
          ) : <strong>{draft?.page.name || '待识别页面'}</strong>}
          <button type="button" className="icon-button" aria-label={pageNameEditing ? '保存页面名称' : '编辑页面名称'} title={pageNameEditing ? '保存页面名称' : '编辑页面名称'} onMouseDown={(event) => event.preventDefault()} onClick={pageNameEditing ? commitPageName : startEditingPageName}>{pageNameEditing ? <Check size={14} /> : <Pencil size={14} />}</button>
        </div>}
        {tabKind === 'workspace' && <div className="workspace-tabs" aria-label="工作区">
          {tabKind === 'workspace' && <button type="button" className={workspaceMode === 'graph' ? 'active' : ''} onClick={() => setWorkspaceMode('graph')}><PanelsTopLeft size={14} />页面图</button>}
          {tabKind === 'workspace' && <button type="button" className={workspaceMode === 'staging' ? 'active' : ''} onClick={() => setWorkspaceMode('staging')}><FileDiff size={14} />Staging</button>}
        </div>}
        <div className="contextbar-actions">
          {tabKind === 'workspace' && workspaceMode === 'graph' && <button type="button" className="button contextbar-transfer-button" onClick={() => setTransferCenterOpen(true)}><svg className="contextbar-transfer-mark" viewBox="0 0 1024 1024" aria-hidden="true" focusable="false"><g transform="rotate(-90 512 512)"><path d="M856.2 442.7H167.1c-22.1 0-40-17.9-40-40s17.9-40 40-40h689.1c22.1 0 40 17.9 40 40s-17.9 40-40 40z" /><path d="M856.9 442.6c-10.6 0-21.1-4.2-29-12.4L674.4 268.9c-15.2-16-14.6-41.3 1.4-56.6 16-15.2 41.3-14.6 56.6 1.4L885.9 375c15.2 16 14.6 41.3-1.4 56.6-7.8 7.4-17.7 11-27.6 11z" /><path d="M856.9 661.3H167.8c-22.1 0-40-17.9-40-40s17.9-40 40-40h689.1c22.1 0 40 17.9 40 40s-17.9 40-40 40z" /><path d="M320.6 822.7c-10.6 0-21.1-4.2-29-12.4L138.1 649c-15.2-16-14.6-41.3 1.4-56.6 16-15.2 41.3-14.6 56.6 1.4l153.5 161.3c15.2 16 14.6 41.3-1.4 56.6-7.7 7.4-17.7 11-27.6 11z" /></g></svg>传输中心</button>}
          {tabKind === 'workspace' && <span className="spec-hash" title={status?.spec.contentHash}>Schema {status?.spec.schemaVersion || '3.0.0'}</span>}
          {tabKind === 'annotation' && <>
            <button type="button" className="button button-primary contextbar-save-button" disabled={!draft || !dirty || Boolean(busy)} onClick={() => void saveCurrentPage()}>{busy === 'save-page' ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}保存</button>
            <button type="button" className="button" disabled={busy === 'save-page'} onClick={() => onCloseTab(tabId)}><X size={15} />关闭</button>
          </>}
        </div>
      </div>}

      {tabKind === 'model' ? (
        <ProjectModelSettings onNotice={showNotice} />
      ) : tabKind === 'settings' ? (
        <ModelSettings
          onNotice={showNotice}
          onSaved={(settings) => {
            setStatus((current) => current ? {
              ...current,
              manualModelConfigured: Boolean(settings.manual.config.modelName),
              manualModel: settings.manual.config.modelName || null,
              ultraModelAConfigured: Boolean(settings.ultraModelA.config.modelName),
              ultraModelA: settings.ultraModelA.config.modelName || null,
              ultraModelBConfigured: Boolean(settings.ultraModelB.config.modelName),
              ultraModelB: settings.ultraModelB.config.modelName || null,
            } : current);
            const configuredMode = settings.modeConfiguration?.mode;
            if (configuredMode === 'manual' || configuredMode === 'ultra') window.dispatchEvent(new CustomEvent('uikg-mode-change', { detail: configuredMode }));
          }}
        />
      ) : tabKind === 'knowledge' ? (
        active ? <KnowledgeGraph appKey={draft?.appKey || 'zto.connect'} onGoToWorkbench={() => onSelectTab('workspace')} onOpenModel={onOpenModelTab} /> : null
      ) : workspaceMode === 'annotation' ? <main className="workspace">
        <section className="device-panel">
          <div className="panel-toolbar">
            <div className="view-tabs">
              <button type="button" className={viewMode === 'live' ? 'active' : ''} title="实时操作" disabled><Play size={14} /><span>实时操作</span></button>
              <button type="button" className={viewMode === 'frozen' ? 'active' : ''} title="冻结画面" disabled><Camera size={14} /><span>冻结画面</span></button>
              <button type="button" className={viewMode === 'review' ? 'active' : ''} title="页面标注" disabled><SquareDashed size={14} /><span>页面标注</span></button>
            </div>
            <div className="toolbar-actions">
              {viewMode === 'live' ? (
                <>
                  <button type="button" className="button" disabled={!connected || busy === 'freeze'} onClick={() => void captureFrame()}>{busy === 'freeze' ? <LoaderCircle className="spin" size={15} /> : <Camera size={15} />}冻结画面</button>
                </>
              ) : viewMode === 'frozen' ? (
                <>
                  <button type="button" className="button" disabled={busy === 'discard-freeze'} onClick={() => void discardFrozenCapture()}>{busy === 'discard-freeze' ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}重新冻结</button>
                  <button type="button" className="button button-primary" disabled={!frameUrl || busy === 'discard-freeze'} onClick={startAnnotation}><SquareDashed size={15} />开始标注</button>
                </>
              ) : (
                <>
                  <button type="button" className="icon-button danger-button" title="取消标注" aria-label="取消标注" disabled={busy === 'cancel-annotation' || busy === 'review-complete'} onClick={requestCancelAnnotation}><X size={16} /></button>
                  <button type="button" className={`icon-button ${drawing ? 'active' : ''}`} title="绘制新元素" onClick={() => setDrawing((value) => !value)}><span className="drawing-tool-icon" aria-hidden="true"><SquareDashed /><Feather /></span></button>
                  {modelActivity?.status === 'paused' && <button type="button" className="icon-button recognition-resume-button" title={`继续页面识别，已完成 ${modelActivity.completedCandidates || 0} 个候选`} aria-label="继续页面识别" onClick={() => setRecognitionDialogOpen(true)}><RefreshCw size={15} /></button>}
                  <button type="button" className="icon-button" title="页面识别历史" disabled={pageHistorySessions.length === 0} onClick={openRecognitionHistory}><History size={15} /></button>
                  <button type="button" className="icon-button recognition-button" title={hasAnalyzedCurrentFrame ? '重新识别' : '识别分析'} aria-label={hasAnalyzedCurrentFrame ? '重新识别' : '识别分析'} disabled={!draft?.currentFrameId || busy === 'recognition' || busy === 'ultra-a' || busy === 'ultra-b' || modelActivity?.status === 'paused' || (explorationMode === 'manual' ? !status?.manualModelConfigured : !status?.ultraModelAConfigured || !status?.ultraModelBConfigured)} onClick={() => void runRecognition()}>{busy === 'recognition' || busy === 'ultra-a' || busy === 'ultra-b' ? <LoaderCircle className="spin" size={15} /> : <ScanSearch size={15} />}</button>
                </>
              )}
            </div>
          </div>
          <div
            className={`device-stage-wrap ${ultraModelComparison && explorationMode === 'ultra' ? 'has-ultra-model-comparison' : ''}`}
            onPointerDown={(event) => {
              if (viewMode === 'review' && event.target === event.currentTarget) setSelectedId(null);
            }}
          >
            {viewMode === 'live' ? (
              connected ? (
                <div className="live-preview">
                  <LiveDevicePreview client={deviceClient} runtimeInfo={device.runtimeInfo!} serverUrl={serverUrl} enabled={!['recognition', 'ultra-a', 'ultra-b'].includes(busy || '')} onError={(message) => showNotice('error', message)} />
                </div>
              ) : (
                <div className="device-empty"><MonitorSmartphone size={42} /><strong>暂无实时设备画面</strong><span>未检测到 Android 设备，连接设备后可开始实时操作</span></div>
              )
            ) : viewMode === 'frozen' && frameUrl ? (
              <img className="frozen-frame" src={frameUrl} alt="冻结设备画面" />
            ) : frameUrl ? (
              explorationMode === 'ultra' && ultraModelComparison ? (
                <UltraModelComparisonPanel imageUrl={frameUrl} modelAResult={ultraModelComparison.modelAResult} modelBResult={ultraModelComparison.modelBResult} applying={busy === 'ultra-model-merge'} candidatePortalTarget={ultraModelCandidatePortal} onApply={(selections) => void applyUltraModelComparison(selections)} />
              ) : (
                <AnnotationCanvas imageUrl={frameUrl} elements={currentElements} selectedId={selectedId} drawing={drawing} showRejected={showRejected} showGridGuides={showGridGuides} onSelect={setSelectedId} onAdd={addElement} onBoxChange={(id, bbox) => updateElement(id, { bbox }, `bbox:${id}`)} onBoxChangeEnd={endHistoryGroup} />
              )
            ) : (
              <div className="device-empty"><MonitorSmartphone size={42} /><strong>暂无冻结画面</strong><span>请先在实时操作中冻结设备画面</span></div>
            )}
          </div>
          <div className="frame-status">
            <span>{viewMode === 'live' ? connected ? 'LIVE' : 'OFFLINE' : viewMode === 'frozen' ? 'FROZEN' : draft?.currentFrameId ? 'ANNOTATING' : 'EMPTY'}</span>
            <code>{draft?.currentFrameId ? `${draft.currentFrameId.slice(0, 22)}...` : '暂无 frameId'}</code>
            {frame && <small>{frame.width} × {frame.height}</small>}
          </div>
        </section>

        <section className="tree-panel">
          <div className="panel-title">
            <div className="panel-title-heading">
              <MousePointer2 size={16} /><strong>页面元素</strong><span>{ultraModelComparison && explorationMode === 'ultra' ? '候选' : currentElements.length}</span>
              {!(ultraModelComparison && explorationMode === 'ultra') && <div className="element-history-actions" aria-label="元素历史操作">
                <button type="button" className="icon-button" title="撤销上一步" disabled={pastRef.current.length === 0 || historyBlockedForPendingPage} onClick={undo}><Undo2 size={15} /></button>
                <button type="button" className="icon-button" title="取消撤销" disabled={futureRef.current.length === 0 || historyBlockedForPendingPage} onClick={redo}><Redo2 size={15} /></button>
                <button type="button" className="icon-button" title="恢复全部" disabled={!canRestoreAllElements} onClick={restoreAllElements}><RotateCcw size={15} /></button>
                <button type="button" className={`icon-button ${showRejected ? 'active' : ''}`} title={showRejected ? '隐藏已忽略元素' : '显示已忽略元素'} aria-pressed={showRejected} onClick={() => setShowRejected((value) => !value)}>{showRejected ? <Eye size={15} /> : <EyeOff size={15} />}</button>
              </div>}
            </div>
            {!(ultraModelComparison && explorationMode === 'ultra') && <div className="element-toolbar" aria-label="元素全局操作">
              <button type="button" className={`icon-button ${multiSelect ? 'active' : ''}`} title="多选" aria-pressed={multiSelect} disabled={currentElements.length === 0} onClick={() => { setMultiSelect((value) => !value); if (multiSelect) setCheckedIds(new Set()); }}><ListChecks size={15} /></button>
            </div>}
          </div>
          {ultraModelComparison && explorationMode === 'ultra' ? <div className="ultra-model-candidate-portal" ref={setUltraModelCandidatePortal} /> : <ElementTree elements={treeElements} filterCandidateKey={duplicateCandidateKeyFilter} selectedId={selectedId} multiSelect={multiSelect} checkedIds={checkedIds} allChecked={allCurrentChecked} allCheckedAccepted={allCheckedAccepted} onToggleAll={() => setCheckedIds(allCurrentChecked ? new Set() : new Set(treeElements.map((element) => element.id)))} onCreateContainer={createContainerFromSelection} onToggleAccept={allCheckedAccepted ? bulkCancelAccept : bulkAccept} onDeleteChecked={deleteCheckedElements} onSelect={setSelectedId} onCheck={(id, checked) => setCheckedIds((current) => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; })} onClearFilter={() => setDuplicateCandidateKeyFilter(null)} />}
          <div className={`tree-legend ${ultraModelComparison && explorationMode === 'ultra' ? 'ultra-model-source-legend' : ''}`}>
            {ultraModelComparison && explorationMode === 'ultra' ? <><span><i className="legend-ultra-a" />Model A</span><span><i className="legend-ultra-b" />Model B</span></> :
              (Object.entries(reviewStatusLabels) as [keyof typeof reviewStatusLabels, string][]).map(([statusKey, label]) => <span key={statusKey}><i className={`legend-${statusKey}`} />{label}</span>)}
          </div>
        </section>

        <section className="detail-panel">
          <div className="detail-tabs">
            <button type="button" className={sideTab === 'elements' ? 'active' : ''} onClick={() => setSideTab('elements')}><PanelRight size={15} />属性</button>
            <button type="button" className={sideTab === 'validation' ? 'active' : ''} onClick={() => setSideTab('validation')}><CloudCog size={15} />校验<span>{issues.length}</span></button>
            <button type="button" className={sideTab === 'history' ? 'active' : ''} onClick={() => setSideTab('history')}><History size={15} />记录<span>{elementActivities.length}</span></button>
          </div>
          {sideTab === 'elements' ? (
            <Inspector
              element={selectedElement}
              initialElement={initialSelectedElement}
              elements={currentElements}
              pages={draft?.pages || []}
              currentPageId={draft?.currentPageId || ''}
              showGridGuides={showGridGuides}
              canRestoreCurrent={canRestoreSelectedElement}
              onShowGridGuidesChange={setShowGridGuides}
              onChange={(patch, historyKey) => selectedId && updateElement(selectedId, patch, historyKey ? `${selectedId}:${historyKey}` : undefined)}
              onChangeEnd={endHistoryGroup}
              onRestoreCurrent={restoreSelectedElement}
              onAccept={() => selectedElement && toggleAccept(selectedElement)}
              onReject={() => selectedElement && toggleReject(selectedElement)}
              onDelete={deleteSelectedElement}
            />
          ) : sideTab === 'validation' ? (
            <div className="validation-list">
              {validationIssueGroups.length === 0 ? <div className="validation-empty"><CircleCheck size={30} /><strong>当前草稿检查通过</strong></div> : validationIssueGroups.map((group) => (
                <section key={`${group.level}:${group.code}`} className={`validation-group validation-${group.level}`}>
                  <header><CircleAlert size={15} /><div><strong>{validationIssueTypeLabels[group.code] || group.issues[0].message}</strong><code>{group.code}</code></div><span>{validationGroupItems(group).length}</span></header>
                  <div>
                    {validationGroupItems(group).map((itemIssues, index) => {
                      const issue = itemIssues[0];
                      const duplicateIssue = group.code.startsWith('candidate_key_duplicate_');
                      const samePageDuplicate = group.code === 'candidate_key_duplicate_current_page';
                      const relatedElementIds = [...new Set(itemIssues.flatMap((item) => item.relatedElementIds || (item.elementId ? [item.elementId] : [])))];
                      const relatedElements = relatedElementIds.flatMap((id) => {
                        const element = draft?.elements.find((candidate) => candidate.id === id);
                        return element ? [element] : [];
                      });
                      const relatedPageIds = [...new Set(itemIssues.flatMap((item) => item.pageIds || []))];
                      const relatedPages = relatedPageIds.map((id) => draft?.pages.find((page) => page.id === id)).filter((page): page is DraftPage => Boolean(page));
                      const relatedPageNames = relatedPages.map((page) => relatedPages.filter((candidate) => candidate.name === page.name).length > 1 ? `${page.name}（${page.id.slice(-8)}）` : page.name);
                      const element = issue.elementId ? draft?.elements.find((candidate) => candidate.id === issue.elementId) : null;
                      const detail = samePageDuplicate
                        ? `${relatedPageNames.join('、')} · ${relatedElements.map((candidate) => candidate.label).join('、')}`
                        : duplicateIssue
                          ? `涉及页面：${relatedPageNames.join('、')}`
                          : issue.message;
                      return <button key={`${issue.code}-${issue.candidateKey || issue.elementId || 'draft'}-${index}`} type="button" disabled={!issue.elementId} onClick={() => {
                        if (samePageDuplicate && issue.candidateKey) showDuplicateCandidateKey(issue.candidateKey, relatedPageIds);
                        else showValidationElement(issue);
                      }}><span><strong>{duplicateIssue ? issue.candidateKey : element?.label || '当前草稿'}</strong><small>{detail}</small></span>{samePageDuplicate ? <ListFilter size={14} /> : issue.elementId && <ChevronRight size={14} />}</button>;
                    })}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <EditHistoryPanel records={elementActivities} onSelectElement={(id) => { setSelectedId(id); setSideTab('elements'); }} />
          )}
        </section>
      </main> : workspaceMode === 'graph' && draft ? (
        <PageGraph draft={pageGraphDraft || draft} draftDirty={dirty} onOpenPage={openPageInNewTab} onCreateFromDevice={onOpenDeviceAnnotationTab} onUploadDraftChange={(nextDraft) => { resetDraftState(nextDraft, false, true); setServerIssues(validateDraftClient(nextDraft)); }} onUpdatePage={(pageId, patch, historyKey) => { updatePage(pageId, patch, historyKey); if (patch.name !== undefined) onPageNameChange(pageId, patch.name); }} onDeletePage={(pageId) => { onPageNameChange(pageId, null); void deletePage(pageId); }} onChangeEnd={endHistoryGroup} />
      ) : workspaceMode === 'staging' ? (
        <StagingPanel versions={stagingVersions} staging={staging} busy={busy} dirty={dirty} onPrepare={() => void prepareStaging()} onSelect={setStaging} onMerge={(stageIds) => void mergeStaging(stageIds)} onPublish={(stageId) => void publishStaging(stageId)} onDelete={(stageId) => void deleteStaging(stageId)} onRollback={(stageId) => void rollbackStaging(stageId)} onArchive={(stageId) => void archiveStaging(stageId)} />
      ) : (
        <div />
      )}

      {pendingRecognitionReplacement && <div className="annotation-cancel-backdrop recognition-replacement-backdrop" role="presentation">
        <section className="annotation-cancel-dialog recognition-replacement-dialog" role="dialog" aria-modal="true" aria-labelledby="recognition-replacement-title" onMouseDown={(event) => event.stopPropagation()}>
          <header><div><strong id="recognition-replacement-title">是否使用新的识别结果？</strong><span>当前页面已有识别结果。使用新结果会替换当前页面的原有识别内容；保留原结果则丢弃本次新结果。</span></div></header>
          <div className="recognition-replacement-summary">
            <span><small>原有结果</small><strong>{currentElements.length} 个元素</strong></span>
            <ChevronRight size={18} />
            <span><small>新的结果</small><strong>{pendingRecognitionReplacement.kind === 'manual' ? `${pendingRecognitionReplacement.result.recognitionResult.elements.length} 个元素` : `${pendingRecognitionReplacement.selections.length} 个合并元素`}</strong></span>
          </div>
          <div className="annotation-cancel-options">
            <button type="button" className="annotation-cancel-option save" disabled={recognitionReplacementBusy} onClick={() => void confirmRecognitionReplacement()}><strong>{recognitionReplacementBusy ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}使用新的结果</strong><span>{pendingRecognitionReplacement.kind === 'ultra' ? '使用当前 Model A / B 合并选择替换原结果。' : '用本次重新识别的内容替换当前页面结果。'}</span></button>
            <button type="button" className="annotation-cancel-option" disabled={recognitionReplacementBusy} onClick={keepExistingRecognitionResult}><strong>保留原有结果</strong><span>不应用本次重新识别结果，继续使用当前页面内容。</span></button>
          </div>
        </section>
      </div>}

      {cancelDialogOpen && <div className="annotation-cancel-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCancelDialogOpen(false); }}>
        <section className="annotation-cancel-dialog" role="dialog" aria-modal="true" aria-labelledby="annotation-cancel-title" onMouseDown={(event) => event.stopPropagation()}>
          <header><div><strong id="annotation-cancel-title">取消标注</strong><span>请选择返回冻结画面继续处理，或放弃本次变更并关闭页面。</span></div><button type="button" className="icon-button" aria-label="关闭" title="关闭" onClick={() => setCancelDialogOpen(false)}><X size={16} /></button></header>
          <div className="annotation-cancel-options">
            <button type="button" className="annotation-cancel-option" disabled={!annotationEntryDraftRef.current || busy === 'cancel-annotation'} onClick={() => void restoreAnnotationEntry('frozen')}><strong>回退到冻结画面节点</strong><span>放弃进入标注后产生的识别、编辑和选择变化，保留当前截图。</span></button>
            <button type="button" className="annotation-cancel-option danger" disabled={!annotationEntryDraftRef.current || busy === 'cancel-annotation'} onClick={() => void restoreAnnotationEntry('close')}><strong>放弃变更并关闭页面</strong><span>恢复进入标注前的页面数据，并关闭当前内部标签页。</span></button>
          </div>
          <footer><button type="button" className="button" onClick={() => setCancelDialogOpen(false)}>继续标注</button></footer>
        </section>
      </div>}
      <PageUploadDialog open={pageUploadOpen} draftDirty={dirty} onClose={() => setPageUploadOpen(false)} onDraftChange={(nextDraft) => { resetDraftState(nextDraft, false, true); setServerIssues(validateDraftClient(nextDraft)); }} />
      <PageUploadDialog open={transferCenterOpen} purpose="history" draftDirty={dirty} onClose={() => setTransferCenterOpen(false)} onDraftChange={(nextDraft) => { resetDraftState(nextDraft, false, true); setServerIssues(validateDraftClient(nextDraft)); }} />
      {notice && <div className={`notice notice-${notice.type}`}>{notice.type === 'error' ? <CircleAlert size={16} /> : <CircleCheck size={16} />}{notice.text}</div>}
      {recognitionDialogOpen && modelActivity && frameUrl && <RecognitionProgressPanel activity={modelActivity} modelName={explorationMode === 'ultra' ? status?.ultraModelA || null : status?.manualModel || null} modelBModel={status?.ultraModelB || null} ultraMode={explorationMode === 'ultra'} sessions={pageHistorySessions} acceptedSessionId={acceptedHistorySessionId} recognitionControlBusy={recognitionControlBusy || (busy === 'ultra-a' || busy === 'ultra-b' ? busy : null)} onCancel={() => void cancelUltraModels()} onCancelModel={(kind) => void cancelUltraModel(kind)} onRetryModel={(kind) => kind === 'ultra_a' ? void retryUltraModelA() : void retryUltraModelB()} onResumeModel={(kind) => kind === 'ultra_a' ? void resumeUltraModelA() : void resumeUltraModelB()} onRetry={() => modelActivity.resumeKind === 'manual' ? void resumeManualRecognition() : modelActivity.resumeKind === 'ultra_b' ? void resumeUltraModelB() : modelActivity.resumeKind === 'ultra_a' ? void resumeUltraModelA() : modelActivity.phase === 'ultra-b-error' ? void retryUltraModelB() : void runRecognition()} onClose={closeRecognitionDialog} />}
    </div>
  );
}

export default function App() {
  const [tabs, setTabs] = useState<InternalTab[]>(() => [
    { id: 'knowledge', title: '知识图谱', sessionId: createAnnotationSessionId(), kind: 'knowledge', annotationTarget: null },
    { id: 'workspace', title: '工作台', sessionId: createAnnotationSessionId(), kind: 'workspace', annotationTarget: null },
  ]);
  const [activeTabId, setActiveTabId] = useState('knowledge');
  const [tabRefreshKeys, setTabRefreshKeys] = useState<Record<string, number>>({});
  const [pageNameOverrides, setPageNameOverrides] = useState<Record<string, string>>({});
  const [tabNotice, setTabNotice] = useState<string | null>(null);
  const [tabDirtyStates, setTabDirtyStates] = useState<Record<string, boolean>>({});
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);
  const [pendingCloseSaving, setPendingCloseSaving] = useState(false);
  const [pendingRecoveries, setPendingRecoveries] = useState<UnsavedAnnotationRecovery[]>(() => readUnsavedAnnotationRecoveries());
  const [recoveryDrafts, setRecoveryDrafts] = useState<Record<string, Draft>>({});
  const tabSaveHandlersRef = useRef(new Map<string, () => Promise<boolean>>());
  const dirtyTabIds = useMemo(() => new Set(Object.entries(tabDirtyStates).filter(([, dirty]) => dirty).map(([tabId]) => tabId)), [tabDirtyStates]);

  const handleTabDirtyChange = useCallback((tabId: string, dirty: boolean) => {
    setTabDirtyStates((current) => {
      if (current[tabId] === dirty) return current;
      if (!dirty && !Object.prototype.hasOwnProperty.call(current, tabId)) return current;
      const next = { ...current };
      if (dirty) next[tabId] = true;
      else delete next[tabId];
      return next;
    });
  }, []);

  const registerTabSaveHandler = useCallback((tabId: string, handler: (() => Promise<boolean>) | null) => {
    if (handler) tabSaveHandlersRef.current.set(tabId, handler);
    else tabSaveHandlersRef.current.delete(tabId);
  }, []);

  const selectTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
    setTabRefreshKeys((current) => ({ ...current, [tabId]: (current[tabId] || 0) + 1 }));
  }, []);

  const showPageTabLimit = () => {
    const text = `页面标签页最多可打开 ${MAX_PAGE_TABS} 个，请先关闭不需要的页面`;
    setTabNotice(text);
    window.setTimeout(() => setTabNotice((current) => current === text ? null : current), 4200);
  };

  const openAnnotationTab = (pageId: string, frameId: string, title = '待识别页面') => {
    if (tabs.filter((tab) => tab.kind === 'annotation').length >= MAX_PAGE_TABS) {
      showPageTabLimit();
      return;
    }
    const sessionId = createAnnotationSessionId();
    setTabs((current) => [...current, {
      id: sessionId,
      title,
      sessionId,
      kind: 'annotation',
      annotationTarget: { pageId, frameId, sessionId },
    }]);
    selectTab(sessionId);
  };

  const openDeviceAnnotationTab = () => {
    if (tabs.filter((tab) => tab.kind === 'annotation').length >= MAX_PAGE_TABS) {
      showPageTabLimit();
      return;
    }
    const sessionId = createAnnotationSessionId();
    setTabs((current) => [...current, {
      id: sessionId,
      title: '新建页面',
      sessionId,
      kind: 'annotation',
      annotationTarget: null,
    }]);
    selectTab(sessionId);
  };

  const openSettingsTab = () => {
    const existing = tabs.find((tab) => tab.kind === 'settings');
    if (existing) {
      selectTab(existing.id);
      return;
    }
    const settingsTab: InternalTab = { id: 'settings', title: '设置', sessionId: createAnnotationSessionId(), kind: 'settings', annotationTarget: null };
    setTabs((current) => {
      const fixed = current.filter((tab) => tab.kind !== 'annotation');
      const pages = current.filter((tab) => tab.kind === 'annotation');
      return [...fixed, settingsTab, ...pages];
    });
    selectTab(settingsTab.id);
  };

  const openModelTab = () => {
    const existing = tabs.find((tab) => tab.kind === 'model');
    if (existing) {
      selectTab(existing.id);
      return;
    }
    const modelTab: InternalTab = { id: 'model', title: '图谱模型', sessionId: createAnnotationSessionId(), kind: 'model', annotationTarget: null };
    setTabs((current) => {
      const fixed = current.filter((tab) => tab.kind !== 'annotation');
      const pages = current.filter((tab) => tab.kind === 'annotation');
      return [...fixed, modelTab, ...pages];
    });
    selectTab(modelTab.id);
  };

  const promoteAnnotationTab = (tabId: string, pageId: string, frameId: string, title = '待识别页面') => {
    setTabs((current) => current.map((tab) => tab.id === tabId ? {
      ...tab,
      title,
      annotationTarget: { pageId, frameId, sessionId: tab.sessionId },
    } : tab));
  };

  const renameAnnotationTab = (tabId: string, title: string) => {
    setTabs((current) => current.map((tab) => tab.id === tabId ? { ...tab, title } : tab));
  };

  const handlePageNameChange = (pageId: string, name: string | null) => {
    setPageNameOverrides((current) => {
      if (name === null) {
        if (!Object.prototype.hasOwnProperty.call(current, pageId)) return current;
        const next = { ...current };
        delete next[pageId];
        return next;
      }
      return { ...current, [pageId]: name };
    });
  };

  const closeTabImmediately = (tabId: string) => {
    removeUnsavedAnnotationRecovery(tabId);
    tabSaveHandlersRef.current.delete(tabId);
    setTabs((current) => {
      const closingTab = current.find((tab) => tab.id === tabId);
      if (!closingTab || (closingTab.kind !== 'annotation' && closingTab.kind !== 'settings' && closingTab.kind !== 'model')) return current;
      const index = current.findIndex((tab) => tab.id === tabId);
      const next = current.filter((tab) => tab.id !== tabId);
      if (activeTabId === tabId) {
        const fallback = closingTab.kind === 'settings' || closingTab.kind === 'model' ? 'knowledge' : next[Math.max(0, index - 1)]?.id || 'workspace';
        setActiveTabId(fallback);
      }
      return next;
    });
    setTabDirtyStates((current) => {
      if (!Object.prototype.hasOwnProperty.call(current, tabId)) return current;
      const next = { ...current };
      delete next[tabId];
      return next;
    });
    setPendingCloseTabId((current) => current === tabId ? null : current);
    setPendingCloseSaving(false);
    setRecoveryDrafts((current) => {
      if (!Object.prototype.hasOwnProperty.call(current, tabId)) return current;
      const next = { ...current };
      delete next[tabId];
      return next;
    });
  };

  const requestCloseTab = (tabId: string) => {
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (tab?.kind === 'annotation' && dirtyTabIds.has(tabId)) {
      setPendingCloseTabId(tabId);
      return;
    }
    closeTabImmediately(tabId);
  };

  const saveAndClosePendingTab = async () => {
    if (!pendingCloseTabId || pendingCloseSaving) return;
    const saveHandler = tabSaveHandlersRef.current.get(pendingCloseTabId);
    if (!saveHandler) {
      setTabNotice('当前页面尚未加载完成，暂时无法保存');
      return;
    }
    setPendingCloseSaving(true);
    try {
      if (await saveHandler()) closeTabImmediately(pendingCloseTabId);
    } finally {
      setPendingCloseSaving(false);
    }
  };

  const restoreUnsavedPages = () => {
    const recoveries = pendingRecoveries.slice(-MAX_PAGE_TABS);
    if (pendingRecoveries.length > MAX_PAGE_TABS) {
      const text = `未保存页面超过上限，仅恢复最近 ${MAX_PAGE_TABS} 个页面`;
      setTabNotice(text);
      window.setTimeout(() => setTabNotice((current) => current === text ? null : current), 5200);
    }
    const restoredTabs: InternalTab[] = recoveries.map((entry) => ({
      id: entry.tabId,
      title: entry.title || entry.draft.page.name || '未保存页面',
      sessionId: entry.sessionId,
      kind: 'annotation',
      annotationTarget: entry.annotationTarget ? { ...entry.annotationTarget, sessionId: entry.sessionId } : null,
    }));
    setRecoveryDrafts(Object.fromEntries(recoveries.map((entry) => [entry.tabId, structuredClone(entry.draft)])));
    setTabDirtyStates((current) => ({ ...current, ...Object.fromEntries(recoveries.map((entry) => [entry.tabId, true])) }));
    setTabs((current) => [...current, ...restoredTabs.filter((tab) => !current.some((candidate) => candidate.id === tab.id))]);
    if (restoredTabs.length > 0) selectTab(restoredTabs.at(-1)!.id);
    setPendingRecoveries([]);
  };

  const discardUnsavedRecoveries = () => {
    clearUnsavedAnnotationRecoveries();
    setPendingRecoveries([]);
  };

  const pendingCloseTab = pendingCloseTabId ? tabs.find((tab) => tab.id === pendingCloseTabId) : null;

  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#087f5b', borderRadius: 6, fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif' } }}>
      <AntdApp>
        <div className="internal-workbench">
          {tabs.map((tab) => <AppContent
            key={tab.id}
            tabId={tab.id}
            tabTitle={tab.title}
            tabKind={tab.kind}
            annotationTarget={tab.annotationTarget}
            annotationSessionId={tab.sessionId}
            recoveryDraft={recoveryDrafts[tab.id] || null}
            pageNameOverrides={pageNameOverrides}
            active={activeTabId === tab.id}
            tabRefreshKey={tabRefreshKeys[tab.id] || 0}
            onOpenAnnotationTab={openAnnotationTab}
            onOpenDeviceAnnotationTab={openDeviceAnnotationTab}
            onOpenSettingsTab={openSettingsTab}
            onOpenModelTab={openModelTab}
            onPromoteAnnotationTab={promoteAnnotationTab}
            onRenameAnnotationTab={renameAnnotationTab}
            onPageNameChange={handlePageNameChange}
            tabs={tabs}
            activeTabId={activeTabId}
            dirtyTabIds={dirtyTabIds}
            onSelectTab={selectTab}
            onCloseTab={requestCloseTab}
            onTabDirtyChange={handleTabDirtyChange}
            onRegisterSaveHandler={registerTabSaveHandler}
          />)}
          {tabNotice && <div className="notice notice-info global-tab-notice"><CircleAlert size={16} />{tabNotice}</div>}
          {pendingRecoveries.length > 0 && <div className="annotation-cancel-backdrop" role="presentation">
            <section className="annotation-cancel-dialog annotation-recovery-dialog" role="dialog" aria-modal="true" aria-labelledby="annotation-recovery-title" onMouseDown={(event) => event.stopPropagation()}>
              <header><div><strong id="annotation-recovery-title">发现未保存的页面内容</strong><span>上次关闭浏览器时有 {pendingRecoveries.length} 个页面尚未保存。恢复后可继续编辑全部内容。</span></div></header>
              <div className="annotation-cancel-options">
                <button type="button" className="annotation-cancel-option save" onClick={restoreUnsavedPages}><strong><RotateCcw size={16} />恢复全部页面</strong><span>重新打开所有未保存的页面，并保留其未保存状态。</span></button>
                <button type="button" className="annotation-cancel-option danger" onClick={discardUnsavedRecoveries}><strong>放弃未保存内容</strong><span>清除上次关闭前留下的页面草稿，此操作无法撤销。</span></button>
              </div>
            </section>
          </div>}
          {pendingCloseTab && <div className="annotation-cancel-backdrop" role="presentation" onMouseDown={(event) => { if (!pendingCloseSaving && event.target === event.currentTarget) setPendingCloseTabId(null); }}>
            <section className="annotation-cancel-dialog" role="dialog" aria-modal="true" aria-labelledby="unsaved-close-title" onMouseDown={(event) => event.stopPropagation()}>
              <header><div><strong id="unsaved-close-title">页面尚未保存</strong><span>“{pendingCloseTab.title}”包含未保存的修改，请选择保存或放弃后关闭。</span></div><button type="button" className="icon-button" disabled={pendingCloseSaving} aria-label="关闭提示" title="关闭提示" onClick={() => setPendingCloseTabId(null)}><X size={16} /></button></header>
              <div className="annotation-cancel-options">
                <button type="button" className="annotation-cancel-option save" disabled={pendingCloseSaving} onClick={() => void saveAndClosePendingTab()}><strong>{pendingCloseSaving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}保存并关闭</strong><span>保存当前页面的全部修改，然后关闭这个标签页。</span></button>
                <button type="button" className="annotation-cancel-option danger" disabled={pendingCloseSaving} onClick={() => closeTabImmediately(pendingCloseTab.id)}><strong>放弃修改并关闭</strong><span>不保存当前修改，立即关闭这个标签页。</span></button>
              </div>
              <footer><button type="button" className="button" disabled={pendingCloseSaving} onClick={() => setPendingCloseTabId(null)}>继续编辑</button></footer>
            </section>
          </div>}
        </div>
      </AntdApp>
    </ConfigProvider>
  );
}
