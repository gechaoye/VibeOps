import {
  Check,
  ChevronDown,
  CircleAlert,
  Gauge,
  KeyRound,
  LoaderCircle,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Server,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { workbenchApi } from './api';
import type {
  AvailableModels,
  ModelGatewayCatalog,
  ModelSettingsData,
  ModelSlotSettings,
  ModelTarget,
  ReasoningEffort,
  WorkbenchMode,
} from './types';

interface ModelSettingsProps {
  onSaved: (settings: ModelSettingsData) => void;
  onNotice: (type: 'info' | 'error' | 'success', text: string) => void;
}

interface ModelForm {
  gatewayId: string;
  modelName: string;
  modelFamily: string;
  timeout: number;
  temperature: number;
  reasoningEffort: ReasoningEffort;
}

interface GatewayForm {
  label: string;
  baseUrl: string;
  apiKey: string;
}

type ModelForms = Record<ModelTarget, ModelForm>;
type GatewayTestState = { status: 'testing' | 'success' | 'error'; detail?: string };

const TARGETS: ModelTarget[] = ['model_a', 'model_b', 'midscene'];
const CUSTOM_GATEWAY_LIMIT = 5;

function familyForModel(modelName: string) {
  const name = modelName.toLowerCase();
  if (name.includes('qwen2.5-vl')) return 'qwen2.5-vl';
  if (name.includes('qwen3-vl')) return 'qwen3-vl';
  if (name.includes('qwen3.6')) return 'qwen3.6';
  if (name.includes('qwen3.5')) return 'qwen3.5';
  if (name.includes('qwen3')) return 'qwen3';
  if (name.includes('doubao')) return 'doubao-seed';
  if (name.includes('gemini')) return 'gemini';
  if (name.includes('kimi-k3') || name.includes('kimi3')) return 'kimi3';
  if (name.includes('kimi')) return 'kimi';
  if (name.includes('xiaomi') || name.includes('mimo')) return 'xiaomi-mimo';
  return 'gpt-5';
}

function slotForTarget(settings: ModelSettingsData, target: ModelTarget) {
  if (target === 'model_b') return settings.modelB;
  if (target === 'midscene') return settings.midscene;
  return settings.modelA;
}

function formFromSlot(slot: ModelSlotSettings): ModelForm {
  return {
    gatewayId: slot.config.gatewayId,
    modelName: slot.config.modelName,
    modelFamily: slot.config.modelFamily,
    timeout: slot.config.timeout,
    temperature: slot.config.temperature,
    reasoningEffort: slot.config.reasoningEffort === 'none' ? 'low' : slot.config.reasoningEffort,
  };
}

function formsFromSettings(settings: ModelSettingsData): ModelForms {
  return Object.fromEntries(TARGETS.map((target) => [target, formFromSlot(slotForTarget(settings, target))])) as ModelForms;
}

function formChanged(form: ModelForm, slot: ModelSlotSettings) {
  return form.gatewayId !== slot.config.gatewayId
    || form.modelName !== slot.config.modelName
    || form.modelFamily !== slot.config.modelFamily
    || form.timeout !== slot.config.timeout
    || form.temperature !== slot.config.temperature
    || form.reasoningEffort !== slot.config.reasoningEffort;
}

export function ModelSettings({ onSaved, onNotice }: ModelSettingsProps) {
  const [settings, setSettings] = useState<ModelSettingsData | null>(null);
  const [catalog, setCatalog] = useState<AvailableModels | null>(null);
  const [query, setQuery] = useState('');
  const [forms, setForms] = useState<ModelForms | null>(null);
  const [mode, setMode] = useState<WorkbenchMode>('ultra');
  const [loading, setLoading] = useState(true);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [gatewayForm, setGatewayForm] = useState<GatewayForm | null>(null);
  const [editingGatewayId, setEditingGatewayId] = useState<string | null>(null);
  const [gatewaySaving, setGatewaySaving] = useState(false);
  const [gatewayDeleting, setGatewayDeleting] = useState(false);
  const [gatewayTests, setGatewayTests] = useState<Record<string, GatewayTestState>>({});
  const [activeSection, setActiveSection] = useState('model-gateways');
  const [openModelTarget, setOpenModelTarget] = useState<ModelTarget | null>(null);
  const [modelQueries, setModelQueries] = useState<Partial<Record<ModelTarget, string>>>({});

  const applySettings = (result: ModelSettingsData) => {
    setSettings(result);
    setForms(formsFromSettings(result));
    setMode(result.modeConfiguration?.mode || 'ultra');
  };

  const loadSettings = async () => {
    setLoading(true);
    try { applySettings(await workbenchApi.modelSettings()); }
    catch (error) { onNotice('error', error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };

  const loadModels = async () => {
    setModelsLoading(true);
    try { setCatalog(await workbenchApi.availableModels()); }
    catch (error) { onNotice('error', error instanceof Error ? error.message : String(error)); }
    finally { setModelsLoading(false); }
  };

  useEffect(() => { void loadSettings(); void loadModels(); }, []);

  const customGateways = settings?.gateways.filter((gateway) => gateway.kind === 'custom') || [];
  const defaultGateways = settings?.gateways.filter((gateway) => gateway.kind === 'default') || [];
  const filteredGateways = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (catalog?.gateways || []).map((gateway) => ({
      ...gateway,
      models: needle ? gateway.models.filter((model) => model.toLowerCase().includes(needle)) : gateway.models,
    })).filter((gateway) => gateway.models.length > 0 || gateway.error || !needle);
  }, [catalog, query]);
  const modelOptions = useMemo(() => (catalog?.gateways || []).flatMap((gateway) => gateway.models.map((modelName) => ({
    key: `${gateway.id}::${modelName}`,
    gatewayId: gateway.id,
    gatewayLabel: gateway.label,
    modelName,
    modelFamily: gateway.modelFamilies[modelName] || familyForModel(modelName),
  }))), [catalog]);

  const modeDirty = Boolean(settings && mode !== (settings.modeConfiguration?.mode || 'ultra'));
  const dirtyTargets = settings && forms ? TARGETS.filter((target) => formChanged(forms[target], slotForTarget(settings, target))) : [];
  const dirty = modeDirty || Boolean(dirtyTargets?.length);

  const updateModel = (target: ModelTarget, value: string) => {
    const selected = modelOptions.find((option) => option.key === value);
    if (!selected) return;
    setForms((current) => current ? {
      ...current,
      [target]: { ...current[target], gatewayId: selected.gatewayId, modelName: selected.modelName, modelFamily: selected.modelFamily },
    } : current);
    setOpenModelTarget(null);
    setModelQueries((current) => ({ ...current, [target]: '' }));
  };

  const updateForm = <K extends keyof ModelForm>(target: ModelTarget, field: K, value: ModelForm[K]) => {
    setForms((current) => current ? { ...current, [target]: { ...current[target], [field]: value } } : current);
  };

  const saveConfiguration = async () => {
    if (!settings || !forms || !dirty) return;
    setSaving(true);
    try {
      let result = settings;
      if (modeDirty) result = await workbenchApi.saveModelMode(mode);
      for (const target of dirtyTargets || []) result = await workbenchApi.saveModelSettings({ ...forms[target], target });
      applySettings(result);
      onSaved(result);
      onNotice('success', '模式配置已保存并应用');
    } catch (error) { onNotice('error', error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };

  const openGatewayDialog = (gateway?: ModelGatewayCatalog | ModelSettingsData['gateways'][number]) => {
    setEditingGatewayId(gateway?.id || null);
    setGatewayForm({ label: gateway?.label || '', baseUrl: gateway?.baseUrl || '', apiKey: '' });
  };

  const editingGatewayUsage = useMemo(() => {
    if (!settings || !editingGatewayId) return [];
    const labels: Record<ModelTarget, string> = { model_a: 'Model A', model_b: 'Model B', midscene: 'Midscene' };
    return TARGETS.filter((target) => slotForTarget(settings, target).config.gatewayId === editingGatewayId).map((target) => labels[target]);
  }, [editingGatewayId, settings]);

  const editingGateway = settings?.gateways.find((gateway) => gateway.id === editingGatewayId) || null;

  const saveGateway = async () => {
    if (!gatewayForm) return;
    setGatewaySaving(true);
    try {
      const result = editingGatewayId
        ? await workbenchApi.saveModelGateway(editingGatewayId, gatewayForm)
        : await workbenchApi.createModelGateway(gatewayForm);
      applySettings(result);
      setGatewayForm(null);
      setEditingGatewayId(null);
      await loadModels();
      onSaved(result);
      onNotice('success', `${gatewayForm.label} 已保存`);
    } catch (error) { onNotice('error', error instanceof Error ? error.message : String(error)); }
    finally { setGatewaySaving(false); }
  };

  const deleteGateway = async (gatewayId: string, gatewayLabel: string) => {
    if (!window.confirm(`确定删除“${gatewayLabel}”网关？`)) return;
    setGatewayDeleting(true);
    try {
      const result = await workbenchApi.deleteModelGateway(gatewayId);
      applySettings(result);
      await loadModels();
      onSaved(result);
      onNotice('success', `${gatewayLabel} 已移除`);
    } catch (error) { onNotice('error', error instanceof Error ? error.message : String(error)); }
    finally { setGatewayDeleting(false); }
  };

  const testGateway = async (gatewayId: string) => {
    setGatewayTests((current) => ({ ...current, [gatewayId]: { status: 'testing' } }));
    try {
      const result = await workbenchApi.testModelGateway(gatewayId);
      setGatewayTests((current) => ({ ...current, [gatewayId]: { status: 'success', detail: `${result.latencyMs} ms · ${result.modelCount} 个模型` } }));
    } catch (error) {
      setGatewayTests((current) => ({ ...current, [gatewayId]: { status: 'error', detail: error instanceof Error ? error.message : String(error) } }));
    }
  };

  if (loading && !settings) return <main className="settings-page"><div className="settings-state"><LoaderCircle className="spin" size={20} />正在读取设置</div></main>;
  if (!settings || !forms) return <main className="settings-page"><div className="settings-state"><CircleAlert size={20} />设置读取失败<button type="button" className="button" onClick={() => void loadSettings()}><RefreshCw size={14} />重试</button></div></main>;

  const targetLabels: Record<ModelTarget, string> = { model_a: 'Model A', model_b: 'Model B', midscene: 'Midscene' };

  const renderModelParameters = (target: ModelTarget, disabled: boolean) => {
    const form = forms[target];
    if (disabled || !form.modelName) return null;
    return <div className="model-advanced-row" aria-label={`${targetLabels[target]} 模型连接配置`}>
      <label className="settings-field"><span>超时时间</span><span className="number-suffix"><input type="number" min={10000} max={600000} step={10000} value={form.timeout} onChange={(event) => updateForm(target, 'timeout', Number(event.target.value))} /><small>ms</small></span></label>
      <label className="settings-field"><span>Temperature</span><input type="number" min={0} max={2} step={0.1} value={form.temperature} onChange={(event) => updateForm(target, 'temperature', Number(event.target.value))} /></label>
      <label className="settings-field"><span>推理强度</span><select value={form.reasoningEffort} onChange={(event) => updateForm(target, 'reasoningEffort', event.target.value as ReasoningEffort)}><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></label>
    </div>;
  };

  const renderModelSelect = (target: ModelTarget, label: string, description: string, disabled = false) => {
    const form = forms[target];
    const currentKey = `${form.gatewayId}::${form.modelName}`;
    const selectedGateway = settings.gateways.find((gateway) => gateway.id === form.gatewayId)
      || catalog?.gateways.find((gateway) => gateway.id === form.gatewayId);
    const currentQuery = modelQueries[target] || '';
    const needle = currentQuery.trim().toLowerCase();
    const groups = (catalog?.gateways || []).map((gateway) => ({
      ...gateway,
      models: gateway.models.filter((modelName) => !needle || `${gateway.label} ${modelName}`.toLowerCase().includes(needle)),
    })).filter((gateway) => gateway.models.length > 0);
    const displayValue = form.modelName ? `${selectedGateway?.label || '未选择网关'}：${form.modelName}` : '未配置';
    return <div className={`setting-row model-setting-row ${disabled ? 'disabled' : ''}`}>
      <div className="setting-copy"><strong>{label}</strong><span>{description}</span></div>
      <div className="model-setting-control">
        <div className="model-picker">
          <button type="button" className="model-picker-trigger" aria-label={`${label} 模型`} aria-expanded={openModelTarget === target} disabled={disabled || modelsLoading} onClick={() => setOpenModelTarget((current) => current === target ? null : target)}><span>{displayValue}</span><ChevronDown className="model-picker-chevron" aria-hidden="true" size={13} /></button>
          {openModelTarget === target && <div className="model-picker-popover">
            <label className="model-picker-search"><Search size={13} /><input autoFocus value={currentQuery} placeholder="搜索模型或网关" onChange={(event) => setModelQueries((current) => ({ ...current, [target]: event.target.value }))} /></label>
            <div className="model-picker-options">
              {groups.map((gateway) => <div className="model-picker-group" key={gateway.id}><strong>{gateway.label}</strong>{gateway.models.map((modelName) => <button type="button" key={`${gateway.id}::${modelName}`} className={currentKey === `${gateway.id}::${modelName}` ? 'selected' : ''} onClick={() => updateModel(target, `${gateway.id}::${modelName}`)}>{modelName}</button>)}</div>)}
              {!groups.length && <div className="model-picker-empty">没有匹配的模型</div>}
            </div>
          </div>}
        </div>
      </div>
      {renderModelParameters(target, disabled)}
    </div>;
  };

  const renderGateway = (gateway: ModelGatewayCatalog) => {
    const test = gatewayTests[gateway.id];
    const stored = settings.gateways.find((item) => item.id === gateway.id);
    if (!stored) return null;
    return <section className="gateway-catalog-card" key={gateway.id}>
      <header className="gateway-catalog-card-header">
        <div className="gateway-catalog-card-title"><span><strong>{gateway.label}</strong><em>{gateway.kind === 'default' ? '默认' : '自定义'}</em></span><code title={gateway.baseUrl}>{gateway.baseUrl}</code><small><KeyRound size={11} />{gateway.apiKeyConfigured ? `已配置 ${gateway.apiKeyHint || ''}` : '未配置 API Key'}</small></div>
        <div className="gateway-catalog-actions">
          {test && <small className={`gateway-test-result ${test.status}`} title={test.detail}>{test.status === 'testing' ? '测试中' : test.detail}</small>}
          <button type="button" className="icon-button" aria-label={`测试 ${gateway.label} 连通性`} title="测试连通性" disabled={test?.status === 'testing' || gatewayDeleting} onClick={() => void testGateway(gateway.id)}>{test?.status === 'testing' ? <LoaderCircle className="spin" size={14} /> : <PlugZap size={14} />}</button>
          <button type="button" className="icon-button" aria-label={`刷新 ${gateway.label} 模型列表`} title="刷新模型列表" disabled={modelsLoading || gatewayDeleting} onClick={() => void loadModels()}><RefreshCw className={modelsLoading ? 'spin' : ''} size={14} /></button>
          <button type="button" className="icon-button" aria-label={`编辑 ${gateway.label}`} title="编辑网关" disabled={gatewayDeleting} onClick={() => openGatewayDialog(stored)}><Pencil size={14} /></button>
          <button type="button" className="icon-button danger-icon" aria-label={`删除 ${gateway.label}`} title="删除网关" disabled={gatewayDeleting} onClick={() => void deleteGateway(gateway.id, gateway.label)}><Trash2 size={14} /></button>
        </div>
      </header>
      {gateway.error ? <div className="model-list-error"><CircleAlert size={14} /><span title={gateway.error}>{gateway.error}</span></div> : <div className="model-gateway-models" aria-label={`${gateway.label} 模型`}>
        {gateway.models.map((modelName) => <div key={modelName} className="gateway-model-row"><i aria-hidden="true" /><strong title={modelName}>{modelName}</strong><code>{gateway.modelFamilies[modelName] || familyForModel(modelName)}</code></div>)}
        {!gateway.models.length && <div className="model-list-empty">没有可用模型</div>}
      </div>}
    </section>;
  };

  const sectionTitle = activeSection === 'model-gateways' ? '模型网关' : '模式配置';
  return (
    <main className="settings-page">
      <aside className="settings-sidebar">
        <header><Settings size={18} /><strong>设置</strong></header>
        <nav aria-label="设置分类">
          {(settings.sections?.length ? settings.sections : [
            { id: 'model-gateways', label: '模型网关', order: 10 },
            { id: 'mode-configuration', label: '模式配置', order: 20 },
          ]).sort((left, right) => left.order - right.order).map((section) => <button key={section.id} type="button" className={activeSection === section.id ? 'active' : ''} onClick={() => setActiveSection(section.id)}><span>{section.label}</span></button>)}
        </nav>
        <footer><span>配置版本</span><code>v{settings.settingsSchemaVersion || 1}</code></footer>
      </aside>

      <div className="settings-detail">
        <header className="settings-detail-header"><h1>{sectionTitle}</h1><p>{activeSection === 'model-gateways' ? '管理默认与自定义网关及模型连接。' : '选择工作模式并指定使用的模型。'}</p></header>

        {activeSection === 'model-gateways' ? <section className="gateway-detail-page" aria-label="模型网关详情">
          <label className="model-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型" /></label>
          <div className="gateway-catalog-group"><h3><span>默认网关 <small>{defaultGateways.length}</small></span></h3>{filteredGateways.filter((gateway) => gateway.kind === 'default').map(renderGateway)}{!defaultGateways.length && <div className="settings-empty"><span>暂无默认网关</span></div>}</div>
          <div className="gateway-catalog-group"><h3><span>自定义网关 <small>{customGateways.length} / {CUSTOM_GATEWAY_LIMIT}</small>{customGateways.length > 0 && customGateways.length < CUSTOM_GATEWAY_LIMIT && <button type="button" className="button gateway-inline-add" disabled={gatewaySaving} onClick={() => openGatewayDialog()}><Plus size={13} />添加网关</button>}</span></h3>{filteredGateways.filter((gateway) => gateway.kind === 'custom').map(renderGateway)}{!customGateways.length && <div className="settings-empty gateway-empty-state"><span>尚未添加自定义网关</span>{customGateways.length < CUSTOM_GATEWAY_LIMIT && <button type="button" className="button" disabled={gatewaySaving} onClick={() => openGatewayDialog()}><Plus size={13} />添加网关</button>}</div>}</div>
        </section> : <section className="mode-detail-page" aria-labelledby="mode-settings-title">
          <div className="settings-group-heading"><div><Gauge size={17} /><span><h2 id="mode-settings-title">工作模式</h2><p>Manual 使用单模型，Ultra 使用 Model A/B 双模型并行。</p></span></div></div>
          <div className="setting-row mode-setting-row"><div className="setting-copy"><strong>工作模式</strong><span>Auto 模式暂未开放。</span></div><div className="mode-segment" role="radiogroup" aria-label="工作模式">{(['manual', 'ultra', 'auto'] as WorkbenchMode[]).map((value) => <button key={value} type="button" role="radio" aria-checked={mode === value} className={mode === value ? 'active' : ''} disabled={value === 'auto'} onClick={() => setMode(value)}>{value === 'manual' ? 'Manual' : value === 'ultra' ? 'Ultra' : 'Auto'}{value === 'auto' && <small>待开发</small>}</button>)}</div></div>
          {renderModelSelect('model_a', 'Model A', mode === 'manual' ? 'Manual 模式使用的模型。' : 'Ultra 模式的主模型。')}
          {renderModelSelect('model_b', 'Model B', 'Ultra 模式的第二个并行模型。', mode !== 'ultra')}
          {renderModelSelect('midscene', 'Midscene 模型', '预留给 Midscene，当前模式暂不使用。')}
          <footer className="settings-save-bar"><span>{dirty ? '有未保存的更改' : <><Check size={13} />设置已同步</>}</span><button type="button" className="button" disabled={!dirty || saving} onClick={() => { setForms(formsFromSettings(settings)); setMode(settings.modeConfiguration?.mode || 'ultra'); }}><RotateCcw size={14} />还原</button><button type="button" className="button button-primary" disabled={!dirty || saving} onClick={() => void saveConfiguration()}>{saving ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}保存设置</button></footer>
        </section>}
      </div>

      {gatewayForm && <div className="gateway-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !gatewaySaving && !gatewayDeleting) setGatewayForm(null); }}>
        <form className="gateway-dialog" role="dialog" aria-modal="true" aria-labelledby="gateway-dialog-title" autoComplete="off" onSubmit={(event) => { event.preventDefault(); if (!gatewaySaving && !gatewayDeleting) void saveGateway(); }} onMouseDown={(event) => event.stopPropagation()}>
          <header><div><strong id="gateway-dialog-title">{editingGatewayId ? '编辑模型网关' : '添加自定义网关'}</strong><span>保存后可用于 Model A、Model B 和 Midscene。</span></div><button type="button" className="icon-button" aria-label="关闭" title="关闭" disabled={gatewaySaving || gatewayDeleting} onClick={() => setGatewayForm(null)}><X size={16} /></button></header>
          <div className="gateway-dialog-fields">
            <label className="settings-field settings-field-wide"><span>显示名称</span><input required value={gatewayForm.label} placeholder="例如 Internal API" onChange={(event) => setGatewayForm({ ...gatewayForm, label: event.target.value })} /></label>
            <label className="settings-field settings-field-wide"><span>Base URL</span><input required type="url" value={gatewayForm.baseUrl} placeholder="https://gateway.example.com/v1" onChange={(event) => setGatewayForm({ ...gatewayForm, baseUrl: event.target.value })} /></label>
            <label className="settings-field settings-field-wide"><span>API Key</span><span className="secret-input"><KeyRound size={14} /><input type="password" autoComplete="new-password" value={gatewayForm.apiKey} placeholder={editingGatewayId ? '留空即保留现有凭据' : '请输入 API Key'} onChange={(event) => setGatewayForm({ ...gatewayForm, apiKey: event.target.value })} /></span><small>{editingGatewayId ? '仅在需要更换凭据时填写。' : '新增网关必须配置凭据。'}</small></label>
          </div>
          {editingGateway?.kind === 'default' && <div className="gateway-default-note"><Server size={14} /><span>这是默认网关，保存会更新当前默认值。</span></div>}
          {editingGatewayUsage.length > 0 && <div className="gateway-usage-note"><CircleAlert size={14} /><span>当前被 {editingGatewayUsage.join('、')} 使用。</span></div>}
          <footer><button type="button" className="button" disabled={gatewaySaving || gatewayDeleting} onClick={() => setGatewayForm(null)}>取消</button><button type="submit" className="button button-primary" disabled={gatewaySaving || gatewayDeleting}>{gatewaySaving ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}{editingGateway?.kind === 'default' ? '保存默认值' : '保存网关'}</button></footer>
        </form>
      </div>}
    </main>
  );
}
