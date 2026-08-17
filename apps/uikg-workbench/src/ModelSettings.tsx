import {
  Check,
  CircleAlert,
  Cpu,
  FileText,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  ServerCog,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { workbenchApi } from './api';
import type { ModelGatewayCatalog, ModelTarget, ReasoningEffort, WorkerAvailableModels, WorkerModelSettings, WorkerSlotSettings } from './types';

interface ModelSettingsProps {
  onSaved: (settings: WorkerModelSettings) => void;
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
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
}

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
  if (name.includes('minimax')) return 'gpt-5';
  return 'gpt-5';
}

function formFromSettings(settings: Pick<WorkerSlotSettings, 'config'>): ModelForm {
  return {
    gatewayId: settings.config.gatewayId,
    modelName: settings.config.modelName,
    modelFamily: settings.config.modelFamily,
    timeout: settings.config.timeout,
    temperature: settings.config.temperature,
    reasoningEffort: settings.config.reasoningEffort === 'none' ? 'low' : settings.config.reasoningEffort,
  };
}

function settingsForTarget(settings: WorkerModelSettings, target: ModelTarget) {
  if (target === 'worker_b') return settings.workerB;
  if (target === 'midscene') return settings.midscene;
  return settings.workerA;
}

function targetLabel(target: ModelTarget) {
  if (target === 'worker_b') return 'Worker B';
  if (target === 'midscene') return 'Midscene';
  return 'Worker A';
}

export function ModelSettings({ onSaved, onNotice }: ModelSettingsProps) {
  const [activeTarget, setActiveTarget] = useState<ModelTarget>('worker_a');
  const [settings, setSettings] = useState<WorkerModelSettings | null>(null);
  const [form, setForm] = useState<ModelForm | null>(null);
  const [catalog, setCatalog] = useState<WorkerAvailableModels | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [gatewayForm, setGatewayForm] = useState<GatewayForm | null>(null);
  const [editingGatewayId, setEditingGatewayId] = useState<string | null>(null);
  const [gatewaySaving, setGatewaySaving] = useState(false);
  const [gatewayDeleting, setGatewayDeleting] = useState(false);
  const [confirmingGatewayDelete, setConfirmingGatewayDelete] = useState(false);

  const loadSettings = async () => {
    setLoading(true);
    try {
      const result = await workbenchApi.modelSettings();
      setSettings(result);
      setForm(formFromSettings(settingsForTarget(result, activeTarget)));
    } catch (error) {
      onNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const loadModels = async () => {
    setModelsLoading(true);
    try {
      setCatalog(await workbenchApi.availableModels());
    } catch (error) {
      onNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setModelsLoading(false);
    }
  };

  useEffect(() => {
    void loadSettings();
    void loadModels();
  }, []);

  const targetSettings = settings ? settingsForTarget(settings, activeTarget) : null;
  useEffect(() => {
    if (targetSettings) setForm(formFromSettings(targetSettings));
  }, [activeTarget]);

  const filteredGateways = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (catalog?.gateways || []).map((gateway) => ({
      ...gateway,
      models: needle ? gateway.models.filter((model) => model.toLowerCase().includes(needle)) : gateway.models,
    })).filter((gateway) => gateway.models.length > 0 || gateway.error || !needle);
  }, [catalog, query]);

  const selectedGateway = useMemo(() => {
    if (!form) return null;
    return settings?.gateways.find((gateway) => gateway.id === form.gatewayId)
      || catalog?.gateways.find((gateway) => gateway.id === form.gatewayId)
      || null;
  }, [catalog, form, settings]);

  const dirty = useMemo(() => {
    if (!targetSettings || !form) return false;
    return form.gatewayId !== targetSettings.config.gatewayId
      || form.modelName !== targetSettings.config.modelName
      || form.modelFamily !== targetSettings.config.modelFamily
      || form.timeout !== targetSettings.config.timeout
      || form.temperature !== targetSettings.config.temperature
      || form.reasoningEffort !== targetSettings.config.reasoningEffort;
  }, [form, targetSettings]);

  const selectModel = (gateway: ModelGatewayCatalog, modelName: string) => {
    setForm((current) => current ? {
      ...current,
      gatewayId: gateway.id,
      modelName,
      modelFamily: gateway.modelFamilies[modelName] || familyForModel(modelName),
    } : current);
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      const result = await workbenchApi.saveModelSettings({ ...form, target: activeTarget });
      setSettings(result);
      const savedTarget = settingsForTarget(result, activeTarget);
      setForm(formFromSettings(savedTarget));
      onSaved(result);
      onNotice('success', `${targetLabel(activeTarget)} 已切换为 ${savedTarget.config.modelName}`);
    } catch (error) {
      onNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const openGatewayDialog = (gateway?: ModelGatewayCatalog) => {
    setConfirmingGatewayDelete(false);
    setEditingGatewayId(gateway?.id || null);
    setGatewayForm({
      id: gateway?.id || '',
      label: gateway?.label || '',
      baseUrl: gateway?.baseUrl || '',
      apiKey: '',
    });
  };

  const editingGatewayUsage = useMemo(() => {
    if (!settings || !editingGatewayId) return [];
    return (['worker_a', 'worker_b', 'midscene'] as ModelTarget[])
      .filter((target) => settingsForTarget(settings, target).config.gatewayId === editingGatewayId)
      .map(targetLabel);
  }, [editingGatewayId, settings]);

  const editingGateway = useMemo(() => {
    if (!editingGatewayId) return null;
    return settings?.gateways.find((gateway) => gateway.id === editingGatewayId)
      || catalog?.gateways.find((gateway) => gateway.id === editingGatewayId)
      || null;
  }, [catalog, editingGatewayId, settings]);

  const deleteGateway = async () => {
    if (!editingGatewayId || !gatewayForm) return;
    setGatewayDeleting(true);
    try {
      const result = await workbenchApi.deleteModelGateway(editingGatewayId);
      setSettings(result);
      setForm(formFromSettings(settingsForTarget(result, activeTarget)));
      setGatewayForm(null);
      setEditingGatewayId(null);
      setConfirmingGatewayDelete(false);
      await loadModels();
      onSaved(result);
      onNotice('success', `${gatewayForm.label} 网关已移除`);
    } catch (error) {
      onNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setGatewayDeleting(false);
    }
  };

  const saveGateway = async () => {
    if (!gatewayForm) return;
    setGatewaySaving(true);
    try {
      const result = await workbenchApi.saveModelGateway(gatewayForm);
      setSettings(result);
      setForm(formFromSettings(settingsForTarget(result, activeTarget)));
      setGatewayForm(null);
      setEditingGatewayId(null);
      await loadModels();
      onSaved(result);
      onNotice('success', `${gatewayForm.label} 网关已保存`);
    } catch (error) {
      onNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setGatewaySaving(false);
    }
  };

  if (loading && !settings) {
    return <main className="model-settings-workspace"><div className="settings-loading"><LoaderCircle className="spin" size={22} /><span>正在读取模型配置</span></div></main>;
  }

  if (!settings || !targetSettings || !form) {
    return <main className="model-settings-workspace"><div className="settings-loading"><CircleAlert size={22} /><span>模型配置读取失败</span><button type="button" className="button" onClick={() => void loadSettings()}><RefreshCw size={14} />重试</button></div></main>;
  }

  return (
    <main className="model-settings-workspace">
      <header className="model-settings-header">
        <div>
          <ServerCog size={21} />
          <span><strong>模型网关配置</strong><small>统一网关目录与运行目标指派</small></span>
        </div>
        <div className="model-worker-switch" role="tablist" aria-label="模型配置目标">
          <button type="button" className={activeTarget === 'worker_a' ? 'active' : ''} onClick={() => setActiveTarget('worker_a')}>Worker A</button>
          <button type="button" className={activeTarget === 'worker_b' ? 'active' : ''} onClick={() => setActiveTarget('worker_b')}>Worker B</button>
          <button type="button" className={activeTarget === 'midscene' ? 'active' : ''} onClick={() => setActiveTarget('midscene')}>Midscene</button>
        </div>
        <div className="settings-runtime">
          <i className={targetSettings.runtimeSynced ? 'synced' : ''} />
          <span><small>当前运行时</small><strong>{targetSettings.runtimeModel || '未配置'}</strong></span>
          <span className={targetSettings.runtimeSynced ? 'runtime-badge synced' : 'runtime-badge'}>{targetSettings.runtimeSynced ? '已同步' : '待刷新'}</span>
        </div>
      </header>

      <div className="model-settings-body">
        <section className="model-preset-section">
          <div className="settings-section-title">
            <span><Cpu size={16} /><strong>网关模型目录</strong></span>
            <span className="model-list-meta">
              <small>{modelsLoading ? '读取中' : `${catalog?.totalModels || 0} 个`}</small>
              <button type="button" className="icon-button" aria-label="新增网关" title="新增网关" disabled={gatewaySaving} onClick={() => openGatewayDialog()}><Plus size={14} /></button>
              <button type="button" className="icon-button" aria-label="刷新模型列表" title="刷新模型列表" disabled={modelsLoading} onClick={() => void loadModels()}><RefreshCw className={modelsLoading ? 'spin' : ''} size={13} /></button>
            </span>
          </div>
          <label className="model-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型" /></label>
          <div className="model-gateway-list">
            {filteredGateways.map((gateway) => (
              <section className="model-gateway-group" key={gateway.id}>
                <header>
                  <span><span className="gateway-title"><strong>{gateway.label}</strong><em className={`gateway-kind gateway-kind-${gateway.kind}`}>{gateway.kind === 'default' ? '默认网关' : '自定义网关'}</em></span><code title={gateway.baseUrl}>{gateway.baseUrl}</code></span>
                  <div className="gateway-header-actions"><small>{gateway.error ? '不可用' : `${gateway.models.length} 个`}</small><button type="button" className="icon-button" aria-label={`编辑 ${gateway.label}`} title="编辑网关" onClick={() => openGatewayDialog(gateway)}><Pencil size={12} /></button></div>
                </header>
                {gateway.error ? <div className="model-list-error"><CircleAlert size={14} /><span title={gateway.error}>{gateway.error}</span></div> : (
                  <div className="model-gateway-models" role="radiogroup" aria-label={`${gateway.label} 模型`}>
                    {gateway.models.map((modelName) => {
                      const family = familyForModel(modelName);
                      const selected = form.gatewayId === gateway.id && form.modelName === modelName;
                      return <button key={modelName} type="button" role="radio" aria-checked={selected} className={`gateway-model-row ${selected ? 'selected' : ''}`} onClick={() => selectModel(gateway, modelName)}><i>{selected && <Check size={10} />}</i><strong title={modelName}>{modelName}</strong><code>{family}</code></button>;
                    })}
                  </div>
                )}
              </section>
            ))}
            {!modelsLoading && filteredGateways.length === 0 && <div className="model-list-empty">没有匹配的模型</div>}
          </div>
        </section>

        <form className="model-config-section" autoComplete="off" onSubmit={(event) => { event.preventDefault(); if (dirty && !saving) void save(); }}>
          <div className="settings-section-title"><span><FileText size={16} /><strong>{targetLabel(activeTarget)} 连接配置</strong></span><button type="button" className="icon-button" title="重新读取数据库" disabled={loading || saving} onClick={() => void loadSettings()}><RefreshCw className={loading ? 'spin' : ''} size={14} /></button></div>
          <div className="env-path"><span>配置存储</span><code title={targetSettings.storagePath}>{targetSettings.storagePath}</code></div>

          <div className="settings-form">
            <div className="settings-field settings-field-wide"><span>Base URL</span><output className="settings-readonly"><code>{selectedGateway?.baseUrl || form.gatewayId || '未选择网关'}</code></output></div>
            <div className="settings-field settings-field-wide"><span>API Key</span><output className="settings-readonly"><KeyRound size={14} /><code>{selectedGateway?.apiKeyConfigured ? `已配置 ${selectedGateway.apiKeyHint || ''}` : '尚未配置'}</code></output></div>
            <div className="settings-field"><span>模型名称</span><output className="settings-readonly"><code>{form.modelName}</code></output></div>
            <div className="settings-field"><span>Model Family</span><output className="settings-readonly"><code>{form.modelFamily}</code></output></div>
            <label className="settings-field"><span>超时时间</span><span className="number-suffix"><input type="number" min={10000} max={600000} step={10000} value={form.timeout} onChange={(event) => setForm({ ...form, timeout: Number(event.target.value) })} /><small>ms</small></span></label>
            <label className="settings-field"><span>Temperature</span><input type="number" min={0} max={2} step={0.1} value={form.temperature} onChange={(event) => setForm({ ...form, temperature: Number(event.target.value) })} /></label>
            <label className="settings-field"><span>推理强度</span><select value={form.reasoningEffort} onChange={(event) => setForm({ ...form, reasoningEffort: event.target.value as ReasoningEffort })}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
          </div>

          <footer className="settings-actions">
            <span>{selectedGateway ? `${selectedGateway.label} · ${form.modelFamily}` : '尚未选择模型网关'}</span>
            <button type="button" className="button" disabled={!dirty || saving} onClick={() => setForm(formFromSettings(targetSettings))}><RefreshCw size={14} />还原</button>
            <button type="submit" className="button button-primary" disabled={!dirty || saving}>{saving ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}保存并应用</button>
          </footer>
        </form>
      </div>

      {gatewayForm && <div className="gateway-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !gatewaySaving && !gatewayDeleting) setGatewayForm(null); }}>
        <form className="gateway-dialog" role="dialog" aria-modal="true" aria-labelledby="gateway-dialog-title" autoComplete="off" onSubmit={(event) => { event.preventDefault(); if (!gatewaySaving && !gatewayDeleting) void saveGateway(); }} onMouseDown={(event) => event.stopPropagation()}>
          <header>
            <div><strong id="gateway-dialog-title">{editingGatewayId ? '编辑模型网关' : '新增模型网关'}</strong><span>网关配置全局生效，Worker A、Worker B 和 Midscene 共用。</span></div>
            <button type="button" className="icon-button" aria-label="关闭" title="关闭" disabled={gatewaySaving || gatewayDeleting} onClick={() => setGatewayForm(null)}><X size={16} /></button>
          </header>
          <div className="gateway-dialog-fields">
            <label className="settings-field"><span>网关 ID</span><input required pattern="[a-z0-9][a-z0-9-]*" value={gatewayForm.id} disabled={Boolean(editingGatewayId)} placeholder="例如 zto-newapi" onChange={(event) => setGatewayForm({ ...gatewayForm, id: event.target.value.toLowerCase() })} /></label>
            <label className="settings-field"><span>显示名称</span><input required value={gatewayForm.label} placeholder="例如 ZTO New API" onChange={(event) => setGatewayForm({ ...gatewayForm, label: event.target.value })} /></label>
            <label className="settings-field settings-field-wide"><span>Base URL</span><input required type="url" value={gatewayForm.baseUrl} placeholder="https://gateway.example.com/v1" onChange={(event) => setGatewayForm({ ...gatewayForm, baseUrl: event.target.value })} /></label>
            <label className="settings-field settings-field-wide"><span>API Key</span><span className="secret-input"><KeyRound size={14} /><input type="password" autoComplete="new-password" value={gatewayForm.apiKey} placeholder={editingGatewayId ? '留空即保留现有凭据' : '请输入 API Key'} onChange={(event) => setGatewayForm({ ...gatewayForm, apiKey: event.target.value })} /></span><small>{editingGatewayId ? '仅在需要更换凭据时填写。现有密钥不会返回到浏览器。' : '新增网关必须配置凭据。'}</small></label>
          </div>
          {editingGateway?.kind === 'default' && <div className="gateway-default-note"><ServerCog size={14} /><span>这是系统默认网关，不允许删除。</span></div>}
          {editingGateway?.kind !== 'default' && editingGatewayUsage.length > 0 && <div className="gateway-usage-note"><CircleAlert size={14} /><span>当前被 {editingGatewayUsage.join('、')} 使用，请先为这些运行目标指派其他网关后再移除。</span></div>}
          {confirmingGatewayDelete && <div className="gateway-delete-confirm" role="alertdialog" aria-label="确认移除模型网关"><span><strong>移除 {gatewayForm.label}？</strong><small>网关地址和 API Key 将从数据库删除，此操作不可撤销。</small></span><div><button type="button" className="button" disabled={gatewayDeleting} onClick={() => setConfirmingGatewayDelete(false)}>取消</button><button type="button" className="button danger-button" disabled={gatewayDeleting} onClick={() => void deleteGateway()}>{gatewayDeleting ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}确认移除</button></div></div>}
          <footer>{editingGatewayId && <button type="button" className="button danger-button gateway-delete-button" title={editingGateway?.kind === 'default' ? '默认网关不允许删除' : editingGatewayUsage.length ? `请先为 ${editingGatewayUsage.join('、')} 指派其他网关` : '移除网关'} disabled={gatewaySaving || gatewayDeleting || editingGateway?.kind === 'default' || editingGatewayUsage.length > 0} onClick={() => setConfirmingGatewayDelete(true)}><Trash2 size={14} />移除网关</button>}<button type="button" className="button" disabled={gatewaySaving || gatewayDeleting} onClick={() => setGatewayForm(null)}>取消</button><button type="submit" className="button button-primary" disabled={gatewaySaving || gatewayDeleting}>{gatewaySaving ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}保存网关</button></footer>
        </form>
      </div>}
    </main>
  );
}
