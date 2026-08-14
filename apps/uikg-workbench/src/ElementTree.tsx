import { CheckCircle2, CircleHelp, Container, EyeOff, PenLine } from 'lucide-react';
import { elementTypeLabel, reviewStatusLabels } from './model';
import type { DraftElement } from './types';

interface ElementTreeProps {
  elements: DraftElement[];
  selectedId: string | null;
  multiSelect: boolean;
  checkedIds: Set<string>;
  onSelect: (id: string) => void;
  onCheck: (id: string, checked: boolean) => void;
}

function StatusIcon({ status }: { status: DraftElement['reviewStatus'] }) {
  if (status === 'accepted') return <CheckCircle2 size={14} />;
  if (status === 'edited') return <PenLine size={14} />;
  if (status === 'rejected') return <EyeOff size={14} />;
  return <CircleHelp size={14} />;
}

export function ElementTree({ elements, selectedId, multiSelect, checkedIds, onSelect, onCheck }: ElementTreeProps) {
  const byParent = new Map<string | null, DraftElement[]>();
  for (const element of elements) {
    const siblings = byParent.get(element.parentId) || [];
    siblings.push(element);
    byParent.set(element.parentId, siblings);
  }

  const renderLevel = (parentId: string | null, depth: number, path: Set<string>): React.ReactNode =>
    (byParent.get(parentId) || []).map((element) => {
      if (path.has(element.id)) return null;
      const nextPath = new Set(path).add(element.id);
      return (
        <div key={element.id}>
          <div
            className={`tree-row ${selectedId === element.id ? 'tree-row-selected' : ''} ${element.reviewStatus === 'rejected' ? 'tree-row-rejected' : ''}`}
            style={{ paddingLeft: `${12 + depth * 18}px` }}
          >
            {multiSelect && <input className="tree-checkbox" type="checkbox" checked={checkedIds.has(element.id)} aria-label={`选择 ${element.label}`} onChange={(event) => onCheck(element.id, event.target.checked)} />}
            <button type="button" className="tree-row-content" onClick={() => onSelect(element.id)}>
            <Container size={14} className="tree-control-icon" />
            <span className="tree-row-main">
              <span className="tree-row-label">{element.label}</span>
              <span className="tree-row-meta">{elementTypeLabel(element.controlType)}{element.aiReview && <i className={`tree-ai-review tree-ai-review-${element.aiReview.status}`} title={`AI 初审：${element.aiReview.summary}`} />}</span>
            </span>
            <span className={`tree-status tree-status-${element.reviewStatus}`} title={reviewStatusLabels[element.reviewStatus]}>
              <StatusIcon status={element.reviewStatus} />
            </span>
            </button>
          </div>
          {renderLevel(element.id, depth + 1, nextPath)}
        </div>
      );
    });

  const orphaned = elements.filter((element) => element.parentId && !elements.some((candidate) => candidate.id === element.parentId));
  return (
    <div className="element-tree">
      {elements.length === 0 ? <div className="empty-state">当前页面暂无元素</div> : renderLevel(null, 0, new Set())}
      {orphaned.length > 0 && (
        <div className="tree-orphans">
          <div className="tree-section-label">关系异常</div>
          {orphaned.map((element) => (
            <button key={element.id} type="button" className="tree-row" onClick={() => onSelect(element.id)}>{element.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
