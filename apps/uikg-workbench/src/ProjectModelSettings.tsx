import {
  Braces, Check, ChevronDown, ChevronRight, CircleAlert, GitBranch, Info, Layers3,
  LoaderCircle, Plus, RotateCcw, Save, Search, Settings2, SlidersHorizontal, X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { workbenchApi } from './api';
import { elementTypeGroups } from './model';
import type {
  ProjectModelData, ProjectModelDefinition, ProjectModelField, ProjectModelFieldValueType,
  ProjectModelOption, ProjectModelOptionSet, ProjectModelRelationType,
} from './types';

type View = 'objects' | 'relations' | 'advanced';
type CreateDialog =
  | { kind: 'field'; key: string; label: string }
  | { kind: 'entity'; key: string; label: string }
  | { kind: 'relation'; key: string; label: string };

interface ProjectModelSettingsProps {
  onNotice: (type: 'info' | 'error' | 'success', text: string) => void;
}

const groupDefinitions = [
  { key: 'project', label: '项目组织' }, { key: 'product', label: '应用与功能' },
  { key: 'ui', label: '页面与交互' }, { key: 'service', label: '接口与服务' },
  { key: 'data', label: '数据资产' }, { key: 'requirement', label: '需求与规则' },
  { key: 'engineering', label: '研发资产' }, { key: 'quality', label: '质量保障' },
  { key: 'custom', label: '项目自定义' },
];

const valueTypeLabels: Record<ProjectModelFieldValueType, string> = {
  string: '简短文字', text: '长文本说明', integer: '整数', number: '数值', boolean: '是 / 否',
  date: '日期', datetime: '日期和时间', option: '单选', multi_option: '多选',
  entity_ref: '关联一个对象', entity_ref_list: '关联多个对象', object: '结构化信息', object_list: '多组结构化信息',
};

const views: Array<{ id: View; label: string; description: string; icon: typeof Layers3 }> = [
  { id: 'objects', label: '对象与字段', description: '定义每类知识需要记录什么', icon: Layers3 },
  { id: 'relations', label: '关联规则', description: '定义不同知识对象如何连接', icon: GitBranch },
  { id: 'advanced', label: '高级设置', description: '管理自定义对象和技术信息', icon: Settings2 },
];

function cloneProject(model: ProjectModelDefinition): ProjectModelDefinition {
  return structuredClone({ ...model, entityTypes: model.entityTypes || {}, relationTypes: model.relationTypes || {}, optionSets: model.optionSets || {}, fields: model.fields || [] });
}

function effectiveFields(data: ProjectModelData, project: ProjectModelDefinition) {
  const values = new Map<string, ProjectModelField & { source: 'core' | 'project' }>((data.core.fields || []).map((field) => [field.key, { ...field, source: 'core' as const }]));
  for (const field of project.fields || []) values.set(field.key, { ...values.get(field.key), ...field, source: 'project' } as ProjectModelField & { source: 'project' });
  return [...values.values()].sort((left, right) => (left.label || left.key).localeCompare(right.label || right.key, 'zh-CN'));
}

function effectiveOptions(core: ProjectModelOptionSet | undefined, project: ProjectModelOptionSet | undefined) {
  const replaced = Boolean(project?.options);
  const base = replaced ? project?.options || [] : core?.options || [];
  return [...base.map((option) => ({ ...option, source: replaced ? 'project' as const : 'core' as const })), ...(project?.addOptions || []).map((option) => ({ ...option, source: 'project' as const }))];
}

type EffectiveOption = ReturnType<typeof effectiveOptions>[number];

function groupedOptions(optionSetKey: string, options: EffectiveOption[]) {
  const indexed = options.map((option, index) => ({ option, index }));
  if (optionSetKey !== 'element-type') return [{ label: '', items: indexed }];
  const knownValues = new Set(elementTypeGroups.flatMap((group) => group.options.map(([value]) => value)));
  const groups = elementTypeGroups.map((group) => ({
    label: group.label,
    items: indexed.filter(({ option }) => group.options.some(([value]) => value === option.value)),
  })).filter((group) => group.items.length > 0);
  const custom = indexed.filter(({ option }) => !knownValues.has(option.value));
  return custom.length > 0 ? [...groups, { label: '项目自定义', items: custom }] : groups;
}

const fieldOptionSetKey = (field: ProjectModelField) => field.optionSetRef || `${field.key}-options`;

export function ProjectModelSettings({ onNotice }: ProjectModelSettingsProps) {
  const [data, setData] = useState<ProjectModelData | null>(null);
  const [project, setProject] = useState<ProjectModelDefinition | null>(null);
  const [view, setView] = useState<View>('objects');
  const [selectedEntity, setSelectedEntity] = useState('Page');
  const [selectedRelation, setSelectedRelation] = useState<string | null>(null);
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [createDialog, setCreateDialog] = useState<CreateDialog | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const result = await workbenchApi.projectModel();
        setData(result); setProject(cloneProject(result.project)); setDirty(false);
      } catch (error) { onNotice('error', error instanceof Error ? error.message : String(error)); }
      finally { setLoading(false); }
    })();
  }, []);

  const entityTypes = useMemo(() => {
    if (!data || !project) return [];
    const keys = new Set([...Object.keys(data.core.entityTypes || {}), ...Object.keys(project.entityTypes || {})]);
    return [...keys].filter((key) => key !== 'Project').map((key) => ({ key, ...(data.core.entityTypes?.[key] || {}), ...(project.entityTypes?.[key] || {}), source: project.entityTypes?.[key] ? 'project' as const : 'core' as const, group: project.entityTypes?.[key]?.group || data.core.entityTypes?.[key]?.group || 'custom' }));
  }, [data, project]);
  const fields = useMemo(() => data && project ? effectiveFields(data, project) : [], [data, project]);
  const relationTypes = useMemo(() => {
    if (!data || !project) return [];
    const keys = new Set([...Object.keys(data.core.relationTypes || {}), ...Object.keys(project.relationTypes || {})]);
    return [...keys].map((key) => {
      const definition = { ...(data.core.relationTypes?.[key] || {}), ...(project.relationTypes?.[key] || {}) };
      return { key, ...definition, sourceTypes: definition.sourceTypes || [], targetTypes: definition.targetTypes || [], source: project.relationTypes?.[key] ? 'project' as const : 'core' as const };
    }).sort((left, right) => (left.label || left.key).localeCompare(right.label || right.key, 'zh-CN'));
  }, [data, project]);

  const entity = entityTypes.find((item) => item.key === selectedEntity) || entityTypes[0];
  const objectFields = fields.filter((field) => field.appliesTo.includes(entity?.key || ''));
  const activeField = objectFields.find((field) => field.key === selectedField) || objectFields[0] || null;
  const relation = relationTypes.find((item) => item.key === selectedRelation) || relationTypes[0] || null;

  useEffect(() => { if (activeField?.key !== selectedField) setSelectedField(activeField?.key || null); }, [selectedEntity, activeField?.key]);
  useEffect(() => { if (relation?.key !== selectedRelation) setSelectedRelation(relation?.key || null); }, [relation?.key]);

  const updateProject = (updater: (current: ProjectModelDefinition) => ProjectModelDefinition) => { setProject((current) => current ? updater(current) : current); setDirty(true); };
  const updateField = (key: string, changes: Partial<ProjectModelField>) => {
    const base = fields.find((field) => field.key === key); if (!base) return;
    updateProject((current) => {
      const nextFields = [...(current.fields || [])]; const index = nextFields.findIndex((field) => field.key === key);
      const next = { ...base, ...changes } as ProjectModelField & { source?: string }; delete next.source;
      if (index >= 0) nextFields[index] = next; else nextFields.push(next);
      return { ...current, fields: nextFields };
    });
  };
  const updateFieldValueType = (field: ProjectModelField, valueType: ProjectModelFieldValueType) => {
    if (valueType !== 'option' && valueType !== 'multi_option') { updateField(field.key, { valueType, optionSetRef: undefined, allowCustomOptions: undefined }); return; }
    const optionSetRef = fieldOptionSetKey(field);
    updateProject((current) => {
      const base = fields.find((item) => item.key === field.key) || field; const nextFields = [...(current.fields || [])]; const index = nextFields.findIndex((item) => item.key === field.key);
      const nextField = { ...base, valueType, optionSetRef } as ProjectModelField & { source?: string }; delete nextField.source;
      if (index >= 0) nextFields[index] = nextField; else nextFields.push(nextField);
      return { ...current, fields: nextFields, optionSets: { ...(current.optionSets || {}), [optionSetRef]: current.optionSets?.[optionSetRef] || { label: `${field.label || field.key}选项`, options: [] } } };
    });
  };
  const updateProjectOptionSet = (key: string, updater: (value: ProjectModelOptionSet) => ProjectModelOptionSet) => updateProject((current) => ({ ...current, optionSets: { ...(current.optionSets || {}), [key]: updater(current.optionSets?.[key] || {}) } }));
  const addOption = (field: ProjectModelField) => {
    const key = fieldOptionSetKey(field); const customSet = Boolean(project?.optionSets?.[key]?.options);
    updateProjectOptionSet(key, (current) => { const property = customSet ? 'options' : 'addOptions'; return { ...current, label: current.label || `${field.label || field.key}选项`, [property]: [...(current[property] || []), { value: `option_${(current[property]?.length || 0) + 1}`, label: '新选项', status: 'active' }] }; });
  };
  const updateOption = (field: ProjectModelField, projectIndex: number, changes: Partial<ProjectModelOption>) => {
    const key = fieldOptionSetKey(field); const customSet = Boolean(project?.optionSets?.[key]?.options);
    updateProjectOptionSet(key, (current) => { const property = customSet ? 'options' : 'addOptions'; const options = [...(current[property] || [])]; options[projectIndex] = { ...options[projectIndex], ...changes }; return { ...current, [property]: options }; });
  };
  const entityLabel = (key: string) => key === '*' ? '任意对象' : entityTypes.find((item) => item.key === key)?.label || key;

  const createItem = () => {
    if (!createDialog || !entity) return;
    const key = createDialog.key.trim(); const label = createDialog.label.trim(); const flexibleKey = createDialog.kind === 'relation';
    const valid = flexibleKey ? /^[A-Za-z][A-Za-z0-9_.-]*$/.test(key) : /^[A-Za-z][A-Za-z0-9_]*$/.test(key);
    if (!valid) { onNotice('error', flexibleKey ? '标识必须以字母开头，只能包含字母、数字、点、横线或下划线' : '标识必须以字母开头，只能包含字母、数字和下划线'); return; }
    if ((createDialog.kind === 'field' && fields.some((item) => item.key === key)) || (createDialog.kind === 'entity' && entityTypes.some((item) => item.key === key)) || (createDialog.kind === 'relation' && relationTypes.some((item) => item.key === key))) { onNotice('error', '该标识已经存在'); return; }
    updateProject((current) => {
      if (createDialog.kind === 'field') return { ...current, fields: [...(current.fields || []), { key, label: label || key, description: '', appliesTo: [entity.key], valueType: 'string', required: false, searchable: false }] };
      if (createDialog.kind === 'entity') return { ...current, entityTypes: { ...(current.entityTypes || {}), [key]: { label: label || key, description: '', group: 'custom' } } };
      return { ...current, relationTypes: { ...(current.relationTypes || {}), [key]: { label: label || key, description: '', sourceTypes: [entity.key], targetTypes: [entity.key] } } };
    });
    if (createDialog.kind === 'field') setSelectedField(key); if (createDialog.kind === 'entity') { setSelectedEntity(key); setView('objects'); } if (createDialog.kind === 'relation') { setSelectedRelation(key); setView('relations'); }
    setCreateDialog(null);
  };
  const save = async () => {
    if (!project || !dirty) return; setSaving(true);
    try {
      const submitted = cloneProject(project);
      submitted.relationTypes = Object.fromEntries(Object.entries(submitted.relationTypes || {}).map(([key, definition]) => {
        const { key: _key, source: _source, ...clean } = definition as ProjectModelRelationType & { key?: string; source?: string };
        return [key, clean];
      }));
      const result = await workbenchApi.saveProjectModel(submitted); setData(result); setProject(cloneProject(result.project)); setDirty(false); onNotice('success', `项目模型已保存为 ${result.effectiveModelVersion}`);
    }
    catch (error) { onNotice('error', error instanceof Error ? error.message : String(error)); } finally { setSaving(false); }
  };

  if (loading || !data || !project) return <main className="project-model-page"><div className="project-model-state">{loading ? <LoaderCircle className="spin" size={20} /> : <CircleAlert size={20} />}{loading ? '正在读取项目模型' : '项目模型读取失败'}</div></main>;

  const renderSaveFooter = () => <footer><button type="button" className="button" disabled={!dirty || saving} onClick={() => { setProject(cloneProject(data.project)); setDirty(false); }}><RotateCcw size={14} />放弃修改</button><button type="button" className="button button-primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}保存项目模型</button></footer>;

  const renderOptionEditor = (field: ProjectModelField) => {
    if (field.valueType !== 'option' && field.valueType !== 'multi_option') return null;
    const key = fieldOptionSetKey(field); const coreSet = data.core.optionSets?.[key]; const projectSet = project.optionSets?.[key]; const options = effectiveOptions(coreSet, projectSet); const customSet = Boolean(projectSet?.options); const coreCount = customSet ? 0 : coreSet?.options?.length || 0;
    return <section className="object-field-options"><header><div><strong>可选值</strong><span>维护人员填写这个字段时会从以下内容中选择</span></div><button type="button" className="button" onClick={() => addOption(field)}><Plus size={14} />添加选项</button></header><div className="option-editor-table"><div className="option-editor-head"><span>界面显示</span><span>内部值</span><span>是否可用</span></div>{groupedOptions(key, options).map((group) => <section className="option-editor-group" key={group.label || 'options'}>{group.label && <h4>{group.label}</h4>}{group.items.map(({ option, index }) => { const locked = option.source === 'core'; const projectIndex = locked ? -1 : index - coreCount; return <div className={`option-editor-row ${locked ? 'locked' : ''}`} key={`${option.value}-${index}`}><input aria-label={`${option.value} 显示名称`} value={option.label} disabled={locked} onChange={(event) => updateOption(field, projectIndex, { label: event.target.value })} /><input aria-label={`${option.value} 内部值`} value={option.value} disabled={locked} onChange={(event) => updateOption(field, projectIndex, { value: event.target.value })} /><label className="option-status"><input type="checkbox" disabled={locked} checked={option.status !== 'inactive'} onChange={(event) => updateOption(field, projectIndex, { status: event.target.checked ? 'active' : 'inactive' })} /><span>{locked ? '平台内置' : option.status === 'inactive' ? '已停用' : '使用中'}</span></label></div>; })}</section>)}{options.length === 0 && <div className="model-config-empty">还没有可选值，请添加第一个选项</div>}</div></section>;
  };

  const renderFieldEditor = () => {
    if (!activeField) return <div className="object-empty-fields"><SlidersHorizontal size={20} /><strong>这个对象还没有专属字段</strong><span>名称、说明等通用信息由系统提供；可以按宝盒项目需要添加字段。</span><button type="button" className="button button-primary" onClick={() => setCreateDialog({ kind: 'field', key: '', label: '' })}><Plus size={14} />添加第一个字段</button></div>;
    const projectField = project.fields?.find((item) => item.key === activeField.key); const coreField = data.core.fields?.find((item) => item.key === activeField.key); const projectOnly = Boolean(projectField && !coreField);
    return <div className="object-field-editor"><div className="object-field-editor-heading"><div><span>{projectOnly ? '宝盒项目字段' : projectField ? '已按宝盒项目调整' : '平台建议字段'}</span><h3>{activeField.label || activeField.key}</h3><p>{activeField.description || '请补充这个字段的用途，帮助维护人员正确填写。'}</p></div>{projectOnly && <button type="button" className="button" onClick={() => { updateProject((current) => ({ ...current, fields: (current.fields || []).filter((field) => field.key !== activeField.key) })); setSelectedField(null); }}><X size={14} />移除字段</button>}</div><div className="model-config-grid"><label><span>字段名称</span><input value={activeField.label || ''} onChange={(event) => updateField(activeField.key, { label: event.target.value })} /></label><label><span>填写方式</span><select value={activeField.valueType} onChange={(event) => updateFieldValueType(activeField, event.target.value as ProjectModelFieldValueType)}>{Object.entries(valueTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="model-config-wide"><span>这个字段用来记录什么</span><textarea value={activeField.description || ''} placeholder={`例如：用于记录${entity?.label || '对象'}的业务含义或维护要求`} onChange={(event) => updateField(activeField.key, { description: event.target.value })} /></label><label className="model-config-wide"><span>填写示例（可选）</span><input value={activeField.example || ''} placeholder="给维护人员一个真实、简短的填写示例" onChange={(event) => updateField(activeField.key, { example: event.target.value })} /></label></div><div className="model-config-toggles"><label><input type="checkbox" checked={Boolean(activeField.required)} onChange={(event) => updateField(activeField.key, { required: event.target.checked })} /><span><strong>必须填写</strong><small>新建{entity?.label || '对象'}时不能留空</small></span></label><label><input type="checkbox" checked={Boolean(activeField.searchable)} onChange={(event) => updateField(activeField.key, { searchable: event.target.checked })} /><span><strong>用于搜索和筛选</strong><small>可通过这个字段快速找到相关{entity?.label || '对象'}</small></span></label>{(activeField.valueType === 'option' || activeField.valueType === 'multi_option') && <label><input type="checkbox" checked={Boolean(activeField.allowCustomOptions)} onChange={(event) => updateField(activeField.key, { allowCustomOptions: event.target.checked })} /><span><strong>允许临时填写其他值</strong><small>维护时可以输入选项之外的内容</small></span></label>}</div>{renderOptionEditor(activeField)}<button type="button" className="advanced-disclosure" onClick={() => setAdvancedOpen((current) => !current)}><ChevronDown size={14} className={advancedOpen ? 'open' : ''} />高级信息</button>{advancedOpen && <div className="field-technical-info"><div><span>字段标识</span><code>{activeField.key}</code></div><div><span>适用对象</span><code>{activeField.appliesTo.map(entityLabel).join('、')}</code></div>{activeField.optionSetRef && <div><span>选项字典</span><code>{activeField.optionSetRef}</code></div>}</div>}</div>;
  };

  const renderLivePreview = () => <section className="model-live-preview"><header><div><strong>实时预览</strong><span>这里模拟维护人员实际录入“{entity?.label}”时看到的界面</span></div><span className="preview-live-dot"><i />随配置更新</span></header><div className="model-preview-surface"><div className="model-preview-title"><span>{entity?.label}</span><strong>新建{entity?.label}</strong><small>保存后，这些信息会成为图谱中的一个“{entity?.label}”对象</small></div>{objectFields.length ? <div className="model-preview-fields">{objectFields.map((field) => { const optionField = field.valueType === 'option' || field.valueType === 'multi_option'; const optionSetKey = fieldOptionSetKey(field); const options = optionField ? effectiveOptions(data.core.optionSets?.[optionSetKey], project.optionSets?.[optionSetKey]).filter((option) => option.status !== 'inactive') : []; return <label key={field.key}><span>{field.label || field.key}{field.required && <em>必填</em>}</span>{field.valueType === 'text' || field.valueType === 'object' || field.valueType === 'object_list' ? <textarea readOnly placeholder={field.example || field.description || `填写${field.label || field.key}`} /> : optionField ? <select defaultValue=""><option value="">请选择{field.label || field.key}</option>{groupedOptions(optionSetKey, options).map((group) => group.label ? <optgroup key={group.label} label={group.label}>{group.items.map(({ option }) => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup> : group.items.map(({ option }) => <option key={option.value} value={option.value}>{option.label}</option>))}</select> : field.valueType === 'boolean' ? <select defaultValue=""><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select> : <input readOnly placeholder={field.example || field.description || `填写${field.label || field.key}`} />}{field.description && <small>{field.description}</small>}</label>; })}</div> : <div className="model-preview-empty">这个对象还没有字段，添加字段后会在这里显示。</div>}<div className="model-preview-footer"><button type="button" className="button" disabled>取消</button><button type="button" className="button button-primary" disabled>保存{entity?.label}</button></div></div></section>;

  const renderObjects = () => <><section className="project-model-list object-list"><header><label><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="查找业务对象" /></label></header><div className="project-model-list-body grouped-object-list">{groupDefinitions.map((group) => { const items = entityTypes.filter((item) => item.group === group.key && `${item.label} ${item.description || ''}`.toLocaleLowerCase('zh-CN').includes(query.trim().toLocaleLowerCase('zh-CN'))); if (!items.length) return null; return <section key={group.key}><h3>{group.label}</h3>{items.map((item) => { const fieldCount = fields.filter((field) => field.appliesTo.includes(item.key)).length; return <button type="button" key={item.key} className={entity?.key === item.key ? 'active' : ''} onClick={() => { setSelectedEntity(item.key); setSelectedField(null); setAdvancedOpen(false); }}><span><strong>{item.label}</strong><small>{item.description}</small></span><em>{fieldCount} 个字段</em></button>; })}</section>; })}</div></section><section className="project-model-detail task-model-detail"><header><div><span>当前业务对象</span><strong>{entity?.label || '业务对象'}</strong></div><div className="model-version-state">{dirty ? '有未保存更改' : <><Check size={13} />配置已同步</>}</div></header><div className="project-model-detail-body"><div className="object-definition-heading"><div className="object-icon"><Layers3 size={18} /></div><div><h2>{entity?.label}</h2><p>{entity?.description || '项目自定义的知识对象。'}</p></div><button type="button" className="button button-primary" onClick={() => setCreateDialog({ kind: 'field', key: '', label: '' })}><Plus size={14} />添加字段</button></div><div className="object-workspace"><aside><header><strong>需要维护的信息</strong><span>{objectFields.length} 个字段</span></header>{objectFields.map((field) => <button type="button" className={activeField?.key === field.key ? 'active' : ''} key={field.key} onClick={() => { setSelectedField(field.key); setAdvancedOpen(false); }}><span><strong>{field.label || field.key}</strong><small>{field.description || '尚未填写用途说明'}</small></span><ChevronRight size={14} /></button>)}{!objectFields.length && <p>暂无专属字段</p>}</aside><main>{renderFieldEditor()}</main></div>{renderLivePreview()}</div>{renderSaveFooter()}</section></>;

  const renderRelations = () => <><section className="project-model-list"><header><label><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="查找关联规则" /></label><button type="button" className="icon-button" title="新增关联规则" onClick={() => setCreateDialog({ kind: 'relation', key: '', label: '' })}><Plus size={16} /></button></header><div className="project-model-list-body relation-rule-list">{relationTypes.filter((item) => `${item.label || ''} ${item.description || ''}`.toLocaleLowerCase('zh-CN').includes(query.trim().toLocaleLowerCase('zh-CN'))).map((item) => <button type="button" key={item.key} className={relation?.key === item.key ? 'active' : ''} onClick={() => setSelectedRelation(item.key)}><span><strong>{item.label || item.key}</strong><small>{item.description || '尚未填写用途说明'}</small></span></button>)}</div></section><section className="project-model-detail task-model-detail"><header><div><span>关联规则</span><strong>{relation?.label || relation?.key}</strong></div><div className="model-version-state">{dirty ? '有未保存更改' : <><Check size={13} />配置已同步</>}</div></header><div className="project-model-detail-body">{relation && <div className="relation-task-editor"><div className="relation-purpose"><GitBranch size={20} /><div><h2>{relation.label || relation.key}</h2><p>{relation.description || '请补充这条关联在业务上的含义。'}</p></div></div><div className="relation-sentence"><span>允许</span><strong>{relation.sourceTypes.map(entityLabel).join('、')}</strong><ChevronRight size={18} /><span>关联到</span><strong>{relation.targetTypes.map(entityLabel).join('、')}</strong></div><div className="model-config-readonly-note"><Info size={15} /><span>{relation.source === 'core' ? '这是平台内置规则，保证全公司图谱关系含义一致。项目可以新增自己的关联规则。' : '这是宝盒项目新增的关联规则，可以调整来源和目标对象。'}</span></div>{relation.source === 'project' && !data.core.relationTypes?.[relation.key] && <div className="model-config-grid relation-edit-grid"><label><span>规则名称</span><input value={relation.label || ''} onChange={(event) => updateProject((current) => ({ ...current, relationTypes: { ...(current.relationTypes || {}), [relation.key]: { ...relation, label: event.target.value } } }))} /></label><label className="model-config-wide"><span>用途说明</span><textarea value={relation.description || ''} onChange={(event) => updateProject((current) => ({ ...current, relationTypes: { ...(current.relationTypes || {}), [relation.key]: { ...relation, description: event.target.value } } }))} /></label><label className="model-config-wide"><span>可以从哪些对象发起</span><select multiple value={relation.sourceTypes} onChange={(event) => updateProject((current) => ({ ...current, relationTypes: { ...(current.relationTypes || {}), [relation.key]: { ...relation, sourceTypes: [...event.currentTarget.selectedOptions].map((option) => option.value) } } }))}>{entityTypes.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label><label className="model-config-wide"><span>可以关联到哪些对象</span><select multiple value={relation.targetTypes} onChange={(event) => updateProject((current) => ({ ...current, relationTypes: { ...(current.relationTypes || {}), [relation.key]: { ...relation, targetTypes: [...event.currentTarget.selectedOptions].map((option) => option.value) } } }))}>{entityTypes.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label></div>}<details className="technical-details"><summary>查看技术信息</summary><code>{relation.key}</code></details></div>}</div>{renderSaveFooter()}</section></>;

  const renderAdvanced = () => <><section className="project-model-list advanced-index"><div className="advanced-index-heading"><Settings2 size={18} /><strong>高级设置</strong><span>通常不需要修改</span></div><nav><button type="button" className="active"><Braces size={15} /><span>对象类型</span><em>{entityTypes.length}</em></button><button type="button" disabled><SlidersHorizontal size={15} /><span>内部字典</span><em>{Object.keys({ ...(data.core.optionSets || {}), ...(project.optionSets || {}) }).length}</em></button></nav></section><section className="project-model-detail task-model-detail"><header><div><span>高级设置</span><strong>对象类型</strong></div><div className="model-version-state">{dirty ? '有未保存更改' : <><Check size={13} />配置已同步</>}</div></header><div className="project-model-detail-body"><div className="advanced-object-heading"><div><h2>项目可用的业务对象</h2><p>对象类型决定图谱中可以创建哪些知识。平台内置类型适用于所有项目；这里只需补充宝盒特有的对象。</p></div><button type="button" className="button button-primary" onClick={() => setCreateDialog({ kind: 'entity', key: '', label: '' })}><Plus size={14} />新增项目对象</button></div><div className="advanced-object-table"><div className="advanced-object-row head"><span>对象名称</span><span>所属领域</span><span>来源</span></div>{entityTypes.map((item) => <div className="advanced-object-row" key={item.key}><span><strong>{item.label}</strong><small>{item.description}</small></span><span>{groupDefinitions.find((group) => group.key === item.group)?.label || '项目自定义'}</span><span>{item.source === 'core' ? '平台内置' : '宝盒项目'}</span></div>)}</div></div>{renderSaveFooter()}</section></>;

  return <main className="project-model-page project-model-task-page"><aside className="project-model-nav task-model-nav"><header><Braces size={18} /><div><strong>项目模型</strong><span>宝盒 · {data.effectiveModelVersion}</span></div></header><div className="task-model-intro"><strong>配置知识图谱要记录什么</strong><p>先选择业务对象，再维护它的字段；关联规则用于连接不同对象。</p></div><nav aria-label="项目模型配置方式">{views.map((item) => { const Icon = item.icon; return <button type="button" key={item.id} className={view === item.id ? 'active' : ''} onClick={() => { setView(item.id); setQuery(''); }}><Icon size={15} /><span><strong>{item.label}</strong><small>{item.description}</small></span></button>; })}</nav><footer><span>当前项目</span><strong>宝盒</strong></footer></aside>{view === 'objects' ? renderObjects() : view === 'relations' ? renderRelations() : renderAdvanced()}{createDialog && <div className="model-create-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreateDialog(null); }}><form className="model-create-dialog" role="dialog" aria-modal="true" onSubmit={(event) => { event.preventDefault(); createItem(); }}><header><div><strong>{createDialog.kind === 'field' ? `为“${entity?.label}”添加字段` : createDialog.kind === 'entity' ? '新增项目业务对象' : '新增项目关联规则'}</strong><span>{createDialog.kind === 'field' ? `这个字段只会出现在${entity?.label}的维护界面中` : '创建后可以继续填写用途和详细规则'}</span></div><button type="button" className="icon-button" aria-label="关闭" onClick={() => setCreateDialog(null)}><X size={16} /></button></header><label><span>{createDialog.kind === 'field' ? '字段名称' : createDialog.kind === 'entity' ? '对象名称' : '规则名称'}</span><input autoFocus required value={createDialog.label} placeholder={createDialog.kind === 'field' ? '例如：业务负责人' : ''} onChange={(event) => setCreateDialog({ ...createDialog, label: event.target.value })} /></label><label><span>内部唯一标识</span><input required value={createDialog.key} placeholder={createDialog.kind === 'field' ? '例如 businessOwner' : createDialog.kind === 'entity' ? '例如 DesignAsset' : '例如 depends_on'} onChange={(event) => setCreateDialog({ ...createDialog, key: event.target.value })} /><small>保存后不建议修改；日常维护人员不会看到它</small></label><footer><button type="button" className="button" onClick={() => setCreateDialog(null)}>取消</button><button type="submit" className="button button-primary"><Plus size={14} />创建并继续配置</button></footer></form></div>}</main>;
}
