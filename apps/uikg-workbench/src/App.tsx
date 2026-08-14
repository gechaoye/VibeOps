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
  GitBranch,
  History,
  LoaderCircle,
  MonitorSmartphone,
  MousePointer2,
  BoxSelect,
  PanelRight,
  Play,
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
import { absoluteAssetUrl, serverUrl, workbenchApi } from './api';
import { DeviceClient } from './device-client';
import { EditHistoryPanel } from './EditHistoryPanel';
import { ElementTree } from './ElementTree';
import { Inspector } from './Inspector';
import { LiveDevicePreview } from './LiveDevicePreview';
import { ModelSettings } from './ModelSettings';
import { createDraftPage, createDraftTransition, createHumanElement, elementAvailableOnPage, reviewStatusLabels, validateDraftClient } from './model';
import { PageGraph } from './PageGraph';
import { ScoutProgressPanel, type ScoutActivity } from './ScoutProgressPanel';
import { StagingPanel } from './StagingPanel';
import type { BBox, DeviceState, Draft, DraftElement, DraftPage, DraftTransition, ElementActivityRecord, ElementEditRecord, FrameMetadata, ScoutResumeSession, StagingResult, ValidationIssue, WorkbenchStatus } from './types';
import './styles.css';

type ViewMode = 'live' | 'review';
type SideTab = 'elements' | 'validation' | 'history';
type WorkspaceMode = 'annotation' | 'graph' | 'staging' | 'settings';
type ExplorationMode = 'auto' | 'ai_assist';

const emptyDevice: DeviceState = { online: false, session: null, runtimeInfo: null, targets: [] };

const editableElementFields: Array<keyof DraftElement> = [
  'label', 'controlType', 'role', 'capabilities', 'actionable', 'state', 'parentId',
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

function pausedScoutActivity(session: ScoutResumeSession): ScoutActivity {
  return {
    status: 'paused',
    phase: 'paused',
    phaseMessage: '自动续写 5 次仍未完成，可从断点继续',
    reasoningContent: session.reasoningContent || '',
    outputContent: session.outputContent || '',
    errorMessage: session.errorMessage,
    resumeSessionId: session.id,
    completedCandidates: session.completedCandidates,
  };
}

function AppContent() {
  const deviceClient = useMemo(() => new DeviceClient(serverUrl), []);
  const [status, setStatus] = useState<WorkbenchStatus | null>(null);
  const [device, setDevice] = useState<DeviceState>(emptyDevice);
  const [selectedDevice, setSelectedDevice] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([]);
  const [frame, setFrame] = useState<FrameMetadata | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('live');
  const [sideTab, setSideTab] = useState<SideTab>('elements');
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('annotation');
  const [explorationMode, setExplorationMode] = useState<ExplorationMode>(() => window.localStorage.getItem('uikg-exploration-mode') === 'ai_assist' ? 'ai_assist' : 'auto');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTransitionId, setSelectedTransitionId] = useState<string | null>(null);
  const [multiSelect, setMultiSelect] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [drawing, setDrawing] = useState(false);
  const [showRejected, setShowRejected] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: 'info' | 'error' | 'success'; text: string } | null>(null);
  const [scoutActivity, setScoutActivity] = useState<ScoutActivity | null>(null);
  const [scoutDialogOpen, setScoutDialogOpen] = useState(false);
  const [staging, setStaging] = useState<StagingResult | null>(null);
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

  const issues = useMemo(() => draft ? validateDraftClient(draft) : serverIssues, [draft, serverIssues]);
  const selectedElement = draft?.elements.find((element) => element.id === selectedId) || null;
  const initialSelectedElement = selectedId ? initialElementsRef.current.get(selectedId) || null : null;
  const canRestoreSelectedElement = Boolean(selectedElement && initialSelectedElement && JSON.stringify(selectedElement) !== JSON.stringify(initialSelectedElement));
  const canRestoreAllElements = Boolean(draft && JSON.stringify(draft.elements) !== JSON.stringify(initialAllElementsRef.current));
  const currentElements = useMemo(() => draft ? draft.elements.filter((element) => elementAvailableOnPage(element, draft.currentPageId, draft.elements)) : [], [draft]);
  const allCurrentChecked = currentElements.length > 0 && currentElements.every((element) => checkedIds.has(element.id));
  const frameUrl = draft?.currentFrameId
    ? absoluteAssetUrl(`/workbench/api/frames/${encodeURIComponent(draft.currentFrameId)}/image`)
    : null;

  const showNotice = (type: 'info' | 'error' | 'success', text: string) => {
    setNotice({ type, text });
    window.setTimeout(() => setNotice((current) => current?.text === text ? null : current), 4200);
  };

  const cloneDraft = (value: Draft) => structuredClone(value);

  const resetDraftState = (nextDraft: Draft, markDirty = false, preserveActivities = false) => {
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    setDirty(markDirty);
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
    const next = updater(current);
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
    if (!current || !previous) return;
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
    if (!current || !next) return;
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
      const [online, workbenchStatus, session, targets] = await Promise.all([
        deviceClient.checkStatus(),
        workbenchApi.status(),
        deviceClient.getSessionInfo(),
        deviceClient.listSessionTargets(forceTargetRefresh),
      ]);
      const runtimeInfo = workbenchStatus.agentConnected ? await deviceClient.getRuntimeInfo() : null;
      setStatus(workbenchStatus);
      if (workbenchStatus.scoutSession) {
        setScoutActivity((current) => current || pausedScoutActivity(workbenchStatus.scoutSession!));
      }
      setDevice({ online, session, runtimeInfo, targets });
      setSelectedDevice((current) => current || targets[0]?.id || '');
    } catch (error) {
      setDevice((current) => ({ ...current, online: false }));
      showNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      connectionRefreshInFlightRef.current = false;
    }
  }, [deviceClient]);

  useEffect(() => {
    Promise.all([refreshConnection(), workbenchApi.draft(), workbenchApi.scoutSession()])
      .then(([, result, scoutSessionResult]) => {
        resetDraftState(result.draft);
        setServerIssues(result.issues);
        if (result.draft.currentFrameId) setViewMode('review');
        if (scoutSessionResult.session) setScoutActivity(pausedScoutActivity(scoutSessionResult.session));
      })
      .catch((error) => showNotice('error', error instanceof Error ? error.message : String(error)));
    const timer = window.setInterval(() => void refreshConnection(), 30_000);
    return () => window.clearInterval(timer);
  }, [refreshConnection]);

  useEffect(() => {
    window.localStorage.setItem('uikg-exploration-mode', explorationMode);
  }, [explorationMode]);

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
      const result = await workbenchApi.freezeFrame();
      setFrame(result.frame);
      resetDraftState(result.draft);
      setSelectedId(null);
      setSelectedTransitionId(null);
      setViewMode('review');
      setDrawing(false);
      showNotice('success', '已保存冻结帧');
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const handleScoutEvent = (event: { type: string; [key: string]: unknown }) => {
    if (event.type === 'stage') {
      setScoutActivity((current) => current ? {
        ...current,
        phase: String(event.phase || current.phase),
        phaseMessage: String(event.message || current.phaseMessage),
      } : current);
    }
    if (event.type === 'chunk') {
      setScoutActivity((current) => current ? {
        ...current,
        reasoningContent: current.reasoningContent + String(event.reasoningContent || ''),
        outputContent: current.outputContent + String(event.content || ''),
      } : current);
    }
  };

  const finishScout = async (result: Awaited<ReturnType<typeof workbenchApi.scoutStream>>, runReview: boolean) => {
    resetDraftState(result.draft);
    setServerIssues(result.issues);
    setSelectedId(result.draft.elements[0]?.id || null);
    setStatus((current) => current ? { ...current, scoutSession: null } : current);
    if (!runReview) {
      setScoutActivity((current) => current ? { ...current, status: 'completed', phase: 'complete', phaseMessage: 'Scout 分析完成，等待人工确认', errorMessage: undefined, resumeSessionId: undefined } : current);
      showNotice('success', `Scout 已识别 ${result.draft.elements.length} 个候选元素`);
      return;
    }
    setScoutActivity((current) => current ? { ...current, status: 'running', phase: 'review', phaseMessage: 'Scout 完成，AI Reviewer 正在进行初审', errorMessage: undefined, resumeSessionId: undefined } : current);
    try {
      const reviewed = await workbenchApi.review(result.draft.currentFrameId!);
      resetDraftState(reviewed.draft);
      setServerIssues(reviewed.issues);
      setSelectedId(reviewed.draft.elements[0]?.id || null);
      setScoutActivity((current) => current ? { ...current, status: 'completed', phase: 'complete', phaseMessage: 'AI 初审完成，等待人工确认', errorMessage: undefined } : current);
      showNotice('success', `Auto 已识别并初审 ${reviewed.reviewed} 个候选，仍需人工确认`);
    } catch (error) {
      setScoutActivity((current) => current ? { ...current, status: 'error', phase: 'review-error', phaseMessage: 'Scout 已完成，AI 初审失败', errorMessage: error instanceof Error ? error.message : String(error) } : current);
      showNotice('error', `Scout 结果已保留；AI 初审失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const retryReview = async () => {
    const currentDraft = draftRef.current;
    if (!currentDraft?.currentFrameId) return;
    setBusy('review');
    setScoutDialogOpen(true);
    setScoutActivity((current) => current ? { ...current, status: 'running', phase: 'review', phaseMessage: '正在重试 AI 初审', errorMessage: undefined } : current);
    try {
      const reviewed = await workbenchApi.review(currentDraft.currentFrameId);
      resetDraftState(reviewed.draft);
      setServerIssues(reviewed.issues);
      setScoutActivity((current) => current ? { ...current, status: 'completed', phase: 'complete', phaseMessage: 'AI 初审完成，等待人工确认', errorMessage: undefined } : current);
      showNotice('success', `AI 初审完成，${reviewed.reviewed} 个候选等待人工确认`);
    } catch (error) {
      setScoutActivity((current) => current ? { ...current, status: 'error', phase: 'review-error', phaseMessage: 'AI 初审重试失败', errorMessage: error instanceof Error ? error.message : String(error) } : current);
      showNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const handleScoutFailure = (error: unknown) => {
    const cancelled = error instanceof Error && error.name === 'ScoutCancelledError';
    const details = error instanceof Error ? (error as Error & { details?: Record<string, unknown> }).details : undefined;
    const resumeSession = details?.resumableSession as ScoutResumeSession | undefined;
    if (resumeSession?.id) {
      setScoutActivity((current) => ({
        ...(current || pausedScoutActivity(resumeSession)),
        status: 'paused',
        phase: 'paused',
        phaseMessage: '自动续写 5 次仍未完成，可从断点继续',
        errorMessage: resumeSession.errorMessage,
        resumeSessionId: resumeSession.id,
        completedCandidates: resumeSession.completedCandidates,
      }));
      setStatus((current) => current ? { ...current, scoutSession: resumeSession } : current);
      showNotice('info', `Scout 已保留 ${resumeSession.completedCandidates} 个候选的断点`);
      return;
    }
    setScoutActivity((current) => current ? {
      ...current,
      status: cancelled ? 'cancelled' : 'error',
      phase: cancelled ? 'cancelled' : 'error',
      phaseMessage: cancelled ? 'Scout 已中断' : 'Scout 分析失败',
      errorMessage: cancelled ? undefined : error instanceof Error ? error.message : String(error),
    } : current);
    showNotice(cancelled ? 'info' : 'error', cancelled ? 'Scout 已中断，草稿未更新' : error instanceof Error ? error.message : String(error));
  };

  const runScout = async () => {
    if (!draft?.currentFrameId) return;
    setBusy('scout');
    setScoutDialogOpen(true);
    setScoutActivity({
      status: 'running',
      phase: 'starting',
      phaseMessage: '正在启动 Scout',
      reasoningContent: '',
      outputContent: '',
    });
    try {
      const pageContext = [draft.page.name, draft.page.stateSummary].filter(Boolean).join('；');
      await finishScout(await workbenchApi.scoutStream(draft.currentFrameId, pageContext, handleScoutEvent), explorationMode === 'auto');
    } catch (error) {
      handleScoutFailure(error);
    } finally {
      setBusy(null);
    }
  };

  const resumeScout = async () => {
    const sessionId = scoutActivity?.resumeSessionId;
    if (!sessionId) return;
    setBusy('scout');
    setScoutDialogOpen(true);
    setScoutActivity((current) => current ? {
      ...current,
      status: 'running',
      phase: 'resume',
      phaseMessage: '正在从已保存断点继续 Scout',
      errorMessage: undefined,
    } : current);
    try {
      await finishScout(await workbenchApi.resumeScoutStream(sessionId, handleScoutEvent), explorationMode === 'auto');
    } catch (error) {
      handleScoutFailure(error);
    } finally {
      setBusy(null);
    }
  };

  const cancelScout = async () => {
    setScoutActivity((current) => current ? { ...current, status: 'cancelling', phaseMessage: '正在中断模型请求' } : current);
    try {
      const result = await workbenchApi.cancelScout();
      if (!result.cancelled) {
        setScoutActivity((current) => current ? { ...current, phaseMessage: 'Scout 已结束，正在接收最终结果' } : current);
      }
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
    }
  };

  const saveDraft = async () => {
    if (!draft) return;
    setBusy('save');
    try {
      const result = await workbenchApi.saveDraft(draft);
      resetDraftState(result.draft, false, true);
      setServerIssues(result.issues);
      showNotice('success', '草稿已保存');
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
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
      return { ...element, reviewStatus: preAcceptStatusRef.current.get(element.id) || (element.source === 'ai_scout' ? 'pending' : 'edited') };
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
      actionable: 'no' as const,
      interactionBoundary: 'candidate_bbox',
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
      const reviewStatus = previous || (element.source === 'ai_scout' ? 'pending' : 'edited');
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
      const reviewStatus = previous || (element.source === 'ai_scout' ? 'pending' : 'edited');
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

  const switchPage = (pageId: string) => {
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
    setSelectedTransitionId(null);
    setCheckedIds(new Set());
  };

  const addPage = () => {
    const page = createDraftPage(null);
    commitDraft((current) => ({
      ...current,
      currentPageId: page.id,
      currentFrameId: null,
      page: { id: page.id, key: page.key, name: page.name, surfaceType: page.surfaceType, stateSummary: page.stateSummary, scrollableRegions: page.scrollableRegions },
      pages: [...current.pages, page],
    }));
    setSelectedId(null);
    setSelectedTransitionId(null);
  };

  const updatePage = (pageId: string, patch: Partial<DraftPage>, historyKey?: string) => {
    commitDraft((current) => {
      const pages = current.pages.map((page) => page.id === pageId ? { ...page, ...patch } : page);
      const page = pages.find((item) => item.id === current.currentPageId);
      return { ...current, pages, page: page ? { id: page.id, key: page.key, name: page.name, surfaceType: page.surfaceType, stateSummary: page.stateSummary, scrollableRegions: page.scrollableRegions } : current.page };
    }, historyKey ? `${pageId}:${historyKey}` : undefined);
  };

  const deletePage = (pageId: string) => {
    if (!draft || draft.pages.length <= 1) return;
    const fallback = draft.pages.find((page) => page.id !== pageId);
    if (!fallback) return;
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
      return {
        ...current,
        currentPageId: nextPage.id,
        currentFrameId: nextPage.frameIds.at(-1) || null,
        page: { id: nextPage.id, key: nextPage.key, name: nextPage.name, surfaceType: nextPage.surfaceType, stateSummary: nextPage.stateSummary, scrollableRegions: nextPage.scrollableRegions },
        pages,
        elements,
        elementEditRecords: current.elementEditRecords.filter((record) => !removedElementIds.has(record.elementId)),
        transitions: current.transitions.filter((transition) => transition.sourcePageId !== pageId && transition.targetPageId !== pageId && !removedElementIds.has(transition.triggerElementId)),
      };
    });
    setSelectedId(null);
    setSelectedTransitionId(null);
    setCheckedIds(new Set());
  };

  const addTransition = () => {
    if (!draft || draft.pages.length < 2) return;
    const source = draft.pages.find((page) => page.id === draft.currentPageId) || draft.pages[0];
    const target = draft.pages.find((page) => page.id !== source.id) || source;
    const trigger = draft.elements.find((element) => elementAvailableOnPage(element, source.id, draft.elements));
    if (!trigger) return;
    const transition = createDraftTransition(source.id, target.id, trigger.id, source.frameIds.at(-1) || '', target.frameIds.at(-1) || '');
    commitDraft((current) => ({ ...current, transitions: [...current.transitions, transition] }));
    setSelectedTransitionId(transition.id);
  };

  const updateTransition = (transitionId: string, patch: Partial<DraftTransition>, historyKey?: string) => {
    commitDraft((current) => ({ ...current, transitions: current.transitions.map((transition) => transition.id === transitionId ? { ...transition, ...patch } : transition) }), historyKey ? `${transitionId}:${historyKey}` : undefined);
  };

  const deleteTransition = (transitionId: string) => {
    commitDraft((current) => ({ ...current, transitions: current.transitions.filter((transition) => transition.id !== transitionId) }));
    setSelectedTransitionId(null);
  };

  const prepareStaging = async () => {
    setBusy('staging');
    try {
      const result = await workbenchApi.prepareStaging();
      setStaging(result);
      showNotice(result.validation.valid ? 'success' : 'info', result.validation.valid ? 'staging 校验通过' : `staging 有 ${result.validation.errors.length} 个阻断项`);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const publishStaging = async () => {
    if (!staging) return;
    setBusy('publish');
    try {
      const result = await workbenchApi.publish(staging.stageId);
      showNotice('success', `已发布 ${result.graphRevision}`);
      setStaging(null);
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
          <div className={`connection-dot ${connected ? 'connected' : ''}`} />
          <select value={selectedDevice} disabled={connected || busy === 'connect'} onChange={(event) => setSelectedDevice(event.target.value)} aria-label="Android 设备">
            {device.targets.length === 0 && <option value="">未发现 Android 设备</option>}
            {device.targets.map((target) => <option key={target.id} value={target.id}>{target.description || target.label}</option>)}
          </select>
          <button type="button" className="icon-button" title="刷新设备列表" onClick={() => void refreshConnection(true)}><RefreshCw size={16} /></button>
          {!connected ? (
            <button type="button" className="button" disabled={!selectedDevice || busy === 'connect'} onClick={() => void connectDevice()}>{busy === 'connect' ? <LoaderCircle className="spin" size={16} /> : <Smartphone size={16} />}连接设备</button>
          ) : (
            <button type="button" className="icon-button" title="断开设备" disabled={busy === 'disconnect'} onClick={() => void disconnectDevice()}><Unplug size={16} /></button>
          )}
        </div>
        <div className="mode-segment" aria-label="探索模式">
          <button type="button" className={explorationMode === 'auto' ? 'active' : ''} title="Scout 识别后由 GPT 初审，再由人工确认" onClick={() => setExplorationMode('auto')}>Auto</button>
          <button type="button" className={explorationMode === 'ai_assist' ? 'active' : ''} title="Scout 识别后直接进入人工审核" onClick={() => setExplorationMode('ai_assist')}>AI Assist</button>
        </div>
        <div className="header-actions">
          <span className={`validation-summary ${errorCount ? 'has-error' : ''}`} title="当前草稿校验结果"><CircleAlert size={15} />{errorCount} / {warningCount}</span>
          <button type="button" className="button button-primary" disabled={!dirty || busy === 'save'} onClick={() => void saveDraft()}>{busy === 'save' ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}保存草稿</button>
        </div>
      </header>

      <div className="contextbar">
        <label><span>应用</span><input value={draft?.appKey || ''} onBlur={endHistoryGroup} onChange={(event) => updateDraft((current) => ({ ...current, appKey: event.target.value }), 'draft:appKey')} /></label>
        <label><span>构建</span><input value={draft?.buildRef || ''} placeholder="android-package:..." onBlur={endHistoryGroup} onChange={(event) => updateDraft((current) => ({ ...current, buildRef: event.target.value }), 'draft:buildRef')} /></label>
        <label className="page-name-field"><span>页面</span><input value={draft?.page.name || ''} onBlur={endHistoryGroup} onChange={(event) => draft && updatePage(draft.currentPageId, { name: event.target.value }, 'page:name')} /></label>
        <div className="workspace-tabs" aria-label="工作区">
          <button type="button" className={workspaceMode === 'annotation' ? 'active' : ''} onClick={() => setWorkspaceMode('annotation')}><MousePointer2 size={14} />标注</button>
          <button type="button" className={workspaceMode === 'graph' ? 'active' : ''} onClick={() => setWorkspaceMode('graph')}><GitBranch size={14} />页面图</button>
          <button type="button" className={workspaceMode === 'staging' ? 'active' : ''} onClick={() => setWorkspaceMode('staging')}><FileDiff size={14} />Staging</button>
          <button type="button" className={workspaceMode === 'settings' ? 'active' : ''} onClick={() => setWorkspaceMode('settings')}><Settings2 size={14} />模型</button>
        </div>
        <span className="spec-hash" title={status?.spec.contentHash}>Schema {status?.spec.schemaVersion || '3.0.0'}</span>
      </div>

      {workspaceMode === 'annotation' ? <main className="workspace">
        <section className="device-panel">
          <div className="panel-toolbar">
            <div className="view-tabs">
              <button type="button" className={viewMode === 'live' ? 'active' : ''} disabled={!connected} onClick={() => setViewMode('live')}><Play size={14} />实时操作</button>
              <button type="button" className={viewMode === 'review' ? 'active' : ''} disabled={!draft?.currentFrameId} onClick={() => setViewMode('review')}><Camera size={14} />冻结标注</button>
            </div>
            <div className="toolbar-actions">
              {viewMode === 'live' ? (
                <button type="button" className="button" disabled={!connected || busy === 'freeze'} onClick={() => void freezeFrame()}>{busy === 'freeze' ? <LoaderCircle className="spin" size={15} /> : <Camera size={15} />}冻结画面</button>
              ) : (
                <>
                  <button type="button" className={`icon-button ${drawing ? 'active' : ''}`} title="绘制新元素" onClick={() => setDrawing((value) => !value)}><SquareDashed size={16} /></button>
                  <button type="button" className="icon-button" title={showRejected ? '隐藏已忽略元素' : '显示已忽略元素'} onClick={() => setShowRejected((value) => !value)}>{showRejected ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                  <span className="scout-model" title={explorationMode === 'auto' ? `Scout：${status?.scoutModel || '未配置'}；Reviewer：${status?.reviewerModel || '未配置'}` : `Scout：${status?.scoutModel || '未配置'}`}>{explorationMode === 'auto' ? `Scout + Reviewer` : `Scout：${status?.scoutModel || '未配置'}`}</span>
                  {scoutActivity?.status === 'paused' && <button type="button" className="button scout-resume-button" onClick={() => setScoutDialogOpen(true)}><RefreshCw size={15} />继续 Scout · {scoutActivity.completedCandidates || 0}</button>}
                  <button type="button" className="button" disabled={!draft?.currentFrameId || busy === 'scout' || busy === 'review' || scoutActivity?.status === 'paused' || (explorationMode === 'auto' && !status?.reviewerConfigured)} onClick={() => void runScout()}>{busy === 'scout' || busy === 'review' ? <LoaderCircle className="spin" size={15} /> : <ScanSearch size={15} />}{explorationMode === 'auto' ? '运行 Auto' : '运行 Scout'}</button>
                </>
              )}
            </div>
          </div>
          <div className="device-stage-wrap">
            {viewMode === 'live' && connected ? (
              <div className="live-preview">
                <LiveDevicePreview client={deviceClient} runtimeInfo={device.runtimeInfo!} serverUrl={serverUrl} enabled={busy !== 'scout'} onError={(message) => showNotice('error', message)} />
              </div>
            ) : frameUrl ? (
              <AnnotationCanvas imageUrl={frameUrl} elements={currentElements} selectedId={selectedId} drawing={drawing} showRejected={showRejected} onSelect={setSelectedId} onAdd={addElement} onBoxChange={(id, bbox) => updateElement(id, { bbox }, `bbox:${id}`)} onBoxChangeEnd={endHistoryGroup} />
            ) : (
              <div className="device-empty"><MonitorSmartphone size={42} /><strong>未连接设备</strong><span>本地 Android</span></div>
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
            <div><MousePointer2 size={16} /><strong>页面元素</strong><span>{currentElements.length}</span></div>
            <div className="element-toolbar" aria-label="元素全局操作">
              <button type="button" className="icon-button" title="撤销上一步" disabled={pastRef.current.length === 0} onClick={undo}><Undo2 size={15} /></button>
              <button type="button" className="icon-button" title="取消撤销" disabled={futureRef.current.length === 0} onClick={redo}><Redo2 size={15} /></button>
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
            </div>
          </div>
          <ElementTree elements={currentElements} selectedId={selectedId} multiSelect={multiSelect} checkedIds={checkedIds} onSelect={setSelectedId} onCheck={(id, checked) => setCheckedIds((current) => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; })} />
          <div className="tree-legend">
            {(Object.entries(reviewStatusLabels) as [keyof typeof reviewStatusLabels, string][]).map(([statusKey, label]) => <span key={statusKey}><i className={`legend-${statusKey}`} />{label}</span>)}
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
        <PageGraph draft={draft} selectedTransitionId={selectedTransitionId} onSelectTransition={setSelectedTransitionId} onSwitchPage={switchPage} onAddPage={addPage} onUpdatePage={updatePage} onDeletePage={deletePage} onAddTransition={addTransition} onUpdateTransition={updateTransition} onDeleteTransition={deleteTransition} onChangeEnd={endHistoryGroup} />
      ) : workspaceMode === 'staging' ? (
        <StagingPanel staging={staging} busy={busy} dirty={dirty} onPrepare={() => void prepareStaging()} onPublish={() => void publishStaging()} />
      ) : (
        <ModelSettings
          onNotice={showNotice}
          onSaved={(settings) => setStatus((current) => current ? { ...current, scoutConfigured: Boolean(settings.config.modelName), scoutModel: settings.config.modelName, reviewerConfigured: Boolean(settings.reviewer?.config.modelName), reviewerModel: settings.reviewer?.config.modelName || null } : current)}
        />
      )}

      {notice && <div className={`notice notice-${notice.type}`}>{notice.type === 'error' ? <CircleAlert size={16} /> : <CircleCheck size={16} />}{notice.text}</div>}
      {scoutDialogOpen && scoutActivity && <ScoutProgressPanel activity={scoutActivity} modelName={status?.scoutModel || null} reviewerModel={status?.reviewerModel || null} autoMode={explorationMode === 'auto'} onCancel={() => void cancelScout()} onRetry={() => scoutActivity.phase === 'review-error' ? void retryReview() : void resumeScout()} onClose={() => { setScoutDialogOpen(false); if (scoutActivity.status !== 'paused') setScoutActivity(null); }} />}
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
