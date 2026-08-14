import { Bot, Check, CircleAlert, CircleCheck, Eye, EyeOff, RotateCcw, Trash2, X } from 'lucide-react';
import { capabilityOptions, controlTypeOptions, roleOptions } from './model';
import type { DraftElement, DraftPage } from './types';

interface InspectorProps {
  element: DraftElement | null;
  initialElement: DraftElement | null;
  elements: DraftElement[];
  pages: DraftPage[];
  currentPageId: string;
  canRestoreCurrent: boolean;
  onChange: (patch: Partial<DraftElement>, historyKey?: string) => void;
  onChangeEnd: () => void;
  onRestoreCurrent: () => void;
  onAccept: () => void;
  onReject: () => void;
  onDelete: () => void;
}

function percentage(value: number) {
  return Math.round(value * 1000) / 10;
}

const meaningStatusLabels = {
  known: '含义明确',
  candidate: '候选含义，需复核',
  unknown: '含义未知',
} as const;

const aiReviewStatusLabels = {
  pass: '初审通过',
  needs_review: '重点复核',
  reject: '建议忽略',
} as const;

function EvidenceValues({ values }: { values: string[] }) {
  return values.length > 0 ? <>{values.map((value) => <span className="evidence-chip" key={value}>{value}</span>)}</> : <span className="evidence-empty">无</span>;
}

function fieldValuesEqual(field: keyof DraftElement, current: unknown, initial: unknown) {
  if (field === 'capabilities' || field === 'availableOnPageIds') {
    const currentValues = Array.isArray(current) ? [...current].sort() : [];
    const initialValues = Array.isArray(initial) ? [...initial].sort() : [];
    return JSON.stringify(currentValues) === JSON.stringify(initialValues);
  }
  return JSON.stringify(current) === JSON.stringify(initial);
}

export function Inspector({ element, initialElement, elements, pages, currentPageId, canRestoreCurrent, onChange, onChangeEnd, onRestoreCurrent, onAccept, onReject, onDelete }: InspectorProps) {
  if (!element) return <div className="inspector-empty-state"><div className="inspector-empty"><CircleSelection /></div></div>;
  const possibleParents = elements.filter((candidate) => candidate.id !== element.id && candidate.reviewStatus !== 'rejected');
  const updateField = (field: keyof DraftElement, value: unknown, group = false) => onChange({ [field]: value } as Partial<DraftElement>, group ? `field:${field}` : undefined);
  const fieldModified = (...fields: Array<keyof DraftElement>) => Boolean(initialElement && fields.some((field) => !fieldValuesEqual(field, element[field], initialElement[field])));
  const fieldClass = (...fields: Array<keyof DraftElement>) => `field${fieldModified(...fields) ? ' field-modified' : ''}`;
  const groupClass = (...fields: Array<keyof DraftElement>) => `field-group${fieldModified(...fields) ? ' field-modified' : ''}`;
  const bboxModified = (key: keyof DraftElement['bbox']) => Boolean(initialElement && element.bbox[key] !== initialElement.bbox[key]);
  const accepted = element.reviewStatus === 'accepted';
  const rejected = element.reviewStatus === 'rejected';

  return (
    <div className="inspector-form">
      <div className="inspector-actions">
        <div className="review-actions">
          <button type="button" className="icon-button danger-button" title="删除元素，可通过撤销恢复" onClick={onDelete}><Trash2 size={16} /></button>
          <button type="button" className="button" title="恢复该元素的初始信息" disabled={!canRestoreCurrent} onClick={onRestoreCurrent}><RotateCcw size={15} />恢复</button>
          <button type="button" className="button" onClick={onReject}>{rejected ? <Eye size={15} /> : <EyeOff size={15} />}{rejected ? '取消忽略' : '忽略元素'}</button>
          <button type="button" className={`button ${accepted ? '' : 'button-primary'}`} onClick={onAccept}>{accepted ? <X size={15} /> : <Check size={15} />}{accepted ? '取消确认' : '确认元素'}</button>
        </div>
      </div>

      <label className={fieldClass('label')}><span>元素名称</span><input value={element.label} onBlur={onChangeEnd} onChange={(event) => updateField('label', event.target.value, true)} /></label>
      <label className={fieldClass('controlType')}><span>控件类型</span><select value={element.controlType} onChange={(event) => updateField('controlType', event.target.value)}>{controlTypeOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className={fieldClass('role')}><span>元素作用</span><select value={element.role} onChange={(event) => updateField('role', event.target.value)}>{roleOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className={fieldClass('actionable')}><span>是否可操作</span><select value={element.actionable} onChange={(event) => updateField('actionable', event.target.value)}><option value="yes">可操作</option><option value="no">不可操作</option><option value="unknown">待确认</option></select></label>

      <fieldset className={groupClass('capabilities')}>
        <legend>支持操作</legend>
        <div className="checkbox-grid">
          {capabilityOptions.map(([value, label]) => (
            <label key={value} className="check-field"><input type="checkbox" checked={element.capabilities.includes(value)} onChange={(event) => updateField('capabilities', event.target.checked ? [...element.capabilities, value] : element.capabilities.filter((item) => item !== value))} /><span>{label}</span></label>
          ))}
        </div>
      </fieldset>

      <label className={fieldClass('state')}><span>当前状态</span><input value={element.state} placeholder="例如：开启、关闭、选中" onBlur={onChangeEnd} onChange={(event) => updateField('state', event.target.value, true)} /></label>
      <label className={fieldClass('parentId')}><span>父级元素</span><select value={element.parentId || ''} onChange={(event) => { const parentId = event.target.value || null; onChange({ parentId, ownerKind: parentId ? 'component' : 'page' }); }}><option value="">无，直接属于页面</option>{possibleParents.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}</select></label>
      {!element.parentId && <label className={fieldClass('ownerKind', 'ownerRef', 'pageId')}><span>所属范围</span><select value={element.ownerKind} onChange={(event) => {
        const ownerKind = event.target.value as DraftElement['ownerKind'];
        onChange(ownerKind === 'application'
          ? { ownerKind, ownerRef: 'application', pageId: null, availableOnPageIds: [...new Set([...element.availableOnPageIds, currentPageId])] }
          : { ownerKind: 'page', ownerRef: currentPageId, pageId: currentPageId, availableOnPageIds: [] });
      }}><option value="page">当前页面</option><option value="application">应用共享</option></select></label>}
      {!element.parentId && element.ownerKind === 'application' && (
        <fieldset className={groupClass('availableOnPageIds')}>
          <legend>共享到页面</legend>
          <div className="page-check-list">
            {pages.map((page) => <label key={page.id} className="check-field"><input type="checkbox" checked={element.availableOnPageIds.includes(page.id)} onChange={(event) => updateField('availableOnPageIds', event.target.checked ? [...new Set([...element.availableOnPageIds, page.id])] : element.availableOnPageIds.filter((id) => id !== page.id))} /><span>{page.name}</span></label>)}
          </div>
        </fieldset>
      )}
      <label className={fieldClass('interactionBoundary')}><span>交互区域</span><select value={element.interactionBoundary} onChange={(event) => updateField('interactionBoundary', event.target.value)}><option value="candidate_bbox">候选边框，待校准</option><option value="whole_element">整个元素可操作</option><option value="trailing_control">仅尾部控件可操作</option><option value="point_only">仅验证中心点</option><option value="unresolved">尚未确定</option></select></label>

      <fieldset className="field-group">
        <legend>边框位置（百分比）</legend>
        <div className="number-grid">
          {(['x', 'y', 'width', 'height'] as const).map((key) => (
            <label key={key} className={bboxModified(key) ? 'number-modified' : undefined}><span>{{ x: '左', y: '上', width: '宽', height: '高' }[key]}</span><input type="number" min="0" max="100" step="0.1" value={percentage(element.bbox[key])} onBlur={onChangeEnd} onChange={(event) => onChange({ bbox: { ...element.bbox, [key]: Number(event.target.value) / 100 } }, `bbox:${key}`)} /></label>
          ))}
        </div>
      </fieldset>

      <div className="evidence-summary">
        <div><span>识别可信度</span><strong>{Math.round(element.confidence * 100)}%</strong></div>
        <div><span>信息来源</span><strong title={element.scoutModel || undefined}>{element.source === 'ai_scout' ? `AI Scout · ${element.scoutModel || '模型未知'}` : element.source === 'human' ? '人工新增' : `AI Scout · ${element.scoutModel || '模型未知'} + 人工`}</strong></div>
        <div><span>人工审核</span><strong>{element.reviewStatus === 'pending' ? '待人工确认' : element.reviewStatus === 'accepted' ? '已确认' : element.reviewStatus === 'edited' ? '人工修订' : '已忽略'}</strong></div>
      </div>

      {element.aiReview && <section className={`ai-review-card ai-review-${element.aiReview.status}`}>
        <header>
          <span>{element.aiReview.status === 'pass' ? <CircleCheck size={16} /> : <CircleAlert size={16} />}<strong>{aiReviewStatusLabels[element.aiReview.status]}</strong></span>
          <span><Bot size={13} />{element.aiReview.model} · {Math.round(element.aiReview.confidence * 100)}%</span>
        </header>
        <p>{element.aiReview.summary}</p>
        {element.aiReview.issues.length > 0 && <div>{element.aiReview.issues.map((issue) => <span key={issue}>{issue}</span>)}</div>}
        {element.reviewStatus === 'pending' && <footer>AI 初审不替代人工确认</footer>}
      </section>}

      <details className="meaning-evidence" open>
        <summary>元素含义与识别依据</summary>
        <dl className="meaning-overview">
          <dt>含义状态</dt><dd>{meaningStatusLabels[element.meaning.status]}</dd>
          <dt>含义说明</dt><dd>{element.meaning.description || '暂无说明'}</dd>
        </dl>
        <div className="evidence-groups">
          <div><span>可见文字</span><p><EvidenceValues values={element.meaning.evidence.visibleTexts} /></p></div>
          <div><span>可见图标</span><p><EvidenceValues values={element.meaning.evidence.visibleIcons} /></p></div>
          <div><span>可见状态</span><p><EvidenceValues values={element.meaning.evidence.visibleStates} /></p></div>
          <div><span>视觉线索</span><p><EvidenceValues values={element.meaning.evidence.visualCues} /></p></div>
          <div><span>用户上下文</span><p>{element.meaning.evidence.userContext || <span className="evidence-empty">无</span>}</p></div>
          <div className="unclassified-evidence"><span>待归类证据</span><p>{element.meaning.evidence.unclassified.length > 0
            ? element.meaning.evidence.unclassified.map((item, index) => <span className="evidence-chip evidence-chip-warning" key={`${item.type}-${index}`}>{item.detail ? `${item.type}：${item.detail}` : item.type}</span>)
            : <span className="evidence-empty">无</span>}</p></div>
        </div>
      </details>

      {element.lastModelProposal && <div className="model-proposal"><RotateCcw size={15} /><span>AI 有新的识别建议，人工结果已受到保护。</span></div>}
      <details className="advanced-fields"><summary>高级信息</summary><dl><dt>候选键</dt><dd>{element.candidateKey}</dd><dt>内部 ID</dt><dd>{element.id}</dd><dt>归属类型</dt><dd>{element.ownerKind}</dd><dt>归属引用</dt><dd>{element.ownerRef}</dd></dl></details>
    </div>
  );
}

function CircleSelection() {
  return <div><div className="selection-placeholder" /><p>未选择元素</p></div>;
}
