import { chmod, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';

const TARGETS = ['manual', 'auto', 'midscene', 'self_heal'];
const DEFAULT_GATEWAY_SNAPSHOT_KEY = 'default_gateway_snapshot_v1';
const WORKBENCH_PREFERENCES_KEY = 'workbench_preferences_v1';
const MODEL_CAPABILITIES_KEY = 'model_capabilities_v1';
const LEGACY_RECOGNITION_PROMPT_RULES_KEY = 'recognition_prompt_rules_v1';
const PREVIOUS_RECOGNITION_PROMPT_RULES_KEY = 'recognition_prompt_rules_v2';
const PREVIOUS_ELEMENT_UNIVERSAL_RULES_KEY = 'element_universal_rules_v3';
const RECOGNITION_PROMPT_RULES_KEY = 'element_universal_rules_v4';
const ELEMENT_UNIVERSAL_RULE_KEYS = new Set([
  'managed-list-abstraction',
  'managed-dynamic-content',
]);

function normalizeRecognitionPromptRule(rule) {
  if (!rule || typeof rule !== 'object') return rule;
  const category = rule.category === 'element-universal' || rule.category === 'custom'
    ? rule.category
    : ELEMENT_UNIVERSAL_RULE_KEYS.has(rule.key) ? 'element-universal' : 'custom';
  return { ...rule, category };
}

function normalizeRecognitionPromptRules(rules) {
  return Array.isArray(rules)
    ? rules.filter((rule) => rule?.key !== 'managed-carousel').map(normalizeRecognitionPromptRule)
    : [];
}

export const DEFAULT_RECOGNITION_PROMPT_RULES = [
  {
    key: 'managed-list-abstraction',
    category: 'element-universal',
    title: '列表项元素共相',
    description: '当两个及以上对象共享稳定的视觉结构和交互职责时，可输出一个 abstraction.kind=repeated-template 的共相，并按实际形态选择 elementType（列表项使用 list-item；表单字段块使用 section，整体录入集合才使用 form）。业务标签不同不是排除理由；例如标题、必填标记和多行输入框组成的多个表单字段可以属于同一字段模板。重复字段中的序号、必填标记、字段标签、输入框内可见占位提示语和输入框职责不同，必须分别作为 fields 记录；每个 field 的 instanceRegions 只填写截图实际可见区域，不可见内容不补造。位于模板实例内且已由 input、text-area 或 rich-text-input field 表达的输入控件，只保留为该共相字段的多个实例，不得再作为独立顶层元素重复输出。跨实例共享且连续的视觉分隔边界是独立块级容器的强证据，不预设颜色、明暗或方向；根据连续性、厚度、相邻区域对比和横向或纵向跨度识别分隔边界，并沿实际方向确定实例边界。每个实例边界必须覆盖对应块内的标题和输入控件。共相必须提供 fields、每个字段的 instanceRegions、instanceCount、instanceRegions 和 bboxStyle=abstract；每个实例保留可见标签、必填状态和位置，只记录截图实际可见区域，底部部分可见实例不得推断屏幕外边界，不补造字段、头像或图标。',
  },
  {
    key: 'managed-dynamic-content',
    category: 'element-universal',
    title: '动态元素共相',
    description: '随账号、时间、状态或数据变化的可见内容必须设置 dynamicContent=true，但只有字段共同属于同一稳定展示载荷时，才创建 abstraction.kind=dynamic-template、instanceCount 固定为 1。当前用户头像、姓名、组织、部门或职位、轮播/横幅等属于可能的动态载荷，但必须有共同变化的槽位证据；轮播区域按实际形态使用 elementType=carousel。用户可填写的 form、input、text-area、rich-text-input 以及包含这些字段的录入模板，不因填写值未来会变化而成为动态载荷；重复录入结构应使用 repeated-template。共相只保留共同变化的可见字段、显示条件和交互职责；当前文案、图片、数值和业务对象只是观测。位于共相块之外的独立可点击或可输入控件必须作为普通顶层元素输出，永远不得放入任何 abstraction.fields，也不得用字段路径作为 actionCandidates.triggerCandidateKey。仅颜色、位置或短暂动画变化，或者无法确认共同载荷时，不得创建动态元素共相。',
  },
];

const PREVIOUS_DEFAULT_RULE_SIGNATURES = new Map([
  ['managed-list-abstraction', new Set([
    'e2a91e69b78624d477b684d85245aaad0601b9b6390bbb16b3b18419f9c1a076',
    '636cf5815e23eb9b80dd7e7992ab5d6546892fdb5b0ec164d0d526241c0025ab',
    '5afece79f200d19dc40d55f4e00a8d86b88eccfac38e7cc17f6cd87a8663d5a1',
    '75789c52d0cdd755eae91a35caff735930dc3b4aa8cdaaf8ecfba95b668bf4c4',
    '82dcf98bfbae35e8f280e3eecba47594b12c64d68ec1ea50fdde32a37cf54c49',
    'fe1ed7ab2b18494ebdbf315248cfcc5be1c58057048b376a297f9256f8989543',
    '2390b38197ff9a3e3a83dc197d1d1d10013c77bb908fc79f8cf850afeaeb2453',
    'a3643a038d3cb4309b5a837bef3fbe12fd2b2921445715914d43b8176c76b1c9',
  ])],
  ['managed-dynamic-content', new Set([
    '7bfd3d1c255185418d4ecdb7f1e5d2ec728d043e3d9e7481c933abb082824ae5',
    'c3c6c09bc6e2e10fc6f890d8592f39e21980e647efc04371790bea1fbe7837e6',
    'b05a83e3d0362c6455b57059e2e1cf5df64431751572e60d55002c84b703b060',
    '8bb9e57b3af1e0ed9e1ebed06e87f1596c081704549f12fa1afdb206c25d0c61',
    '31974694e91714b697f4124ef799863ab6a02c5bd0764c6a1f8f9984147059c8',
    '5d42320fb3bc3f2f86b821d77d68838186ea53906b159f8cfa9993626370f238',
    '4180973b3708919a4eb08468efe8e5f84b3ea4443f3c686bbfcb2b0565796cd3',
  ])],
]);

function recognitionPromptRuleSignature(rule) {
  return createHash('sha256').update(JSON.stringify({ title: rule.title, description: rule.description })).digest('hex');
}

function migrateRecognitionPromptRule(rule) {
  if (!rule || rule.key === 'managed-carousel') return null;
  const previousDefaultSignatures = PREVIOUS_DEFAULT_RULE_SIGNATURES.get(rule.key) || new Set();
  const current = DEFAULT_RECOGNITION_PROMPT_RULES.find((candidate) => candidate.key === rule.key);
  const unchangedDefault = previousDefaultSignatures.has(recognitionPromptRuleSignature(rule));
  return unchangedDefault && current ? current : rule;
}

export class ModelSettingsStore {
  constructor(databasePath) {
    this.databasePath = databasePath;
    this.database = null;
  }

  async initialize() {
    await mkdir(path.dirname(this.databasePath), { recursive: true });
    this.database = new Database(this.databasePath);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('foreign_keys = ON');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS model_gateways (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        base_url TEXT NOT NULL UNIQUE COLLATE NOCASE,
        api_key TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_assignments (
        target TEXT PRIMARY KEY CHECK (target IN ('manual', 'auto', 'midscene', 'self_heal')),
        gateway_id TEXT NOT NULL REFERENCES model_gateways(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        model_name TEXT NOT NULL,
        model_family TEXT NOT NULL,
        timeout INTEGER NOT NULL,
        temperature REAL NOT NULL,
        reasoning_effort TEXT NOT NULL CHECK (reasoning_effort IN ('low', 'medium', 'high')),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_settings_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.migrateModelAssignmentTargets();
    await chmod(this.databasePath, 0o600);
    this.ensureDefaultGatewaySnapshot();
    this.ensureRecognitionPromptRules();
  }

  ensureDatabase() {
    if (!this.database) throw new Error('模型配置数据库尚未初始化');
    return this.database;
  }

  migrateModelAssignmentTargets() {
    const database = this.ensureDatabase();
    const table = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'model_assignments'").get();
    if (table?.sql?.includes("'manual'") && table.sql.includes("'auto'") && table.sql.includes("'midscene'") && table.sql.includes("'self_heal'") && !table.sql.includes("'ultra_a'")) return false;
    const assignments = database.prepare('SELECT target, gateway_id, model_name, model_family, timeout, temperature, reasoning_effort, updated_at FROM model_assignments').all();
    const byTarget = new Map(assignments.map((assignment) => [assignment.target, assignment]));
    const legacySingleModel = byTarget.get('manual') || byTarget.get('model_a') || byTarget.get('ultra_a');
    const migrated = [
      legacySingleModel ? { ...legacySingleModel, target: 'manual' } : null,
      byTarget.get('auto'),
      byTarget.get('midscene'),
      byTarget.get('self_heal'),
    ].filter(Boolean);
    database.transaction(() => {
      database.exec(`
        ALTER TABLE model_assignments RENAME TO model_assignments_legacy_targets;
        CREATE TABLE model_assignments (
          target TEXT PRIMARY KEY CHECK (target IN ('manual', 'auto', 'midscene', 'self_heal')),
          gateway_id TEXT NOT NULL REFERENCES model_gateways(id) ON UPDATE CASCADE ON DELETE RESTRICT,
          model_name TEXT NOT NULL,
          model_family TEXT NOT NULL,
          timeout INTEGER NOT NULL,
          temperature REAL NOT NULL,
          reasoning_effort TEXT NOT NULL CHECK (reasoning_effort IN ('low', 'medium', 'high')),
          updated_at TEXT NOT NULL
        );
        DROP TABLE model_assignments_legacy_targets;
      `);
      const insert = database.prepare(`
        INSERT INTO model_assignments (target, gateway_id, model_name, model_family, timeout, temperature, reasoning_effort, updated_at)
        VALUES (@target, @gateway_id, @model_name, @model_family, @timeout, @temperature, @reasoning_effort, @updated_at)
      `);
      for (const assignment of migrated) insert.run(assignment);
    })();
    return true;
  }

  getMeta(key) {
    const row = this.ensureDatabase().prepare('SELECT value FROM model_settings_meta WHERE key = ?').get(key);
    return row?.value || null;
  }

  setMeta(key, value) {
    this.ensureDatabase().prepare('INSERT OR REPLACE INTO model_settings_meta (key, value) VALUES (?, ?)').run(key, String(value));
  }

  ensureDefaultGatewaySnapshot() {
    if (this.getMeta(DEFAULT_GATEWAY_SNAPSHOT_KEY)) return false;
    const gateway = this.getGateway('zto-newapi', { includeApiKey: true });
    if (!gateway) return false;
    this.setMeta(DEFAULT_GATEWAY_SNAPSHOT_KEY, JSON.stringify(gateway));
    return true;
  }

  getDefaultGatewaySnapshot() {
    const value = this.getMeta(DEFAULT_GATEWAY_SNAPSHOT_KEY);
    if (!value) return null;
    try { return JSON.parse(value); } catch { return null; }
  }

  resetGatewayToDefault(id) {
    if (id !== 'zto-newapi') return null;
    const snapshot = this.getDefaultGatewaySnapshot();
    if (!snapshot) return null;
    return this.saveGateway(snapshot);
  }

  getWorkbenchPreferences() {
    const value = this.getMeta(WORKBENCH_PREFERENCES_KEY);
    if (!value) return { mode: 'manual' };
    try {
      const parsed = JSON.parse(value);
      return { mode: parsed?.mode === 'auto' ? 'auto' : 'manual' };
    } catch { return { mode: 'manual' }; }
  }

  saveWorkbenchPreferences(preferences) {
    const next = { ...this.getWorkbenchPreferences(), ...preferences };
    this.setMeta(WORKBENCH_PREFERENCES_KEY, JSON.stringify(next));
    return next;
  }

  ensureRecognitionPromptRules() {
    const currentValue = this.getMeta(RECOGNITION_PROMPT_RULES_KEY);
    if (currentValue !== null) {
      try {
        const normalizedValue = JSON.stringify(normalizeRecognitionPromptRules(JSON.parse(currentValue).map(migrateRecognitionPromptRule).filter(Boolean)));
        if (normalizedValue !== currentValue) this.setMeta(RECOGNITION_PROMPT_RULES_KEY, normalizedValue);
      } catch {
        this.setMeta(RECOGNITION_PROMPT_RULES_KEY, '[]');
      }
      return false;
    }
    const previousUniversalValue = this.getMeta(PREVIOUS_ELEMENT_UNIVERSAL_RULES_KEY);
    const previousValue = this.getMeta(PREVIOUS_RECOGNITION_PROMPT_RULES_KEY);
    const legacyValue = previousUniversalValue ?? previousValue ?? this.getMeta(LEGACY_RECOGNITION_PROMPT_RULES_KEY);
    let legacyRules = [];
    try {
      const parsed = legacyValue ? JSON.parse(legacyValue) : [];
      if (Array.isArray(parsed)) legacyRules = parsed;
    } catch {
      legacyRules = [];
    }
    const rules = previousUniversalValue !== null || previousValue !== null
      ? legacyRules.map(migrateRecognitionPromptRule).filter(Boolean)
      : [...DEFAULT_RECOGNITION_PROMPT_RULES, ...legacyRules];
    this.setMeta(RECOGNITION_PROMPT_RULES_KEY, JSON.stringify(normalizeRecognitionPromptRules(rules)));
    return true;
  }

  listRecognitionPromptRules() {
    const value = this.getMeta(RECOGNITION_PROMPT_RULES_KEY);
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return normalizeRecognitionPromptRules(parsed);
    } catch { return []; }
  }

  saveRecognitionPromptRules(rules) {
    this.setMeta(RECOGNITION_PROMPT_RULES_KEY, JSON.stringify(normalizeRecognitionPromptRules(rules)));
    return this.listRecognitionPromptRules();
  }

  listModelCapabilities() {
    const value = this.getMeta(MODEL_CAPABILITIES_KEY);
    if (!value) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  }

  getModelCapability(gatewayId, modelName) {
    return this.listModelCapabilities()[`${gatewayId}::${modelName}`] || null;
  }

  saveModelCapability(gatewayId, modelName, capability) {
    const capabilities = this.listModelCapabilities();
    capabilities[`${gatewayId}::${modelName}`] = { ...capability };
    this.setMeta(MODEL_CAPABILITIES_KEY, JSON.stringify(capabilities));
    return capabilities[`${gatewayId}::${modelName}`];
  }

  listGateways({ includeApiKey = false } = {}) {
    const rows = this.ensureDatabase().prepare('SELECT id, label, base_url, api_key, created_at, updated_at FROM model_gateways ORDER BY label COLLATE NOCASE, id').all();
    const ztoIndex = rows.findIndex((row) => row.id === 'zto-newapi');
    const cfzIndex = rows.findIndex((row) => row.id === 'cfz');
    if (ztoIndex !== -1 && cfzIndex !== -1) [rows[ztoIndex], rows[cfzIndex]] = [rows[cfzIndex], rows[ztoIndex]];
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      baseUrl: row.base_url,
      ...(includeApiKey ? { apiKey: row.api_key } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getGateway(id, { includeApiKey = false } = {}) {
    const row = this.ensureDatabase().prepare('SELECT id, label, base_url, api_key, created_at, updated_at FROM model_gateways WHERE id = ?').get(id);
    if (!row) return null;
    return {
      id: row.id,
      label: row.label,
      baseUrl: row.base_url,
      ...(includeApiKey ? { apiKey: row.api_key } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  saveGateway(gateway) {
    const previous = this.getGateway(gateway.id);
    const currentTime = Date.now();
    const previousTime = Date.parse(previous?.updatedAt || '');
    const now = new Date(Number.isFinite(previousTime) ? Math.max(currentTime, previousTime + 1) : currentTime).toISOString();
    this.ensureDatabase().prepare(`
      INSERT INTO model_gateways (id, label, base_url, api_key, created_at, updated_at)
      VALUES (@id, @label, @baseUrl, @apiKey, @now, @now)
      ON CONFLICT(id) DO UPDATE SET label = excluded.label, base_url = excluded.base_url,
        api_key = CASE WHEN excluded.api_key = '' THEN model_gateways.api_key ELSE excluded.api_key END,
        updated_at = excluded.updated_at
    `).run({ ...gateway, apiKey: gateway.apiKey || '', now });
    if (gateway.id === 'zto-newapi' && !this.getMeta(DEFAULT_GATEWAY_SNAPSHOT_KEY)) {
      const saved = this.getGateway(gateway.id, { includeApiKey: true });
      if (saved) this.setMeta(DEFAULT_GATEWAY_SNAPSHOT_KEY, JSON.stringify(saved));
    }
    return this.getGateway(gateway.id, { includeApiKey: true });
  }

  deleteGateway(id) {
    const database = this.ensureDatabase();
    return database.transaction(() => {
      database.prepare('DELETE FROM model_assignments WHERE gateway_id = ?').run(id);
      return database.prepare('DELETE FROM model_gateways WHERE id = ?').run(id).changes > 0;
    })();
  }

  listAssignments() {
    return this.ensureDatabase().prepare('SELECT target, gateway_id, model_name, model_family, timeout, temperature, reasoning_effort, updated_at FROM model_assignments ORDER BY target').all().map((row) => ({
      target: row.target,
      gatewayId: row.gateway_id,
      modelName: row.model_name,
      modelFamily: row.model_family,
      timeout: row.timeout,
      temperature: row.temperature,
      reasoningEffort: row.reasoning_effort,
      updatedAt: row.updated_at,
    }));
  }

  getAssignment(target) {
    if (!TARGETS.includes(target)) throw new Error(`未知模型目标：${target}`);
    return this.listAssignments().find((item) => item.target === target) || null;
  }

  saveAssignment(assignment) {
    if (!TARGETS.includes(assignment.target)) throw new Error(`未知模型目标：${assignment.target}`);
    const updatedAt = new Date().toISOString();
    this.ensureDatabase().prepare(`
      INSERT INTO model_assignments (target, gateway_id, model_name, model_family, timeout, temperature, reasoning_effort, updated_at)
      VALUES (@target, @gatewayId, @modelName, @modelFamily, @timeout, @temperature, @reasoningEffort, @updatedAt)
      ON CONFLICT(target) DO UPDATE SET gateway_id = excluded.gateway_id, model_name = excluded.model_name,
        model_family = excluded.model_family, timeout = excluded.timeout, temperature = excluded.temperature,
        reasoning_effort = excluded.reasoning_effort, updated_at = excluded.updated_at
    `).run({ ...assignment, updatedAt });
    return this.getAssignment(assignment.target);
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}
