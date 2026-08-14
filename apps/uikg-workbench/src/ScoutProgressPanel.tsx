import { ArrowDown, Bot, ChevronDown, ChevronRight, CircleAlert, CircleCheck, LoaderCircle, RefreshCw, ScanSearch, Square, UserCheck, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface ScoutActivity {
  status: 'running' | 'cancelling' | 'completed' | 'cancelled' | 'paused' | 'error';
  phase: string;
  phaseMessage: string;
  reasoningContent: string;
  outputContent: string;
  errorMessage?: string;
  resumeSessionId?: string;
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
  const elementRef = useRef<HTMLPreElement>(null);
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

export function ScoutProgressPanel({ activity, modelName, reviewerModel, autoMode, onCancel, onRetry, onClose }: ScoutProgressPanelProps) {
  const active = activity.status === 'running' || activity.status === 'cancelling';
  const reviewing = activity.phase === 'review' || activity.phase === 'review-error';
  const reasoningStream = useStreamFollow(activity.reasoningContent);
  const outputStream = useStreamFollow(activity.outputContent);
  const hasReasoning = Boolean(activity.reasoningContent.trim());
  const hasOutput = Boolean(activity.outputContent.trim());
  const [reasoningExpanded, setReasoningExpanded] = useState(false);

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
          {!active && <button type="button" className="icon-button" title="关闭分析记录" onClick={onClose}><X size={16} /></button>}
        </header>

        {autoMode && <div className="auto-review-pipeline" aria-label="Auto 审核流程">
          <span className={!reviewing && activity.status === 'running' ? 'active' : activity.phase !== 'starting' && activity.phase !== 'model' && activity.phase !== 'resume' ? 'done' : ''}><ScanSearch size={14} /><small>Scout</small><strong>{modelName || '未配置'}</strong></span>
          <i />
          <span className={reviewing && activity.status === 'running' ? 'active' : activity.phase === 'complete' ? 'done' : ''}><Bot size={14} /><small>AI 初审</small><strong>{reviewerModel || '未配置'}</strong></span>
          <i />
          <span className={activity.phase === 'complete' ? 'active' : ''}><UserCheck size={14} /><small>人工确认</small><strong>必须完成</strong></span>
        </div>}

        <div className="scout-progress-stage">
          {active ? <LoaderCircle className="spin" size={16} /> : activity.status === 'completed' ? <CircleCheck size={16} /> : <CircleAlert size={16} />}
          <span>{activity.phaseMessage || '等待模型返回'}</span>
        </div>

        <div className={`scout-progress-streams ${hasReasoning ? 'has-reasoning' : 'output-only'} `}>
          {hasReasoning && <article className={`scout-reasoning-stream ${reasoningExpanded ? 'expanded' : 'collapsed'}`}>
            <button type="button" className="scout-reasoning-toggle" aria-expanded={reasoningExpanded} onClick={() => setReasoningExpanded((expanded) => !expanded)}>
              {reasoningExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <strong>模型思考</strong>
              <span>{active ? '实时' : '已完成'}</span>
            </button>
            {reasoningExpanded && <div className="scout-stream-scroll">
              <pre ref={reasoningStream.elementRef} aria-label="模型思考流" onScroll={reasoningStream.trackScroll}>{activity.reasoningContent}</pre>
              {!reasoningStream.atBottom && <button type="button" className="stream-bottom-button" title="滚动到底部" aria-label="滚动到底部" onClick={reasoningStream.scrollToBottom}><ArrowDown size={14} /></button>}
            </div>}
          </article>}
          <article>
            <div className="scout-stream-title"><strong>模型输出</strong><span>{activity.outputContent ? '实时' : '等待'}</span></div>
            <div className="scout-stream-scroll">
              <pre ref={outputStream.elementRef} aria-label="模型输出流" onScroll={outputStream.trackScroll}>{activity.outputContent || (active ? '等待模型输出…' : '没有可展示的模型输出')}</pre>
              {!outputStream.atBottom && <button type="button" className="stream-bottom-button" title="滚动到底部" aria-label="滚动到底部" onClick={outputStream.scrollToBottom}><ArrowDown size={14} /></button>}
            </div>
          </article>
        </div>

        {activity.errorMessage && <div className="scout-progress-error"><CircleAlert size={15} /><span>{activity.errorMessage}</span></div>}
        <footer className="scout-progress-footer">
          <span>{activity.status === 'completed' ? autoMode ? 'AI 初审结果已写入，元素仍处于待人工确认状态' : '结构化结果已写入草稿' : activity.status === 'cancelled' ? '半截结果未写入草稿' : activity.status === 'paused' ? `已保留 ${activity.completedCandidates || 0} 个候选的断点` : reviewing ? 'Scout 草稿已保留' : ''}</span>
          <div className="scout-progress-actions">
            {active ? reviewing ? <button type="button" className="button" disabled><LoaderCircle className="spin" size={14} />AI 初审中</button> : <button type="button" className="button danger-button" disabled={activity.status === 'cancelling'} onClick={onCancel}><Square size={14} />中断 Scout</button> : <>
              {activity.status === 'paused' && <button type="button" className="button retry-button" onClick={onRetry}><RefreshCw size={14} />从断点重试</button>}
              {activity.phase === 'review-error' && <button type="button" className="button retry-button" onClick={onRetry}><RefreshCw size={14} />重试 AI 初审</button>}
              <button type="button" className="button" onClick={onClose}>关闭</button>
            </>}
          </div>
        </footer>
      </section>
    </div>
  );
}
