import { Check, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RefObject } from 'react';
import type { CSSProperties, MouseEvent, PointerEvent } from 'react';
import type { BBox, WorkerElementMergeSelection, WorkerMergeSource, WorkerElementCandidate, WorkerResult } from './types';

interface WorkerComparisonPanelProps {
  imageUrl: string;
  workerAResult: WorkerResult;
  workerBResult: WorkerResult;
  applying: boolean;
  candidatePortalTarget: HTMLElement | null;
  onApply: (selections: WorkerElementMergeSelection[]) => void;
}

type DiffStatus = 'same' | 'changed' | 'worker-a-only' | 'worker-b-only';
type MergeField = 'label' | 'controlType' | 'visualDescription' | 'interactive' | 'enabled' | 'state' | 'approximateRegion' | 'geometryKind' | 'geometryConfidence' | 'meaning' | 'dynamicContent' | 'riskSignals' | 'confidence' | 'actions';
type CandidateView = WorkerElementCandidate & { actions?: Array<Record<string, unknown>> };

interface ComparisonRow {
  candidateKey: string;
  workerACandidateKey?: string;
  workerBCandidateKey?: string;
  workerA?: CandidateView;
  workerB?: CandidateView;
  status: DiffStatus;
  changedFields: MergeField[];
}

const mergeFields: Array<{ key: MergeField; label: string }> = [
  { key: 'label', label: '名称' },
  { key: 'controlType', label: '元素类型' },
  { key: 'visualDescription', label: '元素描述' },
  { key: 'interactive', label: '可交互' },
  { key: 'enabled', label: '启用状态' },
  { key: 'state', label: '当前状态' },
  { key: 'approximateRegion', label: '识别区域' },
  { key: 'geometryKind', label: '几何类型' },
  { key: 'geometryConfidence', label: '几何置信度' },
  { key: 'meaning', label: '元素含义' },
  { key: 'dynamicContent', label: '动态内容' },
  { key: 'riskSignals', label: '风险信号' },
  { key: 'confidence', label: '识别置信度' },
  { key: 'actions', label: '元素动作' },
];

const statusLabels: Record<DiffStatus, string> = {
  same: '一致',
  changed: '有差异',
  'worker-a-only': '仅 Model A',
  'worker-b-only': '仅 Model B',
};

function stableValue(value: unknown) {
  if (value === undefined || value === null || value === '') return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function workerCandidate(element: WorkerElementCandidate, result: WorkerResult): CandidateView {
  return {
    ...element,
    actions: (result.actionCandidates || []).filter((action) => action.triggerCandidateKey === element.candidateKey),
  };
}

function buildComparisonRows(workerAResult: WorkerResult, workerBResult: WorkerResult) {
  const workerAByKey = new Map((workerAResult.elements || []).map((element) => [element.candidateKey, workerCandidate(element, workerAResult)]));
  const workerBByKey = new Map((workerBResult.elements || []).map((element) => [element.candidateKey, workerCandidate(element, workerBResult)]));
  const usedWorkerBKeys = new Set<string>();
  const regionScore = (left?: CandidateView, right?: CandidateView) => {
    const a = validRegion(left);
    const b = validRegion(right);
    if (!a || !b) return -1;
    const overlapWidth = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
    const overlapHeight = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    const intersection = overlapWidth * overlapHeight;
    const union = a.width * a.height + b.width * b.height - intersection;
    const iou = union > 0 ? intersection / union : 0;
    const centerDistance = Math.hypot(a.x + a.width / 2 - b.x - b.width / 2, a.y + a.height / 2 - b.y - b.height / 2);
    return iou >= 0.2 ? iou + 1 : centerDistance <= 0.06 ? 0.5 - centerDistance : -1;
  };
  const rows = [...workerAByKey.entries()].map<ComparisonRow>(([workerACandidateKey, workerA]) => {
    let workerBCandidateKey = workerBByKey.has(workerACandidateKey) && !usedWorkerBKeys.has(workerACandidateKey) ? workerACandidateKey : undefined;
    if (!workerBCandidateKey) {
      const best = [...workerBByKey.entries()]
        .filter(([key]) => !usedWorkerBKeys.has(key) && !workerAByKey.has(key))
        .map(([key, workerB]) => ({ key, score: regionScore(workerA, workerB) }))
        .filter(({ score }) => score >= 0)
        .sort((left, right) => right.score - left.score)[0];
      workerBCandidateKey = best?.key;
    }
    if (workerBCandidateKey) usedWorkerBKeys.add(workerBCandidateKey);
    const workerB = workerBCandidateKey ? workerBByKey.get(workerBCandidateKey) : undefined;
    if (!workerB) return { candidateKey: workerACandidateKey, workerACandidateKey, workerA, status: 'worker-a-only', changedFields: [] };
    const changedFields = mergeFields.map(({ key }) => key).filter((field) => stableValue(workerA[field]) !== stableValue(workerB[field]));
    return { candidateKey: workerACandidateKey, workerACandidateKey, workerBCandidateKey, workerA, workerB, status: changedFields.length ? 'changed' : 'same', changedFields };
  });
  for (const [workerBCandidateKey, workerB] of workerBByKey) {
    if (!usedWorkerBKeys.has(workerBCandidateKey)) rows.push({ candidateKey: workerBCandidateKey, workerBCandidateKey, workerB, status: 'worker-b-only', changedFields: [] });
  }
  return rows;
}

function validRegion(candidate?: CandidateView) {
  const region = candidate?.approximateRegion;
  if (!region) return null;
  const values = [region.x, region.y, region.width, region.height].map(Number);
  return values.every(Number.isFinite) ? { x: values[0], y: values[1], width: values[2], height: values[3] } : null;
}

function ResultCanvas({ source, imageUrl, rows, selectedKey, includedKeys, scrollRef, onScroll, onSelect, onToggleIncluded, onSelectAll, onClearAll }: {
  source: WorkerMergeSource;
  imageUrl: string;
  rows: ComparisonRow[];
  selectedKey: string | null;
  includedKeys: Set<string>;
  scrollRef: RefObject<HTMLDivElement>;
  onScroll: () => void;
  onSelect: (candidateKey: string) => void;
  onToggleIncluded: (candidateKey: string, included: boolean) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
}) {
  const title = source === 'workerA' ? 'Model A' : 'Model B';
  const stageRef = useRef<HTMLDivElement>(null);
  const [selectionBox, setSelectionBox] = useState<BBox | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const pointInStage = (event: PointerEvent<HTMLDivElement>) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  };
  const startBoxSelection = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    const point = pointInStage(event);
    if (!point) return;
    dragStartRef.current = point;
    stageRef.current?.setPointerCapture(event.pointerId);
    setSelectionBox({ x: point.x, y: point.y, width: 0, height: 0 });
  };
  const moveBoxSelection = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return;
    const point = pointInStage(event);
    if (!point) return;
    const start = dragStartRef.current;
    setSelectionBox({ x: Math.min(start.x, point.x), y: Math.min(start.y, point.y), width: Math.abs(point.x - start.x), height: Math.abs(point.y - start.y) });
  };
  const finishBoxSelection = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return;
    const box = selectionBox;
    dragStartRef.current = null;
    setSelectionBox(null);
    if (!box || box.width < 0.01 || box.height < 0.01) return;
    rows.forEach((row) => {
      const candidate = row[source];
      const region = validRegion(candidate);
      if (!candidate || !region) return;
      const intersects = region.x < box.x + box.width && region.x + region.width > box.x && region.y < box.y + box.height && region.y + region.height > box.y;
      if (intersects) onToggleIncluded(candidate.candidateKey, true);
    });
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  const selectAtPoint = (event: MouseEvent<HTMLButtonElement>, fallbackKey: string) => {
    const point = pointInStage(event as unknown as PointerEvent<HTMLDivElement>);
    const hits = point ? rows
      .flatMap((row) => {
        const candidate = row[source];
        const region = validRegion(candidate);
        if (!candidate || !region || point.x < region.x || point.x > region.x + region.width || point.y < region.y || point.y > region.y + region.height) return [];
        return [{ key: candidate.candidateKey, area: region.width * region.height }];
      })
      .sort((left, right) => left.area - right.area) : [];
    const currentIndex = hits.findIndex(({ key }) => key === selectedKey);
    const nextKey = hits.length > 1 ? hits[(currentIndex + 1 + hits.length) % hits.length].key : hits[0]?.key || fallbackKey;
    onSelect(nextKey);
    onToggleIncluded(nextKey, !includedKeys.has(nextKey));
  };
  return (
    <article className={`comparison-canvas comparison-canvas-${source}`}>
      <header><span><strong>{title}</strong><small>{rows.filter((row) => row[source]).length} 个候选 · 已选 {includedKeys.size}</small></span><div className="comparison-canvas-actions"><button type="button" onClick={onSelectAll}>全选</button><button type="button" onClick={onClearAll}>取消全选</button></div></header>
      <div ref={scrollRef} className="comparison-canvas-scroll" onScroll={onScroll}>
        <div ref={stageRef} className="comparison-image-stage" onPointerDown={startBoxSelection} onPointerMove={moveBoxSelection} onPointerUp={finishBoxSelection} onPointerCancel={finishBoxSelection}>
          <img src={imageUrl} alt={`${title} 识别画面`} draggable={false} />
          {selectionBox && <span className="comparison-selection-rect" style={{ left: `${selectionBox.x * 100}%`, top: `${selectionBox.y * 100}%`, width: `${selectionBox.width * 100}%`, height: `${selectionBox.height * 100}%` }} />}
          {rows.map((row) => {
            const candidate = row[source];
            const region = validRegion(candidate);
            if (!candidate || !region) return null;
            const selected = candidate.candidateKey === selectedKey;
            const included = includedKeys.has(candidate.candidateKey);
            const layer = Math.max(1, Math.round((1 - Math.min(1, region.width * region.height)) * 900));
            return <button
              key={candidate.candidateKey}
              type="button"
              className={`comparison-bbox ${row.status} ${included ? 'included' : ''} ${selected ? 'selected' : ''}`}
              style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%`, '--candidate-layer': layer } as CSSProperties}
              title={`${String(candidate.label || candidate.candidateKey)} · ${statusLabels[row.status]}`}
              aria-label={`${title}：${String(candidate.label || candidate.candidateKey)}，${statusLabels[row.status]}`}
              onClick={(event) => selectAtPoint(event, candidate.candidateKey)}
            >
              {selected && <span className={`comparison-bbox-callout ${region.y > 0.7 ? 'above' : ''}`}>
                <strong>{String(candidate.label || candidate.candidateKey)}</strong>
                <small>{row.changedFields.length ? `${row.changedFields.length} 项差异` : statusLabels[row.status]}</small>
              </span>}
            </button>;
          })}
        </div>
      </div>
    </article>
  );
}

function CandidateGroup({ source, rows, selectedKey, includedKeys, onSelect, onToggleIncluded, onSelectAll, onClearAll }: {
  source: WorkerMergeSource;
  rows: ComparisonRow[];
  selectedKey: string | null;
  includedKeys: Set<string>;
  onSelect: (candidateKey: string) => void;
  onToggleIncluded: (candidateKey: string, included: boolean) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
}) {
  const title = source === 'workerA' ? 'Model A' : 'Model B';
  const candidates = rows.flatMap((row) => row[source] ? [{ row, candidate: row[source] }] : []);
  return <section className={`comparison-candidate-group comparison-candidate-group-${source}`}>
    <header>
      <span><strong>{title}</strong><small>{includedKeys.size} / {candidates.length} 已选</small></span>
      <div className="comparison-list-actions"><button type="button" onClick={onSelectAll}>全选</button><button type="button" onClick={onClearAll}>取消全选</button></div>
    </header>
    <div className="comparison-candidate-items">
      {candidates.map(({ row, candidate }) => {
        const key = candidate.candidateKey;
        const included = includedKeys.has(key);
        return <article key={key} className={`comparison-element-option ${included ? 'selected' : ''} ${selectedKey === key ? 'focused' : ''}`}>
          <input type="checkbox" checked={included} aria-label={`选择 ${title} 的 ${String(candidate.label || key)}`} onChange={(event) => onToggleIncluded(key, event.target.checked)} />
          <button type="button" onClick={() => onSelect(key)}><strong>{String(candidate.label || key)}</strong><small>{statusLabels[row.status]}{row.changedFields.length ? ` · ${row.changedFields.length} 项差异` : ''}</small></button>
        </article>;
      })}
    </div>
  </section>;
}

export function WorkerComparisonPanel({ imageUrl, workerAResult, workerBResult, applying, candidatePortalTarget, onApply }: WorkerComparisonPanelProps) {
  const rows = useMemo(() => buildComparisonRows(workerAResult, workerBResult), [workerAResult, workerBResult]);
  const [selectedKeys, setSelectedKeys] = useState<Record<WorkerMergeSource, string | null>>({ workerA: null, workerB: null });
  const [includedKeys, setIncludedKeys] = useState<Record<WorkerMergeSource, Set<string>>>({ workerA: new Set(), workerB: new Set() });
  const workerAScrollRef = useRef<HTMLDivElement>(null);
  const workerBScrollRef = useRef<HTMLDivElement>(null);
  const syncingScrollRef = useRef(false);
  const statusCounts = useMemo(() => rows.reduce<Record<DiffStatus, number>>((counts, row) => {
    counts[row.status] += 1;
    return counts;
  }, { same: 0, changed: 0, 'worker-a-only': 0, 'worker-b-only': 0 }), [rows]);
  const workerCounts = {
    workerA: rows.filter((row) => row.workerA).length,
    workerB: rows.filter((row) => row.workerB).length,
  };
  const totalIncluded = includedKeys.workerA.size + includedKeys.workerB.size;

  useEffect(() => {
    setSelectedKeys({ workerA: null, workerB: null });
    setIncludedKeys({ workerA: new Set(), workerB: new Set() });
  }, [workerAResult, workerBResult]);

  const toggleIncluded = (source: WorkerMergeSource, candidateKey: string, included: boolean) => {
    setIncludedKeys((current) => {
      const next = new Set(current[source]);
      if (included) next.add(candidateKey); else next.delete(candidateKey);
      return { ...current, [source]: next };
    });
  };
  const selectCandidate = (source: WorkerMergeSource, candidateKey: string) => setSelectedKeys((current) => ({ ...current, [source]: candidateKey }));
  const candidateKeys = (source: WorkerMergeSource) => rows.flatMap((row) => row[source]?.candidateKey ? [row[source].candidateKey] : []);
  const selectAll = (source: WorkerMergeSource) => setIncludedKeys((current) => ({ ...current, [source]: new Set(candidateKeys(source)) }));
  const clearAll = (source: WorkerMergeSource) => setIncludedKeys((current) => ({ ...current, [source]: new Set() }));
  const syncScroll = (source: 'workerA' | 'workerB') => {
    if (syncingScrollRef.current) return;
    const origin = source === 'workerA' ? workerAScrollRef.current : workerBScrollRef.current;
    const target = source === 'workerA' ? workerBScrollRef.current : workerAScrollRef.current;
    if (!origin || !target) return;
    const originRange = origin.scrollHeight - origin.clientHeight;
    const targetRange = target.scrollHeight - target.clientHeight;
    syncingScrollRef.current = true;
    target.scrollTop = originRange > 0 ? origin.scrollTop / originRange * targetRange : 0;
    requestAnimationFrame(() => { syncingScrollRef.current = false; });
  };

  const applySelection = () => {
    const selections: WorkerElementMergeSelection[] = [
      ...[...includedKeys.workerA].map((candidateKey) => ({ candidateKey: `workerA:${candidateKey}`, workerACandidateKey: candidateKey, baseSource: 'workerA' as const, fieldSources: {} })),
      ...[...includedKeys.workerB].map((candidateKey) => ({ candidateKey: `workerB:${candidateKey}`, workerBCandidateKey: candidateKey, baseSource: 'workerB' as const, fieldSources: {} })),
    ];
    onApply(selections);
  };

  return (
    <section className="worker-comparison" aria-label="双模型 识别结果">
      <header>
        <span><strong>双模型 识别画面</strong><small>A {workerCounts.workerA} · B {workerCounts.workerB}</small></span>
      </header>

      <div className="comparison-diff-summary" aria-label="差异汇总">
        <span className="same">一致 {statusCounts.same}</span>
        <span className="changed">变更 {statusCounts.changed}</span>
        <span className="worker-a-only">仅 Model A {statusCounts['worker-a-only']}</span>
        <span className="worker-b-only">仅 Model B {statusCounts['worker-b-only']}</span>
      </div>

      <div className="comparison-visual-results">
        <ResultCanvas source="workerA" imageUrl={imageUrl} rows={rows} selectedKey={selectedKeys.workerA} includedKeys={includedKeys.workerA} scrollRef={workerAScrollRef} onScroll={() => syncScroll('workerA')} onSelect={(key) => selectCandidate('workerA', key)} onToggleIncluded={(key, included) => toggleIncluded('workerA', key, included)} onSelectAll={() => selectAll('workerA')} onClearAll={() => clearAll('workerA')} />
        <ResultCanvas source="workerB" imageUrl={imageUrl} rows={rows} selectedKey={selectedKeys.workerB} includedKeys={includedKeys.workerB} scrollRef={workerBScrollRef} onScroll={() => syncScroll('workerB')} onSelect={(key) => selectCandidate('workerB', key)} onToggleIncluded={(key, included) => toggleIncluded('workerB', key, included)} onSelectAll={() => selectAll('workerB')} onClearAll={() => clearAll('workerB')} />
      </div>

      {candidatePortalTarget && createPortal(
        <section className="comparison-element-list" aria-label="候选元素选择">
          <header><span><strong>模型候选</strong><small>已选 {totalIncluded}</small></span><button type="button" className="button comparison-apply" disabled={applying || totalIncluded === 0} onClick={applySelection}>{applying ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}合并 {totalIncluded}</button></header>
          <div className="comparison-candidate-groups">
            <CandidateGroup source="workerA" rows={rows} selectedKey={selectedKeys.workerA} includedKeys={includedKeys.workerA} onSelect={(key) => selectCandidate('workerA', key)} onToggleIncluded={(key, included) => toggleIncluded('workerA', key, included)} onSelectAll={() => selectAll('workerA')} onClearAll={() => clearAll('workerA')} />
            <CandidateGroup source="workerB" rows={rows} selectedKey={selectedKeys.workerB} includedKeys={includedKeys.workerB} onSelect={(key) => selectCandidate('workerB', key)} onToggleIncluded={(key, included) => toggleIncluded('workerB', key, included)} onSelectAll={() => selectAll('workerB')} onClearAll={() => clearAll('workerB')} />
          </div>
        </section>,
        candidatePortalTarget,
      )}
    </section>
  );
}
