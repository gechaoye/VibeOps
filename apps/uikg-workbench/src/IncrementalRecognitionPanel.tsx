import { Check, ChevronRight, CircleAlert, Layers3, MousePointer2, ScanSearch, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { RecognitionElementCandidate } from './types';

export type IncrementalCandidateKind = 'duplicate' | 'common' | 'new' | 'manual';

export interface IncrementalCandidate {
  id: string;
  key: string;
  label: string;
  kind: IncrementalCandidateKind;
  confidence?: number;
  existingLabel?: string;
  candidate?: RecognitionElementCandidate;
}

interface IncrementalRecognitionPanelProps {
  frameUrl: string;
  frameId: string;
  candidates: IncrementalCandidate[];
  onClose: () => void;
  onConfirm: () => void;
  onOpenCanvas: () => void;
  onRemoveManual: (id: string) => void;
  confirming?: boolean;
}

const labels: Record<IncrementalCandidateKind, string> = {
  duplicate: '重复元素',
  common: '已有元素共相',
  new: '待新增元素',
  manual: '手动画框',
};

const colors: Record<IncrementalCandidateKind, string> = {
  duplicate: 'muted',
  common: 'common',
  new: 'new',
  manual: 'manual',
};

export function IncrementalRecognitionPanel({ frameUrl, frameId, candidates, onClose, onConfirm, onOpenCanvas, onRemoveManual, confirming = false }: IncrementalRecognitionPanelProps) {
  const [tab, setTab] = useState<'summary' | 'compare' | 'output'>('summary');
  const counts = useMemo(() => candidates.reduce((result, candidate) => ({ ...result, [candidate.kind]: (result[candidate.kind] || 0) + 1 }), {} as Record<IncrementalCandidateKind, number>), [candidates]);
  const additions = (counts.new || 0) + (counts.manual || 0);

  return <div className="incremental-backdrop">
    <section className="incremental-panel" role="dialog" aria-modal="true" aria-labelledby="incremental-title">
      <header className="incremental-header">
        <div><div className="incremental-kicker"><ScanSearch size={14} />增量识别</div><h2 id="incremental-title">只把新内容并入「新观测帧」</h2><p>已保留原页面元素。模型结果和手动画框都会先进入候选审核，确认后才写入页面。</p></div>
        <button type="button" className="icon-button" title="关闭" aria-label="关闭" onClick={onClose}><X size={17} /></button>
      </header>
      <div className="incremental-stepper" aria-label="增量识别步骤">
        {['添加观测帧', '识别与对比', '确认并入'].map((step, index) => <div key={step} className={`incremental-step ${index < 2 || tab !== 'summary' ? 'done' : 'active'}`}><span>{index < 2 ? <Check size={13} /> : index + 1}</span><strong>{step}</strong>{index < 2 && <ChevronRight size={14} />}</div>)}
      </div>
      <nav className="incremental-tabs" aria-label="增量识别视图">
        <button type="button" className={tab === 'summary' ? 'active' : ''} onClick={() => setTab('summary')}><Layers3 size={15} />结果摘要</button>
        <button type="button" className={tab === 'compare' ? 'active' : ''} onClick={() => setTab('compare')}><MousePointer2 size={15} />候选对比<span>{candidates.length}</span></button>
        <button type="button" className={tab === 'output' ? 'active' : ''} onClick={() => setTab('output')}><ScanSearch size={15} />结构化输出</button>
      </nav>
      <div className="incremental-body">
        {tab === 'summary' && <>
          <div className="incremental-summary-grid">
            {(Object.keys(labels) as IncrementalCandidateKind[]).map((kind) => <article key={kind} className={`incremental-summary-card ${colors[kind]}`}><span>{labels[kind]}</span><strong>{counts[kind] || 0}</strong><small>{kind === 'new' || kind === 'manual' ? '确认后才并入页面' : '不会重复写入'}</small></article>)}
          </div>
          <div className="incremental-summary-note"><CircleAlert size={16} /><span>识别到 {candidates.length} 个候选，其中 {additions} 个可能新增。重复元素和已有共相会被保留在本次记录中，但不会再次创建。</span></div>
          <div className="incremental-frame-preview"><img src={frameUrl} alt="新观测帧" /><div><strong>新观测帧</strong><span>可回到画布继续手动画框，框选内容会出现在“手动画框”中。</span><button type="button" className="button" onClick={onOpenCanvas}><MousePointer2 size={14} />回到画布框选</button></div></div>
        </>}
        {tab === 'compare' && <div className="incremental-candidate-list">{candidates.length === 0 ? <div className="incremental-empty">模型尚未返回候选，仍可回到画布手动添加。</div> : candidates.map((candidate) => <article key={candidate.id} className={`incremental-candidate ${colors[candidate.kind]}`}><div className="incremental-candidate-marker" /><div className="incremental-candidate-main"><strong>{candidate.label || candidate.key}</strong><code>{candidate.key}</code>{candidate.existingLabel && <small>匹配：{candidate.existingLabel}</small>}</div><span className="incremental-candidate-kind">{labels[candidate.kind]}</span>{candidate.kind === 'manual' && <button type="button" className="icon-button" title="移除手动画框" aria-label="移除手动画框" onClick={() => onRemoveManual(candidate.id)}><X size={14} /></button>}</article>)}</div>}
        {tab === 'output' && <div className="incremental-output"><div><strong>提交策略</strong><span>按候选键去重；按共相模板复用；仅提交“待新增元素”和“手动画框”。</span></div><pre>{JSON.stringify({ frameId, candidates: candidates.map((candidate) => ({ candidateKey: candidate.key, label: candidate.label, disposition: candidate.kind, confidence: candidate.confidence ?? null })) }, null, 2)}</pre></div>}
      </div>
      <footer className="incremental-footer"><span>{additions > 0 ? `确认后将新增 ${additions} 项` : '当前没有待新增项'}</span><div><button type="button" className="button" onClick={onClose}>稍后处理</button><button type="button" className="button button-primary" disabled={confirming || additions === 0} onClick={onConfirm}>{confirming ? '正在并入…' : `仅并入新增 ${additions} 项`}</button></div></footer>
    </section>
  </div>;
}
