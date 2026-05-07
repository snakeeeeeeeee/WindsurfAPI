/**
 * Outbound proxy configuration manager.
 * Supports per-account and global HTTP proxy settings.
 */

import { log } from '../config.js';
import { getJson, setJson } from '../db.js';
import { getActiveDynamicProxyForAccount } from '../dynamic-proxy.js';

const _config = {
  global: null,       // { type, host, port, username, password }
  perAccount: {},     // { accountId: { type, host, port, username, password } }
};

// Load
try {
  const saved = getJson('proxy', 'config', null);
  if (saved && typeof saved === 'object') Object.assign(_config, saved);
} catch (e) {
  log.error('Failed to load proxy config from SQLite:', e.message);
}

function save() {
  try {
    setJson('proxy', 'config', _config);
  } catch (e) {
    log.error('Failed to save proxy config:', e.message);
  }
}

// Passwords never leave the server. The masked view returns
// `hasPassword: boolean` in place of the plaintext. When the dashboard
// PUTs a config back it omits the `password` key if the user didn't
// retype it, which mergePassword() treats as "keep the stored value".
// An explicit empty string still clears the password.
function maskProxy(p) {
  if (!p) return p;
  const { password, ...rest } = p;
  return { ...rest, hasPassword: !!password };
}

function mergePassword(newCfg, oldCfg) {
  if (!newCfg || !Object.prototype.hasOwnProperty.call(newCfg, 'password')) {
    return oldCfg?.password || '';
  }
  return newCfg.password || '';
}

/** Full config including plaintext passwords — internal callers only. */
export function getProxyConfig() {
  return { ..._config };
}

/** Safe shape for dashboard / API consumers. */
export function getProxyConfigMasked() {
  return {
    global: maskProxy(_config.global),
    perAccount: Object.fromEntries(
      Object.entries(_config.perAccount).map(([k, v]) => [k, maskProxy(v)])
    ),
  };
}

export function setGlobalProxy(cfg) {
  _config.global = cfg && cfg.host ? {
    type: cfg.type || 'http',
    host: String(cfg.host).trim(),
    port: parseInt(cfg.port, 10) || 8080,
    username: cfg.username || '',
    password: mergePassword(cfg, _config.global),
  } : null;
  save();
}

export function setAccountProxy(accountId, cfg) {
  if (cfg && cfg.host) {
    _config.perAccount[accountId] = {
      type: cfg.type || 'http',
      host: String(cfg.host).trim(),
      port: parseInt(cfg.port, 10) || 8080,
      username: cfg.username || '',
      password: mergePassword(cfg, _config.perAccount[accountId]),
    };
  } else {
    delete _config.perAccount[accountId];
  }
  save();
}

export function removeProxy(scope, accountId) {
  if (scope === 'global') {
    _config.global = null;
  } else if (scope === 'account' && accountId) {
    delete _config.perAccount[accountId];
  }
  save();
}

export function removeAccountProxy(accountId) {
  if (!accountId || !_config.perAccount[accountId]) return false;
  delete _config.perAccount[accountId];
  save();
  return true;
}

/**
 * Get effective proxy for an account.
 * Dynamic account binding wins, then manual per-account, then global.
 */
export function getEffectiveProxy(accountId) {
  const dynamicProxy = accountId ? getActiveDynamicProxyForAccount(accountId) : null;
  if (dynamicProxy) return dynamicProxy;
  if (accountId && _config.perAccount[accountId]) {
    return _config.perAccount[accountId];
  }
  return _config.global;
}
