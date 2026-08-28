import { Check, Eye, EyeOff, RotateCcw, Trash2, X } from 'lucide-react';
import { actionEffectsFor, capabilityGroups, capabilityLabel, clampBox, defaultDescriptionForElementType, elementTypeGroups, elementTypeLabel, interactionBoundaryForActions, normalizeGridCount, recommendedActionsForElementType } from './model';
import type { AbstractElementField, DraftElement, DraftPage } from './types';

interface InspectorProps {
  element: DraftElement | null;
  initialElement: DraftElement | null;
  elements: DraftElement[];
  pages: DraftPage[];
  currentPageId: string;
  showGridGuides: boolean;
  canRestoreCurrent: boolean;
  onChange: (patch: Partial<DraftElement>, historyKey?: string) => void;
  onChangeEnd: () => void;
  onShowGridGuidesChange: (show: boolean) => void;
  onRestoreCurrent: () => void;
  onAccept: () => void;
  onReject: () => void;
  onDelete: () => void;
  onCreateRelation: () => void;
  selectedAbstractFieldKey: string | null;
  selectedAbstractFieldInstanceIndex: number | null;
  onSelectAbstractField: (fieldKey: string | null) => void;
  onSelectAbstractFieldInstance: (index: number | null) => void;
}

function decimal(value: number) {
  return value.toFixed(3);
}

const meaningStatusLabels = {
  known: '含义明确',
  candidate: '候选含义，需复核',
  unknown: '含义未知',
} as const;

const interactionBoundaryLabels: Record<string, string> = {
  none: '无',
  candidate_bbox: '候选边框',
  whole_element: '整个元素',
  trailing_control: '尾部控件',
  point_only: '中心点',
  unresolved: '尚未确定',
};

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

export function Inspector({ element, initialElement, elements, pages, currentPageId, showGridGuides, canRestoreCurrent, onChange, onChangeEnd, onShowGridGuidesChange, onRestoreCurrent, onAccept, onReject, onDelete, onCreateRelation, selectedAbstractFieldKey, selectedAbstractFieldInstanceIndex, onSelectAbstractField, onSelectAbstractFieldInstance }: InspectorProps) {
  if (!element) return <div className="inspector-empty-state"><div className="inspector-empty"><CircleSelection /></div></div>;
  const inheritedListRegion = element.abstraction?.kind === 'repeated-template' && ['list', 'grouped-list', 'swipe-list', 'expandable-list'].includes(elements.find((candidate) => candidate.id === element.parentId)?.elementType || '');
  const possibleParents = elements.filter((candidate) => candidate.id !== element.id && candidate.reviewStatus !== 'rejected');
  const updateField = (field: keyof DraftElement, value: unknown, group = false) => onChange({ [field]: value } as Partial<DraftElement>, group ? `field:${field}` : undefined);
  const fieldModified = (...fields: Array<keyof DraftElement>) => Boolean(initialElement && fields.some((field) => !fieldValuesEqual(field, element[field], initialElement[field])));
  const fieldClass = (...fields: Array<keyof DraftElement>) => `field${fieldModified(...fields) ? ' field-modified' : ''}${fields.includes('elementType') && !element.elementType ? ' field-invalid' : ''}`;
  const groupClass = (...fields: Array<keyof DraftElement>) => `field-group${fieldModified(...fields) ? ' field-modified' : ''}`;
  const bboxModified = (key: keyof DraftElement['bbox']) => Boolean(initialElement && element.bbox[key] !== initialElement.bbox[key]);
  const accepted = element.reviewStatus === 'accepted';
  const rejected = element.reviewStatus === 'rejected';
  const displayedActionEffects = actionEffectsFor(element.elementType, element.capabilities, element.actionEffects);
  const changeElementType = (elementType: string) => {
    const capabilities = recommendedActionsForElementType(elementType);
    onChange({
      elementType,
      visualDescription: defaultDescriptionForElementType(elementType),
      capabilities,
      actionEffects: actionEffectsFor(elementType, capabilities),
      interactionBoundary: interactionBoundaryForActions(capabilities, element.interactionBoundary),
    });
  };
  const toggleAction = (action: string, checked: boolean) => {
    let capabilities = checked
      ? action === 'none' ? ['none'] : [...element.capabilities.filter((item) => item !== 'none' && item !== action), action]
      : element.capabilities.filter((item) => item !== action);
    if (capabilities.length === 0) capabilities = ['none'];
    onChange({
      capabilities,
      actionEffects: actionEffectsFor(element.elementType, capabilities, element.actionEffects),
      interactionBoundary: interactionBoundaryForActions(capabilities, element.interactionBoundary),
    });
  };
  const updateActionEffect = (action: string, effect: string) => {
    onChange({ actionEffects: displayedActionEffects.map((item) => item.action === action ? { ...item, effect } : item) }, `field:actionEffects:${action}`);
  };
  const updateAbstractField = (fieldKey: string, patch: Partial<AbstractElementField>, historyKey?: string) => {
    if (!element.abstraction) return;
    onChange({ abstraction: {
      ...element.abstraction,
      fields: element.abstraction.fields.map((field) => field.key === fieldKey ? { ...field, ...patch } : field),
    } }, historyKey || `field:abstract:${fieldKey}`);
  };
  const changeAbstractFieldType = (field: AbstractElementField, elementType: string) => {
    const capabilities = recommendedActionsForElementType(elementType);
    updateAbstractField(field.key, {
      elementType,
      capabilities,
      actionEffects: actionEffectsFor(elementType, capabilities, field.actionEffects),
      interactionBoundary: interactionBoundaryForActions(capabilities, field.interactionBoundary),
    });
  };
  const toggleAbstractFieldAction = (field: AbstractElementField, action: string, checked: boolean) => {
    let capabilities = checked
      ? action === 'none' ? ['none'] : [...field.capabilities.filter((item) => item !== 'none' && item !== action), action]
      : field.capabilities.filter((item) => item !== action);
    if (capabilities.length === 0) capabilities = ['none'];
    updateAbstractField(field.key, {
      capabilities,
      actionEffects: actionEffectsFor(field.elementType, capabilities, field.actionEffects),
      interactionBoundary: interactionBoundaryForActions(capabilities, field.interactionBoundary),
    });
  };
  const updateAbstractFieldActionEffect = (field: AbstractElementField, action: string, effect: string) => {
    const effects = actionEffectsFor(field.elementType, field.capabilities, field.actionEffects)
      .map((item) => item.action === action ? { ...item, effect } : item);
    updateAbstractField(field.key, { actionEffects: effects }, `field:abstract:${field.key}:actionEffects:${action}`);
  };

  return (
    <div className="inspector-form">
      <div className="inspector-actions">
        <div className="review-actions">
          <button type="button" className="icon-button danger-button" title="删除元素，可通过撤销恢复" onClick={onDelete}><Trash2 size={16} /></button>
          <button type="button" className="button" title="恢复该元素的初始信息" disabled={!canRestoreCurrent} onClick={onRestoreCurrent}><RotateCcw size={15} />恢复</button>
          <button type="button" className="button" onClick={onReject}>{rejected ? <Eye size={15} /> : <EyeOff size={15} />}{rejected ? '取消忽略' : '忽略元素'}</button>
          <button type="button" className={`button ${accepted ? '' : 'button-primary'}`} onClick={onAccept}>{accepted ? <X size={15} /> : <Check size={15} />}{accepted ? '取消审核通过' : '审核通过'}</button>
        </div>
      </div>

      <label className={fieldClass('label')}><span>元素名称</span><input value={element.label} onBlur={onChangeEnd} onChange={(event) => updateField('label', event.target.value, true)} /></label>
      <label className={fieldClass('elementType')}><span>元素类型</span><select value={element.elementType} onChange={(event) => changeElementType(event.target.value)}><option value="" disabled />{elementTypeGroups.map((group) => <optgroup key={group.label} label={group.label}>{group.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</optgroup>)}</select></label>
      {!element.abstraction && <label className={fieldClass('visualDescription')}><span>元素描述</span><input value={element.visualDescription} onBlur={onChangeEnd} onChange={(event) => updateField('visualDescription', event.target.value, true)} /></label>}
      <label className={`${fieldClass('displayCondition')} field-textarea`}><span>展示条件</span><textarea value={element.displayCondition} placeholder="例如：当前用户存在以参会人身份加入的会议" rows={2} onBlur={onChangeEnd} onChange={(event) => updateField('displayCondition', event.target.value, true)} /></label>

      {element.abstraction && <fieldset className="field-group abstract-element-summary">
        <legend>{element.abstraction.kind === 'dynamic-template' ? '动态元素共相' : '列表项元素共相'}</legend>
        <p className="field-hint">{element.abstraction.kind === 'dynamic-template' ? '当前画面的动态载荷属于实例观测，动态元素共相只保留稳定槽位、字段结构与交互职责。' : '列表中的具体文字、编号和当前值属于帧观测，不作为列表项元素共相展示。'}</p>
        <label className={`${fieldClass('visualDescription')} field-textarea abstract-template-description`}><span>共相描述</span><textarea value={element.visualDescription} rows={2} onBlur={onChangeEnd} onChange={(event) => updateField('visualDescription', event.target.value, true)} /></label>
        <div className="evidence-summary abstract-template-metrics">
          <div><span>可见实例</span><strong>{element.abstraction.instanceCount}</strong></div>
          <div><span>共相字段</span><strong>{element.abstraction.fields.length}</strong></div>
        </div>
        <div className="abstract-field-list">
          {element.abstraction.fields.map((field) => {
            const fieldEffects = actionEffectsFor(field.elementType, field.capabilities, field.actionEffects);
            const fieldParentOptions = [
              ...(field.parentId && !elements.some((candidate) => candidate.id === field.parentId || candidate.candidateKey === field.parentId) ? [{ value: field.parentId, label: field.parentId }] : []),
              { value: element.candidateKey, label: `${element.label}（当前元素共相）` },
              ...possibleParents.filter((candidate) => candidate.id !== element.id).map((candidate) => ({ value: candidate.id, label: candidate.label })),
            ].filter((option, index, options) => options.findIndex((candidate) => candidate.value === option.value) === index);
            return <div key={field.key} className={`abstract-field-item ${selectedAbstractFieldKey === field.key ? 'selected' : ''}`}>
            <button type="button" className="abstract-field-select" aria-pressed={selectedAbstractFieldKey === field.key} onClick={() => {
              const nextKey = selectedAbstractFieldKey === field.key ? null : field.key;
              onSelectAbstractField(nextKey);
              onSelectAbstractFieldInstance(nextKey && field.instanceRegions.length > 0 ? 0 : null);
            }}>
              <strong>{field.label}</strong>
              <span>{field.description}</span>
            <dl className="abstract-field-details">
              <div><dt>元素类型</dt><dd>{elementTypeLabel(field.elementType) || field.elementType || '未确认'}</dd></div>
              <div><dt>展示条件</dt><dd>{field.displayCondition || '无'}</dd></div>
              <div><dt>元素动作</dt><dd>{field.capabilities?.length ? field.capabilities.map(capabilityLabel).join('、') : '无'}</dd></div>
              <div><dt>交互区域</dt><dd>{interactionBoundaryLabels[field.interactionBoundary] || field.interactionBoundary || '未确认'}</dd></div>
              <div><dt>动作效果</dt><dd>{field.actionEffects?.length ? field.actionEffects.map((item) => `${capabilityLabel(item.action)}：${item.effect}`).join('；') : '无'}</dd></div>
              <div><dt>父级元素</dt><dd>{field.parentId || element.label || '当前元素共相'}</dd></div>
            </dl>
            </button>
            {selectedAbstractFieldKey === field.key && <div className="abstract-field-editor">
              <label className="field"><span>元素名称</span><input value={field.label} onBlur={onChangeEnd} onChange={(event) => updateAbstractField(field.key, { label: event.target.value }, `field:abstract:${field.key}:label`)} /></label>
              <label className="field field-textarea"><span>元素描述</span><textarea value={field.description} rows={2} onBlur={onChangeEnd} onChange={(event) => updateAbstractField(field.key, { description: event.target.value }, `field:abstract:${field.key}:description`)} /></label>
              <label className="field"><span>元素类型</span><select value={field.elementType} onChange={(event) => changeAbstractFieldType(field, event.target.value)}><option value="" disabled />{elementTypeGroups.map((group) => <optgroup key={group.label} label={group.label}>{group.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</optgroup>)}</select></label>
              <label className="field field-textarea"><span>展示条件</span><textarea value={field.displayCondition} rows={2} onBlur={onChangeEnd} onChange={(event) => updateAbstractField(field.key, { displayCondition: event.target.value }, `field:abstract:${field.key}:displayCondition`)} /></label>
              <fieldset className="field-group"><legend>元素动作</legend><div className="checkbox-grid">
                {capabilityGroups[0].options.map(([value, label]) => <label key={value} className="check-field"><input type="checkbox" checked={field.capabilities.includes(value)} onChange={(event) => toggleAbstractFieldAction(field, value, event.target.checked)} /><span>{label}</span></label>)}
              </div></fieldset>
              <label className="field"><span>交互区域</span><select value={field.interactionBoundary} disabled={field.capabilities.includes('none')} onChange={(event) => updateAbstractField(field.key, { interactionBoundary: event.target.value })}>{Object.entries(interactionBoundaryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <fieldset className="field-group"><legend>动作效果</legend><div className="action-effect-list">
                {fieldEffects.map((item) => <label key={item.action}><span>{capabilityLabel(item.action)}</span><input value={item.effect} onBlur={onChangeEnd} onChange={(event) => updateAbstractFieldActionEffect(field, item.action, event.target.value)} /></label>)}
              </div></fieldset>
              <label className="field"><span>父级元素</span><select value={field.parentId || element.candidateKey} onChange={(event) => updateAbstractField(field.key, { parentId: event.target.value || null })}>{fieldParentOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              <label className="check-field"><input type="checkbox" checked={field.required} onChange={(event) => updateAbstractField(field.key, { required: event.target.checked })} /><span>必填字段</span></label>
              {field.instanceRegions.length > 0 && <fieldset className="field-group abstract-field-regions"><legend>实例边框（归一化小数）</legend>
                <div className="abstract-instance-tabs">
                  {field.instanceRegions.map((_region, index) => <button key={index} type="button" className={selectedAbstractFieldInstanceIndex === index ? 'active' : ''} onClick={() => onSelectAbstractFieldInstance(index)}>实例 {index + 1}</button>)}
                </div>
                {field.instanceRegions.map((region, index) => selectedAbstractFieldInstanceIndex === index && <div className="number-grid" key={index}>
                  {(['x', 'y', 'width', 'height'] as const).map((key) => <label key={key}><span>{{ x: '左', y: '上', width: '宽', height: '高' }[key]}</span><input type="number" min="0" max="1" step="0.001" value={decimal(region[key])} onBlur={onChangeEnd} onChange={(event) => {
                    const instanceRegions = field.instanceRegions.map((candidate, candidateIndex) => candidateIndex === index ? clampBox({ ...candidate, [key]: Number(event.target.value) }) : candidate);
                    updateAbstractField(field.key, { instanceRegions }, `field:abstract:${field.key}:bbox:${index}:${key}`);
                  }} /></label>)}
                </div>)}
              </fieldset>}
            </div>}
          </div>;
          })}
        </div>
      </fieldset>}

      <fieldset className={groupClass('capabilities')}>
        <legend>元素动作</legend>
        <div className="checkbox-grid">
          {capabilityGroups[0].options.map(([value, label]) => (
            <label key={value} className="check-field"><input type="checkbox" checked={element.capabilities.includes(value)} onChange={(event) => toggleAction(value, event.target.checked)} /><span>{label}</span></label>
          ))}
        </div>
      </fieldset>

      <fieldset className={groupClass('actionEffects')}>
        <legend>动作效果</legend>
        <div className="action-effect-list">
          {displayedActionEffects.map((item) => <label key={item.action}><span>{capabilityLabel(item.action)}</span><input value={item.effect} onBlur={onChangeEnd} onChange={(event) => updateActionEffect(item.action, event.target.value)} /></label>)}
        </div>
        {displayedActionEffects.length > 0 && <button type="button" className="inspector-create-relation" onClick={onCreateRelation}>创建关联关系 <span aria-hidden="true">→</span></button>}
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
      <label className={fieldClass('interactionBoundary')}><span>交互区域</span><select value={element.interactionBoundary} disabled={element.capabilities.includes('none')} onChange={(event) => updateField('interactionBoundary', event.target.value)}><option value="none">无</option><option value="candidate_bbox">候选边框，待校准</option><option value="whole_element">整个元素可操作</option><option value="trailing_control">仅尾部控件可操作</option><option value="point_only">仅验证中心点</option><option value="unresolved">尚未确定</option></select></label>

      {!inheritedListRegion && <fieldset className="field-group">
        <legend>边框位置（归一化小数）</legend>
        <div className="number-grid">
          {(['x', 'y', 'width', 'height'] as const).map((key) => (
            <label key={key} className={bboxModified(key) ? 'number-modified' : undefined}><span>{{ x: '左', y: '上', width: '宽', height: '高' }[key]}</span><input type="number" min="0" max="1" step="0.001" value={decimal(element.bbox[key])} onBlur={onChangeEnd} onChange={(event) => onChange({ bbox: { ...element.bbox, [key]: Number(event.target.value) } }, `bbox:${key}`)} /></label>
          ))}
        </div>
      </fieldset>}

      {!inheritedListRegion && <fieldset className={groupClass('gridColumns', 'gridRows', 'gridRegion')}>
        <legend>屏幕宫格定位</legend>
        <label className="check-field grid-guide-toggle"><input type="checkbox" checked={showGridGuides} onChange={(event) => onShowGridGuidesChange(event.target.checked)} /><span>在画面中显示宫格辅助线与区域编号</span></label>
        <div className="grid-location-controls">
          <label><span>横向分割</span><input type="number" min="1" max="12" step="1" value={element.gridColumns} onBlur={onChangeEnd} onChange={(event) => updateField('gridColumns', normalizeGridCount(Number(event.target.value)), true)} /></label>
          <label><span>纵向分割</span><input type="number" min="1" max="12" step="1" value={element.gridRows} onBlur={onChangeEnd} onChange={(event) => updateField('gridRows', normalizeGridCount(Number(event.target.value)), true)} /></label>
          <label><span>区域编号</span><input type="number" value={element.gridRegion} readOnly aria-label="由完整元素边框自动定位的区域编号" /></label>
        </div>
      </fieldset>}
      {inheritedListRegion && <p className="field-hint inherited-list-region-hint">列表项元素共相不单独定位，边框和宫格继承父级列表容器；具体实例仅在列表区域内展示。</p>}

      <div className="evidence-summary">
        <div><span>识别可信度</span><strong>{Math.round(element.confidence * 100)}%</strong></div>
        <div><span>信息来源</span><strong title={element.aiModel || undefined}>{element.source === 'ai' ? `AI 识别 · ${element.aiModel || '模型未知'}` : element.source === 'human' ? '人工新增' : `AI 识别 · ${element.aiModel || '模型未知'} + 人工确认`}</strong></div>
        <div><span>人工审核</span><strong>{element.reviewStatus === 'pending' ? '待人工确认' : element.reviewStatus === 'accepted' ? '已审核通过' : element.reviewStatus === 'edited' ? '人工修订' : '已忽略'}</strong></div>
      </div>

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
