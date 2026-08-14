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
import type { ModelRoleSettings, ScoutModelSettings } from './types';

interface ModelSettingsProps {
  onSaved: (settings: ScoutModelSettings) => void;
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

function formFromSettings(settings: Pick<ModelRoleSettings, 'config'>): ModelForm {
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
  const [activeRole, setActiveRole] = useState<'scout' | 'reviewer'>('scout');
  const [settings, setSettings] = useState<ScoutModelSettings | null>(null);
  const [form, setForm] = useState<ModelForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const result = await workbenchApi.modelSettings();
      setSettings(result);
      setForm(formFromSettings(activeRole === 'reviewer' && result.reviewer ? result.reviewer : result));
    } catch (error) {
      onNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const roleSettings = activeRole === 'scout' ? settings : settings?.reviewer || null;

  useEffect(() => {
    if (roleSettings) setForm(formFromSettings(roleSettings));
  }, [activeRole]);

  const activePreset = useMemo(() => roleSettings?.presets.find((preset) => (
    preset.modelName === form?.modelName && preset.modelFamily === form?.modelFamily
  )) || null, [form?.modelFamily, form?.modelName, roleSettings?.presets]);

  const dirty = useMemo(() => {
    if (!roleSettings || !form) return false;
    return Boolean(form.apiKey)
      || form.baseUrl !== roleSettings.config.baseUrl
      || form.modelName !== roleSettings.config.modelName
      || form.modelFamily !== roleSettings.config.modelFamily
      || form.timeout !== roleSettings.config.timeout
      || form.temperature !== roleSettings.config.temperature
      || form.reasoningEnabled !== roleSettings.config.reasoningEnabled;
  }, [form, roleSettings]);

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      const result = await workbenchApi.saveModelSettings({ ...form, role: activeRole });
      setSettings(result);
      const savedRole = activeRole === 'scout' ? result : result.reviewer;
      if (savedRole) setForm(formFromSettings(savedRole));
      onSaved(result);
      onNotice('success', result.runtimeReloaded === false ? '模型配置已保存，重新连接设备后生效' : `${activeRole === 'scout' ? 'Scout' : 'AI Reviewer'} 已切换为 ${savedRole?.config.modelName || form.modelName}`);
    } catch (error) {
      onNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  if (loading && !settings) {
    return <main className="model-settings-workspace"><div className="settings-loading"><LoaderCircle className="spin" size={22} /><span>正在读取模型配置</span></div></main>;
  }

  if (!settings || !roleSettings || !form) {
    return <main className="model-settings-workspace"><div className="settings-loading"><CircleAlert size={22} /><span>模型配置读取失败</span><button type="button" className="button" onClick={() => void load()}><RefreshCw size={14} />重试</button></div></main>;
  }

  return (
    <main className="model-settings-workspace">
      <header className="model-settings-header">
        <div>
          <ServerCog size={21} />
          <span><strong>{activeRole === 'scout' ? 'Scout 模型' : 'AI Reviewer'}</strong><small>{activeRole === 'scout' ? '只读页面清点与结构化提取' : '对 Scout 结果做初审，之后仍需人工确认'}</small></span>
        </div>
        <div className="model-role-switch" role="tablist" aria-label="模型角色">
          <button type="button" className={activeRole === 'scout' ? 'active' : ''} onClick={() => setActiveRole('scout')}>Scout</button>
          <button type="button" className={activeRole === 'reviewer' ? 'active' : ''} onClick={() => setActiveRole('reviewer')}>AI Reviewer</button>
        </div>
        <div className="settings-runtime">
          <i className={roleSettings.runtimeSynced ? 'synced' : ''} />
          <span><small>当前运行时</small><strong>{roleSettings.runtimeModel || '未配置'}</strong></span>
          <span className={roleSettings.runtimeSynced ? 'runtime-badge synced' : 'runtime-badge'}>{roleSettings.runtimeSynced ? '已同步' : '待刷新'}</span>
        </div>
      </header>

      <div className="model-settings-body">
        <section className="model-preset-section">
          <div className="settings-section-title"><span><Cpu size={16} /><strong>模型预设</strong></span><small>单价：每百万 Token</small></div>
          <div className="model-preset-list" role="radiogroup" aria-label={`${activeRole === 'scout' ? 'Scout' : 'AI Reviewer'} 模型预设`}>
            {roleSettings.presets.map((preset) => {
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
                    baseUrl: activeRole === 'scout' ? 'https://dashscope.aliyuncs.com/compatible-mode/v1' : current.baseUrl,
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
          {activeRole === 'scout' && <div className="realtime-compatibility"><CircleAlert size={15} /><span><strong>Qwen3.5 Omni Flash Realtime</strong><small>使用独立实时接口，当前 Scout HTTP 链路不支持。</small></span></div>}
        </section>

        <form className="model-config-section" autoComplete="off" onSubmit={(event) => { event.preventDefault(); if (dirty && !saving) void save(); }}>
          <div className="settings-section-title"><span><FileText size={16} /><strong>连接配置</strong></span><button type="button" className="icon-button" title="重新读取 .env" disabled={loading || saving} onClick={() => void load()}><RefreshCw className={loading ? 'spin' : ''} size={14} /></button></div>
          <div className="env-path"><span>配置文件</span><code title={roleSettings.envPath}>{roleSettings.envPath}</code></div>

          <div className="settings-form">
            <label className="settings-field settings-field-wide"><span>Base URL</span><input autoComplete="off" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} /></label>
            <label className="settings-field settings-field-wide"><span>API Key</span><span className="secret-input"><KeyRound size={14} /><input type={showApiKey ? 'text' : 'password'} value={form.apiKey} placeholder={roleSettings.config.apiKeyHint ? `已配置 ${roleSettings.config.apiKeyHint}` : '尚未配置'} autoComplete="off" onChange={(event) => setForm({ ...form, apiKey: event.target.value })} /><button type="button" title={showApiKey ? '隐藏新密钥' : '显示新密钥'} onClick={() => setShowApiKey((value) => !value)}>{showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}</button></span></label>
            <label className="settings-field"><span>模型名称</span><input autoComplete="off" value={form.modelName} onChange={(event) => setForm({ ...form, modelName: event.target.value })} /></label>
            <label className="settings-field"><span>Model Family</span><select value={form.modelFamily} onChange={(event) => setForm({ ...form, modelFamily: event.target.value })}>{roleSettings.modelFamilies.map((family) => <option key={family} value={family}>{family}</option>)}</select></label>
            <label className="settings-field"><span>超时时间</span><span className="number-suffix"><input type="number" min={10000} max={600000} step={10000} value={form.timeout} onChange={(event) => setForm({ ...form, timeout: Number(event.target.value) })} /><small>ms</small></span></label>
            <label className="settings-field"><span>Temperature</span><input type="number" min={0} max={2} step={0.1} value={form.temperature} onChange={(event) => setForm({ ...form, temperature: Number(event.target.value) })} /></label>
            <div className="settings-field settings-toggle-field"><span>模型思考</span><button type="button" role="switch" aria-checked={form.reasoningEnabled} className={`settings-switch ${form.reasoningEnabled ? 'active' : ''}`} onClick={() => setForm({ ...form, reasoningEnabled: !form.reasoningEnabled })}><i /></button></div>
          </div>

          <footer className="settings-actions">
            <span>{activePreset ? `${activePreset.name} · ${activePreset.modelFamily}` : '自定义非实时视觉模型'}</span>
            <button type="button" className="button" disabled={!dirty || saving} onClick={() => setForm(formFromSettings(roleSettings))}><RefreshCw size={14} />还原</button>
            <button type="submit" className="button button-primary" disabled={!dirty || saving}>{saving ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}保存并应用</button>
          </footer>
        </form>
      </div>
    </main>
  );
}
