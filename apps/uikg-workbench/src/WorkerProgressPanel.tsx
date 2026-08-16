import { ArrowDown, Bot, Check, ChevronDown, ChevronRight, CircleAlert, CircleCheck, History, LoaderCircle, RefreshCw, ScanSearch, Square, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { ModelMarkdown } from './ModelMarkdown';
import type { AnalysisSession } from './types';

export interface WorkerActivity {
  status: 'running' | 'cancelling' | 'completed' | 'cancelled' | 'paused' | 'error';
  phase: string;
  phaseMessage: string;
  reasoningContent: string;
  outputContent: string;
  workerAReasoningContent?: string;
  workerAOutputContent?: string;
  errorMessage?: string;
  resumeSessionId?: string;
  resumeKind?: 'worker_a' | 'worker_b';
  completedCandidates?: number;
  workerAStatus?: WorkerActivity['status'];
  workerBStatus?: WorkerActivity['status'];
  workerAResumeSessionId?: string;
  workerBResumeSessionId?: string;
}

interface WorkerProgressPanelProps {
  activity: WorkerActivity;
  modelName: string | null;
  workerBModel: string | null;
  ultraMode: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onCancelWorker?: (kind: 'worker_a' | 'worker_b') => void;
  onRetryWorker?: (kind: 'worker_a' | 'worker_b') => void;
  onResumeWorker?: (kind: 'worker_a' | 'worker_b') => void;
  workerControlBusy?: 'worker-a' | 'worker-b' | null;
  onClose: () => void;
  sessions: AnalysisSession[];
  acceptedSessionId?: string | null;
}

const statusLabels = {
  running: '分析中',
  cancelling: '正在中断',
  completed: '已完成',
  cancelled: '已中断',
  paused: '等待续写',
  error: '分析失败',
} as const;

function useStreamFollow(content: string, enabled: boolean) {
  const elementRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const frameRef = useRef<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  const followLatest = useCallback(() => {
    const element = elementRef.current;
    if (!element || !followingRef.current) return;
    element.scrollTop = element.scrollHeight;
    setAtBottom(true);
  }, []);

  useLayoutEffect(() => {
    if (!enabled || !followingRef.current) return;
    followLatest();
    frameRef.current = requestAnimationFrame(followLatest);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [content, enabled, followLatest]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element || !enabled) return;
    followingRef.current = true;
    followLatest();
    const contentElement = element.firstElementChild || element;
    const observer = new ResizeObserver(() => {
      if (!followingRef.current) return;
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(followLatest);
    });
    observer.observe(contentElement);
    return () => {
      observer.disconnect();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [enabled, followLatest]);

  const trackScroll = () => {
    const element = elementRef.current;
    if (!element) return;
    const nextAtBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
    followingRef.current = nextAtBottom;
    setAtBottom(nextAtBottom);
  };

  const scrollToBottom = () => {
    const element = elementRef.current;
    if (!element) return;
    followingRef.current = true;
    followLatest();
    frameRef.current = requestAnimationFrame(followLatest);
  };

  return { elementRef, trackScroll, scrollToBottom, atBottom };
}

function displayModelError(message?: string) {
  if (!message) return '';
  if (message.includes('524 status code') || message.includes('Error 524')) {
    return 'Worker B 模型响应超时（524）：上游服务在代理时限内没有开始返回内容，请重新识别';
  }
  return message;
}

export function WorkerProgressPanel({ activity, modelName, workerBModel, ultraMode, onCancel, onRetry, onCancelWorker, onRetryWorker, onResumeWorker, workerControlBusy = null, onClose, sessions, acceptedSessionId = null }: WorkerProgressPanelProps) {
  const active = activity.status === 'running' || activity.status === 'cancelling';
  const workerBActive = activity.phase.startsWith('worker_b');
  const workerAStatus = activity.workerAStatus || (ultraMode ? (active ? 'running' : activity.status) : activity.status);
  const workerBStatus = activity.workerBStatus || (ultraMode ? (active ? 'running' : activity.status) : activity.status);
  const hasReasoning = Boolean(activity.reasoningContent.trim());
  const hasOutput = Boolean(activity.outputContent.trim());
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(true);
  const [showHistory, setShowHistory] = useState(activity.phase === 'history');
  const sortedSessions = useMemo(() => [...sessions].sort((left, right) => String(right.updatedAt || right.startedAt).localeCompare(String(left.updatedAt || left.startedAt))), [sessions]);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(activity.phase === 'history' ? sortedSessions[0]?.id || null : null);
  const [windowPosition, setWindowPosition] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const reasoningStream = useStreamFollow(activity.reasoningContent, reasoningExpanded && !showHistory);
  const outputStream = useStreamFollow(activity.outputContent, outputExpanded && !showHistory);
  const workerAOutputStream = useStreamFollow(activity.workerAOutputContent || '', ultraMode && !showHistory);
  const startDragging = (event: PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    dragRef.current = { startX: event.clientX, startY: event.clientY, originX: windowPosition.x, originY: windowPosition.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const dragWindow = (event: PointerEvent<HTMLElement>) => {
    if (!dragRef.current) return;
    setWindowPosition({ x: dragRef.current.originX + event.clientX - dragRef.current.startX, y: dragRef.current.originY + event.clientY - dragRef.current.startY });
  };
  const stopDragging = () => { dragRef.current = null; };
  const historySession = activity.phase === 'history' ? sortedSessions.find((session) => session.id === selectedHistoryId) || sortedSessions[0] : undefined;
  const workerBStage = workerBActive || historySession?.kind === 'worker_b';
  const workerAStepDone = workerBStage || activity.phase === 'compare' || activity.phase === 'complete' || historySession?.kind === 'worker_a' && historySession.status === 'completed';
  const workerBStepDone = activity.phase === 'compare' || activity.phase === 'complete' || historySession?.kind === 'worker_b' && historySession.status === 'completed';
  const workerAStepState = ultraMode ? workerAStatus === 'completed' ? 'done' : workerAStatus === 'running' || workerAStatus === 'cancelling' ? 'active' : workerAStatus === 'error' ? 'failed' : workerAStatus === 'paused' || workerAStatus === 'cancelled' ? 'paused' : '' : workerAStepDone ? 'done' : !workerBStage && activity.status === 'error' ? 'failed' : !workerBStage && (activity.status === 'cancelled' || activity.status === 'paused') ? 'paused' : !workerBStage && active ? 'active' : '';
  const workerBStepState = ultraMode ? workerBStatus === 'completed' ? 'done' : workerBStatus === 'running' || workerBStatus === 'cancelling' ? 'active' : workerBStatus === 'error' ? 'failed' : workerBStatus === 'paused' || workerBStatus === 'cancelled' ? 'paused' : '' : workerBStepDone ? 'done' : activity.phase === 'worker-b-error' || historySession?.kind === 'worker_b' && historySession.status === 'failed' ? 'failed' : activity.phase === 'worker-b-cancelled' || activity.phase === 'worker-b-paused' || historySession?.kind === 'worker_b' && historySession.status === 'cancelled' ? 'paused' : workerBStage && active ? 'active' : '';

  useEffect(() => {
    if (hasReasoning && !hasOutput) setReasoningExpanded(true);
    if (hasOutput) setReasoningExpanded(false);
  }, [hasReasoning, hasOutput]);

  useEffect(() => {
    if (activity.phase === 'compare') {
      setOutputExpanded(false);
    } else if (hasOutput) {
      setOutputExpanded(true);
    }
  }, [activity.phase, hasOutput]);

  return (
    <div className="worker-progress-backdrop" role="presentation">
      <section className="worker-progress-panel" role="dialog" aria-modal="true" aria-label={ultraMode ? 'Ultra 模式' : 'Manual 模式'} style={{ transform: `translate(calc(-50% + ${windowPosition.x}px), calc(-50% + ${windowPosition.y}px))` }}>
        <header className="worker-progress-header" onPointerDown={startDragging} onPointerMove={dragWindow} onPointerUp={stopDragging} onPointerCancel={stopDragging}>
          <div>
            <strong>{ultraMode ? 'Ultra 模式' : 'Manual 模式'}</strong>
            <span className={`analysis-status ${activity.status}`}>{statusLabels[activity.status]} · {ultraMode ? `${modelName || 'Worker A 未配置'} + ${workerBModel || 'Worker B 未配置'}` : workerBActive ? workerBModel || 'Worker B 未配置' : modelName || 'Worker A 未配置'}</span>
          </div>
          <div className="analysis-header-actions">
            <button type="button" className={showHistory ? 'icon-button active' : 'icon-button'} title="页面识别历史" onClick={() => setShowHistory((visible) => !visible)}><History size={16} /><span>{sessions.length}</span></button>
            {!active && <button type="button" className="icon-button" title="关闭分析记录" onClick={onClose}><X size={16} /></button>}
          </div>
        </header>

        {ultraMode && <div className="worker-pipeline" aria-label="Ultra 并行识别流程">
          <div className="worker-pipeline-track">
            <span className={`pipeline-step ${workerAStepState}`}><i><ScanSearch size={16} /></i><span><small>并发识别</small><strong>Worker A</strong><em>{modelName || '未配置'}</em></span></span>
            <span className={`pipeline-step ${workerBStepState}`}><i><Bot size={16} /></i><span><small>并发识别</small><strong>Worker B</strong><em>{workerBModel || '未配置'}</em></span></span>
          </div>
        </div>}

        {!showHistory && <div className={`worker-progress-stage ${activity.status === 'error' ? 'failed' : ''}`}>
          {active ? <LoaderCircle className="spin" size={16} /> : activity.status === 'completed' ? <CircleCheck size={16} /> : <CircleAlert size={16} />}
          <span>{activity.phaseMessage || '等待模型返回'}</span>
        </div>}

        <div className="worker-progress-body">
          {showHistory && <section className={`analysis-session-history ${ultraMode ? 'ultra-history' : ''}`} aria-label="页面识别历史">
            <header className="history-panel-heading"><strong>页面识别历史</strong><span>按更新时间降序</span></header>
            {sortedSessions.length === 0 ? <p>暂无页面识别历史</p> : <>
              <div className="history-worker-columns">
                {(ultraMode ? (['worker_a', 'worker_b'] as const) : [historySession?.kind || 'worker_a']).map((kind) => <section key={kind} className="history-worker-column">
                  <header><strong>{kind === 'worker_a' ? 'Worker A' : 'Worker B'}</strong><span>{sortedSessions.filter((session) => session.kind === kind).length} 条</span></header>
                  <div>{sortedSessions.filter((session) => session.kind === kind).map((session) => <button type="button" key={session.id} className={`history-session-item ${session.id === selectedHistoryId ? 'selected' : ''}`} onClick={() => setSelectedHistoryId(session.id)}><i className={session.status} /><span><strong>{new Date(session.startedAt).toLocaleString('zh-CN')}</strong><small>{session.model || '未配置模型'} · {session.status === 'completed' ? '成功' : session.status === 'failed' ? '失败' : session.status === 'cancelled' ? '已中断' : '运行中'}</small></span>{acceptedSessionId === session.id && <Check className="history-accepted" size={15} aria-label="最终采用" />}</button>)}</div>
                </section>)}
              </div>
              {historySession && <article className="history-session-output"><header><strong>{historySession.kind === 'worker_a' ? 'Worker A' : 'Worker B'} 输出</strong>{acceptedSessionId === historySession.id && <span><Check size={13} />最终采用</span>}</header><div className="model-markdown-scroll"><ModelMarkdown content={historySession.outputContent || '没有可展示的模型输出'} label="页面识别历史模型输出" /></div></article>}
            </>}
          </section>}

          {!showHistory && ultraMode ? <div className="worker-progress-streams ultra-output-layout">
            <article className="worker-output-stream expanded">
              <div className="worker-stream-toggle"><strong>Worker A 输出</strong><span>{activity.workerAOutputContent ? '流式更新' : '等待输出'}</span></div>
              <div className="worker-stream-scroll"><div ref={workerAOutputStream.elementRef} className="model-markdown-scroll" onScroll={workerAOutputStream.trackScroll}><ModelMarkdown content={activity.workerAOutputContent || (workerAStatus === 'running' || workerAStatus === 'cancelling' ? '等待 Worker A 输出…' : '没有可展示的 Worker A 输出')} label="Worker A 输出流" /></div>{!workerAOutputStream.atBottom && <button type="button" className="stream-bottom-button" title="滚动到底部" aria-label="滚动到底部" onClick={workerAOutputStream.scrollToBottom}><ArrowDown size={14} /></button>}</div>
              <div className="worker-card-actions">
                {workerAStatus === 'running' || workerAStatus === 'cancelling' ? <button type="button" className="button danger-button" disabled={workerAStatus === 'cancelling' || workerControlBusy === 'worker-a'} onClick={() => onCancelWorker?.('worker_a')}><Square size={12} fill="currentColor" />{workerAStatus === 'cancelling' ? '中断中' : '中断'}</button> : workerAStatus === 'paused' && activity.workerAResumeSessionId ? <button type="button" className="button retry-button" disabled={workerControlBusy === 'worker-a'} onClick={() => onResumeWorker?.('worker_a')}><RefreshCw size={12} />从断点重试</button> : <button type="button" className="button retry-button" disabled={workerControlBusy === 'worker-a'} onClick={() => onRetryWorker?.('worker_a')}><RefreshCw size={12} />重新识别</button>}
              </div>
            </article>
            <article className="worker-output-stream expanded">
              <div className="worker-stream-toggle"><strong>Worker B 输出</strong><span>{activity.outputContent ? '流式更新' : '等待输出'}</span></div>
              <div className="worker-stream-scroll"><div ref={outputStream.elementRef} className="model-markdown-scroll" onScroll={outputStream.trackScroll}><ModelMarkdown content={activity.outputContent || (workerBStatus === 'running' || workerBStatus === 'cancelling' ? '等待 Worker B 输出…' : '没有可展示的 Worker B 输出')} label="Worker B 输出流" /></div>{!outputStream.atBottom && <button type="button" className="stream-bottom-button" title="滚动到底部" aria-label="滚动到底部" onClick={outputStream.scrollToBottom}><ArrowDown size={14} /></button>}</div>
              <div className="worker-card-actions">
                {workerBStatus === 'running' || workerBStatus === 'cancelling' ? <button type="button" className="button danger-button" disabled={workerBStatus === 'cancelling' || workerControlBusy === 'worker-b'} onClick={() => onCancelWorker?.('worker_b')}><Square size={12} fill="currentColor" />{workerBStatus === 'cancelling' ? '中断中' : '中断'}</button> : workerBStatus === 'paused' && activity.workerBResumeSessionId ? <button type="button" className="button retry-button" disabled={workerControlBusy === 'worker-b'} onClick={() => onResumeWorker?.('worker_b')}><RefreshCw size={12} />从断点重试</button> : <button type="button" className="button retry-button" disabled={workerControlBusy === 'worker-b'} onClick={() => onRetryWorker?.('worker_b')}><RefreshCw size={12} />重新识别</button>}
              </div>
            </article>
          </div> : !showHistory && <div className={`worker-progress-streams ${hasReasoning ? 'has-reasoning' : 'output-only'}`}>
            {hasReasoning && <article className={`worker-reasoning-stream ${reasoningExpanded ? 'expanded' : 'collapsed'}`}>
              <button type="button" className="worker-stream-toggle" aria-expanded={reasoningExpanded} onClick={() => setReasoningExpanded((expanded) => !expanded)}>
                {reasoningExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <strong>{ultraMode ? 'Worker B 思考' : '模型思考'}</strong>
                <span>{reasoningExpanded ? '点击收起' : '点击展开'}</span>
              </button>
              {reasoningExpanded && <div className="worker-stream-scroll">
                <div ref={reasoningStream.elementRef} className="model-markdown-scroll" onScroll={reasoningStream.trackScroll}><ModelMarkdown content={activity.reasoningContent} label="模型思考流" /></div>
                {!reasoningStream.atBottom && <button type="button" className="stream-bottom-button" title="滚动到底部" aria-label="滚动到底部" onClick={reasoningStream.scrollToBottom}><ArrowDown size={14} /></button>}
              </div>}
            </article>}
            <article className={`worker-output-stream ${outputExpanded ? 'expanded' : 'collapsed'}`}>
              <button type="button" className="worker-stream-toggle" aria-expanded={outputExpanded} onClick={() => setOutputExpanded((expanded) => !expanded)}>
                {outputExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <strong>{ultraMode ? 'Worker B 输出' : '模型输出'}</strong>
                <span>{outputExpanded ? '点击收起' : '点击展开'}</span>
              </button>
              {outputExpanded && <div className="worker-stream-scroll">
                <div ref={outputStream.elementRef} className="model-markdown-scroll" onScroll={outputStream.trackScroll}><ModelMarkdown content={activity.outputContent || (active ? '等待模型输出…' : '没有可展示的模型输出')} label="模型输出流" /></div>
                {!outputStream.atBottom && <button type="button" className="stream-bottom-button" title="滚动到底部" aria-label="滚动到底部" onClick={outputStream.scrollToBottom}><ArrowDown size={14} /></button>}
              </div>}
            </article>
          </div>}

          {activity.errorMessage && <div className="worker-progress-error"><CircleAlert size={15} /><span>{displayModelError(activity.errorMessage)}</span></div>}
        </div>
        <footer className="worker-progress-footer">
          <span>{activity.status === 'completed' ? '识别完成，可关闭窗口或重新识别' : activity.status === 'cancelled' ? '半截结果未写入草稿' : activity.status === 'paused' ? activity.resumeKind === 'worker_b' ? '已保存 Worker B 输出断点' : `已保留 ${activity.completedCandidates || 0} 个候选的断点` : workerBActive ? 'Worker A 结果已保留' : ''}</span>
          <div className="worker-progress-actions">
            {active ? <button type="button" className="button danger-button" disabled={activity.status === 'cancelling'} onClick={onCancel}><Square size={14} fill="currentColor" />{activity.status === 'cancelling' ? '正在中断' : ultraMode ? '中断双 Worker' : workerBActive ? '中断 Worker B' : '中断 Worker A'}</button> : <>
              {activity.status === 'paused' && <button type="button" className="button retry-button" onClick={onRetry}><RefreshCw size={14} />从断点重试</button>}
              {activity.phase === 'worker-b-error' && <button type="button" className="button retry-button" onClick={onRetry}><RefreshCw size={14} />重新识别</button>}
              {activity.status === 'completed' && <button type="button" className="button retry-button" onClick={onRetry}><RefreshCw size={14} />重新识别</button>}
              <button type="button" className="button" onClick={onClose}>关闭</button>
            </>}
          </div>
        </footer>
      </section>
    </div>
  );
}
