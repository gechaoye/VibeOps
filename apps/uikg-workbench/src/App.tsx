import { App as AntdApp, ConfigProvider } from 'antd';
import {
  Camera,
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
import { absoluteAssetUrl, serverUrl, workbenchApi } from './api';
import { DeviceClient } from './device-client';
import { EditHistoryPanel } from './EditHistoryPanel';
import { ElementTree } from './ElementTree';
import { Inspector } from './Inspector';
import { KnowledgeGraph } from './KnowledgeGraph';
import { LiveDevicePreview } from './LiveDevicePreview';
import { ModelSettings } from './ModelSettings';
import { createHumanElement, elementAvailableOnPage, reviewStatusLabels, validateDraftClient } from './model';
import { PageGraph } from './PageGraph';
import { PageUploadDialog } from './PageUploadDialog';
import { WorkerProgressPanel, type WorkerActivity } from './WorkerProgressPanel';
import { WorkerComparisonPanel } from './WorkerComparisonPanel';
import { StagingPanel } from './StagingPanel';
import type { AnalysisSession, BBox, DeviceState, Draft, DraftElement, DraftPage, ElementActivityRecord, ElementEditRecord, FrameMetadata, WorkerResult, WorkerElementMergeSelection, WorkerResumeSession, StagingResult, ValidationIssue, WorkbenchStatus } from './types';
import './styles.css';

type ViewMode = 'live' | 'frozen' | 'review';
type SideTab = 'elements' | 'validation' | 'history';
type WorkspaceMode = 'annotation' | 'graph' | 'knowledge' | 'staging';
type ExplorationMode = 'ultra' | 'manual';
type InternalTabKind = 'knowledge' | 'workspace' | 'settings' | 'annotation';

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
  candidate_key_duplicate_current_page: '同页候选键重复',
  candidate_key_duplicate_other_page: '跨页候选键重复',
  candidate_key_required: '缺少候选键',
  capability_missing: '缺少元素动作',
  capability_none_conflict: '元素动作冲突',
  control_type_required: '缺少元素类型',
  label_required: '缺少元素名称',
  nested_owner_kind: '嵌套元素归属异常',
  owner_cycle: '元素层级循环',
  parent_missing: '父级元素不存在',
  parent_self: '父级元素指向自身',
  review_pending: '元素待审核',
  root_owner_kind: '根元素归属异常',
  transition_evidence_incomplete: '跳转证据不完整',
  worker_action_inconsistent: '识别动作不一致',
  worker_bbox_clamped: '识别边框已裁剪',
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
    surfaceType: 'unknown' as const,
    stateSummary: '',
    scrollableRegions: [],
  };
  return {
    ...current,
    currentPageId: nextPage?.id || emptyPage.id,
    currentFrameId: nextPage?.frameIds.at(-1) || null,
    page: nextPage
      ? { id: nextPage.id, key: nextPage.key, name: nextPage.name, surfaceType: nextPage.surfaceType, stateSummary: nextPage.stateSummary, scrollableRegions: nextPage.scrollableRegions }
      : emptyPage,
    pages,
    elements,
    elementEditRecords: current.elementEditRecords.filter((record) => !removedElementIds.has(record.elementId)),
    transitions: current.transitions.filter((transition) => transition.sourcePageId !== pageId && transition.targetPageId !== pageId && !removedElementIds.has(transition.triggerElementId)),
  };
}

function aggregateUltraWorkerStatus(workerAStatus?: WorkerActivity['status'], workerBStatus?: WorkerActivity['status']): WorkerActivity['status'] {
  const statuses = [workerAStatus, workerBStatus].filter(Boolean) as WorkerActivity['status'][];
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
  'label', 'controlType', 'visualDescription', 'capabilities', 'actionEffects', 'state', 'parentId',
  'ownerKind', 'ownerRef', 'pageId', 'availableOnPageIds', 'interactionBoundary', 'bbox',
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

function pausedWorkerAActivity(session: WorkerResumeSession): WorkerActivity {
  const manuallyInterrupted = session.errorMessage === '用户中断 Model A';
  return {
    status: 'paused',
    phase: 'paused',
    phaseMessage: manuallyInterrupted ? 'Model A 已中断，可从断点继续' : '自动续写 5 次仍未完成，可从断点继续',
    reasoningContent: session.reasoningContent || '',
    outputContent: session.outputContent || '',
    errorMessage: manuallyInterrupted ? undefined : session.errorMessage,
    resumeSessionId: session.id,
    resumeKind: 'worker_a',
    completedCandidates: session.completedCandidates,
    workerAStatus: 'paused',
    workerAResumeSessionId: session.id,
  };
}

function pausedWorkerBActivity(session: WorkerResumeSession): WorkerActivity {
  return {
    status: 'paused',
    phase: 'worker-b-paused',
    phaseMessage: 'Model B 已中断，可从断点继续',
    reasoningContent: session.reasoningContent || '',
    outputContent: session.outputContent || '',
    errorMessage: undefined,
    resumeSessionId: session.id,
    resumeKind: 'worker_b',
    workerBStatus: 'paused',
    workerBResumeSessionId: session.id,
  };
}

interface InternalTabBarProps {
  tabs: InternalTab[];
  activeTabId: string;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onUploadPage: () => void;
  onCreateFromDevice: () => void;
}

function InternalTabBar({ tabs, activeTabId, onSelectTab, onCloseTab, onUploadPage, onCreateFromDevice }: InternalTabBarProps) {
  const navRef = useRef<HTMLElement>(null);
  const fixedGroupRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const [visiblePageCount, setVisiblePageCount] = useState(MAX_PAGE_TABS);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const fixedTabs = tabs
    .filter((tab) => tab.kind !== 'annotation')
    .sort((left, right) => ['knowledge', 'workspace', 'settings'].indexOf(left.kind) - ['knowledge', 'workspace', 'settings'].indexOf(right.kind));
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
      : tab.kind === 'settings'
        ? <Settings2 size={14} />
        : <Camera size={14} />;
  const renderTab = (tab: InternalTab, group: 'fixed' | 'page') => <div key={tab.id} className={`internal-tab internal-tab-${group} ${activeTabId === tab.id ? 'active' : ''}`} role="presentation">
    <button type="button" role="tab" aria-selected={activeTabId === tab.id} className="internal-tab-select" onClick={() => { setOverflowOpen(false); setCreateMenuOpen(false); onSelectTab(tab.id); }}>
      {tabIcon(tab)}
      <span>{tab.title}</span>
      {tab.annotationTarget && <code>{tab.annotationTarget.pageId.slice(-6)}</code>}
    </button>
    {(tab.kind === 'annotation' || tab.kind === 'settings') && <button type="button" className="icon-button internal-tab-close" aria-label={`关闭 ${tab.title} 标签页`} title="关闭标签页" onClick={() => onCloseTab(tab.id)}><X size={13} /></button>}
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
          <button type="button" role="menuitem" onClick={() => { setCreateMenuOpen(false); onCreateFromDevice(); }}><Smartphone size={15} /><span>使用设备画面</span></button>
        </div>}
      </div>
    </div>
  </nav>;
}

interface AppContentProps {
  tabId: string;
  tabKind: InternalTabKind;
  annotationTarget: AnnotationTarget | null;
  annotationSessionId: string;
  pageNameOverrides: Record<string, string>;
  active: boolean;
  onOpenAnnotationTab: (pageId: string, frameId: string, title?: string) => void;
  onOpenDeviceAnnotationTab: () => void;
  onOpenSettingsTab: () => void;
  onPromoteAnnotationTab: (tabId: string, pageId: string, frameId: string, title?: string) => void;
  onRenameAnnotationTab: (tabId: string, title: string) => void;
  onPageNameChange: (pageId: string, name: string | null) => void;
  tabs: InternalTab[];
  activeTabId: string;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
}

function AppContent({ tabId, tabKind, annotationTarget, annotationSessionId, pageNameOverrides, active, onOpenAnnotationTab, onOpenDeviceAnnotationTab, onOpenSettingsTab, onPromoteAnnotationTab, onRenameAnnotationTab, onPageNameChange, tabs, activeTabId, onSelectTab, onCloseTab }: AppContentProps) {
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
  const [duplicateCandidateKeyFilter, setDuplicateCandidateKeyFilter] = useState<string | null>(null);
  const [pageNameEditing, setPageNameEditing] = useState(false);
  const [pageNameDraft, setPageNameDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [autoSaveState, setAutoSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [pageUploadOpen, setPageUploadOpen] = useState(false);
  const [transferCenterOpen, setTransferCenterOpen] = useState(false);
  const [workerControlBusy, setWorkerControlBusy] = useState<'worker-a' | 'worker-b' | null>(null);
  const [notice, setNotice] = useState<{ type: 'info' | 'error' | 'success'; text: string } | null>(null);
  const [workerActivity, setWorkerActivity] = useState<WorkerActivity | null>(null);
  const [workerDialogOpen, setWorkerDialogOpen] = useState(false);
  const [analysisSessions, setAnalysisSessions] = useState<AnalysisSession[]>([]);
  const [workerComparison, setWorkerComparison] = useState<{ workerAResult: WorkerResult; workerBResult: WorkerResult; modelResultRef: string } | null>(null);
  const [workerCandidatePortal, setWorkerCandidatePortal] = useState<HTMLDivElement | null>(null);
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
  const workerAResultRef = useRef<WorkerResult | null>(null);
  const workerBResultRef = useRef<WorkerResult | null>(null);

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
    const pageFrameIds = new Set(currentPage?.frameIds || []);
    if (draft.currentFrameId) pageFrameIds.add(draft.currentFrameId);
    return analysisSessions.filter((session) => session.pageId
      ? session.pageId === draft.currentPageId
      : Boolean(session.frameId && pageFrameIds.has(session.frameId)));
  }, [analysisSessions, draft]);
  const hasAnalyzedCurrentFrame = Boolean(draft?.currentFrameId && pageHistorySessions.some((session) => session.kind === 'worker_a' && session.frameId === draft.currentFrameId && session.status !== 'running'));
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
      if (workbenchStatus.workerASession) {
        setWorkerActivity((current) => current || pausedWorkerAActivity(workbenchStatus.workerASession!));
      }
      if (workbenchStatus.workerBSession) {
        setWorkerActivity((current) => current || pausedWorkerBActivity(workbenchStatus.workerBSession!));
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
    Promise.all([refreshConnection(), workbenchApi.draft(), workbenchApi.workerASession(annotationSessionId), workbenchApi.workerBSession(annotationSessionId), workbenchApi.sessions(), workbenchApi.modelSettings()])
      .then(([, result, workerASessionResult, workerBSessionResult, sessionHistory, modelSettings]) => {
        const targetedDraft = annotationTarget ? draftForAnnotationTarget(result.draft, annotationTarget) : null;
        resetDraftState(targetedDraft || result.draft);
        if (targetedDraft) {
          setWorkspaceMode('annotation');
          setViewMode(targetedDraft.currentFrameId ? 'review' : 'live');
        } else if (annotationTarget) {
          showNotice('error', '链接中的标注页面不存在或已被删除');
        }
        setServerIssues(result.issues);
        if (workerBSessionResult.session) setWorkerActivity(pausedWorkerBActivity(workerBSessionResult.session));
        else if (workerASessionResult.session) setWorkerActivity(pausedWorkerAActivity(workerASessionResult.session));
        setAnalysisSessions(sessionHistory.sessions);
        const configuredMode = modelSettings.modeConfiguration?.mode;
        if (configuredMode === 'manual' || configuredMode === 'ultra') setExplorationMode(configuredMode);
      })
      .catch((error) => showNotice('error', error instanceof Error ? error.message : String(error)));
    const timer = window.setInterval(() => {
      if (activeRef.current) void refreshConnection(true);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [refreshConnection]);

  useEffect(() => {
    window.localStorage.setItem('uikg-exploration-mode', explorationMode);
  }, [explorationMode]);

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
    setWorkerComparison(null);
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
      workerAResultRef.current = null;
      workerBResultRef.current = null;
      setWorkerComparison(null);
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

  const handleWorkerEvent = (event: { type: string; [key: string]: unknown }) => {
    if (event.type === 'stage') {
      setWorkerActivity((current) => current ? {
        ...current,
        phase: String(event.phase || current.phase),
        phaseMessage: String(event.message || current.phaseMessage),
      } : current);
    }
    if (event.type === 'chunk') {
      setWorkerActivity((current) => current ? {
        ...current,
        reasoningContent: current.reasoningContent + String(event.reasoningContent || ''),
        outputContent: current.outputContent + String(event.content || ''),
      } : current);
    }
  };

  const handleUltraWorkerAEvent = (event: { type: string; [key: string]: unknown }) => {
    if (event.type === 'chunk') {
      setWorkerActivity((current) => current ? {
        ...current,
        workerAReasoningContent: (current.workerAReasoningContent || '') + String(event.reasoningContent || ''),
        workerAOutputContent: (current.workerAOutputContent || '') + String(event.content || ''),
      } : current);
    }
  };

  const handleUltraWorkerBEvent = (event: { type: string; [key: string]: unknown }) => {
    if (event.type === 'chunk') {
      setWorkerActivity((current) => current ? {
        ...current,
        reasoningContent: current.reasoningContent + String(event.reasoningContent || ''),
        outputContent: current.outputContent + String(event.content || ''),
      } : current);
    }
  };

  const finishManualWorkerA = async (result: Awaited<ReturnType<typeof workbenchApi.workerAStream>>) => {
    if (!result.draft || !result.issues) throw new Error('Model A 已完成，但没有返回草稿');
    resetDraftState(result.draft);
    setServerIssues(result.issues);
    setSelectedId(result.draft.elements[0]?.id || null);
    setStatus((current) => current ? { ...current, workerASession: null } : current);
    setWorkerActivity((current) => current ? { ...current, status: 'completed', phase: 'complete', phaseMessage: 'Model A 分析完成', errorMessage: undefined, resumeSessionId: undefined, resumeKind: undefined } : current);
    showNotice('success', `Model A 已识别 ${result.draft.elements.length} 个候选元素`);
    await refreshAnalysisSessions();
  };

  const retryWorkerB = async () => {
    const currentDraft = draftRef.current;
    if (!currentDraft?.currentFrameId) return;
    setWorkerControlBusy('worker-b');
    setWorkerDialogOpen(true);
    setWorkerComparison(null);
    setWorkerActivity((current) => current ? { ...current, status: 'running', workerBStatus: 'running', phase: 'worker_b', phaseMessage: 'Model B 正在重新识别画面', reasoningContent: '', outputContent: '', errorMessage: undefined, resumeSessionId: undefined, resumeKind: undefined, workerBResumeSessionId: undefined } : current);
    try {
      const pageContext = [currentDraft.page.name, currentDraft.page.stateSummary].filter(Boolean).join('；');
      const result = await workbenchApi.workerBStream(currentDraft.currentFrameId, pageContext, explorationMode === 'ultra' ? handleUltraWorkerBEvent : handleWorkerEvent, currentDraft.currentPageId, annotationSessionId);
      workerBResultRef.current = result.workerResult;
      if (workerAResultRef.current) setWorkerComparison({ workerAResult: workerAResultRef.current, workerBResult: result.workerResult, modelResultRef: result.modelResultRef });
      setStatus((current) => current ? { ...current, workerBSession: null } : current);
      setWorkerActivity((current) => current ? { ...current, status: aggregateUltraWorkerStatus(current.workerAStatus, 'completed'), workerBStatus: 'completed', phase: workerAResultRef.current ? 'compare' : 'complete', phaseMessage: 'Model B 识别完成', errorMessage: undefined } : current);
      showNotice('success', 'Model B 已完成独立识别，可在冻结区域选择元素');
    } catch (error) {
      handleWorkerBFailure(error, 'Model B 重新识别失败');
    } finally {
      setWorkerControlBusy(null);
      await refreshAnalysisSessions();
    }
  };

  const retryWorkerA = async () => {
    const currentDraft = draftRef.current;
    if (!currentDraft?.currentFrameId) return;
    setWorkerControlBusy('worker-a');
    setWorkerDialogOpen(true);
    setWorkerComparison(null);
    setWorkerActivity((current) => current ? { ...current, status: 'running', workerAStatus: 'running', phase: 'worker_a', phaseMessage: 'Model A 正在重新识别画面', workerAReasoningContent: '', workerAOutputContent: '', errorMessage: undefined, resumeSessionId: undefined, resumeKind: undefined, workerAResumeSessionId: undefined } : current);
    try {
      const pageContext = [currentDraft.page.name, currentDraft.page.stateSummary].filter(Boolean).join('；');
      const result = await workbenchApi.workerAStream(currentDraft.currentFrameId, pageContext, false, handleUltraWorkerAEvent, currentDraft.currentPageId, annotationSessionId);
      workerAResultRef.current = result.workerResult;
      if (workerBResultRef.current) setWorkerComparison({ workerAResult: result.workerResult, workerBResult: workerBResultRef.current, modelResultRef: result.modelResultRef });
      setStatus((current) => current ? { ...current, workerASession: null } : current);
      setWorkerActivity((current) => current ? { ...current, status: aggregateUltraWorkerStatus('completed', current.workerBStatus), workerAStatus: 'completed', phase: workerBResultRef.current ? 'compare' : 'complete', phaseMessage: 'Model A 识别完成', errorMessage: undefined } : current);
      showNotice('success', 'Model A 已完成重新识别');
    } catch (error) {
      handleWorkerAFailure(error);
    } finally {
      setWorkerControlBusy(null);
      await refreshAnalysisSessions();
    }
  };

  const handleWorkerAFailure = (error: unknown) => {
    const cancelled = error instanceof Error && error.name === 'AnalysisCancelledError';
    const details = error instanceof Error ? (error as Error & { details?: Record<string, unknown> }).details : undefined;
    const resumeSession = details?.resumableSession as WorkerResumeSession | undefined;
    if (resumeSession?.id) {
      if (explorationMode === 'ultra') {
        setWorkerActivity((current) => current ? {
          ...current,
          status: aggregateUltraWorkerStatus('paused', current.workerBStatus),
          workerAStatus: 'paused',
          workerAResumeSessionId: resumeSession.id,
          phase: 'worker-a-paused',
          phaseMessage: cancelled ? 'Model A 已中断，可从断点继续' : 'Model A 已暂停，可从断点继续',
          errorMessage: cancelled ? undefined : resumeSession.errorMessage,
          resumeSessionId: resumeSession.id,
          resumeKind: 'worker_a',
          completedCandidates: resumeSession.completedCandidates,
        } : current);
        setStatus((current) => current ? { ...current, workerASession: resumeSession } : current);
        showNotice('info', `Model A 已保留 ${resumeSession.completedCandidates} 个候选的断点`);
        return;
      }
      setWorkerActivity((current) => ({
        ...(current || pausedWorkerAActivity(resumeSession)),
        status: 'paused',
        phase: 'paused',
        phaseMessage: cancelled ? 'Model A 已中断，可从断点继续' : '自动续写 5 次仍未完成，可从断点继续',
        errorMessage: cancelled ? undefined : resumeSession.errorMessage,
        resumeSessionId: resumeSession.id,
        resumeKind: 'worker_a',
        completedCandidates: resumeSession.completedCandidates,
      }));
      setStatus((current) => current ? { ...current, workerASession: resumeSession } : current);
      showNotice('info', `Model A 已保留 ${resumeSession.completedCandidates} 个候选的断点`);
      return;
    }
    if (explorationMode === 'ultra') {
      setWorkerActivity((current) => current ? {
        ...current,
        status: aggregateUltraWorkerStatus(cancelled ? 'cancelled' : 'error', current.workerBStatus),
        workerAStatus: cancelled ? 'cancelled' : 'error',
        phase: cancelled ? 'worker-a-cancelled' : 'worker-a-error',
        phaseMessage: cancelled ? 'Model A 已中断' : 'Model A 分析失败',
        errorMessage: cancelled ? undefined : error instanceof Error ? error.message : String(error),
      } : current);
      showNotice(cancelled ? 'info' : 'error', cancelled ? 'Model A 已中断' : error instanceof Error ? error.message : String(error));
      return;
    }
    setWorkerActivity((current) => current ? {
      ...current,
      status: cancelled ? 'cancelled' : 'error',
      phase: cancelled ? 'cancelled' : 'error',
      phaseMessage: cancelled ? 'Model A 已中断' : 'Model A 分析失败',
      errorMessage: cancelled ? undefined : error instanceof Error ? error.message : String(error),
    } : current);
    showNotice(cancelled ? 'info' : 'error', cancelled ? 'Model A 已中断，草稿未更新' : error instanceof Error ? error.message : String(error));
  };

  const handleWorkerBFailure = (error: unknown, fallbackMessage: string) => {
    const cancelled = error instanceof Error && error.name === 'AnalysisCancelledError';
    const details = error instanceof Error ? (error as Error & { details?: Record<string, unknown> }).details : undefined;
    const resumeSession = details?.resumableSession as WorkerResumeSession | undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (resumeSession?.id) {
      if (explorationMode === 'ultra') {
        setWorkerActivity((current) => current ? {
          ...current,
          status: aggregateUltraWorkerStatus(current.workerAStatus, 'paused'),
          workerBStatus: 'paused',
          workerBResumeSessionId: resumeSession.id,
          phase: 'worker-b-paused',
          phaseMessage: 'Model B 已暂停，可从断点继续',
          errorMessage: undefined,
          resumeSessionId: resumeSession.id,
          resumeKind: 'worker_b',
        } : current);
        setStatus((current) => current ? { ...current, workerBSession: resumeSession } : current);
        showNotice('info', 'Model B 已中断并保存当前输出断点');
        return;
      }
      setWorkerActivity((current) => ({
        ...(current || pausedWorkerBActivity(resumeSession)),
        status: 'paused',
        phase: 'worker-b-paused',
        phaseMessage: 'Model B 已中断，可从断点继续',
        errorMessage: undefined,
        resumeSessionId: resumeSession.id,
        resumeKind: 'worker_b',
      }));
      setStatus((current) => current ? { ...current, workerBSession: resumeSession } : current);
      showNotice('info', 'Model B 已中断并保存当前输出断点');
      return;
    }
    if (explorationMode === 'ultra') {
      setWorkerActivity((current) => current ? {
        ...current,
        status: aggregateUltraWorkerStatus(current.workerAStatus, cancelled ? 'cancelled' : 'error'),
        workerBStatus: cancelled ? 'cancelled' : 'error',
        phase: cancelled ? 'worker-b-cancelled' : 'worker-b-error',
        phaseMessage: cancelled ? 'Model B 已中断' : fallbackMessage,
        errorMessage: cancelled ? undefined : message,
      } : current);
      showNotice(cancelled ? 'info' : 'error', cancelled ? 'Model B 已中断' : message);
      return;
    }
    setWorkerActivity((current) => current ? {
      ...current,
      status: cancelled ? 'cancelled' : 'error',
      phase: cancelled ? 'worker-b-cancelled' : 'worker-b-error',
      phaseMessage: cancelled ? 'Model B 已中断' : fallbackMessage,
      errorMessage: cancelled ? undefined : message,
    } : current);
    showNotice(cancelled ? 'info' : 'error', cancelled ? 'Model B 已中断' : message);
  };

  const runWorkers = async () => {
    if (!draft?.currentFrameId) return;
    setBusy('workers');
    setWorkerDialogOpen(true);
    setWorkerComparison(null);
    workerAResultRef.current = null;
    workerBResultRef.current = null;
    const ultraMode = explorationMode === 'ultra';
    setWorkerActivity({ status: 'running', phase: ultraMode ? 'ultra-running' : 'starting', phaseMessage: ultraMode ? 'Model A 与 Model B 正在并发识别画面' : '正在启动 Model A', reasoningContent: '', outputContent: '', workerAReasoningContent: '', workerAOutputContent: '', workerAStatus: ultraMode ? 'running' : undefined, workerBStatus: ultraMode ? 'running' : undefined });
    try {
      const pageContext = [draft.page.name, draft.page.stateSummary].filter(Boolean).join('；');
      if (!ultraMode) {
        await finishManualWorkerA(await workbenchApi.workerAStream(draft.currentFrameId, pageContext, true, handleWorkerEvent, draft.currentPageId, annotationSessionId));
        return;
      }
      const workerAPromise = workbenchApi.workerAStream(draft.currentFrameId, pageContext, false, handleUltraWorkerAEvent, draft.currentPageId, annotationSessionId).then((result) => {
        workerAResultRef.current = result.workerResult;
        if (workerBResultRef.current) setWorkerComparison({ workerAResult: result.workerResult, workerBResult: workerBResultRef.current, modelResultRef: result.modelResultRef });
        setStatus((current) => current ? { ...current, workerASession: null } : current);
        setWorkerActivity((current) => current ? { ...current, status: aggregateUltraWorkerStatus('completed', current.workerBStatus), workerAStatus: 'completed', workerAResumeSessionId: undefined } : current);
        return result;
      }, (error) => { handleWorkerAFailure(error); throw error; });
      const workerBPromise = workbenchApi.workerBStream(draft.currentFrameId, pageContext, handleUltraWorkerBEvent, draft.currentPageId, annotationSessionId).then((result) => {
        workerBResultRef.current = result.workerResult;
        if (workerAResultRef.current) setWorkerComparison({ workerAResult: workerAResultRef.current, workerBResult: result.workerResult, modelResultRef: result.modelResultRef });
        setStatus((current) => current ? { ...current, workerBSession: null } : current);
        setWorkerActivity((current) => current ? { ...current, status: aggregateUltraWorkerStatus(current.workerAStatus, 'completed'), workerBStatus: 'completed', workerBResumeSessionId: undefined } : current);
        return result;
      }, (error) => { handleWorkerBFailure(error, 'Model B 识别失败'); throw error; });
      const [workerAOutcome, workerBOutcome] = await Promise.allSettled([workerAPromise, workerBPromise]);
      if (workerAOutcome.status === 'fulfilled' && workerBOutcome.status === 'fulfilled') {
        setWorkerActivity((current) => current ? { ...current, status: 'completed', workerAStatus: 'completed', workerBStatus: 'completed', phase: 'compare', phaseMessage: '双模型 并发识别完成', errorMessage: undefined } : current);
        showNotice('success', '两份独立识别答卷已完成，可在双画面或页面元素区域选择');
      }
    } catch (error) {
      handleWorkerAFailure(error);
    } finally {
      setBusy(null);
      await refreshAnalysisSessions();
    }
  };

  const applyWorkerComparison = async (selections: WorkerElementMergeSelection[]) => {
    if (!draft?.currentFrameId || !workerComparison) return;
    setBusy('worker-merge');
    try {
      const result = await workbenchApi.mergeWorkerResults({
        frameId: draft.currentFrameId,
        pageId: draft.currentPageId,
        workerAResult: workerComparison.workerAResult,
        workerBResult: workerComparison.workerBResult,
        selections,
        modelResultRef: workerComparison.modelResultRef,
      });
      resetDraftState(result.draft);
      setServerIssues(result.issues);
      setSelectedId(result.draft.elements[0]?.id || null);
      setWorkerComparison(null);
      setWorkerActivity((current) => current ? { ...current, status: 'completed', phase: 'complete', phaseMessage: '识别结果已合并，可在页面元素区域编辑审核' } : current);
      showNotice('success', `已合并 ${result.draft.elements.length} 个候选元素`);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const resumeWorkerA = async () => {
    const sessionId = workerActivity?.workerAResumeSessionId || (workerActivity?.resumeKind === 'worker_a' ? workerActivity.resumeSessionId : undefined);
    if (!sessionId) return;
    setWorkerControlBusy('worker-a');
    setWorkerDialogOpen(true);
    setWorkerActivity((current) => current ? {
      ...current,
      status: 'running',
      workerAStatus: 'running',
      phase: 'resume',
      phaseMessage: '正在从已保存断点继续 Model A',
      errorMessage: undefined,
    } : current);
    try {
      const result = await workbenchApi.resumeWorkerAStream(sessionId, annotationSessionId, explorationMode === 'ultra' ? handleUltraWorkerAEvent : handleWorkerEvent);
      if (explorationMode === 'ultra') {
        workerAResultRef.current = result.workerResult;
        if (workerBResultRef.current) setWorkerComparison({ workerAResult: result.workerResult, workerBResult: workerBResultRef.current, modelResultRef: result.modelResultRef });
        setWorkerActivity((current) => current ? { ...current, status: aggregateUltraWorkerStatus('completed', current.workerBStatus), workerAStatus: 'completed', workerAResumeSessionId: undefined, phase: workerBResultRef.current ? 'compare' : 'complete', phaseMessage: 'Model A 已从断点完成', errorMessage: undefined, resumeSessionId: undefined, resumeKind: undefined } : current);
      } else {
        await finishManualWorkerA(result);
      }
    } catch (error) {
      handleWorkerAFailure(error);
    } finally {
      setWorkerControlBusy(null);
    }
  };

  const resumeWorkerB = async () => {
    const sessionId = workerActivity?.workerBResumeSessionId || (workerActivity?.resumeKind === 'worker_b' ? workerActivity.resumeSessionId : undefined);
    if (!sessionId) return;
    setWorkerControlBusy('worker-b');
    setWorkerDialogOpen(true);
    setWorkerActivity((current) => current ? {
      ...current,
      status: 'running',
      workerBStatus: 'running',
      phase: 'worker_b-resume',
      phaseMessage: '正在从已保存断点继续 Model B',
      errorMessage: undefined,
    } : current);
    try {
      const result = await workbenchApi.resumeWorkerBStream(sessionId, annotationSessionId, explorationMode === 'ultra' ? handleUltraWorkerBEvent : handleWorkerEvent);
      workerBResultRef.current = result.workerResult;
      if (workerAResultRef.current) setWorkerComparison({ workerAResult: workerAResultRef.current, workerBResult: result.workerResult, modelResultRef: result.modelResultRef });
      setStatus((current) => current ? { ...current, workerBSession: null } : current);
      setWorkerActivity((current) => current ? { ...current, status: aggregateUltraWorkerStatus(current.workerAStatus, 'completed'), workerBStatus: 'completed', workerBResumeSessionId: undefined, phase: workerAResultRef.current ? 'compare' : 'complete', phaseMessage: 'Model B 已从断点完成识别', errorMessage: undefined, resumeSessionId: undefined, resumeKind: undefined } : current);
      showNotice('success', 'Model B 已从断点完成识别');
    } catch (error) {
      handleWorkerBFailure(error, 'Model B 断点续写失败');
    } finally {
      setWorkerControlBusy(null);
      await refreshAnalysisSessions();
    }
  };

  const cancelWorker = async (kind: 'worker_a' | 'worker_b') => {
    const busyKey = kind === 'worker_a' ? 'worker-a' : 'worker-b';
    setWorkerControlBusy(busyKey);
    setWorkerActivity((current) => current ? {
      ...current,
      [`${kind === 'worker_a' ? 'workerA' : 'workerB'}Status`]: 'cancelling',
      phaseMessage: `${kind === 'worker_a' ? 'Model A' : 'Model B'} 正在中断`,
    } : current);
    try {
      const result = kind === 'worker_a' ? await workbenchApi.cancelWorkerA(annotationSessionId) : await workbenchApi.cancelWorkerB(annotationSessionId);
      if (!result.cancelled) showNotice('info', `${kind === 'worker_a' ? 'Model A' : 'Model B'} 已结束，无需中断`);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setWorkerControlBusy(null);
    }
  };

  const cancelWorkers = async () => {
    const workerBActive = Boolean(workerActivity?.phase.startsWith('worker_b') || workerActivity?.phase.startsWith('worker-b'));
    setWorkerActivity((current) => current ? { ...current, status: 'cancelling', phaseMessage: '正在中断模型请求' } : current);
    try {
      const results = explorationMode === 'ultra'
        ? await Promise.all([workbenchApi.cancelWorkerA(annotationSessionId), workbenchApi.cancelWorkerB(annotationSessionId)])
        : [workerBActive ? await workbenchApi.cancelWorkerB(annotationSessionId) : await workbenchApi.cancelWorkerA(annotationSessionId)];
      if (!results.some((result) => result.cancelled)) {
        setWorkerActivity((current) => current ? { ...current, phaseMessage: '模型已结束，正在接收最终结果' } : current);
      }
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
    }
  };

  const openWorkerHistory = () => {
    const latest = pageHistorySessions[0];
    if (!latest) return;
    setWorkerComparison(null);
    setWorkerActivity({
      status: latest.status === 'completed' ? 'completed' : latest.status === 'cancelled' ? 'cancelled' : latest.status === 'running' ? 'running' : 'error',
      phase: 'history',
      phaseMessage: latest.kind === 'worker_a' ? 'Model A 识别会话' : 'Model B 识别会话',
      reasoningContent: latest.reasoningContent || '',
      outputContent: latest.outputContent || '',
      errorMessage: latest.errorMessage || undefined,
    });
    setWorkerDialogOpen(true);
  };

  const persistDraft = async (draftToSave: Draft) => {
    const result = annotationTarget
      ? await workbenchApi.savePageDraft(annotationTarget.pageId, draftToSave)
      : await workbenchApi.saveDraft(draftToSave);
    lastSavedDraftRef.current = structuredClone(result.draft);
    // Autosave replaces the server-normalized draft without resetting the
    // undo/redo snapshots or the current review baseline.
    if (draftRef.current === draftToSave) {
      draftRef.current = result.draft;
      setDraft(result.draft);
      setDirty(false);
    }
    setServerIssues(result.issues);
    return result.draft;
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

  useEffect(() => {
    if (workspaceMode !== 'annotation' || !dirty || !draft?.currentFrameId) return undefined;
    const timer = window.setTimeout(() => {
      const latestDraft = draftRef.current;
      if (latestDraft?.currentFrameId) void runAutoSave(latestDraft);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [draft, dirty, workspaceMode]);

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
      setWorkerComparison(null);
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
      setWorkerComparison(null);
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
      const patchFields = Object.keys(patch).filter((field) => !['reviewStatus', 'source'].includes(field));
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
        const nextElement = {
          ...element,
          ...patch,
          ownerRef,
        };
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
      return { ...element, reviewStatus: preAcceptStatusRef.current.get(element.id) || (element.source === 'ai_worker' ? 'pending' : 'edited') };
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
      controlType: 'container',
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
      const reviewStatus = previous || (element.source === 'ai_worker' ? 'pending' : 'edited');
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
      const reviewStatus = previous || (element.source === 'ai_worker' ? 'pending' : 'edited');
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
      page: { id: page.id, key: page.key, name: page.name, surfaceType: page.surfaceType, stateSummary: page.stateSummary, scrollableRegions: page.scrollableRegions },
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
      return { ...current, pages, page: page ? { id: page.id, key: page.key, name: page.name, surfaceType: page.surfaceType, stateSummary: page.stateSummary, scrollableRegions: page.scrollableRegions } : current.page };
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
        <div className="brand"><img className="brand-icon" src="/graphrag-icon.svg?v=3" alt="" /><div><strong>UIKG Workbench</strong><span>{status?.spec.version || 'UIKG'}</span></div></div>
        <label className="topbar-app-field"><span>应用</span><input value={draft?.appKey || ''} onBlur={endHistoryGroup} onChange={(event) => updateDraft((current) => ({ ...current, appKey: event.target.value }), 'draft:appKey')} /></label>
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

      <InternalTabBar tabs={tabs} activeTabId={activeTabId} onSelectTab={onSelectTab} onCloseTab={onCloseTab} onUploadPage={() => setPageUploadOpen(true)} onCreateFromDevice={onOpenDeviceAnnotationTab} />

      {tabKind !== 'knowledge' && tabKind !== 'settings' && <div className={`contextbar contextbar-${tabKind}`}>
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
          <span className="spec-hash" title={status?.spec.contentHash}>Schema {status?.spec.schemaVersion || '3.0.0'}</span>
        </div>
      </div>}

      {tabKind === 'settings' ? (
        <ModelSettings
          onNotice={showNotice}
          onSaved={(settings) => {
            setStatus((current) => current ? { ...current, workerAConfigured: Boolean(settings.modelA.config.modelName), workerAModel: settings.modelA.config.modelName, workerBConfigured: Boolean(settings.modelB.config.modelName), workerBModel: settings.modelB.config.modelName || null } : current);
            const configuredMode = settings.modeConfiguration?.mode;
            if (configuredMode === 'manual' || configuredMode === 'ultra') window.dispatchEvent(new CustomEvent('uikg-mode-change', { detail: configuredMode }));
          }}
        />
      ) : tabKind === 'knowledge' ? (
        active ? <KnowledgeGraph appKey={draft?.appKey || 'zto.connect'} onGoToWorkbench={() => onSelectTab('workspace')} /> : null
      ) : workspaceMode === 'annotation' ? <main className="workspace">
        <section className="device-panel">
          <div className="panel-toolbar">
            <div className="view-tabs">
              <button type="button" className={viewMode === 'live' ? 'active' : ''} title="实时操作" disabled><Play size={14} /><span>实时操作</span></button>
              <button type="button" className={viewMode === 'frozen' ? 'active' : ''} title="冻结画面" disabled><Camera size={14} /><span>冻结画面</span></button>
              <button type="button" className={viewMode === 'review' ? 'active' : ''} title="页面标注" disabled><SquareDashed size={14} /><span>页面标注</span></button>
            </div>
            {viewMode === 'review' && <div className="toolbar-mode-model">
              <div className="mode-segment" aria-label="探索模式">
                <button type="button" className={explorationMode === 'ultra' ? 'active' : ''} title="Model A 与 Model B 并发识别，再按元素和字段选择合并" onClick={() => void changeExplorationMode('ultra')}>Ultra</button>
                <button type="button" className={explorationMode === 'manual' ? 'active' : ''} title="使用 Model A 单模型识别后直接人工审核" onClick={() => void changeExplorationMode('manual')}>Manual</button>
              </div>
              <span className="worker-model" title={explorationMode === 'ultra' ? `Model A：${status?.workerAModel || '未配置'}；Model B：${status?.workerBModel || '未配置'}` : `Model A：${status?.workerAModel || '未配置'}`}>
                {explorationMode === 'ultra' ? `${status?.workerAModel || '未配置'} + ${status?.workerBModel || '未配置'}` : status?.workerAModel || '未配置'}
              </span>
            </div>}
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
                  {workerActivity?.status === 'paused' && <button type="button" className="icon-button worker-resume-button" title={`继续 Worker，已完成 ${workerActivity.completedCandidates || 0} 个候选`} aria-label="继续 Worker" onClick={() => setWorkerDialogOpen(true)}><RefreshCw size={15} /></button>}
                  <button type="button" className="icon-button" title="页面识别历史" disabled={pageHistorySessions.length === 0} onClick={openWorkerHistory}><History size={15} /></button>
                  <button type="button" className="icon-button recognition-button" title={hasAnalyzedCurrentFrame ? '重新识别' : '识别分析'} aria-label={hasAnalyzedCurrentFrame ? '重新识别' : '识别分析'} disabled={!draft?.currentFrameId || busy === 'workers' || busy === 'worker-a' || busy === 'worker-b' || workerActivity?.status === 'paused' || (explorationMode === 'ultra' && !status?.workerBConfigured)} onClick={() => void runWorkers()}>{busy === 'workers' || busy === 'worker-a' || busy === 'worker-b' ? <LoaderCircle className="spin" size={15} /> : <ScanSearch size={15} />}</button>
                </>
              )}
            </div>
          </div>
          <div
            className={`device-stage-wrap ${workerComparison && explorationMode === 'ultra' ? 'has-worker-comparison' : ''}`}
            onPointerDown={(event) => {
              if (viewMode === 'review' && event.target === event.currentTarget) setSelectedId(null);
            }}
          >
            {viewMode === 'live' ? (
              connected ? (
                <div className="live-preview">
                  <LiveDevicePreview client={deviceClient} runtimeInfo={device.runtimeInfo!} serverUrl={serverUrl} enabled={!['workers', 'worker-a', 'worker-b'].includes(busy || '')} onError={(message) => showNotice('error', message)} />
                </div>
              ) : (
                <div className="device-empty"><MonitorSmartphone size={42} /><strong>暂无实时设备画面</strong><span>未检测到 Android 设备，连接设备后可开始实时操作</span></div>
              )
            ) : viewMode === 'frozen' && frameUrl ? (
              <img className="frozen-frame" src={frameUrl} alt="冻结设备画面" />
            ) : frameUrl ? (
              explorationMode === 'ultra' && workerComparison ? (
                <WorkerComparisonPanel imageUrl={frameUrl} workerAResult={workerComparison.workerAResult} workerBResult={workerComparison.workerBResult} applying={busy === 'worker-merge'} candidatePortalTarget={workerCandidatePortal} onApply={(selections) => void applyWorkerComparison(selections)} />
              ) : (
                <AnnotationCanvas imageUrl={frameUrl} elements={currentElements} selectedId={selectedId} drawing={drawing} showRejected={showRejected} onSelect={setSelectedId} onAdd={addElement} onBoxChange={(id, bbox) => updateElement(id, { bbox }, `bbox:${id}`)} onBoxChangeEnd={endHistoryGroup} />
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
              <MousePointer2 size={16} /><strong>页面元素</strong><span>{workerComparison && explorationMode === 'ultra' ? '候选' : currentElements.length}</span>
              {!(workerComparison && explorationMode === 'ultra') && <div className="element-history-actions" aria-label="元素历史操作">
                <button type="button" className="icon-button" title="撤销上一步" disabled={pastRef.current.length === 0 || historyBlockedForPendingPage} onClick={undo}><Undo2 size={15} /></button>
                <button type="button" className="icon-button" title="取消撤销" disabled={futureRef.current.length === 0 || historyBlockedForPendingPage} onClick={redo}><Redo2 size={15} /></button>
                <button type="button" className="icon-button" title="恢复全部" disabled={!canRestoreAllElements} onClick={restoreAllElements}><RotateCcw size={15} /></button>
                <button type="button" className={`icon-button ${showRejected ? 'active' : ''}`} title={showRejected ? '隐藏已忽略元素' : '显示已忽略元素'} aria-pressed={showRejected} onClick={() => setShowRejected((value) => !value)}>{showRejected ? <Eye size={15} /> : <EyeOff size={15} />}</button>
              </div>}
            </div>
            {!(workerComparison && explorationMode === 'ultra') && <div className="element-toolbar" aria-label="元素全局操作">
              <button type="button" className={`icon-button ${multiSelect ? 'active' : ''}`} title="多选" aria-pressed={multiSelect} disabled={currentElements.length === 0} onClick={() => { setMultiSelect((value) => !value); if (multiSelect) setCheckedIds(new Set()); }}><ListChecks size={15} /></button>
            </div>}
          </div>
          {workerComparison && explorationMode === 'ultra' ? <div className="worker-candidate-portal" ref={setWorkerCandidatePortal} /> : <ElementTree elements={treeElements} filterCandidateKey={duplicateCandidateKeyFilter} selectedId={selectedId} multiSelect={multiSelect} checkedIds={checkedIds} allChecked={allCurrentChecked} allCheckedAccepted={allCheckedAccepted} onToggleAll={() => setCheckedIds(allCurrentChecked ? new Set() : new Set(treeElements.map((element) => element.id)))} onCreateContainer={createContainerFromSelection} onToggleAccept={allCheckedAccepted ? bulkCancelAccept : bulkAccept} onDeleteChecked={deleteCheckedElements} onSelect={setSelectedId} onCheck={(id, checked) => setCheckedIds((current) => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; })} onClearFilter={() => setDuplicateCandidateKeyFilter(null)} />}
          <div className={`tree-legend ${workerComparison && explorationMode === 'ultra' ? 'worker-source-legend' : ''}`}>
            {workerComparison && explorationMode === 'ultra' ? <><span><i className="legend-worker-a" />Model A</span><span><i className="legend-worker-b" />Model B</span></> :
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
              canRestoreCurrent={canRestoreSelectedElement}
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
      {workerDialogOpen && workerActivity && frameUrl && <WorkerProgressPanel activity={workerActivity} modelName={status?.workerAModel || null} workerBModel={status?.workerBModel || null} ultraMode={explorationMode === 'ultra'} sessions={pageHistorySessions} acceptedSessionId={acceptedHistorySessionId} workerControlBusy={workerControlBusy || (busy === 'worker-a' || busy === 'worker-b' ? busy : null)} onCancel={() => void cancelWorkers()} onCancelWorker={(kind) => void cancelWorker(kind)} onRetryWorker={(kind) => kind === 'worker_a' ? void retryWorkerA() : void retryWorkerB()} onResumeWorker={(kind) => kind === 'worker_a' ? void resumeWorkerA() : void resumeWorkerB()} onRetry={() => workerActivity.resumeKind === 'worker_b' ? void resumeWorkerB() : workerActivity.resumeKind === 'worker_a' ? void resumeWorkerA() : workerActivity.phase === 'worker-b-error' ? void retryWorkerB() : void runWorkers()} onClose={() => { setWorkerDialogOpen(false); if (workerActivity.status !== 'paused') setWorkerActivity(null); }} />}
    </div>
  );
}

export default function App() {
  const [tabs, setTabs] = useState<InternalTab[]>(() => [
    { id: 'knowledge', title: '知识图谱', sessionId: createAnnotationSessionId(), kind: 'knowledge', annotationTarget: null },
    { id: 'workspace', title: '工作台', sessionId: createAnnotationSessionId(), kind: 'workspace', annotationTarget: null },
  ]);
  const [activeTabId, setActiveTabId] = useState('knowledge');
  const [pageNameOverrides, setPageNameOverrides] = useState<Record<string, string>>({});
  const [tabNotice, setTabNotice] = useState<string | null>(null);

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
    setActiveTabId(sessionId);
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
    setActiveTabId(sessionId);
  };

  const openSettingsTab = () => {
    const existing = tabs.find((tab) => tab.kind === 'settings');
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const settingsTab: InternalTab = { id: 'settings', title: '设置', sessionId: createAnnotationSessionId(), kind: 'settings', annotationTarget: null };
    setTabs((current) => {
      const fixed = current.filter((tab) => tab.kind !== 'annotation');
      const pages = current.filter((tab) => tab.kind === 'annotation');
      return [...fixed, settingsTab, ...pages];
    });
    setActiveTabId(settingsTab.id);
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

  const closeTab = (tabId: string) => {
    setTabs((current) => {
      const closingTab = current.find((tab) => tab.id === tabId);
      if (!closingTab || (closingTab.kind !== 'annotation' && closingTab.kind !== 'settings')) return current;
      const index = current.findIndex((tab) => tab.id === tabId);
      const next = current.filter((tab) => tab.id !== tabId);
      if (activeTabId === tabId) {
        const fallback = closingTab.kind === 'settings' ? 'workspace' : next[Math.max(0, index - 1)]?.id || 'workspace';
        setActiveTabId(fallback);
      }
      return next;
    });
  };

  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#087f5b', borderRadius: 6, fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif' } }}>
      <AntdApp>
        <div className="internal-workbench">
          {tabs.map((tab) => <AppContent
            key={tab.id}
            tabId={tab.id}
            tabKind={tab.kind}
            annotationTarget={tab.annotationTarget}
            annotationSessionId={tab.sessionId}
            pageNameOverrides={pageNameOverrides}
            active={activeTabId === tab.id}
            onOpenAnnotationTab={openAnnotationTab}
            onOpenDeviceAnnotationTab={openDeviceAnnotationTab}
            onOpenSettingsTab={openSettingsTab}
            onPromoteAnnotationTab={promoteAnnotationTab}
            onRenameAnnotationTab={renameAnnotationTab}
            onPageNameChange={handlePageNameChange}
            tabs={tabs}
            activeTabId={activeTabId}
            onSelectTab={setActiveTabId}
            onCloseTab={closeTab}
          />)}
          {tabNotice && <div className="notice notice-info global-tab-notice"><CircleAlert size={16} />{tabNotice}</div>}
        </div>
      </AntdApp>
    </ConfigProvider>
  );
}
