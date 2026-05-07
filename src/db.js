/**
 * SQLite persistence layer for long-lived WindsurfAPI state.
 *
 * Redis remains responsible for short-lived TTL state (cooldowns, breakers,
 * worker locks). This module owns durable configuration and account snapshots.
 */

import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { config, log } from './config.js';

const DEFAULT_DB_NAME = 'windsurfapi.sqlite';

let _db = null;
let _dbPath = '';
let _importChecked = false;

function nowMs() {
  return Date.now();
}

function sharedDir() {
  return configuredDataDir() || config.sharedDataDir || config.dataDir;
}

function configuredDataDir() {
  const raw = String(process.env.DATA_DIR || '').trim();
  if (!raw) return '';
  return raw.startsWith('/') ? raw : resolve(raw);
}

function legacyDataDir() {
  return configuredDataDir() || config.dataDir;
}

export function getDatabasePath() {
  const raw = String(process.env.WINDSURFAPI_SQLITE_PATH || '').trim();
  if (raw) return raw === ':memory:' ? raw : resolve(raw);
  const dataDir = configuredDataDir();
  return join(dataDir || sharedDir(), DEFAULT_DB_NAME);
}

function ensureParentDir(file) {
  if (!file || file === ':memory:') return;
  mkdirSync(dirname(file), { recursive: true });
}

function openDatabase() {
  if (_db) return _db;
  _dbPath = getDatabasePath();
  ensureParentDir(_dbPath);
  _db = new DatabaseSync(_dbPath);
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA busy_timeout = 5000');
  _db.exec('PRAGMA foreign_keys = ON');
  runMigrations(_db);
  importJsonOnEmpty(_db);
  return _db;
}

const MIGRATIONS = [
  {
    version: 1,
    name: 'initial_sqlite_persistence',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS kv_config (
          namespace TEXT NOT NULL,
          key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (namespace, key)
        );

        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY,
          api_key TEXT NOT NULL UNIQUE,
          email TEXT,
          status TEXT,
          tier TEXT,
          method TEXT,
          added_at INTEGER,
          last_probed INTEGER,
          json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
        CREATE INDEX IF NOT EXISTS idx_accounts_tier ON accounts(tier);
        CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);

        CREATE TABLE IF NOT EXISTS availability_worker_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL,
          reason TEXT,
          lock_acquired INTEGER NOT NULL DEFAULT 0,
          skipped INTEGER NOT NULL DEFAULT 0,
          success INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          counts_json TEXT,
          models_json TEXT,
          accounts_json TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_availability_worker_runs_started
          ON availability_worker_runs(started_at);

        CREATE TABLE IF NOT EXISTS availability_probe_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          time INTEGER NOT NULL,
          run_id INTEGER,
          account_id TEXT,
          email TEXT,
          model_key TEXT,
          probe_type TEXT,
          ok INTEGER NOT NULL DEFAULT 0,
          rate_limited INTEGER NOT NULL DEFAULT 0,
          retry_after_ms INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          details_json TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_availability_probe_events_time
          ON availability_probe_events(time);
        CREATE INDEX IF NOT EXISTS idx_availability_probe_events_account_model
          ON availability_probe_events(account_id, model_key);

        CREATE TABLE IF NOT EXISTS account_model_health_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          time INTEGER NOT NULL,
          account_id TEXT NOT NULL,
          email TEXT,
          model_key TEXT NOT NULL,
          served_model TEXT,
          success_count INTEGER NOT NULL DEFAULT 0,
          source TEXT,
          details_json TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_account_model_health_history_time
          ON account_model_health_history(time);
        CREATE INDEX IF NOT EXISTS idx_account_model_health_history_account_model
          ON account_model_health_history(account_id, model_key);
      `);
    },
  },
  {
    version: 2,
    name: 'account_dynamic_proxy_bindings',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS account_proxy_bindings (
          account_id TEXT PRIMARY KEY,
          provider TEXT NOT NULL DEFAULT 'novproxy',
          protocol TEXT NOT NULL DEFAULT 'http',
          host TEXT NOT NULL,
          port INTEGER NOT NULL,
          username TEXT,
          password TEXT,
          session_id TEXT,
          egress_ip TEXT,
          country TEXT,
          region TEXT,
          city TEXT,
          isp_org TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          expires_at INTEGER NOT NULL DEFAULT 0,
          last_verified_at INTEGER NOT NULL DEFAULT 0,
          verify_error TEXT,
          fail_count INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_account_proxy_bindings_status
          ON account_proxy_bindings(status);
        CREATE INDEX IF NOT EXISTS idx_account_proxy_bindings_expires
          ON account_proxy_bindings(expires_at);
      `);
    },
  },
];

function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT,
      applied_at INTEGER NOT NULL
    )
  `);
  const hasMigration = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
  const insertMigration = db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)');
  for (const migration of MIGRATIONS) {
    if (hasMigration.get(migration.version)) continue;
    try {
      db.exec('BEGIN IMMEDIATE');
      migration.up(db);
      insertMigration.run(migration.version, migration.name, nowMs());
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  }
}

function jsonString(value) {
  return JSON.stringify(value ?? null);
}

function parseJson(raw, fallback = null) {
  if (typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function readJsonFile(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (e) {
    log.warn(`sqlite import: skipped ${file}: ${e.message}`);
    return null;
  }
}

function setMetaRaw(db, key, value) {
  db.prepare(`
    INSERT INTO meta(key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, String(value ?? ''), nowMs());
}

function getMetaRaw(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setJsonRaw(db, namespace, key, value) {
  db.prepare(`
    INSERT INTO kv_config(namespace, key, value_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(namespace, key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(namespace, key, jsonString(value), nowMs());
}

function normalizeAccountForStorage(account) {
  if (!account || typeof account !== 'object') return null;
  const apiKey = String(account.apiKey || account.api_key || '').trim();
  if (!apiKey) return null;
  const id = String(account.id || randomUUID().slice(0, 8));
  const addedAt = Number(account.addedAt || account.added_at || 0) || nowMs();
  const lastProbed = Number(account.lastProbed || account.last_probed || 0) || 0;
  const snapshot = {
    ...account,
    id,
    apiKey,
    addedAt,
    lastProbed,
  };
  return {
    id,
    apiKey,
    email: String(snapshot.email || ''),
    status: String(snapshot.status || 'active'),
    tier: String(snapshot.tier || 'unknown'),
    method: String(snapshot.method || 'api_key'),
    addedAt,
    lastProbed,
    json: jsonString(snapshot),
  };
}

function insertAccountRaw(db, account) {
  const row = normalizeAccountForStorage(account);
  if (!row) return false;
  db.prepare('DELETE FROM accounts WHERE api_key = ? AND id <> ?').run(row.apiKey, row.id);
  db.prepare(`
    INSERT INTO accounts(id, api_key, email, status, tier, method, added_at, last_probed, json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      api_key = excluded.api_key,
      email = excluded.email,
      status = excluded.status,
      tier = excluded.tier,
      method = excluded.method,
      added_at = excluded.added_at,
      last_probed = excluded.last_probed,
      json = excluded.json,
      updated_at = excluded.updated_at
  `).run(
    row.id,
    row.apiKey,
    row.email,
    row.status,
    row.tier,
    row.method,
    row.addedAt,
    row.lastProbed,
    row.json,
    nowMs()
  );
  return true;
}

function databaseHasDurableData(db) {
  if (getMetaRaw(db, 'imported_at')) return true;
  const accountCount = db.prepare('SELECT COUNT(*) AS c FROM accounts').get().c || 0;
  const kvCount = db.prepare('SELECT COUNT(*) AS c FROM kv_config').get().c || 0;
  return accountCount > 0 || kvCount > 0;
}

function readLegacyAccounts() {
  const root = sharedDir();
  const accountsFile = join(root, 'accounts.json');
  const direct = readJsonFile(accountsFile);
  if (Array.isArray(direct)) return { accounts: direct, source: accountsFile };

  const merged = new Map();
  let scanned = 0;
  try {
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith('replica-')) continue;
      const legacy = readJsonFile(join(root, entry, 'accounts.json'));
      if (!Array.isArray(legacy)) continue;
      scanned++;
      for (const account of legacy) {
        const key = account?.apiKey || account?.api_key;
        if (key && !merged.has(key)) merged.set(key, account);
      }
    }
  } catch {}
  if (!merged.size) return { accounts: [], source: '' };
  return { accounts: [...merged.values()], source: `${scanned} replica-* accounts.json file(s)` };
}

function importJsonOnEmpty(db) {
  if (_importChecked) return;
  _importChecked = true;
  if (process.env.WINDSURFAPI_DB_IMPORT_JSON_ON_EMPTY === '0') return;
  if (databaseHasDurableData(db)) return;

  const imported = {};
  try {
    db.exec('BEGIN IMMEDIATE');

    const { accounts, source } = readLegacyAccounts();
    let accountCount = 0;
    for (const account of accounts) {
      if (insertAccountRaw(db, account)) accountCount++;
    }
    if (accountCount) {
      imported.accounts = { count: accountCount, source };
    }

    const runtimeConfig = readJsonFile(join(legacyDataDir(), 'runtime-config.json'));
    if (runtimeConfig && typeof runtimeConfig === 'object' && !Array.isArray(runtimeConfig)) {
      setJsonRaw(db, 'runtime', 'config', runtimeConfig);
      imported.runtimeConfig = true;
    }

    const proxyConfig = readJsonFile(join(legacyDataDir(), 'proxy.json'));
    if (proxyConfig && typeof proxyConfig === 'object' && !Array.isArray(proxyConfig)) {
      setJsonRaw(db, 'proxy', 'config', proxyConfig);
      imported.proxy = true;
    }

    const modelAccess = readJsonFile(join(legacyDataDir(), 'model-access.json'));
    if (modelAccess && typeof modelAccess === 'object' && !Array.isArray(modelAccess)) {
      setJsonRaw(db, 'model_access', 'config', modelAccess);
      imported.modelAccess = true;
    }

    const stats = readJsonFile(join(legacyDataDir(), 'stats.json'));
    if (stats && typeof stats === 'object' && !Array.isArray(stats)) {
      setJsonRaw(db, 'stats', 'state', stats);
      imported.stats = true;
    }

    setMetaRaw(db, 'imported_at', String(nowMs()));
    setMetaRaw(db, 'imported_from_json', '1');
    setMetaRaw(db, 'import_summary', jsonString(imported));
    db.exec('COMMIT');
    log.info(`SQLite persistence initialized at ${_dbPath}`);
    if (Object.keys(imported).length) {
      log.info(`SQLite imported legacy JSON stores: ${Object.keys(imported).join(', ')}`);
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

export function getJson(namespace, key, fallback = null) {
  const db = openDatabase();
  const row = db.prepare('SELECT value_json FROM kv_config WHERE namespace = ? AND key = ?').get(namespace, key);
  return row ? parseJson(row.value_json, fallback) : fallback;
}

export function setJson(namespace, key, value) {
  setJsonRaw(openDatabase(), namespace, key, value);
}

export function deleteJson(namespace, key) {
  openDatabase().prepare('DELETE FROM kv_config WHERE namespace = ? AND key = ?').run(namespace, key);
}

export function getMeta(key, fallback = '') {
  const value = getMetaRaw(openDatabase(), key);
  return value == null ? fallback : value;
}

export function setMeta(key, value) {
  setMetaRaw(openDatabase(), key, value);
}

export function getAccountsJson() {
  const db = openDatabase();
  const rows = db.prepare('SELECT json FROM accounts ORDER BY added_at ASC, id ASC').all();
  return rows.map(row => parseJson(row.json, null)).filter(Boolean);
}

export function replaceAccountsJson(accountList = []) {
  const db = openDatabase();
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM accounts').run();
    for (const account of accountList || []) insertAccountRaw(db, account);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

export function saveAccountJson(account) {
  const db = openDatabase();
  try {
    db.exec('BEGIN IMMEDIATE');
    insertAccountRaw(db, account);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

export function deleteAccountJson(id) {
  if (!id) return;
  openDatabase().prepare('DELETE FROM accounts WHERE id = ?').run(String(id));
}

export function deleteAccountAvailabilityHistory(accountId) {
  if (!accountId) return { probeEvents: 0, healthHistory: 0 };
  const db = openDatabase();
  const id = String(accountId);
  try {
    db.exec('BEGIN IMMEDIATE');
    const probeEvents = db.prepare('DELETE FROM availability_probe_events WHERE account_id = ?').run(id).changes || 0;
    const healthHistory = db.prepare('DELETE FROM account_model_health_history WHERE account_id = ?').run(id).changes || 0;
    let workerRunsUpdated = 0;
    const workerRows = db.prepare('SELECT id, accounts_json FROM availability_worker_runs WHERE accounts_json LIKE ?').all(`%${id}%`);
    const updateWorker = db.prepare('UPDATE availability_worker_runs SET accounts_json = ? WHERE id = ?');
    for (const row of workerRows) {
      const accounts = parseJson(row.accounts_json, []);
      if (!Array.isArray(accounts) || !accounts.includes(id)) continue;
      updateWorker.run(jsonString(accounts.filter(x => x !== id)), row.id);
      workerRunsUpdated++;
    }
    db.exec('COMMIT');
    return { probeEvents, healthHistory, workerRunsUpdated };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

function normalizeProxyBinding(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    provider: row.provider || 'novproxy',
    protocol: row.protocol || 'http',
    host: row.host || '',
    port: Number(row.port || 0),
    username: row.username || '',
    password: row.password || '',
    sessionId: row.session_id || '',
    egressIp: row.egress_ip || '',
    country: row.country || '',
    region: row.region || '',
    city: row.city || '',
    ispOrg: row.isp_org || '',
    status: row.status || 'active',
    expiresAt: Number(row.expires_at || 0),
    lastVerifiedAt: Number(row.last_verified_at || 0),
    verifyError: row.verify_error || '',
    failCount: Number(row.fail_count || 0),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
  };
}

export function getAccountProxyBinding(accountId) {
  if (!accountId) return null;
  const row = openDatabase().prepare('SELECT * FROM account_proxy_bindings WHERE account_id = ?').get(String(accountId));
  return normalizeProxyBinding(row);
}

export function getAccountProxyBindings() {
  const rows = openDatabase().prepare('SELECT * FROM account_proxy_bindings ORDER BY updated_at DESC, account_id ASC').all();
  return rows.map(normalizeProxyBinding).filter(Boolean);
}

export function saveAccountProxyBinding(binding = {}) {
  if (!binding.accountId) throw new Error('accountId required');
  const existing = getAccountProxyBinding(binding.accountId);
  const createdAt = Number(binding.createdAt || existing?.createdAt || nowMs()) || nowMs();
  const updatedAt = Number(binding.updatedAt || nowMs()) || nowMs();
  openDatabase().prepare(`
    INSERT INTO account_proxy_bindings(
      account_id, provider, protocol, host, port, username, password, session_id,
      egress_ip, country, region, city, isp_org, status, expires_at,
      last_verified_at, verify_error, fail_count, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      provider = excluded.provider,
      protocol = excluded.protocol,
      host = excluded.host,
      port = excluded.port,
      username = excluded.username,
      password = excluded.password,
      session_id = excluded.session_id,
      egress_ip = excluded.egress_ip,
      country = excluded.country,
      region = excluded.region,
      city = excluded.city,
      isp_org = excluded.isp_org,
      status = excluded.status,
      expires_at = excluded.expires_at,
      last_verified_at = excluded.last_verified_at,
      verify_error = excluded.verify_error,
      fail_count = excluded.fail_count,
      updated_at = excluded.updated_at
  `).run(
    String(binding.accountId),
    String(binding.provider || existing?.provider || 'novproxy'),
    String(binding.protocol || existing?.protocol || 'http'),
    String(binding.host || existing?.host || ''),
    Math.max(0, Math.round(Number(binding.port ?? existing?.port ?? 0) || 0)),
    String(binding.username ?? existing?.username ?? ''),
    String(binding.password ?? existing?.password ?? ''),
    String(binding.sessionId ?? existing?.sessionId ?? ''),
    String(binding.egressIp ?? existing?.egressIp ?? ''),
    String(binding.country ?? existing?.country ?? ''),
    String(binding.region ?? existing?.region ?? ''),
    String(binding.city ?? existing?.city ?? ''),
    String(binding.ispOrg ?? existing?.ispOrg ?? ''),
    String(binding.status || existing?.status || 'active'),
    Math.max(0, Math.round(Number(binding.expiresAt ?? existing?.expiresAt ?? 0) || 0)),
    Math.max(0, Math.round(Number(binding.lastVerifiedAt ?? existing?.lastVerifiedAt ?? 0) || 0)),
    String(binding.verifyError ?? existing?.verifyError ?? ''),
    Math.max(0, Math.round(Number(binding.failCount ?? existing?.failCount ?? 0) || 0)),
    createdAt,
    updatedAt
  );
  return getAccountProxyBinding(binding.accountId);
}

export function deleteAccountProxyBinding(accountId) {
  if (!accountId) return false;
  return (openDatabase().prepare('DELETE FROM account_proxy_bindings WHERE account_id = ?').run(String(accountId)).changes || 0) > 0;
}

export function deleteAccountProxyBindings(accountIds = []) {
  const ids = [...new Set((accountIds || []).map(String).filter(Boolean))];
  if (!ids.length) return 0;
  const db = openDatabase();
  let changed = 0;
  try {
    db.exec('BEGIN IMMEDIATE');
    const stmt = db.prepare('DELETE FROM account_proxy_bindings WHERE account_id = ?');
    for (const id of ids) changed += stmt.run(id).changes || 0;
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
  return changed;
}

export function recordAvailabilityWorkerRun(run = {}) {
  const db = openDatabase();
  const startedAt = Number(run.startedAt || run.start || nowMs()) || nowMs();
  const finishedAt = Number(run.finishedAt || nowMs()) || nowMs();
  const result = db.prepare(`
    INSERT INTO availability_worker_runs(
      started_at, finished_at, duration_ms, reason, lock_acquired, skipped,
      success, error, counts_json, models_json, accounts_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    startedAt,
    finishedAt,
    Math.max(0, Number(run.durationMs ?? (finishedAt - startedAt)) || 0),
    String(run.reason || ''),
    run.lockAcquired ? 1 : 0,
    run.skipped ? 1 : 0,
    run.success === false ? 0 : 1,
    String(run.error || ''),
    jsonString(run.counts || {}),
    jsonString(run.models || []),
    jsonString(run.accounts || []),
    nowMs()
  );
  return Number(result.lastInsertRowid || 0);
}

export function recordAvailabilityProbeEvent(event = {}) {
  openDatabase().prepare(`
    INSERT INTO availability_probe_events(
      time, run_id, account_id, email, model_key, probe_type, ok,
      rate_limited, retry_after_ms, error, details_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(event.time || nowMs()) || nowMs(),
    event.runId || null,
    String(event.accountId || ''),
    String(event.email || ''),
    String(event.modelKey || ''),
    String(event.probeType || event.type || ''),
    event.ok ? 1 : 0,
    event.rateLimited ? 1 : 0,
    Math.max(0, Number(event.retryAfterMs || 0) || 0),
    String(event.error || ''),
    jsonString(event.details || {})
  );
}

export function recordAccountModelHealth(event = {}) {
  if (!event.accountId || !event.modelKey) return;
  openDatabase().prepare(`
    INSERT INTO account_model_health_history(
      time, account_id, email, model_key, served_model, success_count,
      source, details_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(event.time || nowMs()) || nowMs(),
    String(event.accountId),
    String(event.email || ''),
    String(event.modelKey),
    String(event.servedModel || event.modelKey),
    Math.max(0, Number(event.successCount || 0) || 0),
    String(event.source || ''),
    jsonString(event.details || {})
  );
}

export function getDbStatus() {
  return {
    path: _dbPath || getDatabasePath(),
    open: !!_db,
    importedAt: _db ? getMeta('imported_at', '') : '',
  };
}

export function closeDatabaseForTest() {
  if (_db) {
    try { _db.close(); } catch {}
  }
  _db = null;
  _dbPath = '';
  _importChecked = false;
}
