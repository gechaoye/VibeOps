import { App as AntdApp, ConfigProvider } from 'antd';
import {
  Boxes,
  Camera,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Check,
  CheckCheck,
  CloudCog,
  Eye,
  EyeOff,
  FileDiff,
  History,
  LoaderCircle,
  MonitorSmartphone,
  MousePointer2,
  Network,
  BoxSelect,
  PanelsTopLeft,
  PanelRight,
  Play,
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
import { absoluteAssetUrl, serverUrl, workbenchApi } from './api';
import { DeviceClient } from './device-client';
import { EditHistoryPanel } from './EditHistoryPanel';
import { ElementTree } from './ElementTree';
import { Inspector } from './Inspector';
import { KnowledgeGraph } from './KnowledgeGraph';
import { LiveDevicePreview } from './LiveDevicePreview';
import { ModelSettings } from './ModelSettings';
import { createHumanElement, elementAvailableOnPage, pageWorkflowStatus, pageWorkflowStatusLabels, reviewStatusLabels, validateDraftClient } from './model';
import { PageGraph } from './PageGraph';
import { WorkerProgressPanel, type WorkerActivity } from './WorkerProgressPanel';
import { WorkerComparisonPanel } from './WorkerComparisonPanel';
import { StagingPanel } from './StagingPanel';
import type { AnalysisSession, BBox, DeviceState, Draft, DraftElement, DraftPage, ElementActivityRecord, ElementEditRecord, FrameMetadata, WorkerResult, WorkerElementMergeSelection, WorkerResumeSession, StagingResult, ValidationIssue, WorkbenchStatus } from './types';
import './styles.css';

type ViewMode = 'live' | 'review';
type SideTab = 'elements' | 'validation' | 'history';
type WorkspaceMode = 'annotation' | 'graph' | 'knowledge' | 'staging' | 'settings';
type ExplorationMode = 'ultra' | 'manual';

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
  const manuallyInterrupted = session.errorMessage === '用户中断 Worker A';
  return {
    status: 'paused',
    phase: 'paused',
    phaseMessage: manuallyInterrupted ? 'Worker A 已中断，可从断点继续' : '自动续写 5 次仍未完成，可从断点继续',
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
    phaseMessage: 'Worker B 已中断，可从断点继续',
    reasoningContent: session.reasoningContent || '',
    outputContent: session.outputContent || '',
    errorMessage: undefined,
    resumeSessionId: session.id,
    resumeKind: 'worker_b',
    workerBStatus: 'paused',
    workerBResumeSessionId: session.id,
  };
}

function AppContent() {
  const deviceClient = useMemo(() => new DeviceClient(serverUrl), []);
  const [status, setStatus] = useState<WorkbenchStatus | null>(null);
  const [device, setDevice] = useState<DeviceState>(emptyDevice);
  const [selectedDevice, setSelectedDevice] = useState('');
  const [deviceDiscoveryError, setDeviceDiscoveryError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([]);
  const [frame, setFrame] = useState<FrameMetadata | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('live');
  const [sideTab, setSideTab] = useState<SideTab>('elements');
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('annotation');
  const [explorationMode, setExplorationMode] = useState<ExplorationMode>(() => {
    const savedMode = window.localStorage.getItem('uikg-exploration-mode');
    return savedMode === 'manual' || savedMode === 'ai_assist' ? 'manual' : 'ultra';
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [multiSelect, setMultiSelect] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [drawing, setDrawing] = useState(false);
  const [showRejected, setShowRejected] = useState(false);
  const [continuousCapture, setContinuousCapture] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [autoSaveState, setAutoSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
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
  const autoSaveInFlightRef = useRef(false);
  const autoSaveQueuedRef = useRef(false);
  const annotationEntryDraftRef = useRef<Draft | null>(null);
  const lastSavedDraftRef = useRef<Draft | null>(null);
  const workerAResultRef = useRef<WorkerResult | null>(null);
  const workerBResultRef = useRef<WorkerResult | null>(null);

  const issues = useMemo(() => draft ? validateDraftClient(draft) : serverIssues, [draft, serverIssues]);
  const selectedElement = draft?.elements.find((element) => element.id === selectedId) || null;
  const initialSelectedElement = selectedId ? initialElementsRef.current.get(selectedId) || null : null;
  const canRestoreSelectedElement = Boolean(selectedElement && initialSelectedElement && JSON.stringify(selectedElement) !== JSON.stringify(initialSelectedElement));
  const canRestoreAllElements = Boolean(draft && JSON.stringify(draft.elements) !== JSON.stringify(initialAllElementsRef.current));
  const currentElements = useMemo(() => draft ? draft.elements.filter((element) => elementAvailableOnPage(element, draft.currentPageId, draft.elements)) : [], [draft]);
  const currentPageHasPrivateElements = Boolean(draft?.elements.some((element) => element.pageId === draft.currentPageId));
  const historyBlockedForPendingPage = Boolean(draft?.currentFrameId && !currentPageHasPrivateElements && draft.pages.find((page) => page.id === draft.currentPageId)?.frameIds.includes(draft.currentFrameId));
  const allCurrentChecked = currentElements.length > 0 && currentElements.every((element) => checkedIds.has(element.id));
  const frameUrl = draft?.currentFrameId
    ? absoluteAssetUrl(`/workbench/api/frames/${encodeURIComponent(draft.currentFrameId)}/image`)
    : null;
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
        workbenchApi.status(),
        deviceClient.getSessionInfo(),
        deviceClient.listSessionTargets(forceTargetRefresh),
      ]);
      const runtimeInfo = workbenchStatus.agentConnected ? await deviceClient.getRuntimeInfo() : null;
      setStatus(workbenchStatus);
      if (workbenchStatus.workerASession) {
        setWorkerActivity((current) => current || pausedWorkerAActivity(workbenchStatus.workerASession!));
      }
      if (workbenchStatus.workerBSession) {
        setWorkerActivity((current) => current || pausedWorkerBActivity(workbenchStatus.workerBSession!));
      }
      setDevice({ online, session, runtimeInfo, targets });
      setDeviceDiscoveryError(null);
      setSelectedDevice((current) => current || targets[0]?.id || '');
    } catch (error) {
      setDevice((current) => ({ ...current, online: false }));
      const message = error instanceof Error ? error.message : String(error);
      setDeviceDiscoveryError(message);
      showNotice('error', message);
    } finally {
      connectionRefreshInFlightRef.current = false;
    }
  }, [deviceClient]);

  useEffect(() => {
    Promise.all([refreshConnection(), workbenchApi.draft(), workbenchApi.workerASession(), workbenchApi.workerBSession(), workbenchApi.sessions()])
      .then(([, result, workerASessionResult, workerBSessionResult, sessionHistory]) => {
        resetDraftState(result.draft);
        setServerIssues(result.issues);
        if (result.draft.currentFrameId) setViewMode('review');
        if (workerBSessionResult.session) setWorkerActivity(pausedWorkerBActivity(workerBSessionResult.session));
        else if (workerASessionResult.session) setWorkerActivity(pausedWorkerAActivity(workerASessionResult.session));
        setAnalysisSessions(sessionHistory.sessions);
      })
      .catch((error) => showNotice('error', error instanceof Error ? error.message : String(error)));
    const timer = window.setInterval(() => void refreshConnection(), 30_000);
    return () => window.clearInterval(timer);
  }, [refreshConnection]);

  useEffect(() => {
    window.localStorage.setItem('uikg-exploration-mode', explorationMode);
  }, [explorationMode]);

  useEffect(() => {
    if (workspaceMode !== 'staging') return;
    workbenchApi.stagingVersions()
      .then(({ versions }) => {
        setStagingVersions(versions);
        setStaging((current) => current ? versions.find((version) => version.stageId === current.stageId) || current : versions[0] || null);
      })
      .catch((error) => showNotice('error', error instanceof Error ? error.message : String(error)));
  }, [workspaceMode]);

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

  const freezeFrame = async () => {
    setBusy('freeze');
    try {
      const keepLive = continuousCapture;
      const result = await workbenchApi.freezeFrame(keepLive);
      setFrame(result.frame);
      resetDraftState(result.draft);
      workerAResultRef.current = null;
      workerBResultRef.current = null;
      setWorkerComparison(null);
      setSelectedId(null);
      setWorkspaceMode('annotation');
      setViewMode(keepLive ? 'live' : 'review');
      setDrawing(false);
      showNotice('success', keepLive ? '截图已加入页面图，可继续操作设备' : '截图已加入页面图，请标注或识别页面');
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
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
    if (!result.draft || !result.issues) throw new Error('Worker A 已完成，但没有返回草稿');
    resetDraftState(result.draft);
    setServerIssues(result.issues);
    setSelectedId(result.draft.elements[0]?.id || null);
    setStatus((current) => current ? { ...current, workerASession: null } : current);
    setWorkerActivity((current) => current ? { ...current, status: 'completed', phase: 'complete', phaseMessage: 'Worker A 分析完成', errorMessage: undefined, resumeSessionId: undefined, resumeKind: undefined } : current);
    showNotice('success', `Worker A 已识别 ${result.draft.elements.length} 个候选元素`);
    await refreshAnalysisSessions();
  };

  const retryWorkerB = async () => {
    const currentDraft = draftRef.current;
    if (!currentDraft?.currentFrameId) return;
    setWorkerControlBusy('worker-b');
    setWorkerDialogOpen(true);
    setWorkerComparison(null);
    setWorkerActivity((current) => current ? { ...current, status: 'running', workerBStatus: 'running', phase: 'worker_b', phaseMessage: 'Worker B 正在重新识别画面', reasoningContent: '', outputContent: '', errorMessage: undefined, resumeSessionId: undefined, resumeKind: undefined, workerBResumeSessionId: undefined } : current);
    try {
      const pageContext = [currentDraft.page.name, currentDraft.page.stateSummary].filter(Boolean).join('；');
      const result = await workbenchApi.workerBStream(currentDraft.currentFrameId, pageContext, explorationMode === 'ultra' ? handleUltraWorkerBEvent : handleWorkerEvent, currentDraft.currentPageId);
      workerBResultRef.current = result.workerResult;
      if (workerAResultRef.current) setWorkerComparison({ workerAResult: workerAResultRef.current, workerBResult: result.workerResult, modelResultRef: result.modelResultRef });
      setStatus((current) => current ? { ...current, workerBSession: null } : current);
      setWorkerActivity((current) => current ? { ...current, status: aggregateUltraWorkerStatus(current.workerAStatus, 'completed'), workerBStatus: 'completed', phase: workerAResultRef.current ? 'compare' : 'complete', phaseMessage: 'Worker B 识别完成', errorMessage: undefined } : current);
      showNotice('success', 'Worker B 已完成独立识别，可在冻结区域选择元素');
    } catch (error) {
      handleWorkerBFailure(error, 'Worker B 重新识别失败');
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
    setWorkerActivity((current) => current ? { ...current, status: 'running', workerAStatus: 'running', phase: 'worker_a', phaseMessage: 'Worker A 正在重新识别画面', workerAReasoningContent: '', workerAOutputContent: '', errorMessage: undefined, resumeSessionId: undefined, resumeKind: undefined, workerAResumeSessionId: undefined } : current);
    try {
      const pageContext = [currentDraft.page.name, currentDraft.page.stateSummary].filter(Boolean).join('；');
      const result = await workbenchApi.workerAStream(currentDraft.currentFrameId, pageContext, false, handleUltraWorkerAEvent, currentDraft.currentPageId);
      workerAResultRef.current = result.workerResult;
      if (workerBResultRef.current) setWorkerComparison({ workerAResult: result.workerResult, workerBResult: workerBResultRef.current, modelResultRef: result.modelResultRef });
      setStatus((current) => current ? { ...current, workerASession: null } : current);
      setWorkerActivity((current) => current ? { ...current, status: aggregateUltraWorkerStatus('completed', current.workerBStatus), workerAStatus: 'completed', phase: workerBResultRef.current ? 'compare' : 'complete', phaseMessage: 'Worker A 识别完成', errorMessage: undefined } : current);
      showNotice('success', 'Worker A 已完成重新识别');
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
          phaseMessage: cancelled ? 'Worker A 已中断，可从断点继续' : 'Worker A 已暂停，可从断点继续',
          errorMessage: cancelled ? undefined : resumeSession.errorMessage,
          resumeSessionId: resumeSession.id,
          resumeKind: 'worker_a',
          completedCandidates: resumeSession.completedCandidates,
        } : current);
        setStatus((current) => current ? { ...current, workerASession: resumeSession } : current);
        showNotice('info', `Worker A 已保留 ${resumeSession.completedCandidates} 个候选的断点`);
        return;
      }
      setWorkerActivity((current) => ({
        ...(current || pausedWorkerAActivity(resumeSession)),
        status: 'paused',
        phase: 'paused',
        phaseMessage: cancelled ? 'Worker A 已中断，可从断点继续' : '自动续写 5 次仍未完成，可从断点继续',
        errorMessage: cancelled ? undefined : resumeSession.errorMessage,
        resumeSessionId: resumeSession.id,
        resumeKind: 'worker_a',
        completedCandidates: resumeSession.completedCandidates,
      }));
      setStatus((current) => current ? { ...current, workerASession: resumeSession } : current);
      showNotice('info', `Worker A 已保留 ${resumeSession.completedCandidates} 个候选的断点`);
      return;
    }
    if (explorationMode === 'ultra') {
      setWorkerActivity((current) => current ? {
        ...current,
        status: aggregateUltraWorkerStatus(cancelled ? 'cancelled' : 'error', current.workerBStatus),
        workerAStatus: cancelled ? 'cancelled' : 'error',
        phase: cancelled ? 'worker-a-cancelled' : 'worker-a-error',
        phaseMessage: cancelled ? 'Worker A 已中断' : 'Worker A 分析失败',
        errorMessage: cancelled ? undefined : error instanceof Error ? error.message : String(error),
      } : current);
      showNotice(cancelled ? 'info' : 'error', cancelled ? 'Worker A 已中断' : error instanceof Error ? error.message : String(error));
      return;
    }
    setWorkerActivity((current) => current ? {
      ...current,
      status: cancelled ? 'cancelled' : 'error',
      phase: cancelled ? 'cancelled' : 'error',
      phaseMessage: cancelled ? 'Worker A 已中断' : 'Worker A 分析失败',
      errorMessage: cancelled ? undefined : error instanceof Error ? error.message : String(error),
    } : current);
    showNotice(cancelled ? 'info' : 'error', cancelled ? 'Worker A 已中断，草稿未更新' : error instanceof Error ? error.message : String(error));
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
          phaseMessage: 'Worker B 已暂停，可从断点继续',
          errorMessage: undefined,
          resumeSessionId: resumeSession.id,
          resumeKind: 'worker_b',
        } : current);
        setStatus((current) => current ? { ...current, workerBSession: resumeSession } : current);
        showNotice('info', 'Worker B 已中断并保存当前输出断点');
        return;
      }
      setWorkerActivity((current) => ({
        ...(current || pausedWorkerBActivity(resumeSession)),
        status: 'paused',
        phase: 'worker-b-paused',
        phaseMessage: 'Worker B 已中断，可从断点继续',
        errorMessage: undefined,
        resumeSessionId: resumeSession.id,
        resumeKind: 'worker_b',
      }));
      setStatus((current) => current ? { ...current, workerBSession: resumeSession } : current);
      showNotice('info', 'Worker B 已中断并保存当前输出断点');
      return;
    }
    if (explorationMode === 'ultra') {
      setWorkerActivity((current) => current ? {
        ...current,
        status: aggregateUltraWorkerStatus(current.workerAStatus, cancelled ? 'cancelled' : 'error'),
        workerBStatus: cancelled ? 'cancelled' : 'error',
        phase: cancelled ? 'worker-b-cancelled' : 'worker-b-error',
        phaseMessage: cancelled ? 'Worker B 已中断' : fallbackMessage,
        errorMessage: cancelled ? undefined : message,
      } : current);
      showNotice(cancelled ? 'info' : 'error', cancelled ? 'Worker B 已中断' : message);
      return;
    }
    setWorkerActivity((current) => current ? {
      ...current,
      status: cancelled ? 'cancelled' : 'error',
      phase: cancelled ? 'worker-b-cancelled' : 'worker-b-error',
      phaseMessage: cancelled ? 'Worker B 已中断' : fallbackMessage,
      errorMessage: cancelled ? undefined : message,
    } : current);
    showNotice(cancelled ? 'info' : 'error', cancelled ? 'Worker B 已中断' : message);
  };

  const runWorkers = async () => {
    if (!draft?.currentFrameId) return;
    setBusy('workers');
    setWorkerDialogOpen(true);
    setWorkerComparison(null);
    workerAResultRef.current = null;
    workerBResultRef.current = null;
    const ultraMode = explorationMode === 'ultra';
    setWorkerActivity({ status: 'running', phase: ultraMode ? 'ultra-running' : 'starting', phaseMessage: ultraMode ? 'Worker A 与 Worker B 正在并发识别画面' : '正在启动 Worker A', reasoningContent: '', outputContent: '', workerAReasoningContent: '', workerAOutputContent: '', workerAStatus: ultraMode ? 'running' : undefined, workerBStatus: ultraMode ? 'running' : undefined });
    try {
      const pageContext = [draft.page.name, draft.page.stateSummary].filter(Boolean).join('；');
      if (!ultraMode) {
        await finishManualWorkerA(await workbenchApi.workerAStream(draft.currentFrameId, pageContext, true, handleWorkerEvent, draft.currentPageId));
        return;
      }
      const workerAPromise = workbenchApi.workerAStream(draft.currentFrameId, pageContext, false, handleUltraWorkerAEvent, draft.currentPageId).then((result) => {
        workerAResultRef.current = result.workerResult;
        if (workerBResultRef.current) setWorkerComparison({ workerAResult: result.workerResult, workerBResult: workerBResultRef.current, modelResultRef: result.modelResultRef });
        setStatus((current) => current ? { ...current, workerASession: null } : current);
        setWorkerActivity((current) => current ? { ...current, status: aggregateUltraWorkerStatus('completed', current.workerBStatus), workerAStatus: 'completed', workerAResumeSessionId: undefined } : current);
        return result;
      }, (error) => { handleWorkerAFailure(error); throw error; });
      const workerBPromise = workbenchApi.workerBStream(draft.currentFrameId, pageContext, handleUltraWorkerBEvent, draft.currentPageId).then((result) => {
        workerBResultRef.current = result.workerResult;
        if (workerAResultRef.current) setWorkerComparison({ workerAResult: workerAResultRef.current, workerBResult: result.workerResult, modelResultRef: result.modelResultRef });
        setStatus((current) => current ? { ...current, workerBSession: null } : current);
        setWorkerActivity((current) => current ? { ...current, status: aggregateUltraWorkerStatus(current.workerAStatus, 'completed'), workerBStatus: 'completed', workerBResumeSessionId: undefined } : current);
        return result;
      }, (error) => { handleWorkerBFailure(error, 'Worker B 识别失败'); throw error; });
      const [workerAOutcome, workerBOutcome] = await Promise.allSettled([workerAPromise, workerBPromise]);
      if (workerAOutcome.status === 'fulfilled' && workerBOutcome.status === 'fulfilled') {
        setWorkerActivity((current) => current ? { ...current, status: 'completed', workerAStatus: 'completed', workerBStatus: 'completed', phase: 'compare', phaseMessage: '双 Worker 并发识别完成', errorMessage: undefined } : current);
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
      phaseMessage: '正在从已保存断点继续 Worker A',
      errorMessage: undefined,
    } : current);
    try {
      const result = await workbenchApi.resumeWorkerAStream(sessionId, explorationMode === 'ultra' ? handleUltraWorkerAEvent : handleWorkerEvent);
      if (explorationMode === 'ultra') {
        workerAResultRef.current = result.workerResult;
        if (workerBResultRef.current) setWorkerComparison({ workerAResult: result.workerResult, workerBResult: workerBResultRef.current, modelResultRef: result.modelResultRef });
        setWorkerActivity((current) => current ? { ...current, status: aggregateUltraWorkerStatus('completed', current.workerBStatus), workerAStatus: 'completed', workerAResumeSessionId: undefined, phase: workerBResultRef.current ? 'compare' : 'complete', phaseMessage: 'Worker A 已从断点完成', errorMessage: undefined, resumeSessionId: undefined, resumeKind: undefined } : current);
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
      phaseMessage: '正在从已保存断点继续 Worker B',
      errorMessage: undefined,
    } : current);
    try {
      const result = await workbenchApi.resumeWorkerBStream(sessionId, explorationMode === 'ultra' ? handleUltraWorkerBEvent : handleWorkerEvent);
      workerBResultRef.current = result.workerResult;
      if (workerAResultRef.current) setWorkerComparison({ workerAResult: workerAResultRef.current, workerBResult: result.workerResult, modelResultRef: result.modelResultRef });
      setStatus((current) => current ? { ...current, workerBSession: null } : current);
      setWorkerActivity((current) => current ? { ...current, status: aggregateUltraWorkerStatus(current.workerAStatus, 'completed'), workerBStatus: 'completed', workerBResumeSessionId: undefined, phase: workerAResultRef.current ? 'compare' : 'complete', phaseMessage: 'Worker B 已从断点完成识别', errorMessage: undefined, resumeSessionId: undefined, resumeKind: undefined } : current);
      showNotice('success', 'Worker B 已从断点完成识别');
    } catch (error) {
      handleWorkerBFailure(error, 'Worker B 断点续写失败');
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
      phaseMessage: `${kind === 'worker_a' ? 'Worker A' : 'Worker B'} 正在中断`,
    } : current);
    try {
      const result = kind === 'worker_a' ? await workbenchApi.cancelWorkerA() : await workbenchApi.cancelWorkerB();
      if (!result.cancelled) showNotice('info', `${kind === 'worker_a' ? 'Worker A' : 'Worker B'} 已结束，无需中断`);
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
        ? await Promise.all([workbenchApi.cancelWorkerA(), workbenchApi.cancelWorkerB()])
        : [workerBActive ? await workbenchApi.cancelWorkerB() : await workbenchApi.cancelWorkerA()];
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
      phaseMessage: latest.kind === 'worker_a' ? 'Worker A 识别会话' : 'Worker B 识别会话',
      reasoningContent: latest.reasoningContent || '',
      outputContent: latest.outputContent || '',
      errorMessage: latest.errorMessage || undefined,
    });
    setWorkerDialogOpen(true);
  };

  const persistDraft = async (draftToSave: Draft) => {
    const result = await workbenchApi.saveDraft(draftToSave);
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
    if (!current || !reviewReady || autoSaveInFlightRef.current) return;
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
      const result = await workbenchApi.saveDraft(clearedDraft);
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
      setBusy(null);
    }
  };

  const requestCancelAnnotation = () => {
    if (!draftRef.current?.currentFrameId) return;
    setCancelDialogOpen(true);
  };

  const restoreAnnotationState = async (source: 'entry' | 'saved') => {
    const snapshot = source === 'entry' ? annotationEntryDraftRef.current : lastSavedDraftRef.current;
    if (!snapshot) return;
    setCancelDialogOpen(false);
    setBusy('cancel-annotation');
    try {
      // Keep the selected snapshot's page/element properties, but clear the
      // active frame so the annotation surface returns to its initial state.
      const restoredDraft: Draft = {
        ...structuredClone(snapshot),
        currentFrameId: null,
        rawModelResultRef: null,
      };
      const result = await workbenchApi.saveDraft(restoredDraft);
      lastSavedDraftRef.current = structuredClone(result.draft);
      setServerIssues(result.issues);
      resetDraftState(result.draft, false, true);
      setSelectedId(null);
      setCheckedIds(new Set());
      setDrawing(false);
      setShowRejected(false);
      setFrame(null);
      setWorkerComparison(null);
      // The selected snapshot updates page data, while the annotation canvas
      // returns to its default live/empty view instead of rendering that snapshot.
      setViewMode('live');
      setAutoSaveState('idle');
      showNotice('success', source === 'entry' ? '已恢复进入标注时的状态' : '已恢复最后一次保存的状态');
    } catch (error) {
      showNotice('error', `恢复标注状态失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
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
    for (const element of draft?.elements || []) if (checkedIds.has(element.id) && element.reviewStatus !== 'accepted') preAcceptStatusRef.current.set(element.id, element.reviewStatus);
    updateDraft((current) => ({ ...current, elements: current.elements.map((element) => checkedIds.has(element.id) ? { ...element, reviewStatus: 'accepted' } : element) }), undefined, '批量确认');
  };

  const bulkCancelAccept = () => {
    if (checkedIds.size === 0) return;
    updateDraft((current) => ({ ...current, elements: current.elements.map((element) => {
      if (!checkedIds.has(element.id) || element.reviewStatus !== 'accepted') return element;
      return { ...element, reviewStatus: preAcceptStatusRef.current.get(element.id) || (element.source === 'ai_worker' ? 'pending' : 'edited') };
    }) }), undefined, '取消批量确认');
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
    showNotice('success', `已用 ${selected.length} 个元素创建组合容器`);
  };

  const toggleAccept = (element: DraftElement) => {
    if (element.reviewStatus === 'accepted') {
      const previous = preAcceptStatusRef.current.get(element.id);
      const reviewStatus = previous || (element.source === 'ai_worker' ? 'pending' : 'edited');
      updateElement(element.id, { reviewStatus }, undefined, false, '取消确认元素');
      preAcceptStatusRef.current.delete(element.id);
      return;
    }
    preAcceptStatusRef.current.set(element.id, element.reviewStatus);
    updateElement(element.id, { reviewStatus: 'accepted' }, undefined, false, '确认元素');
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
    selectPage(pageId);
    if (draftRef.current) annotationEntryDraftRef.current = structuredClone(draftRef.current);
    setWorkspaceMode('annotation');
    setViewMode(page.frameIds.length > 0 ? 'review' : 'live');
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
    commitDraft((current) => {
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
        surfaceType: 'unknown',
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
    });
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

  const errorCount = issues.filter((issue) => issue.level === 'error').length;
  const warningCount = issues.filter((issue) => issue.level === 'warning').length;
  const connected = Boolean(device.runtimeInfo && status?.agentConnected);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><Boxes size={20} /><div><strong>UIKG Workbench</strong><span>{status?.spec.version || 'UIKG'}</span></div></div>
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
          <button type="button" className={`button global-model-button ${workspaceMode === 'settings' ? 'active' : ''}`} onClick={() => setWorkspaceMode('settings')}><Settings2 size={15} />模型配置</button>
          {workspaceMode === 'annotation' && viewMode === 'review' && <button type="button" className="button button-primary" disabled={!reviewReady || busy === 'review-complete' || autoSaveState === 'saving'} onClick={() => void completeReview()}>{busy === 'review-complete' ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}审核通过</button>}
        </div>
      </header>

      <div className="contextbar">
        <label><span>应用</span><input value={draft?.appKey || ''} onBlur={endHistoryGroup} onChange={(event) => updateDraft((current) => ({ ...current, appKey: event.target.value }), 'draft:appKey')} /></label>
        <label><span>构建</span><input value={draft?.buildRef || ''} placeholder="android-package:..." onBlur={endHistoryGroup} onChange={(event) => updateDraft((current) => ({ ...current, buildRef: event.target.value }), 'draft:buildRef')} /></label>
        <label className="page-switcher"><span>页面</span><select value={draft?.currentPageId || ''} disabled={!draft?.pages.length} onChange={(event) => openPage(event.target.value)}>{draft?.pages.map((page) => { const pageStatus = pageWorkflowStatus(draft, page); return <option key={page.id} value={page.id}>{page.name} · {pageWorkflowStatusLabels[pageStatus]}</option>; })}</select></label>
        <label className="page-name-field"><span>名称</span><input value={draft?.page.name || ''} onBlur={endHistoryGroup} onChange={(event) => draft && updatePage(draft.currentPageId, { name: event.target.value }, 'page:name')} /></label>
        <div className="context-workflow-controls">
          <div className="mode-segment" aria-label="探索模式">
            <button type="button" className={explorationMode === 'ultra' ? 'active' : ''} title="Worker A 与 Worker B 并发识别，再按元素和字段选择合并" onClick={() => setExplorationMode('ultra')}>Ultra</button>
            <button type="button" className={explorationMode === 'manual' ? 'active' : ''} title="使用 Worker A 单 Worker 识别后直接人工审核" onClick={() => setExplorationMode('manual')}>Manual</button>
          </div>
          <span className={`validation-summary ${errorCount ? 'has-error' : ''}`} title="当前草稿校验结果"><CircleAlert size={15} />{errorCount} / {warningCount}</span>
        </div>
        <div className="workspace-tabs" aria-label="工作区">
          <button type="button" className={workspaceMode === 'annotation' ? 'active' : ''} onClick={() => setWorkspaceMode('annotation')}><MousePointer2 size={14} />标注</button>
          <button type="button" className={workspaceMode === 'graph' ? 'active' : ''} onClick={() => setWorkspaceMode('graph')}><PanelsTopLeft size={14} />页面图</button>
          <button type="button" className={workspaceMode === 'staging' ? 'active' : ''} onClick={() => setWorkspaceMode('staging')}><FileDiff size={14} />Staging</button>
          <button type="button" className={workspaceMode === 'knowledge' ? 'active' : ''} onClick={() => setWorkspaceMode('knowledge')}><Network size={14} />知识图谱</button>
        </div>
        <span className="spec-hash" title={status?.spec.contentHash}>Schema {status?.spec.schemaVersion || '3.0.0'}</span>
      </div>

      {workspaceMode === 'annotation' ? <main className="workspace">
        <section className="device-panel">
          <div className="panel-toolbar">
            <div className="view-tabs">
              <button type="button" className={viewMode === 'live' ? 'active' : ''} onClick={() => setViewMode('live')}><Play size={14} />实时操作</button>
              <button type="button" className={viewMode === 'review' ? 'active' : ''} disabled={!draft?.currentFrameId} onClick={() => setViewMode('review')}><Camera size={14} />标注页面</button>
            </div>
            <div className="toolbar-actions">
              {viewMode === 'live' ? (
                <>
                  <label className="continuous-capture"><input type="checkbox" checked={continuousCapture} onChange={(event) => setContinuousCapture(event.target.checked)} /><span>连续截图</span></label>
                  <button type="button" className="button" disabled={!connected || busy === 'freeze'} onClick={() => void freezeFrame()}>{busy === 'freeze' ? <LoaderCircle className="spin" size={15} /> : <Camera size={15} />}冻结画面</button>
                </>
              ) : (
                <>
                  <button type="button" className="button danger-button" disabled={busy === 'cancel-annotation' || busy === 'review-complete'} onClick={requestCancelAnnotation}><X size={15} />取消标注</button>
                  <button type="button" className={`icon-button ${drawing ? 'active' : ''}`} title="绘制新元素" onClick={() => setDrawing((value) => !value)}><SquareDashed size={16} /></button>
                  <button type="button" className="icon-button" title={showRejected ? '隐藏已忽略元素' : '显示已忽略元素'} onClick={() => setShowRejected((value) => !value)}>{showRejected ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                  <span className="worker-model" title={explorationMode === 'ultra' ? `Worker A：${status?.workerAModel || '未配置'}；Worker B：${status?.workerBModel || '未配置'}` : `Worker A：${status?.workerAModel || '未配置'}`}>{explorationMode === 'ultra' ? '双 Worker 并发' : `Worker A：${status?.workerAModel || '未配置'}`}</span>
                  {workerActivity?.status === 'paused' && <button type="button" className="button worker-resume-button" onClick={() => setWorkerDialogOpen(true)}><RefreshCw size={15} />继续 Worker · {workerActivity.completedCandidates || 0}</button>}
                  <button type="button" className="icon-button" title="页面识别历史" disabled={pageHistorySessions.length === 0} onClick={openWorkerHistory}><History size={15} /></button>
                  <button type="button" className="button" disabled={!draft?.currentFrameId || busy === 'workers' || busy === 'worker-a' || busy === 'worker-b' || workerActivity?.status === 'paused' || (explorationMode === 'ultra' && !status?.workerBConfigured)} onClick={() => void runWorkers()}>{busy === 'workers' || busy === 'worker-a' || busy === 'worker-b' ? <LoaderCircle className="spin" size={15} /> : <ScanSearch size={15} />}{hasAnalyzedCurrentFrame ? '重新识别' : '识别分析'}</button>
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
            <span>{viewMode === 'live' ? connected ? 'LIVE' : 'OFFLINE' : draft?.currentFrameId ? 'FROZEN' : 'EMPTY'}</span>
            <code>{draft?.currentFrameId ? `${draft.currentFrameId.slice(0, 22)}...` : '暂无 frameId'}</code>
            {frame && <small>{frame.width} × {frame.height}</small>}
          </div>
        </section>

        <section className="tree-panel">
          <div className="panel-title">
            <div><MousePointer2 size={16} /><strong>页面元素</strong><span>{workerComparison && explorationMode === 'ultra' ? '候选' : currentElements.length}</span></div>
            {!(workerComparison && explorationMode === 'ultra') && <div className="element-toolbar" aria-label="元素全局操作">
              <button type="button" className="icon-button" title="撤销上一步" disabled={pastRef.current.length === 0 || historyBlockedForPendingPage} onClick={undo}><Undo2 size={15} /></button>
              <button type="button" className="icon-button" title="取消撤销" disabled={futureRef.current.length === 0 || historyBlockedForPendingPage} onClick={redo}><Redo2 size={15} /></button>
              <button type="button" className="icon-button" title="恢复全部元素" disabled={!canRestoreAllElements} onClick={restoreAllElements}><RotateCcw size={15} /></button>
              {!multiSelect ? (
                <button type="button" className="icon-button" title="进入多选" disabled={currentElements.length === 0} onClick={() => setMultiSelect(true)}><BoxSelect size={15} /></button>
              ) : (
                <>
                  <button type="button" className="icon-button" title={allCurrentChecked ? '取消全选' : '全选'} onClick={() => setCheckedIds(allCurrentChecked ? new Set() : new Set(currentElements.map((element) => element.id)))}><CheckCheck size={15} /></button>
                  <button type="button" className="icon-button" title={`用 ${checkedIds.size} 个所选元素创建容器`} disabled={checkedIds.size === 0} onClick={createContainerFromSelection}><BoxSelect size={15} /></button>
                  <button type="button" className="icon-button" title={`确认所选元素（${checkedIds.size}）`} disabled={checkedIds.size === 0} onClick={bulkAccept}><Check size={15} /></button>
                  <button type="button" className="icon-button" title={`取消确认所选元素（${checkedIds.size}）`} disabled={checkedIds.size === 0} onClick={bulkCancelAccept}><X size={15} /></button>
                  <button type="button" className="icon-button" title="退出多选" onClick={() => { setMultiSelect(false); setCheckedIds(new Set()); }}><X size={15} /></button>
                </>
              )}
            </div>}
          </div>
          {workerComparison && explorationMode === 'ultra' ? <div className="worker-candidate-portal" ref={setWorkerCandidatePortal} /> : <ElementTree elements={currentElements} selectedId={selectedId} multiSelect={multiSelect} checkedIds={checkedIds} onSelect={setSelectedId} onCheck={(id, checked) => setCheckedIds((current) => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; })} />}
          <div className={`tree-legend ${workerComparison && explorationMode === 'ultra' ? 'worker-source-legend' : ''}`}>
            {workerComparison && explorationMode === 'ultra' ? <><span><i className="legend-worker-a" />Worker A</span><span><i className="legend-worker-b" />Worker B</span></> :
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
              {issues.length === 0 ? <div className="validation-empty"><CircleCheck size={30} /><strong>当前草稿检查通过</strong></div> : issues.map((issue, index) => (
                <button key={`${issue.code}-${issue.elementId}-${index}`} type="button" className={`validation-item validation-${issue.level}`} onClick={() => { if (issue.elementId) { setSelectedId(issue.elementId); setSideTab('elements'); } }}><CircleAlert size={16} /><span><strong>{issue.level === 'error' ? '错误' : '待完善'}</strong>{issue.message}</span><ChevronDown size={14} /></button>
              ))}
            </div>
          ) : (
            <EditHistoryPanel records={elementActivities} onSelectElement={(id) => { setSelectedId(id); setSideTab('elements'); }} />
          )}
        </section>
      </main> : workspaceMode === 'graph' && draft ? (
        <PageGraph draft={draft} draftDirty={dirty} onOpenPage={openPage} onUploadDraftChange={(nextDraft) => { resetDraftState(nextDraft, false, true); setServerIssues(validateDraftClient(nextDraft)); }} onUpdatePage={updatePage} onDeletePage={deletePage} onChangeEnd={endHistoryGroup} />
      ) : workspaceMode === 'knowledge' ? (
        <KnowledgeGraph appKey={draft?.appKey || 'zto.connect'} />
      ) : workspaceMode === 'staging' ? (
        <StagingPanel versions={stagingVersions} staging={staging} busy={busy} dirty={dirty} onPrepare={() => void prepareStaging()} onSelect={setStaging} onMerge={(stageIds) => void mergeStaging(stageIds)} onPublish={(stageId) => void publishStaging(stageId)} onDelete={(stageId) => void deleteStaging(stageId)} onRollback={(stageId) => void rollbackStaging(stageId)} onArchive={(stageId) => void archiveStaging(stageId)} />
      ) : (
        <ModelSettings
          onNotice={showNotice}
          onSaved={(settings) => setStatus((current) => current ? { ...current, workerAConfigured: Boolean(settings.workerA.config.modelName), workerAModel: settings.workerA.config.modelName, workerBConfigured: Boolean(settings.workerB.config.modelName), workerBModel: settings.workerB.config.modelName || null } : current)}
        />
      )}

      {cancelDialogOpen && <div className="annotation-cancel-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCancelDialogOpen(false); }}>
        <section className="annotation-cancel-dialog" role="dialog" aria-modal="true" aria-labelledby="annotation-cancel-title" onMouseDown={(event) => event.stopPropagation()}>
          <header><div><strong id="annotation-cancel-title">取消标注</strong><span>请选择要恢复的状态，页面和元素信息不会被清空。</span></div><button type="button" className="icon-button" aria-label="关闭" title="关闭" onClick={() => setCancelDialogOpen(false)}><X size={16} /></button></header>
          <div className="annotation-cancel-options">
            <button type="button" className="annotation-cancel-option" disabled={!annotationEntryDraftRef.current || busy === 'cancel-annotation'} onClick={() => void restoreAnnotationState('entry')}><strong>恢复进入标注时状态</strong><span>撤销进入标注后产生的识别、编辑和选择变化。</span></button>
            <button type="button" className="annotation-cancel-option" disabled={!lastSavedDraftRef.current || busy === 'cancel-annotation'} onClick={() => void restoreAnnotationState('saved')}><strong>恢复最后一次保存状态</strong><span>保留最近一次自动保存或服务端保存的内容。</span></button>
          </div>
          <footer><button type="button" className="button" onClick={() => setCancelDialogOpen(false)}>继续标注</button></footer>
        </section>
      </div>}
      {notice && <div className={`notice notice-${notice.type}`}>{notice.type === 'error' ? <CircleAlert size={16} /> : <CircleCheck size={16} />}{notice.text}</div>}
      {workerDialogOpen && workerActivity && frameUrl && <WorkerProgressPanel activity={workerActivity} modelName={status?.workerAModel || null} workerBModel={status?.workerBModel || null} ultraMode={explorationMode === 'ultra'} sessions={pageHistorySessions} acceptedSessionId={acceptedHistorySessionId} workerControlBusy={workerControlBusy || (busy === 'worker-a' || busy === 'worker-b' ? busy : null)} onCancel={() => void cancelWorkers()} onCancelWorker={(kind) => void cancelWorker(kind)} onRetryWorker={(kind) => kind === 'worker_a' ? void retryWorkerA() : void retryWorkerB()} onResumeWorker={(kind) => kind === 'worker_a' ? void resumeWorkerA() : void resumeWorkerB()} onRetry={() => workerActivity.resumeKind === 'worker_b' ? void resumeWorkerB() : workerActivity.resumeKind === 'worker_a' ? void resumeWorkerA() : workerActivity.phase === 'worker-b-error' ? void retryWorkerB() : void runWorkers()} onClose={() => { setWorkerDialogOpen(false); if (workerActivity.status !== 'paused') setWorkerActivity(null); }} />}
    </div>
  );
}

export default function App() {
  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#087f5b', borderRadius: 6, fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif' } }}>
      <AntdApp><AppContent /></AntdApp>
    </ConfigProvider>
  );
}
