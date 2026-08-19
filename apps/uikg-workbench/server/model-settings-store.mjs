import { chmod, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

const TARGETS = ['model_a', 'model_b', 'midscene'];
const MIGRATION_KEY = 'legacy_env_model_settings_v1';
const DEFAULT_GATEWAY_SNAPSHOT_KEY = 'default_gateway_snapshot_v1';
const WORKBENCH_PREFERENCES_KEY = 'workbench_preferences_v1';

function normalizedBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

function gatewayIdFromBaseUrl(baseUrl, fallback = 'gateway') {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    if (hostname === 'dashscope.aliyuncs.com') return 'dashscope';
    if (hostname === 'cfz.nodemapz.com') return 'cfz';
    if (hostname === 'znew-api.dev.ztosys.com') return 'zto-newapi';
    return hostname.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || fallback;
  } catch {
    return fallback;
  }
}

function gatewayLabel(id, baseUrl, configuredLabel) {
  if (configuredLabel) return configuredLabel;
  try { return new URL(baseUrl).hostname; } catch { return id; }
}

function legacyGateways(values) {
  const gateways = [];
  const seen = new Map();
  for (const key of Object.keys(values).sort()) {
    const match = key.match(/^MIDSCENE_GATEWAY_([A-Z0-9_]+)_BASE_URL$/);
    if (!match || !values[key]) continue;
    const suffix = match[1];
    const id = suffix.toLowerCase().replace(/_/g, '-');
    const baseUrl = String(values[key]).trim();
    const normalized = normalizedBaseUrl(baseUrl);
    if (!normalized || seen.has(normalized)) continue;
    const gateway = {
      id,
      label: gatewayLabel(id, baseUrl, values[`MIDSCENE_GATEWAY_${suffix}_LABEL`]),
      baseUrl,
      apiKey: String(values[`MIDSCENE_GATEWAY_${suffix}_API_KEY`] || ''),
    };
    seen.set(normalized, gateway);
    gateways.push(gateway);
  }

  for (const worker of ['A', 'B']) {
    const prefix = `MIDSCENE_WORKER_${worker}_MODEL`;
    const baseUrl = String(values[`${prefix}_BASE_URL`] || '').trim();
    const normalized = normalizedBaseUrl(baseUrl);
    if (!normalized) continue;
    const existing = seen.get(normalized);
    if (existing) {
      if (!existing.apiKey) existing.apiKey = String(values[`${prefix}_API_KEY`] || '');
      continue;
    }
    const id = gatewayIdFromBaseUrl(baseUrl, `legacy-worker-${worker.toLowerCase()}`);
    const gateway = { id, label: gatewayLabel(id, baseUrl), baseUrl, apiKey: String(values[`${prefix}_API_KEY`] || '') };
    seen.set(normalized, gateway);
    gateways.push(gateway);
  }
  return gateways;
}

function legacyAssignment(values, target, gateways) {
  const worker = target === 'model_b' ? 'B' : 'A';
  const prefix = `MIDSCENE_WORKER_${worker}_MODEL`;
  const configuredGateway = String(values[`${prefix}_GATEWAY`] || '');
  const baseUrl = normalizedBaseUrl(values[`${prefix}_BASE_URL`]);
  const gateway = gateways.find((item) => item.id === configuredGateway)
    || gateways.find((item) => normalizedBaseUrl(item.baseUrl) === baseUrl);
  if (!gateway || !values[`${prefix}_NAME`]) return null;
  const effort = String(values[`${prefix}_REASONING_EFFORT`] || (values[`${prefix}_REASONING_ENABLED`] === 'true' ? 'medium' : 'low'));
  return {
    target,
    gatewayId: gateway.id,
    modelName: String(values[`${prefix}_NAME`]),
    modelFamily: String(values[`${prefix}_FAMILY`] || 'gpt-5'),
    timeout: Number(values[`${prefix}_TIMEOUT`] || 180000),
    temperature: Number(values[`${prefix}_TEMPERATURE`] || 0),
    reasoningEffort: ['low', 'medium', 'high'].includes(effort) ? effort : 'low',
  };
}

export class ModelSettingsStore {
  constructor(databasePath) {
    this.databasePath = databasePath;
    this.database = null;
  }

  async initialize({ legacyEnvPath = null } = {}) {
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
        target TEXT PRIMARY KEY CHECK (target IN ('model_a', 'model_b', 'midscene')),
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
    if (legacyEnvPath) await this.migrateLegacyEnvironment(legacyEnvPath);
    this.ensureDefaultGatewaySnapshot();
  }

  ensureDatabase() {
    if (!this.database) throw new Error('模型配置数据库尚未初始化');
    return this.database;
  }

  migrateModelAssignmentTargets() {
    const database = this.ensureDatabase();
    const table = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'model_assignments'").get();
    if (!table?.sql?.includes("'worker_a'")) return false;
    database.transaction(() => {
      database.exec(`
        ALTER TABLE model_assignments RENAME TO model_assignments_legacy_targets;
        CREATE TABLE model_assignments (
          target TEXT PRIMARY KEY CHECK (target IN ('model_a', 'model_b', 'midscene')),
          gateway_id TEXT NOT NULL REFERENCES model_gateways(id) ON UPDATE CASCADE ON DELETE RESTRICT,
          model_name TEXT NOT NULL,
          model_family TEXT NOT NULL,
          timeout INTEGER NOT NULL,
          temperature REAL NOT NULL,
          reasoning_effort TEXT NOT NULL CHECK (reasoning_effort IN ('low', 'medium', 'high')),
          updated_at TEXT NOT NULL
        );
        INSERT INTO model_assignments (target, gateway_id, model_name, model_family, timeout, temperature, reasoning_effort, updated_at)
        SELECT CASE target WHEN 'worker_a' THEN 'model_a' WHEN 'worker_b' THEN 'model_b' ELSE target END,
          gateway_id, model_name, model_family, timeout, temperature, reasoning_effort, updated_at
        FROM model_assignments_legacy_targets;
        DROP TABLE model_assignments_legacy_targets;
      `);
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
    if (!value) return { mode: 'ultra' };
    try {
      const parsed = JSON.parse(value);
      return { mode: ['manual', 'ultra', 'auto'].includes(parsed?.mode) ? parsed.mode : 'ultra' };
    } catch { return { mode: 'ultra' }; }
  }

  saveWorkbenchPreferences(preferences) {
    const next = { ...this.getWorkbenchPreferences(), ...preferences };
    this.setMeta(WORKBENCH_PREFERENCES_KEY, JSON.stringify(next));
    return next;
  }

  async migrateLegacyEnvironment(envPath) {
    const database = this.ensureDatabase();
    if (database.prepare('SELECT value FROM model_settings_meta WHERE key = ?').get(MIGRATION_KEY)) return false;
    let values = {};
    try { values = dotenv.parse(await readFile(envPath, 'utf8')); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const gateways = legacyGateways(values);
    const modelA = legacyAssignment(values, 'model_a', gateways);
    const modelB = legacyAssignment(values, 'model_b', gateways);
    const assignments = [modelA, modelB, modelA ? { ...modelA, target: 'midscene' } : null].filter(Boolean);
    const migrate = database.transaction(() => {
      for (const gateway of gateways) this.saveGateway(gateway);
      for (const assignment of assignments) this.saveAssignment(assignment);
      database.prepare('INSERT OR REPLACE INTO model_settings_meta (key, value) VALUES (?, ?)').run(MIGRATION_KEY, new Date().toISOString());
    });
    migrate();
    return gateways.length > 0;
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
    const now = new Date().toISOString();
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
