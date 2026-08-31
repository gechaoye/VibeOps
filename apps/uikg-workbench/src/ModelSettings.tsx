import {
  Check,
  ChevronDown,
  Clipboard,
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
  FileText,
  Trash2,
  X,
} from 'lucide-react';
import { App as AntdApp } from 'antd';
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
type ModelTestState = { status: 'testing' | 'success' | 'error'; detail?: string };
type GatewayTestState = { connectivity: boolean; capabilities: boolean };
type GatewayModelTests = Record<string, Record<string, ModelTestState>>;
type EditableRuleSource = 'element-universal' | 'custom';
type PromptRule = { key: string; title: string; description: string; source: 'builtin' | EditableRuleSource };

const TARGETS: ModelTarget[] = ['manual', 'auto', 'midscene', 'self_heal'];
const MODE_TARGETS: Record<WorkbenchMode, ModelTarget[]> = {
  manual: ['manual'],
  auto: ['auto', 'midscene'],
};
const MODE_LABELS: Record<WorkbenchMode, string> = { manual: 'Manual', auto: 'Auto' };
const CUSTOM_GATEWAY_LIMIT = 5;
const MODEL_TEST_BATCH_SIZE = 10;

function StructuredOutputIcon() {
  return <svg width="14" height="14" viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true" focusable="false">
    <path d="M309.5 656a45 46.3 0 1 0 90 0 45 46.3 0 1 0-90 0Z" />
    <path d="M242 604.6c0-51.1-26.1-89.4-67.5-89.4 41.4 0 67.5-44.6 67.5-95.8v-243h82.5V107H242c-41.4 0-67.5 33.1-67.5 84.2v185.1c0 51.1-26.1 101-67.5 101H62v69.4h45c19.9 0 42.2 17.3 56.2 34.7 12.1 14.9 11.7 39.7 11.4 62-0.1 3.6-0.1 7.2-0.1 10.6v185.1c0 50.9 33.8 77.8 67.5 77.8h82.5v-69.4H242V604.6z" />
    <path d="M467 656a45 46.3 0 1 0 90 0 45 46.3 0 1 0-90 0Z" />
    <path d="M624.5 656a45 46.3 0 1 0 90 0 45 46.3 0 1 0-90 0Z" />
    <path d="M928.2 477.3c-41.4 0-78.8-49.8-78.8-101V191.2c0-51.1-33.6-84.2-75-84.2h-75v69.4H782v243c0 24.6 0.4 51.3 14.5 68.6 14.1 17.4 33.1 27.1 53 27.1-19.9 0-39 9.8-53 27.1-14.1 17.5-14.5 37.8-14.5 62.4v243h-82.5V917H782c41.4 0 67.5-4.2 67.5-55.3V654c0-3.4-0.1-7-0.1-10.6-0.3-22.3-0.7-47 11.4-62 14.1-17.4 36.4-34.7 56.2-34.7h45v-69.4h-33.8z" />
  </svg>;
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
  return 'gpt-5';
}

function slotForTarget(settings: ModelSettingsData, target: ModelTarget) {
  if (target === 'manual') return settings.manual;
  if (target === 'auto') return settings.auto;
  if (target === 'midscene') return settings.midscene;
  if (target === 'self_heal') return settings.selfHeal;
  return settings.manual;
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
  const { modal } = AntdApp.useApp();
  const [settings, setSettings] = useState<ModelSettingsData | null>(null);
  const [catalog, setCatalog] = useState<AvailableModels | null>(null);
  const [query, setQuery] = useState('');
  const [forms, setForms] = useState<ModelForms | null>(null);
  const [mode, setMode] = useState<WorkbenchMode>('manual');
  const [pendingMode, setPendingMode] = useState<WorkbenchMode | null>(null);
  const [loading, setLoading] = useState(true);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [gatewayForm, setGatewayForm] = useState<GatewayForm | null>(null);
  const [editingGatewayId, setEditingGatewayId] = useState<string | null>(null);
  const [gatewaySaving, setGatewaySaving] = useState(false);
  const [gatewayDeleting, setGatewayDeleting] = useState(false);
  const [gatewayTests, setGatewayTests] = useState<Record<string, GatewayTestState>>({});
  const [modelConnectivityTests, setModelConnectivityTests] = useState<GatewayModelTests>({});
  const [modelCapabilityTests, setModelCapabilityTests] = useState<GatewayModelTests>({});
  const [activeSection, setActiveSection] = useState('model-gateways');
  const [openModelTarget, setOpenModelTarget] = useState<ModelTarget | null>(null);
  const [modelQueries, setModelQueries] = useState<Partial<Record<ModelTarget, string>>>({});
  const [promptData, setPromptData] = useState<{ frameId: string; prompt: string; rules: PromptRule[] } | null>(null);
  const [promptLoading, setPromptLoading] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [editingRuleKey, setEditingRuleKey] = useState<string | null>(null);
  const [editingRuleCategory, setEditingRuleCategory] = useState<EditableRuleSource | null>(null);
  const [draftRule, setDraftRule] = useState({ title: '', description: '' });
  const [ruleSaving, setRuleSaving] = useState(false);

  const applySettings = (result: ModelSettingsData, syncMode = true) => {
    setSettings(result);
    setForms(formsFromSettings(result));
    if (syncMode) setMode(result.modeConfiguration?.mode === 'auto' ? 'auto' : 'manual');
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

  const loadPrompt = async () => {
    setPromptLoading(true);
    try { setPromptData(await workbenchApi.recognitionPrompt()); }
    catch (error) { onNotice('error', error instanceof Error ? error.message : String(error)); }
    finally { setPromptLoading(false); }
  };

  const copyPrompt = async () => {
    if (!promptData?.prompt || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(promptData.prompt);
      onNotice('success', '复制成功');
    } catch {
      onNotice('error', '提示词复制失败，请手动选择文本复制');
    }
  };

  const resizeRuleTextarea = (element: HTMLTextAreaElement | null) => {
    if (!element) return;
    element.style.height = 'auto';
    const borderHeight = element.offsetHeight - element.clientHeight;
    element.style.height = `${element.scrollHeight + borderHeight}px`;
  };

  const beginAddRule = (category: EditableRuleSource) => {
    setEditingRuleKey('__new__');
    setEditingRuleCategory(category);
    setDraftRule({ title: '', description: '' });
  };

  const beginEditRule = (rule: PromptRule) => {
    if (rule.source === 'builtin') return;
    setEditingRuleKey(rule.key);
    setEditingRuleCategory(rule.source);
    setDraftRule({ title: rule.title, description: rule.description });
  };

  const cancelRuleEditing = () => {
    setEditingRuleKey(null);
    setEditingRuleCategory(null);
    setDraftRule({ title: '', description: '' });
  };

  const saveRule = async () => {
    if (!draftRule.title.trim() || !draftRule.description.trim()) return;
    setRuleSaving(true);
    try {
      if (editingRuleKey === '__new__' && editingRuleCategory) await workbenchApi.createRecognitionPromptRule({ ...draftRule, category: editingRuleCategory });
      else if (editingRuleKey) await workbenchApi.saveRecognitionPromptRule(editingRuleKey, draftRule);
      const categoryLabel = editingRuleCategory === 'custom' ? '自定义规则' : '元素共相规则';
      cancelRuleEditing();
      await loadPrompt();
      onNotice('success', `${categoryLabel}已保存并应用`);
    } catch (error) { onNotice('error', error instanceof Error ? error.message : String(error)); }
    finally { setRuleSaving(false); }
  };

  const deleteRule = (key: string, category: EditableRuleSource) => {
    const categoryLabel = category === 'custom' ? '自定义规则' : '元素共相规则';
    modal.confirm({
      title: `删除这条${categoryLabel}？`,
      content: '删除后将立即从识别提示词中移除。',
      okText: '确认删除',
      cancelText: '取消',
      centered: true,
      okButtonProps: { danger: true },
      onOk: async () => {
        setRuleSaving(true);
        try {
          await workbenchApi.deleteRecognitionPromptRule(key);
          await loadPrompt();
          onNotice('success', `${categoryLabel}已删除`);
        } catch (error) { onNotice('error', error instanceof Error ? error.message : String(error)); }
        finally { setRuleSaving(false); }
      },
    });
  };

  useEffect(() => { void loadSettings(); void loadModels(); }, []);

  useEffect(() => { if (activeSection === 'recognition-prompt' && !promptData) void loadPrompt(); }, [activeSection, promptData]);

  useEffect(() => {
    if (!openModelTarget) return undefined;
    const closeModelPickerOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.model-picker')) return;
      setOpenModelTarget(null);
    };
    document.addEventListener('pointerdown', closeModelPickerOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeModelPickerOnOutsidePointer);
  }, [openModelTarget]);

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

  const configuredTargets: ModelTarget[] = [...MODE_TARGETS[mode], 'self_heal'];
  const dirtyTargets = settings && forms
    ? configuredTargets.filter((target) => formChanged(forms[target], slotForTarget(settings, target)))
    : [];
  const dirty = dirtyTargets.length > 0;

  const resetCurrentConfiguration = () => {
    if (!settings) return;
    const savedForms = formsFromSettings(settings);
    setForms((current) => current ? configuredTargets.reduce((next, target) => ({
      ...next,
      [target]: savedForms[target],
    }), current) : current);
    setOpenModelTarget(null);
  };

  const changeConfigurationMode = (nextMode: WorkbenchMode) => {
    if (nextMode === mode) return;
    if (dirty) {
      setPendingMode(nextMode);
      return;
    }
    setOpenModelTarget(null);
    setMode(nextMode);
  };

  const confirmModeChange = () => {
    if (!pendingMode) return;
    resetCurrentConfiguration();
    setMode(pendingMode);
    setPendingMode(null);
  };

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
      for (const target of dirtyTargets) result = await workbenchApi.saveModelSettings({ ...forms[target], target });
      applySettings(result, false);
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
    const labels: Record<ModelTarget, string> = {
      manual: 'Manual 页面识别模型',
      auto: 'Auto 页面识别模型',
      midscene: 'Auto Midscene 模型',
      self_heal: '结构自愈模型',
    };
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

  const deleteGateway = (gatewayId: string, gatewayLabel: string) => {
    modal.confirm({
      title: `删除“${gatewayLabel}”网关？`,
      content: '删除后无法恢复，请确认该网关已不再使用。',
      okText: '删除网关',
      cancelText: '取消',
      centered: true,
      okButtonProps: { danger: true },
      onOk: async () => {
        setGatewayDeleting(true);
        try {
          const result = await workbenchApi.deleteModelGateway(gatewayId);
          applySettings(result);
          await loadModels();
          onSaved(result);
          onNotice('success', `${gatewayLabel} 已移除`);
        } catch (error) { onNotice('error', error instanceof Error ? error.message : String(error)); }
        finally { setGatewayDeleting(false); }
      },
    });
  };

  const testGateway = async (gatewayId: string) => {
    const models = catalog?.gateways.find((gateway) => gateway.id === gatewayId)?.models || [];
    if (!models.length) {
      onNotice('error', '当前网关没有可测试的模型');
      return;
    }
    setGatewayTests((current) => ({ ...current, [gatewayId]: { connectivity: true, capabilities: current[gatewayId]?.capabilities || false } }));
    setModelConnectivityTests((current) => ({
      ...current,
      [gatewayId]: Object.fromEntries(models.map((modelName) => [modelName, { status: 'testing' }])),
    }));
    try {
      for (let offset = 0; offset < models.length; offset += MODEL_TEST_BATCH_SIZE) {
        const batch = models.slice(offset, offset + MODEL_TEST_BATCH_SIZE);
        await Promise.all(batch.map(async (modelName) => {
          try {
            const result = await workbenchApi.testModelConnectivity(gatewayId, modelName);
            setModelConnectivityTests((current) => ({
              ...current,
              [gatewayId]: { ...current[gatewayId], [modelName]: { status: 'success', detail: `${result.latencyMs} ms` } },
            }));
          } catch (error) {
            setModelConnectivityTests((current) => ({
              ...current,
              [gatewayId]: { ...current[gatewayId], [modelName]: { status: 'error', detail: error instanceof Error ? error.message : String(error) } },
            }));
          }
        }));
      }
    } finally {
      setGatewayTests((current) => ({ ...current, [gatewayId]: { connectivity: false, capabilities: current[gatewayId]?.capabilities || false } }));
    }
  };

  const testGatewayCapabilities = async (gatewayId: string) => {
    const models = catalog?.gateways.find((gateway) => gateway.id === gatewayId)?.models || [];
    if (!models.length) {
      onNotice('error', '当前网关没有可检测的模型');
      return;
    }
    setGatewayTests((current) => ({ ...current, [gatewayId]: { connectivity: current[gatewayId]?.connectivity || false, capabilities: true } }));
    setModelCapabilityTests((current) => ({
      ...current,
      [gatewayId]: Object.fromEntries(models.map((modelName) => [modelName, { status: 'testing' }])),
    }));
    try {
      for (let offset = 0; offset < models.length; offset += MODEL_TEST_BATCH_SIZE) {
        const batch = models.slice(offset, offset + MODEL_TEST_BATCH_SIZE);
        await Promise.all(batch.map(async (modelName) => {
          try {
            const capability = await workbenchApi.testModelCapability(gatewayId, modelName);
            setCatalog((current) => current ? {
              ...current,
              gateways: current.gateways.map((gateway) => gateway.id === gatewayId ? {
                ...gateway,
                capabilities: { ...gateway.capabilities, [modelName]: capability },
              } : gateway),
            } : current);
            setModelCapabilityTests((current) => ({
              ...current,
              [gatewayId]: { ...current[gatewayId], [modelName]: { status: 'success', detail: capability.detail } },
            }));
          } catch (error) {
            setModelCapabilityTests((current) => ({
              ...current,
              [gatewayId]: { ...current[gatewayId], [modelName]: { status: 'error', detail: error instanceof Error ? error.message : String(error) } },
            }));
          }
        }));
      }
    } finally {
      setGatewayTests((current) => ({ ...current, [gatewayId]: { connectivity: current[gatewayId]?.connectivity || false, capabilities: false } }));
    }
  };

  if (loading && !settings) return <main className="settings-page"><div className="settings-state"><LoaderCircle className="spin" size={20} />正在读取设置</div></main>;
  if (!settings || !forms) return <main className="settings-page"><div className="settings-state"><CircleAlert size={20} />设置读取失败<button type="button" className="button" onClick={() => void loadSettings()}><RefreshCw size={14} />重试</button></div></main>;

  const targetLabels: Record<ModelTarget, string> = {
    manual: 'Manual 页面识别模型',
    auto: 'Auto 页面识别模型',
    midscene: 'Midscene 模型',
    self_heal: '自愈模型',
  };

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
    const capability = catalog?.gateways.find((gateway) => gateway.id === form.gatewayId)?.capabilities[form.modelName]
      || slotForTarget(settings, target).capability;
    const capabilityLabel = capability?.mode === 'native' ? '原生结构化输出' : capability?.mode === 'local' ? '本地结构化输出' : capability?.mode === 'unavailable' ? '不支持结构化输出' : '未检测';
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
        {form.modelName && <small className={`model-capability-status ${capability?.mode || 'unverified'}`} title={capability?.detail}>{capabilityLabel}</small>}
      </div>
      {renderModelParameters(target, disabled)}
    </div>;
  };

  const renderGateway = (gateway: ModelGatewayCatalog) => {
    const test = gatewayTests[gateway.id];
    const gatewayTesting = Boolean(test?.connectivity || test?.capabilities);
    const stored = settings.gateways.find((item) => item.id === gateway.id);
    if (!stored) return null;
    return <section className="gateway-catalog-card" key={gateway.id}>
      <header className="gateway-catalog-card-header">
        <div className="gateway-catalog-card-title"><span><strong>{gateway.label}</strong><em>{gateway.kind === 'default' ? '默认' : '自定义'}</em></span><code title={gateway.baseUrl}>{gateway.baseUrl}</code><small><KeyRound size={11} />{gateway.apiKeyConfigured ? `已配置 ${gateway.apiKeyHint || ''}` : '未配置 API Key'}</small></div>
        <div className="gateway-catalog-actions">
          <button type="button" className="icon-button" aria-label={`测试 ${gateway.label} 连通性`} title="测试连通性" disabled={gatewayTesting || gatewayDeleting} onClick={() => void testGateway(gateway.id)}>{test?.connectivity ? <LoaderCircle className="spin" size={14} /> : <PlugZap size={14} />}</button>
          <button type="button" className="icon-button" aria-label={`检测 ${gateway.label} 模型结构化输出能力`} title="检测模型结构化输出能力" disabled={gatewayTesting || gatewayDeleting} onClick={() => void testGatewayCapabilities(gateway.id)}>{test?.capabilities ? <LoaderCircle className="spin" size={14} /> : <StructuredOutputIcon />}</button>
          <button type="button" className="icon-button" aria-label={`刷新 ${gateway.label} 模型列表`} title="刷新模型列表" disabled={modelsLoading || gatewayDeleting} onClick={() => void loadModels()}><RefreshCw className={modelsLoading ? 'spin' : ''} size={14} /></button>
          <button type="button" className="icon-button" aria-label={`编辑 ${gateway.label}`} title="编辑网关" disabled={gatewayDeleting} onClick={() => openGatewayDialog(stored)}><Pencil size={14} /></button>
          <button type="button" className="icon-button danger-icon" aria-label={`删除 ${gateway.label}`} title="删除网关" disabled={gatewayDeleting} onClick={() => void deleteGateway(gateway.id, gateway.label)}><Trash2 size={14} /></button>
        </div>
      </header>
      {gateway.error ? <div className="model-list-error"><CircleAlert size={14} /><span title={gateway.error}>{gateway.error}</span></div> : <div className="model-gateway-models" aria-label={`${gateway.label} 模型`}>
        {gateway.models.length > 0 && <div className="gateway-model-table-header" aria-hidden="true"><span /><span>模型名称</span><span>模型类型</span><span>连通性</span><span>结构化输出</span></div>}
        {gateway.models.length > 0 && <div className="gateway-model-table-body">{gateway.models.map((modelName) => {
          const capability = gateway.capabilities[modelName];
          const connectivityTest = modelConnectivityTests[gateway.id]?.[modelName];
          const capabilityTest = modelCapabilityTests[gateway.id]?.[modelName];
          const label = capability?.mode === 'native' ? '原生结构化输出' : capability?.mode === 'local' ? '本地结构化输出' : capability?.mode === 'unavailable' ? '不支持结构化输出' : '未检测';
          const connectivityLabel = connectivityTest?.status === 'testing' ? '测试中' : connectivityTest?.status === 'success' ? connectivityTest.detail : connectivityTest?.status === 'error' ? '连接失败' : '未测试';
          const capabilityLabel = capabilityTest?.status === 'testing' ? '检测中' : capabilityTest?.status === 'error' ? '检测失败' : label;
          return <div key={modelName} className="gateway-model-row"><i className={capability?.mode || 'unverified'} aria-hidden="true" /><strong title={modelName}>{modelName}</strong><code>{gateway.modelFamilies[modelName] || familyForModel(modelName)}</code><span className={`model-connectivity-result ${connectivityTest?.status || 'untested'}`} title={connectivityTest?.detail}>{connectivityTest?.status === 'testing' && <LoaderCircle className="spin" size={12} />}{connectivityLabel}</span><span className={`model-capability-badge ${capabilityTest?.status === 'error' ? 'error' : capability?.mode || 'unverified'}`} title={capabilityTest?.detail || capability?.detail}>{capabilityTest?.status === 'testing' && <LoaderCircle className="spin" size={12} />}{capabilityLabel}</span></div>;
        })}</div>}
        {!gateway.models.length && <div className="model-list-empty">没有可用模型</div>}
      </div>}
    </section>;
  };

  const sectionTitle = activeSection === 'model-gateways' ? '模型网关' : activeSection === 'mode-configuration' ? '模式配置' : '识别提示词';
  const sectionDescription = activeSection === 'model-gateways' ? '管理默认与自定义网关及模型连接。' : activeSection === 'mode-configuration' ? '选择工作模式并指定使用的模型。' : '查看当前识别请求使用的提示词，以及模型必须遵守的规则和约束。';
  const settingsSections = (() => {
    const configured = settings.sections?.length ? settings.sections : [
      { id: 'model-gateways', label: '模型网关', order: 10 },
      { id: 'mode-configuration', label: '模式配置', order: 20 },
    ];
    return configured.some((section) => section.id === 'recognition-prompt')
      ? configured
      : [...configured, { id: 'recognition-prompt', label: '识别提示词', order: 30 }];
  })();

  const renderRuleEditor = (key: string, autoFocus = false) => <div key={key} className="prompt-rule-editor">
    <input autoFocus={autoFocus} value={draftRule.title} placeholder="规则名称" onChange={(event) => setDraftRule({ ...draftRule, title: event.target.value })} />
    <textarea ref={resizeRuleTextarea} value={draftRule.description} placeholder="规则内容" onChange={(event) => { setDraftRule({ ...draftRule, description: event.target.value }); resizeRuleTextarea(event.currentTarget); }} />
    <div><button type="button" className="icon-button" title="保存规则" aria-label="保存规则" disabled={ruleSaving || !draftRule.title.trim() || !draftRule.description.trim()} onClick={() => void saveRule()}>{ruleSaving ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}</button><button type="button" className="icon-button" title="取消编辑" aria-label="取消编辑" disabled={ruleSaving} onClick={cancelRuleEditing}><X size={14} /></button></div>
  </div>;

  const renderEditableRuleGroup = (category: EditableRuleSource, title: string, emptyMessage: string) => {
    const rules = promptData?.rules.filter((rule) => rule.source === category) || [];
    const addingHere = editingRuleKey === '__new__' && editingRuleCategory === category;
    return <section className="prompt-rule-group" aria-labelledby={`${category}-rules-title`}>
      <header><h3 id={`${category}-rules-title`}>{title}</h3>{rules.length > 0 && <button type="button" className="button" disabled={ruleSaving || editingRuleKey !== null} onClick={() => beginAddRule(category)}><Plus size={13} />新增规则</button>}</header>
      {category === 'element-universal' && rules.length > 0 && <p className="prompt-rule-group-description">元素共相是从多个同构元素中归纳出的共有结构、属性与交互行为，不代表某一个具体元素实例。</p>}
      <div className="prompt-rules-list">
        {rules.map((rule) => editingRuleKey === rule.key ? renderRuleEditor(rule.key) : <article key={rule.key} className="prompt-rule-card"><div><strong>{rule.title}</strong></div><p>{rule.description}</p><span className="prompt-rule-actions"><button type="button" className="icon-button" title="编辑规则" aria-label={`编辑${rule.title}`} disabled={ruleSaving} onClick={() => beginEditRule(rule)}><Pencil size={13} /></button><button type="button" className="icon-button danger-icon" title="删除规则" aria-label={`删除${rule.title}`} disabled={ruleSaving} onClick={() => void deleteRule(rule.key, category)}><Trash2 size={13} /></button></span></article>)}
        {rules.length === 0 && !addingHere && <div className="prompt-rules-empty"><span>{emptyMessage}</span><button type="button" className="prompt-empty-add" disabled={ruleSaving || editingRuleKey !== null} onClick={() => beginAddRule(category)}>新增规则</button></div>}
        {addingHere && renderRuleEditor(`new-${category}`, true)}
      </div>
    </section>;
  };

  return (
    <main className="settings-page">
      <aside className="settings-sidebar">
        <header><Settings size={18} /><strong>设置</strong></header>
        <nav aria-label="设置分类">
          {settingsSections.sort((left, right) => left.order - right.order).map((section) => <button key={section.id} type="button" className={activeSection === section.id ? 'active' : ''} onClick={() => setActiveSection(section.id)}><span>{section.label}</span></button>)}
        </nav>
      </aside>

      <div className="settings-detail">
        <header className="settings-detail-header"><h1>{sectionTitle}</h1><p>{sectionDescription}</p></header>

        {activeSection === 'model-gateways' ? <section className="gateway-detail-page" aria-label="模型网关详情">
          <label className="model-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型" /></label>
          <div className="gateway-catalog-group"><h3><span>默认网关 <small>{defaultGateways.length}</small></span></h3>{filteredGateways.filter((gateway) => gateway.kind === 'default').map(renderGateway)}{!defaultGateways.length && <div className="settings-empty"><span>暂无默认网关</span></div>}</div>
          <div className="gateway-catalog-group"><h3><span>自定义网关 <small>{customGateways.length} / {CUSTOM_GATEWAY_LIMIT}</small>{customGateways.length > 0 && customGateways.length < CUSTOM_GATEWAY_LIMIT && <button type="button" className="button gateway-inline-add" disabled={gatewaySaving} onClick={() => openGatewayDialog()}><Plus size={13} />添加网关</button>}</span></h3>{filteredGateways.filter((gateway) => gateway.kind === 'custom').map(renderGateway)}{!customGateways.length && <div className="settings-empty gateway-empty-state"><span>尚未添加自定义网关</span>{customGateways.length < CUSTOM_GATEWAY_LIMIT && <button type="button" className="button" disabled={gatewaySaving} onClick={() => openGatewayDialog()}><Plus size={13} />添加网关</button>}</div>}</div>
        </section> : activeSection === 'mode-configuration' ? <section className="mode-detail-page" aria-labelledby="mode-settings-title">
          <div className="settings-group-heading"><div><Gauge size={17} /><span><h2 id="mode-settings-title">工作模式</h2><p>页面识别使用单模型；Auto 保留为后续自动探索配置。</p></span></div></div>
          <div className="setting-row mode-setting-row"><div className="setting-copy"><strong>工作模式</strong><span>页面识别使用单模型配置。</span></div><div className="mode-segment" role="radiogroup" aria-label="工作模式">{(['manual', 'auto'] as WorkbenchMode[]).map((value) => <button key={value} type="button" role="radio" aria-checked={mode === value} className={mode === value ? 'active' : ''} disabled={value === 'auto'} onClick={() => changeConfigurationMode(value)}>{MODE_LABELS[value]}{value === 'auto' && <small>开发中</small>}</button>)}</div></div>
          {mode === 'manual' && <>
            <div className="settings-group-heading"><div><span><h2>Manual</h2><p>人工触发页面识别，识别后进入人工维护与审核。</p></span></div></div>
            {renderModelSelect('manual', '页面识别模型', '仅供 Manual 模式使用。')}
          </>}
          {mode === 'auto' && <>
            <div className="settings-group-heading"><div><span><h2>Auto</h2><p>自动探索使用独立的页面识别模型与设备交互模型，当前工作流尚未开放。</p></span></div></div>
            {renderModelSelect('auto', '页面识别模型', '仅供 Auto 模式使用，不与 Manual 共用。')}
            {renderModelSelect('midscene', 'Midscene 模型', 'Auto 模式用于理解并操作设备。')}
          </>}
          <div className="settings-group-heading"><div><span><h2>结构自愈</h2><p>识别结果结构检查失败时调用一次，不参与页面识别。</p></span></div></div>
          {renderModelSelect('self_heal', '自愈模型', '修复后的完整 JSON 会再次经过本地归一化和 Schema 校验。')}
          <footer className="settings-save-bar"><span>{dirty ? '有未保存的更改' : <><Check size={13} />设置已同步</>}</span><button type="button" className="button" disabled={!dirty || saving} onClick={resetCurrentConfiguration}><RotateCcw size={14} />还原</button><button type="button" className="button button-primary" disabled={!dirty || saving} onClick={() => void saveConfiguration()}>{saving ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}保存设置</button></footer>
        </section> : <section className="prompt-detail-page" aria-labelledby="recognition-prompt-title">
            <div className="settings-group-heading"><div><FileText size={17} /><span><h2 id="recognition-prompt-title">当前识别提示词</h2></span></div></div>
          {promptLoading && !promptData ? <div className="settings-empty"><LoaderCircle className="spin" size={17} />正在读取提示词</div> : promptData ? <>
            <div className="prompt-rules-toolbar"><strong>规则与约束</strong></div>
            <section className="prompt-rule-group" aria-labelledby="builtin-rules-title">
              <h3 id="builtin-rules-title">内置规则</h3>
              <div className="prompt-rules-list">
                {promptData.rules.filter((rule) => rule.source === 'builtin').map((rule) => <article key={rule.key} className="prompt-rule-card"><div><strong>{rule.title}</strong></div><p>{rule.description}</p></article>)}
              </div>
            </section>
            {renderEditableRuleGroup('element-universal', '元素共相', '暂无元素共相规则。可新增规则定义多个同构元素共有的结构、属性与交互。')}
            {renderEditableRuleGroup('custom', '自定义规则', '暂无自定义规则。')}
            <div className={`prompt-preview ${promptExpanded ? 'expanded' : ''}`}><div className="prompt-preview-heading"><span>完整提示词</span><div className="prompt-text-actions"><button type="button" className="prompt-text-action" disabled={promptLoading} onClick={() => void loadPrompt()}>{promptLoading ? '刷新中' : '刷新'}</button><button type="button" className="prompt-text-action" disabled={!promptData?.prompt || !navigator.clipboard} onClick={() => void copyPrompt()}>复制提示词</button></div></div><pre aria-label="完整提示词">{promptData.prompt}</pre><button type="button" className="prompt-expand-button" onClick={() => setPromptExpanded((current) => !current)}><ChevronDown size={12} className={promptExpanded ? 'rotated' : ''} />{promptExpanded ? '收起提示词' : '展开提示词'}</button></div>
          </> : <div className="settings-empty"><span>提示词读取失败</span><button type="button" className="button" onClick={() => void loadPrompt()}><RefreshCw size={13} />重试</button></div>}
        </section>}
      </div>

      {gatewayForm && <div className="gateway-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !gatewaySaving && !gatewayDeleting) setGatewayForm(null); }}>
        <form className="gateway-dialog" role="dialog" aria-modal="true" aria-labelledby="gateway-dialog-title" autoComplete="off" onSubmit={(event) => { event.preventDefault(); if (!gatewaySaving && !gatewayDeleting) void saveGateway(); }} onMouseDown={(event) => event.stopPropagation()}>
          <header><div><strong id="gateway-dialog-title">{editingGatewayId ? '编辑模型网关' : '添加自定义网关'}</strong><span>保存后可用于单模型页面识别、Auto 和 Midscene 配置。</span></div><button type="button" className="icon-button" aria-label="关闭" title="关闭" disabled={gatewaySaving || gatewayDeleting} onClick={() => setGatewayForm(null)}><X size={16} /></button></header>
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

      {pendingMode && <div className="gateway-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPendingMode(null); }}>
        <section className="gateway-dialog mode-change-dialog" role="dialog" aria-modal="true" aria-labelledby="mode-change-dialog-title" aria-describedby="mode-change-dialog-description" onKeyDown={(event) => { if (event.key === 'Escape') setPendingMode(null); }} onMouseDown={(event) => event.stopPropagation()}>
          <header><div><strong id="mode-change-dialog-title">切换配置模式？</strong><span>当前 {MODE_LABELS[mode]} 配置尚未保存。</span></div><button type="button" className="icon-button" aria-label="关闭" title="关闭" onClick={() => setPendingMode(null)}><X size={16} /></button></header>
          <div className="mode-change-dialog-body"><CircleAlert size={17} /><p id="mode-change-dialog-description">切换到 {MODE_LABELS[pendingMode]} 后，当前未保存的更改将被丢弃。</p></div>
          <footer><button type="button" autoFocus className="button" onClick={() => setPendingMode(null)}>取消</button><button type="button" className="button button-primary" onClick={confirmModeChange}>继续切换</button></footer>
        </section>
      </div>}
    </main>
  );
}
