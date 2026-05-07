import { randomBytes } from 'node:crypto';
import { log } from './config.js';
import {
  deleteAccountProxyBinding,
  getAccountsJson,
  getAccountProxyBinding,
  getAccountProxyBindings,
  saveAccountProxyBinding,
} from './db.js';
import {
  getDynamicProxyRuntimeConfig,
  setDynamicProxyRuntimeConfig,
} from './runtime-config.js';
import { testProxy } from './proxy-test.js';

const ACTIVE_STATUSES = new Set(['active']);
const BLOCKED_EFFECTIVE_STATUSES = new Set(['failed', 'expired', 'suspended', 'rotating', 'verifying']);
const testHooks = {
  testProxy: null,
  skipAfterBindingChanged: false,
};

function nowMs() {
  return Date.now();
}

function clampInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function randomSessionId() {
  return randomBytes(6).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || randomBytes(4).toString('hex');
}

function normalizeProtocol(value) {
  const s = String(value || '').trim().toLowerCase();
  if (s === 'socks' || s === 'socks5h') return 'socks5';
  if (s === 'https') return 'http';
  return ['http', 'socks5'].includes(s) ? s : 'http';
}

function normalizeConfig(raw = {}) {
  const cfg = {
    enabled: raw.enabled === true || raw.enabled === 'true' || raw.enabled === '1' || raw.enabled === 1,
    provider: String(raw.provider || 'novproxy').trim() || 'novproxy',
    protocol: normalizeProtocol(raw.protocol),
    host: String(raw.host || '').trim(),
    port: clampInt(raw.port, 1000, 1, 65535),
    usernameTemplate: String(raw.usernameTemplate || '').trim(),
    password: String(raw.password || ''),
    region: String(raw.region || 'US').trim() || 'US',
    state: String(raw.state || 'New Jersey').trim() || 'New Jersey',
    ttlMinutes: clampInt(raw.ttlMinutes, 120, 1, 24 * 60),
    renewBeforeMs: clampInt(raw.renewBeforeMs, 900000, 0),
    verifyUrl: String(raw.verifyUrl || 'https://ipinfo.io/json').trim() || 'https://ipinfo.io/json',
    maxBindRetries: clampInt(raw.maxBindRetries, 3, 1, 20),
    autoBindNewAccounts: raw.autoBindNewAccounts === true || raw.autoBindNewAccounts === 'true' || raw.autoBindNewAccounts === '1' || raw.autoBindNewAccounts === 1,
    workerIntervalMs: clampInt(raw.workerIntervalMs, 60000, 1000),
    workerBatchSize: clampInt(raw.workerBatchSize, 20, 0, 1000),
    workerConcurrency: clampInt(raw.workerConcurrency, 3, 1, 100),
  };
  if (!cfg.host) cfg.host = 'us.novproxy.io';
  if (!cfg.usernameTemplate) cfg.usernameTemplate = 'nfgr68136-region-{region}-st-{state}-sid-{sid}-t-{ttl}';
  return cfg;
}

export function getDynamicProxyConfig() {
  return normalizeConfig(getDynamicProxyRuntimeConfig());
}

export function getDynamicProxyConfigMasked() {
  const cfg = getDynamicProxyConfig();
  const { password, ...rest } = cfg;
  return { ...rest, hasPassword: !!password };
}

export function setDynamicProxyConfig(patch = {}) {
  const current = getDynamicProxyConfig();
  const next = { ...current, ...patch };
  if (!Object.prototype.hasOwnProperty.call(patch || {}, 'password')) {
    next.password = current.password || '';
  }
  return getDynamicProxyConfigMaskedFromRaw(setDynamicProxyRuntimeConfig(next));
}

function getDynamicProxyConfigMaskedFromRaw(raw) {
  const cfg = normalizeConfig(raw);
  const { password, ...rest } = cfg;
  return { ...rest, hasPassword: !!password };
}

export function generateNovproxyCredentials(cfg = getDynamicProxyConfig(), sid = randomSessionId()) {
  const ttl = clampInt(cfg.ttlMinutes, 120, 1, 24 * 60);
  const username = String(cfg.usernameTemplate || '')
    .replaceAll('{region}', cfg.region || 'US')
    .replaceAll('{state}', cfg.state || '')
    .replaceAll('{sid}', sid)
    .replaceAll('{ttl}', String(ttl));
  return {
    provider: cfg.provider || 'novproxy',
    protocol: normalizeProtocol(cfg.protocol),
    host: cfg.host,
    port: cfg.port,
    username,
    password: cfg.password || '',
    sessionId: sid,
    expiresAt: nowMs() + ttl * 60 * 1000,
  };
}

function maskedBinding(binding) {
  if (!binding) return null;
  const remainingMs = binding.expiresAt ? Math.max(0, binding.expiresAt - nowMs()) : 0;
  return {
    accountId: binding.accountId,
    provider: binding.provider,
    protocol: binding.protocol,
    host: binding.host,
    port: binding.port,
    username: binding.username ? maskUsername(binding.username) : '',
    sessionId: binding.sessionId,
    egressIp: binding.egressIp,
    country: binding.country,
    region: binding.region,
    city: binding.city,
    ispOrg: binding.ispOrg,
    status: binding.status,
    expiresAt: binding.expiresAt,
    remainingMs,
    lastVerifiedAt: binding.lastVerifiedAt,
    verifyError: binding.verifyError,
    failCount: binding.failCount,
    hasPassword: !!binding.password,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  };
}

function maskUsername(username = '') {
  const s = String(username || '');
  if (s.length <= 12) return s ? '***' : '';
  return `${s.slice(0, 10)}...${s.slice(-6)}`;
}

export function getMaskedProxyBinding(accountId) {
  return maskedBinding(getAccountProxyBinding(accountId));
}

export function getMaskedProxyBindings() {
  return getAccountProxyBindings().map(maskedBinding).filter(Boolean);
}

export function getDynamicProxySummary(accounts = []) {
  const accountIds = new Set((accounts || []).map(a => a.id).filter(Boolean));
  const bindings = getAccountProxyBindings().filter(b => !accountIds.size || accountIds.has(b.accountId));
  const now = nowMs();
  return {
    bound: bindings.filter(b => b.status === 'active').length,
    expiringSoon: bindings.filter(b => b.status === 'active' && b.expiresAt && b.expiresAt <= now + getDynamicProxyConfig().renewBeforeMs).length,
    failed: bindings.filter(b => ['failed', 'expired'].includes(b.status)).length,
    suspended: bindings.filter(b => b.status === 'suspended').length,
    unbound: Math.max(0, (accounts || []).length - bindings.length),
  };
}

export function getActiveDynamicProxyForAccount(accountId) {
  const binding = getAccountProxyBinding(accountId);
  if (!binding || !ACTIVE_STATUSES.has(binding.status)) return null;
  if (binding.expiresAt && binding.expiresAt <= nowMs()) {
    saveAccountProxyBinding({
      ...binding,
      status: 'expired',
      verifyError: 'binding_expired',
      updatedAt: nowMs(),
    });
    return null;
  }
  if (!binding.host || !binding.port) return null;
  return {
    type: normalizeProtocol(binding.protocol),
    host: binding.host,
    port: binding.port,
    username: binding.username || '',
    password: binding.password || '',
    strict: true,
    dynamicBinding: true,
    accountId: binding.accountId,
    sessionId: binding.sessionId || '',
  };
}

async function afterBindingChanged(accountId, reason) {
  if (testHooks.skipAfterBindingChanged) return;
  try {
    const m = await import('./availability-router.js');
    await m.purgeAccountAvailabilityState(accountId, { reason });
  } catch (e) {
    log.debug(`dynamic-proxy: failed to purge availability for ${accountId}: ${e.message}`);
  }
  try {
    const m = await import('./auth.js');
    if (typeof m.ensureLsForAccount === 'function') {
      m.ensureLsForAccount(accountId).catch(e => log.debug(`dynamic-proxy: LS warmup failed for ${accountId}: ${e.message}`));
    }
  } catch {}
}

async function accountIsActive(accountId) {
  try {
    const m = await import('./auth.js');
    const account = m.getAccountList().find(a => a.id === accountId);
    if (account) return account.status === 'active';
  } catch {
    // Fall through to the durable store. This path keeps tests and early
    // startup flows from depending on auth.js already having loaded memory.
  }
  const stored = getAccountsJson().find(a => a.id === accountId);
  if (stored) return String(stored.status || 'active') === 'active';
  return false;
}

export async function bindAccountDynamicProxy(accountId, opts = {}) {
  const id = String(accountId || '').trim();
  if (!id) throw new Error('ERR_ACCOUNT_REQUIRED');
  const cfg = { ...getDynamicProxyConfig(), ...(opts.config || {}) };
  if (!cfg.enabled && !opts.force) throw new Error('ERR_DYNAMIC_PROXY_DISABLED');
  if (!cfg.host) throw new Error('ERR_DYNAMIC_PROXY_HOST_REQUIRED');
  if (!await accountIsActive(id)) throw new Error('ERR_ACCOUNT_NOT_ACTIVE');
  const max = clampInt(opts.maxRetries || cfg.maxBindRetries, 3, 1, 20);
  let lastErr = null;
  for (let attempt = 1; attempt <= max; attempt++) {
    const generated = generateNovproxyCredentials(cfg);
    const base = saveAccountProxyBinding({
      accountId: id,
      ...generated,
      status: opts.rotating ? 'rotating' : 'verifying',
      verifyError: '',
      failCount: 0,
      updatedAt: nowMs(),
    });
    try {
      const proxy = {
        type: generated.protocol,
        host: generated.host,
        port: generated.port,
        username: generated.username,
        password: generated.password,
      };
      const verifyFn = testHooks.testProxy || testProxy;
      const verified = await verifyFn(proxy, { verifyUrl: cfg.verifyUrl, timeoutMs: opts.timeoutMs || 10000 });
      const binding = saveAccountProxyBinding({
        ...base,
        ...generated,
        status: 'active',
        egressIp: verified.egressIp || '',
        country: verified.country || '',
        region: verified.region || '',
        city: verified.city || '',
        ispOrg: verified.ispOrg || '',
        lastVerifiedAt: nowMs(),
        verifyError: '',
        failCount: 0,
        updatedAt: nowMs(),
      });
      await afterBindingChanged(id, opts.rotating ? 'dynamic_proxy_rotated' : 'dynamic_proxy_bound');
      log.info(`dynamic-proxy: account ${id} bound to ${binding.egressIp || binding.host} (${binding.provider})`);
      return { success: true, binding: maskedBinding(binding), attempts: attempt };
    } catch (e) {
      lastErr = e;
      saveAccountProxyBinding({
        ...base,
        ...generated,
        status: 'failed',
        verifyError: e.message || String(e),
        failCount: attempt,
        expiresAt: 0,
        updatedAt: nowMs(),
      });
    }
  }
  await afterBindingChanged(id, 'dynamic_proxy_bind_failed');
  throw new Error(lastErr?.message || 'ERR_DYNAMIC_PROXY_BIND_FAILED');
}

export async function rotateAccountDynamicProxy(accountId, opts = {}) {
  return bindAccountDynamicProxy(accountId, { ...opts, rotating: true });
}

export async function verifyAccountDynamicProxy(accountId, opts = {}) {
  const binding = getAccountProxyBinding(accountId);
  if (!binding) throw new Error('ERR_DYNAMIC_PROXY_NOT_BOUND');
  if (BLOCKED_EFFECTIVE_STATUSES.has(binding.status) && !opts.force) {
    throw new Error(`ERR_DYNAMIC_PROXY_STATUS_${String(binding.status).toUpperCase()}`);
  }
  const proxy = {
    type: normalizeProtocol(binding.protocol),
    host: binding.host,
    port: binding.port,
    username: binding.username || '',
    password: binding.password || '',
  };
  try {
    const verifyFn = testHooks.testProxy || testProxy;
    const verified = await verifyFn(proxy, { verifyUrl: getDynamicProxyConfig().verifyUrl, timeoutMs: opts.timeoutMs || 10000 });
    const saved = saveAccountProxyBinding({
      ...binding,
      status: 'active',
      egressIp: verified.egressIp || binding.egressIp,
      country: verified.country || binding.country,
      region: verified.region || binding.region,
      city: verified.city || binding.city,
      ispOrg: verified.ispOrg || binding.ispOrg,
      lastVerifiedAt: nowMs(),
      verifyError: '',
      updatedAt: nowMs(),
    });
    return { success: true, binding: maskedBinding(saved), verified };
  } catch (e) {
    const failed = saveAccountProxyBinding({
      ...binding,
      status: 'failed',
      verifyError: e.message || String(e),
      failCount: (binding.failCount || 0) + 1,
      updatedAt: nowMs(),
    });
    await afterBindingChanged(binding.accountId, 'dynamic_proxy_verify_failed');
    throw Object.assign(new Error(e.message || String(e)), { binding: maskedBinding(failed) });
  }
}

export function clearAccountDynamicProxy(accountId) {
  return deleteAccountProxyBinding(accountId);
}

export function clearAccountsDynamicProxy(accountIds = []) {
  let changed = 0;
  for (const id of accountIds || []) {
    if (deleteAccountProxyBinding(id)) changed++;
  }
  return changed;
}

export async function suspendAccountDynamicProxy(accountId, reason = 'account_disabled') {
  const binding = getAccountProxyBinding(accountId);
  if (!binding) return null;
  const saved = saveAccountProxyBinding({
    ...binding,
    status: 'suspended',
    verifyError: reason,
    updatedAt: nowMs(),
  });
  await afterBindingChanged(binding.accountId, 'dynamic_proxy_suspended');
  return maskedBinding(saved);
}

export async function resumeAccountDynamicProxy(accountId) {
  const binding = getAccountProxyBinding(accountId);
  if (!binding) return null;
  if (binding.expiresAt && binding.expiresAt > nowMs() && binding.status !== 'failed') {
    const saved = saveAccountProxyBinding({ ...binding, status: 'active', verifyError: '', updatedAt: nowMs() });
    await afterBindingChanged(binding.accountId, 'dynamic_proxy_resumed');
    verifyAccountDynamicProxy(accountId).catch(e => log.debug(`dynamic-proxy: resume verify failed for ${accountId}: ${e.message}`));
    return maskedBinding(saved);
  }
  return (await rotateAccountDynamicProxy(accountId)).binding;
}

export async function markDynamicProxyFailure(accountId, error, opts = {}) {
  if (!accountId) return null;
  const binding = getAccountProxyBinding(accountId);
  if (!binding) return null;
  const msg = String(error?.message || error || opts.reason || 'dynamic_proxy_failure').slice(0, 500);
  const saved = saveAccountProxyBinding({
    ...binding,
    status: opts.expired ? 'expired' : 'failed',
    verifyError: msg,
    failCount: (binding.failCount || 0) + 1,
    expiresAt: opts.expired ? Math.min(binding.expiresAt || 0, nowMs()) : binding.expiresAt,
    updatedAt: nowMs(),
  });
  await afterBindingChanged(accountId, 'dynamic_proxy_runtime_failure');
  if (getDynamicProxyConfig().enabled && opts.autoRebind !== false) {
    setTimeout(() => {
      rotateAccountDynamicProxy(accountId).catch(e => log.warn(`dynamic-proxy: auto rotate failed for ${accountId}: ${e.message}`));
    }, 250).unref?.();
  }
  return maskedBinding(saved);
}

export async function autoBindNewAccountIfEnabled(accountId) {
  const cfg = getDynamicProxyConfig();
  if (!cfg.enabled || !cfg.autoBindNewAccounts) return null;
  return bindAccountDynamicProxy(accountId).catch(e => {
    log.warn(`dynamic-proxy: auto bind failed for ${accountId}: ${e.message}`);
    return null;
  });
}

export function getDynamicProxyWorkerPlan(accounts = []) {
  const cfg = getDynamicProxyConfig();
  const accountMap = new Map((accounts || []).map(a => [a.id, a]));
  const now = nowMs();
  const bindings = getAccountProxyBindings();
  const candidates = [];
  for (const binding of bindings) {
    const account = accountMap.get(binding.accountId);
    if (!account || account.status !== 'active') continue;
    if (binding.status === 'suspended') continue;
    if (binding.status === 'failed' || binding.status === 'expired') {
      candidates.push({ accountId: binding.accountId, reason: binding.status, priority: 1 });
      continue;
    }
    if (binding.status === 'active' && binding.expiresAt && binding.expiresAt <= now + cfg.renewBeforeMs) {
      candidates.push({ accountId: binding.accountId, reason: 'expiring_soon', priority: 2 });
    }
  }
  if (cfg.enabled && cfg.autoBindNewAccounts) {
    const bound = new Set(bindings.map(b => b.accountId));
    for (const account of accounts || []) {
      if (account.status === 'active' && !bound.has(account.id)) {
        candidates.push({ accountId: account.id, reason: 'unbound', priority: 3 });
      }
    }
  }
  candidates.sort((a, b) => a.priority - b.priority);
  return candidates.slice(0, cfg.workerBatchSize);
}

export function _setDynamicProxyTestHooks(hooks = {}) {
  testHooks.testProxy = typeof hooks.testProxy === 'function' ? hooks.testProxy : null;
  testHooks.skipAfterBindingChanged = !!hooks.skipAfterBindingChanged;
}
