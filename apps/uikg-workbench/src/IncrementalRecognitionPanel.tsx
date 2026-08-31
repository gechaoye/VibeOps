import { Check, ChevronRight, CircleAlert, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BBox, RecognitionElementCandidate } from './types';

export type IncrementalCandidateKind = 'duplicate' | 'common' | 'new';

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
  onDiscard: () => void;
  onConfirm: () => void;
  confirming?: boolean;
}

const labels: Record<IncrementalCandidateKind, string> = {
  duplicate: '重复元素',
  common: '已有元素共相',
  new: '待新增元素',
};

const colors: Record<IncrementalCandidateKind, string> = {
  duplicate: 'muted',
  common: 'common',
  new: 'new',
};

function candidateRegion(candidate: IncrementalCandidate) {
  const region = candidate.candidate?.approximateRegion;
  if (!region) return null;
  const values = [region.x, region.y, region.width, region.height];
  if (!values.every((value) => Number.isFinite(value)) || region.width <= 0 || region.height <= 0 || region.x < 0 || region.y < 0) return null;
  const x = Math.min(region.x, 1);
  const y = Math.min(region.y, 1);
  return { x, y, width: Math.min(region.width, 1 - x), height: Math.min(region.height, 1 - y) };
}

export function IncrementalRecognitionPanel({ frameUrl, frameId, candidates, onClose, onDiscard, onConfirm, confirming = false }: IncrementalRecognitionPanelProps) {
  const [imageRatio, setImageRatio] = useState<number | null>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const previewStageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const stage = previewStageRef.current;
    if (!stage) return undefined;
    const update = () => {
      setStageSize({ width: Math.max(0, stage.clientWidth), height: Math.max(0, stage.clientHeight) });
    };
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    update();
    return () => observer.disconnect();
  }, []);
  const fittedPreview = useMemo(() => {
    if (!imageRatio || stageSize.width <= 0 || stageSize.height <= 0) return null;
    const width = Math.min(stageSize.width, stageSize.height * imageRatio);
    return { width, height: width / imageRatio };
  }, [imageRatio, stageSize]);
  const visibleCandidates = candidates;
  const counts = useMemo(() => visibleCandidates.reduce((result, candidate) => ({ ...result, [candidate.kind]: (result[candidate.kind] || 0) + 1 }), {} as Record<IncrementalCandidateKind, number>), [visibleCandidates]);
  const additions = counts.new || 0;
  const annotatedCandidates = visibleCandidates.map((candidate, index) => ({ candidate, region: candidateRegion(candidate), index })).filter((item): item is { candidate: IncrementalCandidate; region: BBox; index: number } => Boolean(item.region) && item.candidate.kind === 'new');

  return <div className="incremental-backdrop">
    <section className="incremental-panel" role="dialog" aria-modal="true" aria-labelledby="incremental-title">
      <header className="incremental-header">
        <div><h2 id="incremental-title">增量识别</h2><p>已保留原页面元素。模型结果会先进入候选审核，确认后才写入页面。</p></div>
        <button type="button" className="icon-button" title="关闭" aria-label="关闭" onClick={onClose}><X size={17} /></button>
      </header>
      <div className="incremental-stepper" aria-label="增量识别步骤">
        {['添加观测帧', '识别与对比', '确认并入'].map((step, index) => <div key={step} className={`incremental-step ${index < 2 ? 'done' : 'active'}`}><span>{index < 2 ? <Check size={13} /> : index + 1}</span><strong>{step}</strong>{index < 2 && <ChevronRight size={14} />}</div>)}
      </div>
      <div className="incremental-summary-grid" aria-label="识别结果摘要">
        {(['duplicate', 'common', 'new'] as IncrementalCandidateKind[]).map((kind) => <article key={kind} className={`incremental-summary-card ${colors[kind]}`}><span>{labels[kind]}</span><strong>{counts[kind] || 0}</strong><small>{kind === 'new' ? '确认后才并入页面' : '不会重复写入'}</small></article>)}
      </div>
      <div className="incremental-summary-note"><CircleAlert size={16} /><span>识别到 {visibleCandidates.length} 个候选，其中 {additions} 个可能新增。重复元素和已有共相会被保留在本次记录中，但不会再次创建。</span></div>
      <div className="incremental-body">
        <section className="incremental-column incremental-preview-column" aria-label="观测帧预览"><header><strong>观测帧预览</strong><span>新增候选已标注</span></header><div ref={previewStageRef} className="incremental-preview-stage"><div className="incremental-preview-image" style={fittedPreview ? { width: fittedPreview.width, height: fittedPreview.height } : undefined}><img src={frameUrl} alt="新观测帧" onLoad={(event) => { const image = event.currentTarget; if (image.naturalWidth && image.naturalHeight) setImageRatio(image.naturalWidth / image.naturalHeight); }} />{annotatedCandidates.map(({ candidate, region, index }) => <span key={candidate.id} className={`incremental-preview-box ${colors[candidate.kind]}`} style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }} title={`${index + 1}. ${candidate.label || candidate.key}`}><b>{index + 1}</b></span>)}</div></div><div className="incremental-preview-legend"><span className="new">待新增</span></div></section>
        <section className="incremental-column incremental-list-column" aria-label="候选列表"><header><strong>候选列表</strong><span>{visibleCandidates.length} 项</span></header><div className="incremental-candidate-list">{visibleCandidates.length === 0 ? <div className="incremental-empty">模型尚未返回候选。</div> : visibleCandidates.map((candidate, index) => <article key={candidate.id} className={`incremental-candidate ${colors[candidate.kind]}`}><div className="incremental-candidate-marker"><span>{index + 1}</span></div><div className="incremental-candidate-main"><strong>{candidate.label || candidate.key}</strong><code>{candidate.key}</code>{candidate.existingLabel && <small>匹配：{candidate.existingLabel}</small>}</div><span className="incremental-candidate-kind">{labels[candidate.kind]}</span></article>)}</div></section>
        <section className="incremental-column incremental-output-column" aria-label="结构化输出"><header><strong>结构化输出</strong><span>识别结果</span></header><div className="incremental-output-body"><div><strong>提交策略</strong><span>按候选键去重；按共相模板复用；仅提交“待新增元素”。</span></div><pre>{JSON.stringify({ frameId, candidates: visibleCandidates.map((candidate) => ({ candidateKey: candidate.key, label: candidate.label, disposition: candidate.kind, confidence: candidate.confidence ?? null })) }, null, 2)}</pre></div></section>
      </div>
      <footer className="incremental-footer"><span>{additions > 0 ? `确认后将新增 ${additions} 项` : '当前没有待新增项'}</span><div><button type="button" className="button" disabled={confirming} onClick={onDiscard}>放弃结果</button><button type="button" className="button button-primary" disabled={confirming || additions === 0} onClick={onConfirm}>{confirming ? '正在合并…' : '合并结果'}</button></div></footer>
    </section>
  </div>;
}
