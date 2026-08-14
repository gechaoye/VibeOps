import { ArrowDown, Bot, ChevronDown, ChevronRight, CircleAlert, CircleCheck, History, LoaderCircle, RefreshCw, ScanSearch, Square, UserCheck, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ReviewComparisonPanel } from './ReviewComparisonPanel';
import type { AnalysisSession, DraftElement, ReviewerResult } from './types';

export interface ScoutActivity {
  status: 'running' | 'cancelling' | 'completed' | 'cancelled' | 'paused' | 'error';
  phase: string;
  phaseMessage: string;
  reasoningContent: string;
  outputContent: string;
  scoutReasoningContent?: string;
  scoutOutputContent?: string;
  errorMessage?: string;
  resumeSessionId?: string;
  resumeKind?: 'scout' | 'review';
  completedCandidates?: number;
}

interface ScoutProgressPanelProps {
  activity: ScoutActivity;
  modelName: string | null;
  reviewerModel: string | null;
  autoMode: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onClose: () => void;
  sessions: AnalysisSession[];
  comparison?: {
    scoutElements: DraftElement[];
    reviewerResult: ReviewerResult;
  } | null;
  applyingComparison?: boolean;
  onApplyComparison?: (selectedScoutKeys: string[], selectedReviewerKeys: string[]) => void;
}

const statusLabels = {
  running: '分析中',
  cancelling: '正在中断',
  completed: '已完成',
  cancelled: '已中断',
  paused: '等待续写',
  error: '分析失败',
} as const;

function useStreamFollow(content: string) {
  const elementRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (element && followingRef.current) {
      element.scrollTop = element.scrollHeight;
      setAtBottom(true);
    }
  }, [content]);

  const trackScroll = () => {
    const element = elementRef.current;
    if (!element) return;
    const nextAtBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 20;
    followingRef.current = nextAtBottom;
    setAtBottom(nextAtBottom);
  };

  const scrollToBottom = () => {
    const element = elementRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    followingRef.current = true;
    setAtBottom(true);
  };

  return { elementRef, trackScroll, scrollToBottom, atBottom };
}

function markdownSource(content: string) {
  const value = content || '';
  const trimmed = value.trimStart();
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && !value.includes('```')) {
    return `\`\`\`json\n${value}\n\`\`\``;
  }
  return value;
}

function MarkdownStream({ content, label }: { content: string; label: string }) {
  return <div className="model-markdown" aria-label={label}><ReactMarkdown remarkPlugins={[remarkGfm]}>{markdownSource(content)}</ReactMarkdown></div>;
}

function displayModelError(message?: string) {
  if (!message) return '';
  if (message.includes('524 status code') || message.includes('Error 524')) {
    return 'Reviewer 模型响应超时（524）：上游服务在代理时限内没有开始返回内容，请重新识别';
  }
  return message;
}

export function ScoutProgressPanel({ activity, modelName, reviewerModel, autoMode, onCancel, onRetry, onClose, sessions, comparison, applyingComparison = false, onApplyComparison }: ScoutProgressPanelProps) {
  const active = activity.status === 'running' || activity.status === 'cancelling';
  const reviewing = activity.phase.startsWith('review');
  const reasoningStream = useStreamFollow(activity.reasoningContent);
  const outputStream = useStreamFollow(activity.outputContent);
  const hasReasoning = Boolean(activity.reasoningContent.trim());
  const hasOutput = Boolean(activity.outputContent.trim());
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  const [showHistory, setShowHistory] = useState(activity.phase === 'history');
  const [priorScoutExpanded, setPriorScoutExpanded] = useState(false);
  const scoutStepDone = reviewing || activity.phase === 'review-compare' || activity.phase === 'complete';
  const reviewerStepDone = activity.phase === 'review-compare' || activity.phase === 'complete';
  const reviewerStepError = activity.phase === 'review-error' || activity.phase === 'review-cancelled' || activity.phase === 'review-paused';

  useEffect(() => {
    if (hasReasoning && !hasOutput) setReasoningExpanded(true);
    if (hasOutput) setReasoningExpanded(false);
  }, [hasReasoning, hasOutput]);

  return (
    <div className="scout-progress-backdrop" role="presentation">
      <section className="scout-progress-panel" role="dialog" aria-modal="true" aria-label={autoMode ? 'Auto 双模型分析' : 'Scout 实时分析'}>
        <header className="scout-progress-header">
          <div>
            <strong>{autoMode ? 'Auto 双模型分析' : 'Scout 实时分析'}</strong>
            <span>{statusLabels[activity.status]} · {reviewing ? reviewerModel || 'Reviewer 未配置' : modelName || 'Scout 未配置'}</span>
          </div>
          <div className="analysis-header-actions">
            <button type="button" className={showHistory ? 'icon-button active' : 'icon-button'} title="会话历史" onClick={() => setShowHistory((visible) => !visible)}><History size={16} /><span>{sessions.length}</span></button>
            {!active && <button type="button" className="icon-button" title="关闭分析记录" onClick={onClose}><X size={16} /></button>}
          </div>
        </header>

        {autoMode && <div className="auto-review-pipeline" aria-label="Auto 审核流程">
          <div className="auto-review-pipeline-track">
            <span className={`pipeline-step ${scoutStepDone ? 'done' : !reviewing && active ? 'active' : ''}`}><i><ScanSearch size={16} /></i><span><small>第一步</small><strong>Scout 识别</strong><em>{modelName || '未配置'}</em></span></span>
            <span className={`pipeline-connector ${scoutStepDone ? 'done' : ''}`} aria-hidden="true" />
            <span className={`pipeline-step ${reviewerStepDone ? 'done' : reviewing && active ? 'active' : reviewerStepError ? 'paused' : ''}`}><i><Bot size={16} /></i><span><small>第二步</small><strong>Reviewer 重识别</strong><em>{reviewerModel || '未配置'}</em></span></span>
            <span className={`pipeline-connector ${reviewerStepDone ? 'done' : ''}`} aria-hidden="true" />
            <span className={`pipeline-step ${activity.phase === 'complete' ? 'done' : activity.phase === 'review-compare' ? 'active' : ''}`}><i><UserCheck size={16} /></i><span><small>第三步</small><strong>人工确认</strong><em>合并并审核</em></span></span>
          </div>
        </div>}

        <div className="scout-progress-stage">
          {active ? <LoaderCircle className="spin" size={16} /> : activity.status === 'completed' ? <CircleCheck size={16} /> : <CircleAlert size={16} />}
          <span>{activity.phaseMessage || '等待模型返回'}</span>
        </div>

        {showHistory && <section className="analysis-session-history" aria-label="模型会话历史">
          {sessions.length === 0 ? <p>暂无模型会话</p> : sessions.map((session) => (
            <article key={session.id}>
              <i className={session.status} />
              <span><strong>{session.kind === 'scout' ? 'Scout 识别' : 'Reviewer 重识别'}</strong><small>{new Date(session.startedAt).toLocaleString('zh-CN')} · {session.model || '未配置模型'}</small></span>
              <em>{session.status === 'completed' ? '成功' : session.status === 'failed' ? '失败' : session.status === 'cancelled' ? '已中断' : '运行中'}</em>
              {session.errorMessage && <p>{displayModelError(session.errorMessage)}</p>}
            </article>
          ))}
        </section>}

        {reviewing && (activity.scoutReasoningContent || activity.scoutOutputContent) && <details className="prior-scout-stream" open={priorScoutExpanded} onToggle={(event) => setPriorScoutExpanded(event.currentTarget.open)}>
          <summary>Scout 识别过程 <span>{priorScoutExpanded ? '点击收起' : '点击展开'}</span></summary>
          {activity.scoutReasoningContent && <MarkdownStream content={activity.scoutReasoningContent} label="Scout 思考内容" />}
          {activity.scoutOutputContent && <MarkdownStream content={activity.scoutOutputContent} label="Scout 输出内容" />}
        </details>}

        {!showHistory && <div className={`scout-progress-streams ${hasReasoning ? 'has-reasoning' : 'output-only'} `}>
          {hasReasoning && <article className={`scout-reasoning-stream ${reasoningExpanded ? 'expanded' : 'collapsed'}`}>
            <button type="button" className="scout-reasoning-toggle" aria-expanded={reasoningExpanded} onClick={() => setReasoningExpanded((expanded) => !expanded)}>
              {reasoningExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <strong>模型思考</strong>
              <span>{active ? '实时' : '已完成'}</span>
            </button>
            {reasoningExpanded && <div className="scout-stream-scroll">
              <div ref={reasoningStream.elementRef} className="model-markdown-scroll" onScroll={reasoningStream.trackScroll}><MarkdownStream content={activity.reasoningContent} label="模型思考流" /></div>
              {!reasoningStream.atBottom && <button type="button" className="stream-bottom-button" title="滚动到底部" aria-label="滚动到底部" onClick={reasoningStream.scrollToBottom}><ArrowDown size={14} /></button>}
            </div>}
          </article>}
          <article>
            <div className="scout-stream-title"><strong>模型输出</strong><span>{activity.outputContent ? '实时' : '等待'}</span></div>
            <div className="scout-stream-scroll">
              <div ref={outputStream.elementRef} className="model-markdown-scroll" onScroll={outputStream.trackScroll}><MarkdownStream content={activity.outputContent || (active ? '等待模型输出…' : '没有可展示的模型输出')} label="模型输出流" /></div>
              {!outputStream.atBottom && <button type="button" className="stream-bottom-button" title="滚动到底部" aria-label="滚动到底部" onClick={outputStream.scrollToBottom}><ArrowDown size={14} /></button>}
            </div>
          </article>
        </div>}

        {comparison && onApplyComparison && <ReviewComparisonPanel scoutElements={comparison.scoutElements} reviewerResult={comparison.reviewerResult} applying={applyingComparison} onApply={onApplyComparison} />}

        {activity.errorMessage && <div className="scout-progress-error"><CircleAlert size={15} /><span>{displayModelError(activity.errorMessage)}</span></div>}
        <footer className="scout-progress-footer">
          <span>{activity.status === 'completed' ? comparison ? '请选择两份结果中需要保留的元素' : autoMode ? '合并结果仍需人工确认' : '结构化结果已写入草稿' : activity.status === 'cancelled' ? '半截结果未写入草稿' : activity.status === 'paused' ? activity.resumeKind === 'review' ? '已保存 Reviewer 输出断点' : `已保留 ${activity.completedCandidates || 0} 个候选的断点` : reviewing ? 'Scout 结果已保留' : ''}</span>
          <div className="scout-progress-actions">
            {active ? <button type="button" className="button danger-button" disabled={activity.status === 'cancelling'} onClick={onCancel}><Square size={14} fill="currentColor" />{activity.status === 'cancelling' ? '正在中断' : reviewing ? '中断 Reviewer' : '中断 Scout'}</button> : <>
              {activity.status === 'paused' && <button type="button" className="button retry-button" onClick={onRetry}><RefreshCw size={14} />从断点重试</button>}
              {activity.phase === 'review-error' && <button type="button" className="button retry-button" onClick={onRetry}><RefreshCw size={14} />重新识别</button>}
              <button type="button" className="button" onClick={onClose}>关闭</button>
            </>}
          </div>
        </footer>
      </section>
    </div>
  );
}
