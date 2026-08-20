import { Check, CheckCheck, CheckCircle2, CircleAlert, CircleHelp, Combine, Container, EyeOff, PenLine, Trash2, X } from 'lucide-react';
import { elementTypeLabel, reviewStatusLabels } from './model';
import type { DraftElement } from './types';

interface ElementTreeProps {
  elements: DraftElement[];
  filterCandidateKey: string | null;
  selectedId: string | null;
  multiSelect: boolean;
  checkedIds: Set<string>;
  allChecked: boolean;
  allCheckedAccepted: boolean;
  onToggleAll: () => void;
  onCreateContainer: () => void;
  onToggleAccept: () => void;
  onDeleteChecked: () => void;
  onSelect: (id: string) => void;
  onCheck: (id: string, checked: boolean) => void;
  onClearFilter: () => void;
}

function StatusIcon({ status }: { status: DraftElement['reviewStatus'] }) {
  if (status === 'accepted') return <CheckCircle2 size={14} />;
  if (status === 'edited') return <PenLine size={14} />;
  if (status === 'rejected') return <EyeOff size={14} />;
  return <CircleHelp size={14} />;
}

function hasRequiredFieldIssue(element: DraftElement) {
  if (element.reviewStatus === 'rejected') return false;
  const box = element.bbox;
  const validBox = Boolean(box)
    && [box.x, box.y, box.width, box.height].every(Number.isFinite)
    && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0
    && box.x + box.width <= 1 && box.y + box.height <= 1;
  return !element.label.trim()
    || !element.candidateKey.trim()
    || !element.elementType
    || !validBox
    || !Number.isInteger(element.gridColumns)
    || !Number.isInteger(element.gridRows)
    || !Number.isInteger(element.gridRegion);
}

export function ElementTree({ elements, filterCandidateKey, selectedId, multiSelect, checkedIds, allChecked, allCheckedAccepted, onToggleAll, onCreateContainer, onToggleAccept, onDeleteChecked, onSelect, onCheck, onClearFilter }: ElementTreeProps) {
  const byParent = new Map<string | null, DraftElement[]>();
  for (const element of elements) {
    const effectiveParentId = element.parentId && elements.some((candidate) => candidate.id === element.parentId) ? element.parentId : null;
    const siblings = byParent.get(effectiveParentId) || [];
    siblings.push(element);
    byParent.set(effectiveParentId, siblings);
  }

  const renderLevel = (parentId: string | null, depth: number, path: Set<string>): React.ReactNode =>
    (byParent.get(parentId) || []).map((element) => {
      if (path.has(element.id)) return null;
      const nextPath = new Set(path).add(element.id);
      return (
        <div key={element.id}>
          <div
            className={`tree-row ${selectedId === element.id ? 'tree-row-selected' : ''} ${element.reviewStatus === 'rejected' ? 'tree-row-rejected' : ''} ${!element.elementType ? 'tree-row-needs-type' : ''}`}
            style={{ paddingLeft: `${12 + depth * 18}px` }}
          >
            {multiSelect && <input className="tree-checkbox" type="checkbox" checked={checkedIds.has(element.id)} aria-label={`选择 ${element.label}`} onChange={(event) => onCheck(element.id, event.target.checked)} />}
            <button type="button" className="tree-row-content" onClick={() => onSelect(element.id)}>
            <Container size={14} className="tree-control-icon" />
            <span className="tree-row-main">
              <span className="tree-row-label">{element.label}</span>
              <span className="tree-row-meta">{elementTypeLabel(element.elementType)}</span>
            </span>
            <span className={`tree-status ${hasRequiredFieldIssue(element) ? 'tree-status-warning' : `tree-status-${element.reviewStatus}`}`} title={hasRequiredFieldIssue(element) ? '模型返回缺少必填属性，请补齐后再审核' : reviewStatusLabels[element.reviewStatus]}>
              {hasRequiredFieldIssue(element) ? <CircleAlert size={14} /> : <StatusIcon status={element.reviewStatus} />}
            </span>
            </button>
          </div>
          {renderLevel(element.id, depth + 1, nextPath)}
        </div>
      );
    });

  const orphaned = filterCandidateKey ? [] : elements.filter((element) => element.parentId && !elements.some((candidate) => candidate.id === element.parentId));
  return (
    <div className="element-tree">
      {filterCandidateKey && <div className="element-tree-filter">
        <span>候选键：<code>{filterCandidateKey}</code></span>
        <button type="button" className="icon-button" title="清除筛选" aria-label="清除候选键筛选" onClick={onClearFilter}><X size={14} /></button>
      </div>}
      {multiSelect && elements.length > 0 && <div className="element-tree-selection-toolbar">
        <div className="element-tree-selection-summary">
          <button type="button" className={`icon-button ${allChecked ? 'active' : ''}`} title={allChecked ? '取消全选' : '全选'} aria-pressed={allChecked} onClick={onToggleAll}><CheckCheck size={15} /></button>
          <span>已选 {checkedIds.size}</span>
        </div>
        <div className="element-tree-selection-actions">
          <button type="button" className="icon-button" title={`用 ${checkedIds.size} 个所选元素创建容器`} disabled={checkedIds.size === 0} onClick={onCreateContainer}><Combine size={15} /></button>
          <button type="button" className="icon-button" title={`${allCheckedAccepted ? '取消审核通过' : '审核通过'}所选元素（${checkedIds.size}）`} disabled={checkedIds.size === 0} onClick={onToggleAccept}>{allCheckedAccepted ? <X size={15} /> : <Check size={15} />}</button>
          <button type="button" className="icon-button danger-button" title={`删除所选元素（${checkedIds.size}）`} disabled={checkedIds.size === 0} onClick={onDeleteChecked}><Trash2 size={15} /></button>
        </div>
      </div>}
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
