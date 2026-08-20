import { ArrowDown, Bot, Check, ChevronDown, ChevronRight, CircleAlert, CircleCheck, History, LoaderCircle, RefreshCw, ScanSearch, Square, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { ModelMarkdown } from './ModelMarkdown';
import type { AnalysisSession } from './types';

export interface RecognitionActivity {
  status: 'running' | 'cancelling' | 'completed' | 'cancelled' | 'paused' | 'error';
  phase: string;
  phaseMessage: string;
  reasoningContent: string;
  outputContent: string;
  modelAReasoningContent?: string;
  modelAOutputContent?: string;
  errorMessage?: string;
  resumeSessionId?: string;
  resumeKind?: 'manual' | 'ultra_a' | 'ultra_b';
  completedCandidates?: number;
  modelAStatus?: RecognitionActivity['status'];
  modelBStatus?: RecognitionActivity['status'];
  modelAResumeSessionId?: string;
  modelBResumeSessionId?: string;
}

interface RecognitionProgressPanelProps {
  activity: RecognitionActivity;
  modelName: string | null;
  modelBModel: string | null;
  ultraMode: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onCancelModel?: (kind: 'ultra_a' | 'ultra_b') => void;
  onRetryModel?: (kind: 'ultra_a' | 'ultra_b') => void;
  onResumeModel?: (kind: 'ultra_a' | 'ultra_b') => void;
  recognitionControlBusy?: 'ultra-a' | 'ultra-b' | null;
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
    return 'Model B 模型响应超时（524）：上游服务在代理时限内没有开始返回内容，请重新识别';
  }
  return message;
}

export function RecognitionProgressPanel({ activity, modelName, modelBModel, ultraMode, onCancel, onRetry, onCancelModel, onRetryModel, onResumeModel, recognitionControlBusy = null, onClose, sessions, acceptedSessionId = null }: RecognitionProgressPanelProps) {
  const active = activity.status === 'running' || activity.status === 'cancelling';
  const modelBActive = activity.phase.startsWith('ultra_b');
  const modelAStatus = activity.modelAStatus || (ultraMode ? (active ? 'running' : activity.status) : activity.status);
  const modelBStatus = activity.modelBStatus || (ultraMode ? (active ? 'running' : activity.status) : activity.status);
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
  const modelAOutputStream = useStreamFollow(activity.modelAOutputContent || '', ultraMode && !showHistory);
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
  const modelBStage = modelBActive || historySession?.kind === 'ultra_b';
  const modelAStepDone = modelBStage || activity.phase === 'compare' || activity.phase === 'complete' || historySession?.kind === 'ultra_a' && historySession.status === 'completed';
  const modelBStepDone = activity.phase === 'compare' || activity.phase === 'complete' || historySession?.kind === 'ultra_b' && historySession.status === 'completed';
  const modelAStepState = ultraMode ? modelAStatus === 'completed' ? 'done' : modelAStatus === 'running' || modelAStatus === 'cancelling' ? 'active' : modelAStatus === 'error' ? 'failed' : modelAStatus === 'paused' || modelAStatus === 'cancelled' ? 'paused' : '' : modelAStepDone ? 'done' : !modelBStage && activity.status === 'error' ? 'failed' : !modelBStage && (activity.status === 'cancelled' || activity.status === 'paused') ? 'paused' : !modelBStage && active ? 'active' : '';
  const modelBStepState = ultraMode ? modelBStatus === 'completed' ? 'done' : modelBStatus === 'running' || modelBStatus === 'cancelling' ? 'active' : modelBStatus === 'error' ? 'failed' : modelBStatus === 'paused' || modelBStatus === 'cancelled' ? 'paused' : '' : modelBStepDone ? 'done' : activity.phase === 'ultra-b-error' || historySession?.kind === 'ultra_b' && historySession.status === 'failed' ? 'failed' : activity.phase === 'ultra-b-cancelled' || activity.phase === 'ultra-b-paused' || historySession?.kind === 'ultra_b' && historySession.status === 'cancelled' ? 'paused' : modelBStage && active ? 'active' : '';

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
    <div className="recognition-progress-backdrop" role="presentation">
      <section className="recognition-progress-panel" role="dialog" aria-modal="true" aria-label={ultraMode ? 'Ultra 模式' : 'Manual 模式'} style={{ transform: `translate(calc(-50% + ${windowPosition.x}px), calc(-50% + ${windowPosition.y}px))` }}>
        <header className="recognition-progress-header" onPointerDown={startDragging} onPointerMove={dragWindow} onPointerUp={stopDragging} onPointerCancel={stopDragging}>
          <div>
            <strong>{ultraMode ? 'Ultra 模式' : 'Manual 模式'}</strong>
            <span className={`analysis-status ${activity.status}`}>{statusLabels[activity.status]} · {ultraMode ? `${modelName || 'Model A 未配置'} + ${modelBModel || 'Model B 未配置'}` : modelName || '页面识别模型未配置'}</span>
          </div>
          <div className="analysis-header-actions">
            <button type="button" className={showHistory ? 'icon-button active' : 'icon-button'} title="页面识别历史" onClick={() => setShowHistory((visible) => !visible)}><History size={16} /><span>{sessions.length}</span></button>
            {!active && <button type="button" className="icon-button" title="关闭分析记录" onClick={onClose}><X size={16} /></button>}
          </div>
        </header>

        {ultraMode && <div className="recognition-pipeline" aria-label="Ultra 并行识别流程">
          <div className="recognition-pipeline-track">
            <span className={`pipeline-step ${modelAStepState}`}><i><ScanSearch size={16} /></i><span><small>并发识别</small><strong>Model A</strong><em>{modelName || '未配置'}</em></span></span>
            <span className={`pipeline-step ${modelBStepState}`}><i><Bot size={16} /></i><span><small>并发识别</small><strong>Model B</strong><em>{modelBModel || '未配置'}</em></span></span>
          </div>
        </div>}

        {!showHistory && <div className={`recognition-progress-stage ${activity.status === 'error' ? 'failed' : ''}`}>
          {active ? <LoaderCircle className="spin" size={16} /> : activity.status === 'completed' ? <CircleCheck size={16} /> : <CircleAlert size={16} />}
          <span>{activity.phaseMessage || '等待模型返回'}</span>
        </div>}

        <div className="recognition-progress-body">
          {showHistory && <section className={`analysis-session-history ${ultraMode ? 'ultra-history' : ''}`} aria-label="页面识别历史">
            <header className="history-panel-heading"><strong>页面识别历史</strong><span>按更新时间降序</span></header>
            {sortedSessions.length === 0 ? <p>暂无页面识别历史</p> : <>
              <div className="history-model-columns">
                {(ultraMode ? (['ultra_a', 'ultra_b'] as const) : (['manual'] as const)).map((kind) => <section key={kind} className="history-model-column">
                  <header><strong>{kind === 'manual' ? 'Manual 页面识别' : kind === 'ultra_a' ? 'Model A' : 'Model B'}</strong><span>{sortedSessions.filter((session) => session.kind === kind).length} 条</span></header>
                  <div>{sortedSessions.filter((session) => session.kind === kind).map((session) => <button type="button" key={session.id} className={`history-session-item ${session.id === selectedHistoryId ? 'selected' : ''}`} onClick={() => setSelectedHistoryId(session.id)}><i className={session.status} /><span><strong>{new Date(session.startedAt).toLocaleString('zh-CN')}</strong><small>{session.model || '未配置模型'} · {session.status === 'completed' ? '成功' : session.status === 'failed' ? '失败' : session.status === 'cancelled' ? '已中断' : '运行中'}</small></span>{acceptedSessionId === session.id && <Check className="history-accepted" size={15} aria-label="最终采用" />}</button>)}</div>
                </section>)}
              </div>
              {historySession && <article className="history-session-output"><header><strong>{historySession.kind === 'manual' ? 'Manual 页面识别' : historySession.kind === 'ultra_a' ? 'Model A' : 'Model B'} 输出</strong>{acceptedSessionId === historySession.id && <span><Check size={13} />最终采用</span>}</header><div className="model-markdown-scroll"><ModelMarkdown content={historySession.outputContent || '没有可展示的模型输出'} label="页面识别历史模型输出" /></div></article>}
            </>}
          </section>}

          {!showHistory && ultraMode ? <div className="recognition-progress-streams ultra-output-layout">
            <article className="recognition-output-stream expanded">
              <div className="recognition-stream-toggle"><strong>Model A 输出</strong><span>{activity.modelAOutputContent ? '流式更新' : '等待输出'}</span></div>
              <div className="recognition-stream-scroll"><div ref={modelAOutputStream.elementRef} className="model-markdown-scroll" onScroll={modelAOutputStream.trackScroll}><ModelMarkdown content={activity.modelAOutputContent || (modelAStatus === 'running' || modelAStatus === 'cancelling' ? '等待 Model A 输出…' : '没有可展示的 Model A 输出')} label="Model A 输出流" /></div>{!modelAOutputStream.atBottom && <button type="button" className="stream-bottom-button" title="滚动到底部" aria-label="滚动到底部" onClick={modelAOutputStream.scrollToBottom}><ArrowDown size={14} /></button>}</div>
              <div className="recognition-card-actions">
                {modelAStatus === 'running' || modelAStatus === 'cancelling' ? <button type="button" className="button danger-button" disabled={modelAStatus === 'cancelling' || recognitionControlBusy === 'ultra-a'} onClick={() => onCancelModel?.('ultra_a')}><Square size={12} fill="currentColor" />{modelAStatus === 'cancelling' ? '中断中' : '中断'}</button> : modelAStatus === 'paused' && activity.modelAResumeSessionId ? <button type="button" className="button retry-button" disabled={recognitionControlBusy === 'ultra-a'} onClick={() => onResumeModel?.('ultra_a')}><RefreshCw size={12} />从断点重试</button> : <button type="button" className="button retry-button" disabled={recognitionControlBusy === 'ultra-a'} onClick={() => onRetryModel?.('ultra_a')}><RefreshCw size={12} />重新识别</button>}
              </div>
            </article>
            <article className="recognition-output-stream expanded">
              <div className="recognition-stream-toggle"><strong>Model B 输出</strong><span>{activity.outputContent ? '流式更新' : '等待输出'}</span></div>
              <div className="recognition-stream-scroll"><div ref={outputStream.elementRef} className="model-markdown-scroll" onScroll={outputStream.trackScroll}><ModelMarkdown content={activity.outputContent || (modelBStatus === 'running' || modelBStatus === 'cancelling' ? '等待 Model B 输出…' : '没有可展示的 Model B 输出')} label="Model B 输出流" /></div>{!outputStream.atBottom && <button type="button" className="stream-bottom-button" title="滚动到底部" aria-label="滚动到底部" onClick={outputStream.scrollToBottom}><ArrowDown size={14} /></button>}</div>
              <div className="recognition-card-actions">
                {modelBStatus === 'running' || modelBStatus === 'cancelling' ? <button type="button" className="button danger-button" disabled={modelBStatus === 'cancelling' || recognitionControlBusy === 'ultra-b'} onClick={() => onCancelModel?.('ultra_b')}><Square size={12} fill="currentColor" />{modelBStatus === 'cancelling' ? '中断中' : '中断'}</button> : modelBStatus === 'paused' && activity.modelBResumeSessionId ? <button type="button" className="button retry-button" disabled={recognitionControlBusy === 'ultra-b'} onClick={() => onResumeModel?.('ultra_b')}><RefreshCw size={12} />从断点重试</button> : <button type="button" className="button retry-button" disabled={recognitionControlBusy === 'ultra-b'} onClick={() => onRetryModel?.('ultra_b')}><RefreshCw size={12} />重新识别</button>}
              </div>
            </article>
          </div> : !showHistory && <div className={`recognition-progress-streams ${hasReasoning ? 'has-reasoning' : 'output-only'}`}>
            {hasReasoning && <article className={`recognition-reasoning-stream ${reasoningExpanded ? 'expanded' : 'collapsed'}`}>
              <button type="button" className="recognition-stream-toggle" aria-expanded={reasoningExpanded} onClick={() => setReasoningExpanded((expanded) => !expanded)}>
                {reasoningExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <strong>{ultraMode ? 'Model B 思考' : '模型思考'}</strong>
                <span>{reasoningExpanded ? '点击收起' : '点击展开'}</span>
              </button>
              {reasoningExpanded && <div className="recognition-stream-scroll">
                <div ref={reasoningStream.elementRef} className="model-markdown-scroll" onScroll={reasoningStream.trackScroll}><ModelMarkdown content={activity.reasoningContent} label="模型思考流" /></div>
                {!reasoningStream.atBottom && <button type="button" className="stream-bottom-button" title="滚动到底部" aria-label="滚动到底部" onClick={reasoningStream.scrollToBottom}><ArrowDown size={14} /></button>}
              </div>}
            </article>}
            <article className={`recognition-output-stream ${outputExpanded ? 'expanded' : 'collapsed'}`}>
              <button type="button" className="recognition-stream-toggle" aria-expanded={outputExpanded} onClick={() => setOutputExpanded((expanded) => !expanded)}>
                {outputExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <strong>{ultraMode ? 'Model B 输出' : '模型输出'}</strong>
                <span>{outputExpanded ? '点击收起' : '点击展开'}</span>
              </button>
              {outputExpanded && <div className="recognition-stream-scroll">
                <div ref={outputStream.elementRef} className="model-markdown-scroll" onScroll={outputStream.trackScroll}><ModelMarkdown content={activity.outputContent || (active ? '等待模型输出…' : '没有可展示的模型输出')} label="模型输出流" /></div>
                {!outputStream.atBottom && <button type="button" className="stream-bottom-button" title="滚动到底部" aria-label="滚动到底部" onClick={outputStream.scrollToBottom}><ArrowDown size={14} /></button>}
              </div>}
            </article>
          </div>}

          {activity.errorMessage && <div className="recognition-progress-error"><CircleAlert size={15} /><span>{displayModelError(activity.errorMessage)}</span></div>}
        </div>
        <footer className="recognition-progress-footer">
          <span>{activity.status === 'completed' ? '识别完成，可确认结果或重新识别' : activity.status === 'cancelled' ? '半截结果未写入草稿' : activity.status === 'paused' ? activity.resumeKind === 'ultra_b' ? '已保存 Model B 输出断点' : `已保留 ${activity.completedCandidates || 0} 个候选的断点` : modelBActive ? 'Model A 结果已保留' : ''}</span>
          <div className="recognition-progress-actions">
            {active ? <button type="button" className="button danger-button" disabled={activity.status === 'cancelling'} onClick={onCancel}><Square size={14} fill="currentColor" />{activity.status === 'cancelling' ? '正在中断' : ultraMode ? '中断双模型' : '中断页面识别'}</button> : <>
              {activity.status === 'paused' && <button type="button" className="button retry-button" onClick={onRetry}><RefreshCw size={14} />从断点重试</button>}
              {activity.status === 'error' && <button type="button" className="button button-primary retry-button" autoFocus onClick={onRetry}><RefreshCw size={14} />重新识别</button>}
              {activity.status === 'completed' && <button type="button" className="button retry-button" onClick={onRetry}><RefreshCw size={14} />重新识别</button>}
              <button type="button" className={`button ${activity.status === 'completed' ? 'button-primary' : ''}`} autoFocus={activity.status === 'completed'} onClick={onClose}>{activity.status === 'completed' ? '确定' : '关闭'}</button>
            </>}
          </div>
        </footer>
      </section>
    </div>
  );
}
