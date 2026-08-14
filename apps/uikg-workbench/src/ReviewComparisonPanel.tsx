import { Check, LoaderCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { elementTypeLabel } from './model';
import type { DraftElement, ReviewerResult } from './types';

interface ReviewComparisonPanelProps {
  scoutElements: DraftElement[];
  reviewerResult: ReviewerResult;
  applying: boolean;
  onApply: (selectedScoutKeys: string[], selectedReviewerKeys: string[]) => void;
}

function CandidateRow({ candidateKey, label, description, controlType, checked, onChange }: {
  candidateKey: string;
  label: string;
  description: string;
  controlType: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="comparison-candidate">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        <strong>{label || candidateKey}</strong>
        <small>{elementTypeLabel(controlType || 'other')} · {description || candidateKey}</small>
      </span>
    </label>
  );
}

export function ReviewComparisonPanel({ scoutElements, reviewerResult, applying, onApply }: ReviewComparisonPanelProps) {
  const reviewerElements = reviewerResult.elements || [];
  const [selectedScout, setSelectedScout] = useState(() => new Set(scoutElements.map((element) => element.candidateKey)));
  const [selectedReviewer, setSelectedReviewer] = useState(() => new Set<string>());
  const total = selectedScout.size + selectedReviewer.size;
  const duplicateKeys = useMemo(() => new Set(reviewerElements.filter((candidate) => scoutElements.some((scout) => scout.candidateKey === candidate.candidateKey)).map((candidate) => candidate.candidateKey)), [reviewerElements, scoutElements]);

  const toggle = (source: 'scout' | 'reviewer', key: string, checked: boolean) => {
    const setter = source === 'scout' ? setSelectedScout : setSelectedReviewer;
    setter((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
    if (checked && duplicateKeys.has(key)) {
      (source === 'scout' ? setSelectedReviewer : setSelectedScout)((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  return (
    <section className="review-comparison" aria-label="双模型识别结果">
      <header>
        <span><strong>选择识别结果</strong><small>两侧可混合勾选，同名候选只能选择一个来源</small></span>
        <button type="button" className="button comparison-apply" disabled={applying || total === 0} onClick={() => onApply([...selectedScout], [...selectedReviewer])}>
          {applying ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}应用 {total} 个元素
        </button>
      </header>
      <div className="comparison-columns">
        <article>
          <div className="comparison-title"><span><strong>Scout 识别</strong><small>{scoutElements.length} 个候选</small></span><button type="button" onClick={() => setSelectedScout(new Set(scoutElements.map((element) => element.candidateKey)))}>全选</button></div>
          <div className="comparison-list">
            {scoutElements.map((element) => <CandidateRow key={element.candidateKey} candidateKey={element.candidateKey} label={element.label} description={element.visualDescription} controlType={element.controlType} checked={selectedScout.has(element.candidateKey)} onChange={(checked) => toggle('scout', element.candidateKey, checked)} />)}
          </div>
        </article>
        <article>
          <div className="comparison-title"><span><strong>Reviewer 重识别</strong><small>{reviewerElements.length} 个候选</small></span><button type="button" onClick={() => setSelectedReviewer(new Set(reviewerElements.map((element) => element.candidateKey)))}>全选</button></div>
          <div className="comparison-list">
            {reviewerElements.map((element) => <CandidateRow key={element.candidateKey} candidateKey={element.candidateKey} label={String(element.label || '')} description={String(element.visualDescription || '')} controlType={String(element.controlType || '')} checked={selectedReviewer.has(element.candidateKey)} onChange={(checked) => toggle('reviewer', element.candidateKey, checked)} />)}
          </div>
        </article>
      </div>
    </section>
  );
}
