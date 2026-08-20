import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

const TARGETS = ['manual', 'auto', 'ultra_a', 'ultra_b', 'midscene'];
const DEFAULT_GATEWAY_SNAPSHOT_KEY = 'default_gateway_snapshot_v1';
const WORKBENCH_PREFERENCES_KEY = 'workbench_preferences_v1';

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
        target TEXT PRIMARY KEY CHECK (target IN ('manual', 'auto', 'ultra_a', 'ultra_b', 'midscene')),
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
  }

  ensureDatabase() {
    if (!this.database) throw new Error('模型配置数据库尚未初始化');
    return this.database;
  }

  migrateModelAssignmentTargets() {
    const database = this.ensureDatabase();
    const table = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'model_assignments'").get();
    if (table?.sql?.includes("'manual'") && table.sql.includes("'auto'") && table.sql.includes("'ultra_a'") && table.sql.includes("'ultra_b'")) return false;
    const assignments = database.prepare('SELECT target, gateway_id, model_name, model_family, timeout, temperature, reasoning_effort, updated_at FROM model_assignments').all();
    const byTarget = new Map(assignments.map((assignment) => [assignment.target, assignment]));
    const modelA = byTarget.get('model_a') || byTarget.get('ultra_a');
    const modelB = byTarget.get('model_b') || byTarget.get('ultra_b');
    const migrated = [
      modelA ? { ...modelA, target: 'manual' } : byTarget.get('manual'),
      byTarget.get('auto'),
      modelA ? { ...modelA, target: 'ultra_a' } : byTarget.get('ultra_a'),
      modelB ? { ...modelB, target: 'ultra_b' } : byTarget.get('ultra_b'),
      byTarget.get('midscene'),
    ].filter(Boolean);
    database.transaction(() => {
      database.exec(`
        ALTER TABLE model_assignments RENAME TO model_assignments_legacy_targets;
        CREATE TABLE model_assignments (
          target TEXT PRIMARY KEY CHECK (target IN ('manual', 'auto', 'ultra_a', 'ultra_b', 'midscene')),
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
