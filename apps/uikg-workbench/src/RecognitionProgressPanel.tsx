import { ArrowDown, Check, CircleAlert, History, LoaderCircle, RefreshCw, ScanSearch, Square, X } from 'lucide-react';
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
  errorMessage?: string;
  errorDetails?: string[];
  startedAt?: string;
  completedAt?: string;
  retryAttempt?: number;
  retryLimit?: number;
  retryReason?: string;
  resumeSessionId?: string;
  resumeKind?: 'manual';
  completedCandidates?: number;
}

interface RecognitionProgressPanelProps {
  activity: RecognitionActivity;
  gatewayName: string | null;
  modelName: string | null;
  reasoningEffort: string | null;
  onCancel: () => void;
  onRetry: () => void;
  onClose: () => void;
  sessions: AnalysisSession[];
  acceptedSessionId?: string | null;
}

function useStreamFollow(content: string, enabled: boolean) {
  const elementRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const followFrameRef = useRef<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const followLatest = useCallback(() => {
    const element = elementRef.current;
    if (!element || !followingRef.current) return;
    element.scrollTop = element.scrollHeight;
    setAtBottom(true);
  }, []);
  const scheduleFollow = useCallback(() => {
    if (!enabled || !followingRef.current || followFrameRef.current !== null) return;
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = null;
      followLatest();
    });
  }, [enabled, followLatest]);
  useLayoutEffect(() => {
    if (!enabled || !followingRef.current) return;
    // Follow during layout so a content-growth scroll event cannot disable
    // following before the deferred animation frame gets a chance to run.
    followLatest();
  }, [content, enabled, followLatest]);
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return undefined;
    const contentElement = element.firstElementChild;
    if (!contentElement) return undefined;
    const observer = new ResizeObserver(scheduleFollow);
    observer.observe(contentElement);
    return () => observer.disconnect();
  }, [scheduleFollow]);
  useEffect(() => () => {
    if (followFrameRef.current !== null) cancelAnimationFrame(followFrameRef.current);
  }, []);
  const trackScroll = () => {
    const element = elementRef.current;
    if (!element) return;
    followingRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
    setAtBottom(followingRef.current);
  };
  const scrollToBottom = () => { followingRef.current = true; followLatest(); };
  return { elementRef, atBottom, trackScroll, scrollToBottom };
}

function useThrottledStreamContent(content: string, active: boolean, interval = 80) {
  const latestRef = useRef(content);
  const timerRef = useRef<number | null>(null);
  const [displayedContent, setDisplayedContent] = useState(content);
  latestRef.current = content;

  useEffect(() => {
    if (!active) {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      setDisplayedContent(content);
      return undefined;
    }
    if (timerRef.current !== null) return undefined;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setDisplayedContent(latestRef.current);
    }, interval);
    return undefined;
  }, [active, content, interval]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);
  return displayedContent;
}

function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function StreamContent({ content, active, label }: { content: string; active: boolean; label: string }) {
  if (!active) return <ModelMarkdown content={content} label={label} />;
  return <pre className="model-stream-text" aria-label={label}>{content}</pre>;
}

function formatHistoryErrorMessage(errorMessage: unknown) {
  const message = typeof errorMessage === 'string' ? errorMessage : '';
  return /输出(?:结果)?未通过结构检查/.test(message) ? '输出结果未通过结构检查' : message;
}

function formatHistorySchemaError(error: unknown) {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  const item = error as { instancePath?: unknown; keyword?: unknown; params?: unknown; message?: unknown };
  const instancePath = typeof item.instancePath === 'string' && item.instancePath ? item.instancePath : '根对象';
  const params = item.params && typeof item.params === 'object' && !Array.isArray(item.params) ? item.params as Record<string, unknown> : {};
  if (item.keyword === 'required' && typeof params.missingProperty === 'string') return `${instancePath}：缺少必填属性「${params.missingProperty}」`;
  if (item.keyword === 'additionalProperties' && typeof params.additionalProperty === 'string') return `${instancePath}：包含未允许的属性「${params.additionalProperty}」`;
  return typeof item.message === 'string' && item.message ? `${instancePath}：${item.message}` : null;
}

function historyErrorDetails(session: AnalysisSession | null) {
  if (!session || session.status !== 'failed') return [];
  const message = formatHistoryErrorMessage(session.errorMessage);
  const schemaDetails = (session.schemaErrors || []).map((item) => {
    const detail = formatHistorySchemaError(item);
    return detail;
  });
  const consistencyDetails = (session.consistencyIssues || []).map((item) => typeof item === 'string' && item.trim() ? `一致性检查：${item.trim()}` : null);
  const normalizationDetails = (session.normalizationIssues || []).map((item) => typeof item === 'string' && item.trim() ? `归一化检查：${item.trim()}` : null);
  const details = [...new Set([...schemaDetails, ...consistencyDetails, ...normalizationDetails].filter((item): item is string => Boolean(item)))];
  return details.length > 0 || message !== '输出结果未通过结构检查'
    ? details
    : ['Schema 校验未通过（未返回具体校验项）'];
}

export function RecognitionProgressPanel({ activity, gatewayName, modelName, reasoningEffort, onCancel, onRetry, onClose, sessions, acceptedSessionId = null }: RecognitionProgressPanelProps) {
  const active = activity.status === 'running' || activity.status === 'cancelling';
  const [now, setNow] = useState(Date.now());
  const [showHistory, setShowHistory] = useState(activity.phase === 'history');
  const [historySessionId, setHistorySessionId] = useState<string | null>(activity.phase === 'history' ? sessions[0]?.id || null : null);
  const [windowPosition, setWindowPosition] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const displayedReasoningContent = useThrottledStreamContent(activity.reasoningContent, active && !showHistory);
  const displayedOutputContent = useThrottledStreamContent(activity.outputContent, active && !showHistory);
  const outputStream = useStreamFollow(displayedOutputContent, !showHistory);
  const reasoningStream = useStreamFollow(displayedReasoningContent, !showHistory);
  const sortedSessions = useMemo(() => [...sessions].sort((a, b) => String(b.updatedAt || b.startedAt).localeCompare(String(a.updatedAt || a.startedAt))), [sessions]);
  const historySession = sortedSessions.find((session) => session.id === historySessionId) || null;
  const selectedHistoryErrorMessage = historySession ? formatHistoryErrorMessage(historySession.errorMessage) : activity.errorMessage || '';
  const selectedHistoryErrorDetails = historySession ? historyErrorDetails(historySession) : activity.errorDetails || [];

  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  const startedAt = activity.startedAt ? Date.parse(activity.startedAt) : now;
  const endedAt = activity.completedAt ? Date.parse(activity.completedAt) : now;
  const duration = formatDuration(endedAt - startedAt);
  const onHeaderPointerDown = (event: PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    dragRef.current = { x: event.clientX, y: event.clientY, originX: windowPosition.x, originY: windowPosition.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onHeaderPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (!dragRef.current) return;
    setWindowPosition({ x: dragRef.current.originX + event.clientX - dragRef.current.x, y: dragRef.current.originY + event.clientY - dragRef.current.y });
  };

  return <div className="recognition-progress-backdrop">
    <section className="recognition-progress-panel" role="dialog" aria-modal="true" aria-label="页面识别" style={{ transform: `translate(calc(-50% + ${windowPosition.x}px), calc(-50% + ${windowPosition.y}px))` }}>
      <header className="recognition-progress-header" onPointerDown={onHeaderPointerDown} onPointerMove={onHeaderPointerMove} onPointerUp={() => { dragRef.current = null; }}>
        <div><ScanSearch size={18} /><span><strong>Manual 模式 · {gatewayName || '未配置网关'}：{modelName || '模型未配置'} · {reasoningEffort || '未配置'} · {duration}</strong></span></div>
        <div><button type="button" className={`icon-button ${showHistory ? 'active' : ''}`} title="识别历史" onClick={() => setShowHistory((value) => !value)}><History size={15} /></button><button type="button" className="icon-button" title="关闭" disabled={active} onClick={onClose}><X size={16} /></button></div>
      </header>

      {!showHistory && <div className={`recognition-progress-stage ${activity.status === 'error' ? 'failed' : ''}`}>
        {active ? <LoaderCircle className="spin" size={17} /> : activity.status === 'completed' ? <Check size={17} /> : <CircleAlert size={17} />}
        <span>{activity.phaseMessage}{activity.phase === 'retry' && activity.retryAttempt ? `（${activity.retryAttempt}/${activity.retryLimit || '?'}）` : ''}</span>
      </div>}

      <div className="recognition-progress-body">
        {showHistory ? <section className="analysis-session-history" aria-label="页面识别历史">
          <div className="history-session-list">{sortedSessions.map((session) => <button type="button" key={session.id} className={`history-session-item ${historySessionId === session.id ? 'selected' : ''}`} onClick={() => setHistorySessionId(session.id)}><i className={session.status} /><span><strong>{session.model || '模型未知'}</strong><small>{new Date(session.startedAt).toLocaleString('zh-CN')}</small></span>{acceptedSessionId === session.id && <Check className="history-accepted" size={14} />}</button>)}</div>
          {historySession && <div className="history-session-outputs">
            {selectedHistoryErrorMessage && <div className="recognition-progress-error"><CircleAlert size={15} /><div className="recognition-progress-error-content"><strong>{selectedHistoryErrorMessage}</strong>{selectedHistoryErrorDetails.map((detail) => <span key={detail}>{detail}</span>)}</div></div>}
            <article className="history-session-output"><header><strong>模型输出</strong></header><div className="model-markdown-scroll"><ModelMarkdown content={historySession.outputContent || '暂无输出'} label="历史模型输出" /></div></article>
          </div>}
        </section> : <div className="recognition-progress-streams">
          <article><header className="recognition-stream-toggle"><strong>模型思考</strong></header><div className="recognition-stream-scroll"><div ref={reasoningStream.elementRef} className="model-markdown-scroll" onScroll={reasoningStream.trackScroll}><StreamContent content={displayedReasoningContent || (active ? '正在分析页面...' : '暂无思考内容')} active={active} label="模型思考" /></div>{!reasoningStream.atBottom && <button type="button" className="stream-bottom-button" title="滚动到底部" onClick={reasoningStream.scrollToBottom}><ArrowDown size={14} /></button>}</div></article>
          <article><header className="recognition-stream-toggle"><strong>模型输出</strong></header><div className="recognition-stream-scroll"><div ref={outputStream.elementRef} className="model-markdown-scroll" onScroll={outputStream.trackScroll}><StreamContent content={displayedOutputContent || (active ? '等待模型输出...' : '暂无输出')} active={active} label="模型输出" /></div>{!outputStream.atBottom && <button type="button" className="stream-bottom-button" title="滚动到底部" onClick={outputStream.scrollToBottom}><ArrowDown size={14} /></button>}</div></article>
        </div>}
      </div>

      {!showHistory && activity.errorMessage && <div className="recognition-progress-error"><CircleAlert size={15} /><div className="recognition-progress-error-content"><strong>{activity.errorMessage}</strong>{activity.errorDetails?.map((detail) => <span key={detail}>{detail}</span>)}</div></div>}
      <footer className="recognition-progress-footer"><span>{activity.status === 'paused' ? `已保留 ${activity.completedCandidates || 0} 个候选的断点` : activity.status === 'cancelled' ? '未完成结果没有写入草稿' : ''}</span><div className="recognition-progress-actions">{active ? <button type="button" className="button danger-button" disabled={activity.status === 'cancelling'} onClick={onCancel}><Square size={13} fill="currentColor" />{activity.status === 'cancelling' ? '正在中断' : '中断识别'}</button> : <>{['paused', 'error', 'completed'].includes(activity.status) && <button type="button" className="button retry-button" onClick={onRetry}><RefreshCw size={14} />{activity.status === 'paused' ? '从断点继续' : '重新识别'}</button>}<button type="button" className={`button ${activity.status === 'completed' ? 'button-primary' : ''}`} onClick={onClose}>确定</button></>}</div></footer>
    </section>
  </div>;
}
