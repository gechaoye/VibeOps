import {
  Check,
  CircleAlert,
  Cpu,
  Eye,
  EyeOff,
  FileText,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Save,
  ServerCog,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { workbenchApi } from './api';
import type { WorkerSlotSettings, WorkerModelSettings } from './types';

interface ModelSettingsProps {
  onSaved: (settings: WorkerModelSettings) => void;
  onNotice: (type: 'info' | 'error' | 'success', text: string) => void;
}

interface ModelForm {
  baseUrl: string;
  modelName: string;
  modelFamily: string;
  timeout: number;
  temperature: number;
  reasoningEnabled: boolean;
  apiKey: string;
}

function formFromSettings(settings: Pick<WorkerSlotSettings, 'config'>): ModelForm {
  return {
    baseUrl: settings.config.baseUrl,
    modelName: settings.config.modelName,
    modelFamily: settings.config.modelFamily,
    timeout: settings.config.timeout,
    temperature: settings.config.temperature,
    reasoningEnabled: settings.config.reasoningEnabled,
    apiKey: '',
  };
}

export function ModelSettings({ onSaved, onNotice }: ModelSettingsProps) {
  const [activeWorker, setActiveWorker] = useState<'worker_a' | 'worker_b'>('worker_a');
  const [settings, setSettings] = useState<WorkerModelSettings | null>(null);
  const [form, setForm] = useState<ModelForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const result = await workbenchApi.modelSettings();
      setSettings(result);
      setForm(formFromSettings(activeWorker === 'worker_a' ? result.workerA : result.workerB));
    } catch (error) {
      onNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const workerSettings = settings ? (activeWorker === 'worker_a' ? settings.workerA : settings.workerB) : null;

  useEffect(() => {
    if (workerSettings) setForm(formFromSettings(workerSettings));
  }, [activeWorker]);

  const activePreset = useMemo(() => workerSettings?.presets.find((preset) => (
    preset.modelName === form?.modelName && preset.modelFamily === form?.modelFamily
  )) || null, [form?.modelFamily, form?.modelName, workerSettings?.presets]);

  const dirty = useMemo(() => {
    if (!workerSettings || !form) return false;
    return Boolean(form.apiKey)
      || form.baseUrl !== workerSettings.config.baseUrl
      || form.modelName !== workerSettings.config.modelName
      || form.modelFamily !== workerSettings.config.modelFamily
      || form.timeout !== workerSettings.config.timeout
      || form.temperature !== workerSettings.config.temperature
      || form.reasoningEnabled !== workerSettings.config.reasoningEnabled;
  }, [form, workerSettings]);

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      const result = await workbenchApi.saveModelSettings({ ...form, worker: activeWorker });
      setSettings(result);
      const savedWorker = activeWorker === 'worker_a' ? result.workerA : result.workerB;
      if (savedWorker) setForm(formFromSettings(savedWorker));
      onSaved(result);
      onNotice('success', result.runtimeReloaded === false ? '模型配置已保存，重新连接设备后生效' : `${activeWorker === 'worker_a' ? 'Worker A' : 'Worker B'} 已切换为 ${savedWorker?.config.modelName || form.modelName}`);
    } catch (error) {
      onNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  if (loading && !settings) {
    return <main className="model-settings-workspace"><div className="settings-loading"><LoaderCircle className="spin" size={22} /><span>正在读取模型配置</span></div></main>;
  }

  if (!settings || !workerSettings || !form) {
    return <main className="model-settings-workspace"><div className="settings-loading"><CircleAlert size={22} /><span>模型配置读取失败</span><button type="button" className="button" onClick={() => void load()}><RefreshCw size={14} />重试</button></div></main>;
  }

  return (
    <main className="model-settings-workspace">
      <header className="model-settings-header">
        <div>
          <ServerCog size={21} />
          <span><strong>{activeWorker === 'worker_a' ? 'Worker A 模型' : 'Worker B 模型'}</strong><small>独立识别画面并生成结构化答卷</small></span>
        </div>
        <div className="model-worker-switch" role="tablist" aria-label="Worker 选择">
          <button type="button" className={activeWorker === 'worker_a' ? 'active' : ''} onClick={() => setActiveWorker('worker_a')}>Worker A</button>
          <button type="button" className={activeWorker === 'worker_b' ? 'active' : ''} onClick={() => setActiveWorker('worker_b')}>Worker B</button>
        </div>
        <div className="settings-runtime">
          <i className={workerSettings.runtimeSynced ? 'synced' : ''} />
          <span><small>当前运行时</small><strong>{workerSettings.runtimeModel || '未配置'}</strong></span>
          <span className={workerSettings.runtimeSynced ? 'runtime-badge synced' : 'runtime-badge'}>{workerSettings.runtimeSynced ? '已同步' : '待刷新'}</span>
        </div>
      </header>

      <div className="model-settings-body">
        <section className="model-preset-section">
          <div className="settings-section-title"><span><Cpu size={16} /><strong>模型预设</strong></span><small>单价：每百万 Token</small></div>
          <div className="model-preset-list" role="radiogroup" aria-label={`${activeWorker === 'worker_a' ? 'Worker A' : 'Worker B'} 模型预设`}>
            {workerSettings.presets.map((preset) => {
              const selected = activePreset?.id === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`model-preset ${selected ? 'selected' : ''}`}
                  onClick={() => setForm((current) => current ? {
                    ...current,
                    baseUrl: preset.modelFamily.startsWith('qwen') ? 'https://dashscope.aliyuncs.com/compatible-mode/v1' : current.baseUrl,
                    modelName: preset.modelName,
                    modelFamily: preset.modelFamily,
                  } : current)}
                >
                  <i className="preset-radio">{selected && <Check size={11} />}</i>
                  <span className="preset-copy"><span><strong>{preset.name}</strong><em>{preset.badge}</em></span><small>{preset.summary}</small></span>
                  <span className="preset-price">{preset.inputPrice && preset.outputPrice ? <><small>输入 {preset.inputPrice}</small><small>输出 {preset.outputPrice}</small></> : <small>按量计费</small>}</span>
                </button>
              );
            })}
          </div>
          <div className="realtime-compatibility"><CircleAlert size={15} /><span><strong>Realtime 模型</strong><small>使用独立实时接口，当前 Worker HTTP 链路不支持。</small></span></div>
        </section>

        <form className="model-config-section" autoComplete="off" onSubmit={(event) => { event.preventDefault(); if (dirty && !saving) void save(); }}>
          <div className="settings-section-title"><span><FileText size={16} /><strong>连接配置</strong></span><button type="button" className="icon-button" title="重新读取 .env" disabled={loading || saving} onClick={() => void load()}><RefreshCw className={loading ? 'spin' : ''} size={14} /></button></div>
          <div className="env-path"><span>配置文件</span><code title={workerSettings.envPath}>{workerSettings.envPath}</code></div>

          <div className="settings-form">
            <label className="settings-field settings-field-wide"><span>Base URL</span><input autoComplete="off" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} /></label>
            <label className="settings-field settings-field-wide"><span>API Key</span><span className="secret-input"><KeyRound size={14} /><input type={showApiKey ? 'text' : 'password'} value={form.apiKey} placeholder={workerSettings.config.apiKeyHint ? `已配置 ${workerSettings.config.apiKeyHint}` : '尚未配置'} autoComplete="off" onChange={(event) => setForm({ ...form, apiKey: event.target.value })} /><button type="button" title={showApiKey ? '隐藏新密钥' : '显示新密钥'} onClick={() => setShowApiKey((value) => !value)}>{showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}</button></span></label>
            <label className="settings-field"><span>模型名称</span><input autoComplete="off" value={form.modelName} onChange={(event) => setForm({ ...form, modelName: event.target.value })} /></label>
            <label className="settings-field"><span>Model Family</span><select value={form.modelFamily} onChange={(event) => setForm({ ...form, modelFamily: event.target.value })}>{workerSettings.modelFamilies.map((family) => <option key={family} value={family}>{family}</option>)}</select></label>
            <label className="settings-field"><span>超时时间</span><span className="number-suffix"><input type="number" min={10000} max={600000} step={10000} value={form.timeout} onChange={(event) => setForm({ ...form, timeout: Number(event.target.value) })} /><small>ms</small></span></label>
            <label className="settings-field"><span>Temperature</span><input type="number" min={0} max={2} step={0.1} value={form.temperature} onChange={(event) => setForm({ ...form, temperature: Number(event.target.value) })} /></label>
            <div className="settings-field settings-toggle-field"><span>模型思考</span><button type="button" role="switch" aria-checked={form.reasoningEnabled} className={`settings-switch ${form.reasoningEnabled ? 'active' : ''}`} onClick={() => setForm({ ...form, reasoningEnabled: !form.reasoningEnabled })}><i /></button></div>
          </div>

          <footer className="settings-actions">
            <span>{activePreset ? `${activePreset.name} · ${activePreset.modelFamily}` : '自定义非实时视觉模型'}</span>
            <button type="button" className="button" disabled={!dirty || saving} onClick={() => setForm(formFromSettings(workerSettings))}><RefreshCw size={14} />还原</button>
            <button type="submit" className="button button-primary" disabled={!dirty || saving}>{saving ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}保存并应用</button>
          </footer>
        </form>
      </div>
    </main>
  );
}
