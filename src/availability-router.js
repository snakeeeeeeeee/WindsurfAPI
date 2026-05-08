import { log } from './config.js';
import { getAvailabilityRuntimeConfig, setAvailabilityRuntimeConfig } from './runtime-config.js';
import { MODELS, pickRateLimitFallback, publicModelAliases } from './models.js';
import {
  sharedStateStatus, pingSharedState, stateDel, stateGetJson, stateKeys,
  stateSetJson, stateWithLock,
} from './shared-state.js';
import { recordAccountModelHealth } from './db.js';

const PREFIX = 'wsapi';
const DEFAULTS = {
  mode: 'passive_strong',
  probeConcurrencyPerModel: 3,
  backgroundProbePerModel: 0,
  backgroundProbeGlobal: 0,
  modelBreakerMinMs: 120000,
  modelBreakerThreshold: 3,
  modelBreakerWindowMs: 8000,
  autoFallback: 'same_family',
  workerEnabled: false,
  workerIntervalMs: 300000,
  workerBatchAccounts: 10,
  workerBatchModels: 0,
  workerProbeMode: 'cheap_only',
  workerJitterMs: 5000,
  workerMaxRuntimeMs: 30000,
  hotPoolMinPerModel: 0,
  hotPoolMaxPerModel: 30,
  hotPoolFreshMs: 7200000,
  requestProbeEnabled: false,
  requestProbeConcurrency: 3,
  requestProbeBudgetMs: 2000,
  fastSwitchMaxAttempts: 9,
  fastSwitchBudgetMs: 8000,
  accountScoreFailurePenaltyMs: 300000,
  trackedModelPatterns: [
    'claude-4.5-haiku',
    'claude-sonnet-4.6',
    'claude-opus-4.6',
    'claude-opus-4-7-low',
    'claude-opus-4-7-medium',
    'claude-opus-4-7-high',
    'claude-opus-4-7-xhigh',
    'claude-opus-4-7-max',
  ].join('\n'),
};

const local = {
  accountCooldowns: new Map(),
  modelBreakers: new Map(),
  modelHealth: new Map(),
  rateLimitEvents: new Map(),
  lastSyncAt: 0,
  syncTimer: null,
};

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

function envString(name, fallback, allowed = null) {
  const v = String(process.env[name] || '').trim();
  if (!v) return fallback;
  if (allowed && !allowed.includes(v)) return fallback;
  return v;
}

function boolValue(value, fallback = false) {
  if (value === true || value === 'true' || value === '1' || value === 1) return true;
  if (value === false || value === 'false' || value === '0' || value === 0) return false;
  return fallback;
}

function normalizePatternList(value) {
  const raw = Array.isArray(value) ? value.join('\n') : String(value ?? '');
  return [...new Set(raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean))].join('\n');
}

export function getAvailabilityConfig() {
  const runtime = getAvailabilityRuntimeConfig();
  return {
    mode: runtime.mode || envString('WINDSURFAPI_AVAILABILITY_MODE', DEFAULTS.mode, ['off', 'passive_strong', 'conservative', 'aggressive']),
    probeConcurrencyPerModel: Number(runtime.probeConcurrencyPerModel ?? envInt('WINDSURFAPI_PROBE_CONCURRENCY_PER_MODEL', DEFAULTS.probeConcurrencyPerModel)),
    backgroundProbePerModel: Number(runtime.backgroundProbePerModel ?? envInt('WINDSURFAPI_BACKGROUND_PROBE_PER_MODEL', DEFAULTS.backgroundProbePerModel)),
    backgroundProbeGlobal: Number(runtime.backgroundProbeGlobal ?? envInt('WINDSURFAPI_BACKGROUND_PROBE_GLOBAL', DEFAULTS.backgroundProbeGlobal)),
    modelBreakerMinMs: Number(runtime.modelBreakerMinMs ?? envInt('WINDSURFAPI_MODEL_BREAKER_MIN_MS', DEFAULTS.modelBreakerMinMs)),
    modelBreakerThreshold: Number(runtime.modelBreakerThreshold ?? envInt('WINDSURFAPI_MODEL_BREAKER_THRESHOLD', DEFAULTS.modelBreakerThreshold)),
    modelBreakerWindowMs: Number(runtime.modelBreakerWindowMs ?? envInt('WINDSURFAPI_MODEL_BREAKER_WINDOW_MS', DEFAULTS.modelBreakerWindowMs)),
    autoFallback: runtime.autoFallback || envString('WINDSURFAPI_AUTO_FALLBACK', DEFAULTS.autoFallback, ['off', 'same_family']),
    workerEnabled: boolValue(runtime.workerEnabled, envString('WINDSURFAPI_AVAILABILITY_WORKER_ENABLED', DEFAULTS.workerEnabled ? '1' : '0', ['0', '1']) === '1'),
    workerIntervalMs: Number(runtime.workerIntervalMs ?? envInt('WINDSURFAPI_AVAILABILITY_WORKER_INTERVAL_MS', DEFAULTS.workerIntervalMs)),
    workerBatchAccounts: Number(runtime.workerBatchAccounts ?? envInt('WINDSURFAPI_AVAILABILITY_WORKER_BATCH_ACCOUNTS', DEFAULTS.workerBatchAccounts)),
    workerBatchModels: Number(runtime.workerBatchModels ?? envInt('WINDSURFAPI_AVAILABILITY_WORKER_BATCH_MODELS', DEFAULTS.workerBatchModels)),
    workerProbeMode: runtime.workerProbeMode || envString('WINDSURFAPI_AVAILABILITY_WORKER_PROBE_MODE', DEFAULTS.workerProbeMode, ['cheap_only', 'selective_model', 'aggressive_model']),
    workerJitterMs: Number(runtime.workerJitterMs ?? envInt('WINDSURFAPI_AVAILABILITY_WORKER_JITTER_MS', DEFAULTS.workerJitterMs)),
    workerMaxRuntimeMs: Number(runtime.workerMaxRuntimeMs ?? envInt('WINDSURFAPI_AVAILABILITY_WORKER_MAX_RUNTIME_MS', DEFAULTS.workerMaxRuntimeMs)),
    hotPoolMinPerModel: Number(runtime.hotPoolMinPerModel ?? envInt('WINDSURFAPI_HOT_POOL_MIN_PER_MODEL', DEFAULTS.hotPoolMinPerModel)),
    hotPoolMaxPerModel: Number(runtime.hotPoolMaxPerModel ?? envInt('WINDSURFAPI_HOT_POOL_MAX_PER_MODEL', DEFAULTS.hotPoolMaxPerModel)),
    hotPoolFreshMs: Number(runtime.hotPoolFreshMs ?? envInt('WINDSURFAPI_HOT_POOL_FRESH_MS', DEFAULTS.hotPoolFreshMs)),
    requestProbeEnabled: boolValue(runtime.requestProbeEnabled, envString('WINDSURFAPI_REQUEST_PROBE_ENABLED', DEFAULTS.requestProbeEnabled ? '1' : '0', ['0', '1']) === '1'),
    requestProbeConcurrency: Number(runtime.requestProbeConcurrency ?? envInt('WINDSURFAPI_REQUEST_PROBE_CONCURRENCY', DEFAULTS.requestProbeConcurrency)),
    requestProbeBudgetMs: Number(runtime.requestProbeBudgetMs ?? envInt('WINDSURFAPI_REQUEST_PROBE_BUDGET_MS', DEFAULTS.requestProbeBudgetMs)),
    fastSwitchMaxAttempts: Number(runtime.fastSwitchMaxAttempts ?? envInt('WINDSURFAPI_FAST_SWITCH_MAX_ATTEMPTS', DEFAULTS.fastSwitchMaxAttempts)),
    fastSwitchBudgetMs: Number(runtime.fastSwitchBudgetMs ?? envInt('WINDSURFAPI_FAST_SWITCH_BUDGET_MS', DEFAULTS.fastSwitchBudgetMs)),
    accountScoreFailurePenaltyMs: Number(runtime.accountScoreFailurePenaltyMs ?? envInt('WINDSURFAPI_ACCOUNT_SCORE_FAILURE_PENALTY_MS', DEFAULTS.accountScoreFailurePenaltyMs)),
    trackedModelPatterns: normalizePatternList(runtime.trackedModelPatterns ?? envString('WINDSURFAPI_AVAILABILITY_TRACKED_MODEL_PATTERNS', DEFAULTS.trackedModelPatterns)),
  };
}

export function updateAvailabilityConfig(patch) {
  return setAvailabilityRuntimeConfig(patch || {});
}

function keyAccountCooldown(accountId, modelKey) {
  return `${PREFIX}:acct_cd:${accountId}:${modelKey || '*'}`;
}

function keyModelBreaker(modelKey) {
  return `${PREFIX}:model_breaker:${modelKey}`;
}

function keyModelHealth(modelKey) {
  return `${PREFIX}:model_health:${modelKey}`;
}

function keyModelEvents(modelKey) {
  return `${PREFIX}:model_rl_events:${modelKey}`;
}

function keyProbeLock(modelKey) {
  return `${PREFIX}:model_probe_lock:${modelKey}`;
}

export function keyWorkerLock() {
  return `${PREFIX}:availability_worker_lock`;
}

function nowMs() {
  return Date.now();
}

function isActiveUntil(entry, now = nowMs()) {
  return !!entry && (!entry.until || entry.until > now);
}

function cooldownMapKey(accountId, modelKey) {
  return `${accountId}|${modelKey || '*'}`;
}

function upsertLocalCooldown(entry) {
  if (!entry?.accountId) return;
  const k = cooldownMapKey(entry.accountId, entry.modelKey || '*');
  if (isActiveUntil(entry)) local.accountCooldowns.set(k, entry);
  else local.accountCooldowns.delete(k);
}

export function isAccountModelCoolingDown(accountId, modelKey, now = nowMs()) {
  const specific = local.accountCooldowns.get(cooldownMapKey(accountId, modelKey));
  if (isActiveUntil(specific, now)) return true;
  const global = local.accountCooldowns.get(cooldownMapKey(accountId, '*'));
  return isActiveUntil(global, now);
}

export function getAccountModelCooldown(accountId, modelKey, now = nowMs()) {
  const specific = local.accountCooldowns.get(cooldownMapKey(accountId, modelKey));
  if (isActiveUntil(specific, now)) return specific;
  const global = local.accountCooldowns.get(cooldownMapKey(accountId, '*'));
  if (isActiveUntil(global, now)) return global;
  return null;
}

export async function markAccountModelCooldown({ accountId, email = '', modelKey = '*', durationMs = 300000, source = 'upstream_rate_limit', reason = '' }) {
  if (!accountId) return null;
  const safeMs = Math.max(1000, Number(durationMs) || 0);
  const entry = {
    accountId,
    email,
    modelKey: modelKey || '*',
    source,
    reason,
    until: nowMs() + safeMs,
    updatedAt: nowMs(),
  };
  upsertLocalCooldown(entry);
  await stateSetJson(keyAccountCooldown(accountId, entry.modelKey), entry, safeMs);
  return entry;
}

export async function clearAccountModelCooldown(accountId, modelKey = '*') {
  local.accountCooldowns.delete(cooldownMapKey(accountId, modelKey));
  await stateDel(keyAccountCooldown(accountId, modelKey));
}

export function getLocalAccountCooldowns() {
  const now = nowMs();
  const out = [];
  for (const [k, entry] of local.accountCooldowns) {
    if (isActiveUntil(entry, now)) out.push({ ...entry, remainingMs: Math.max(0, entry.until - now) });
    else local.accountCooldowns.delete(k);
  }
  out.sort((a, b) => a.until - b.until);
  return out;
}

export async function recordRateLimitEvent({ modelKey, accountId = '', email = '', retryAfterMs = 30000, reason = '' }) {
  if (!modelKey) return null;
  const cfg = getAvailabilityConfig();
  const now = nowMs();
  const windowMs = Math.max(1000, cfg.modelBreakerWindowMs || DEFAULTS.modelBreakerWindowMs);
  const events = (local.rateLimitEvents.get(modelKey) || []).filter(e => e.time >= now - windowMs);
  events.push({ time: now, modelKey, accountId, email, retryAfterMs, reason });
  local.rateLimitEvents.set(modelKey, events);
  await stateSetJson(keyModelEvents(modelKey), events, windowMs * 4);
  if (cfg.mode !== 'off' && events.length >= Math.max(1, cfg.modelBreakerThreshold || DEFAULTS.modelBreakerThreshold)) {
    const until = now + Math.max(1000, cfg.modelBreakerMinMs || DEFAULTS.modelBreakerMinMs, Number(retryAfterMs) || 0);
    const state = cfg.mode === 'aggressive' ? 'open' : 'degraded';
    await setModelBreaker(modelKey, {
      state,
      reason: 'rate_limit_burst',
      retryAfterMs: until - now,
      until,
      eventCount: events.length,
      updatedAt: now,
    });
    log.warn(`availability: model breaker ${state} for ${modelKey} after ${events.length} rate-limit event(s)`);
  }
  return { events: events.length, windowMs };
}

export function getLocalRateLimitEvents(modelKey) {
  const cfg = getAvailabilityConfig();
  const cutoff = nowMs() - Math.max(1000, cfg.modelBreakerWindowMs || DEFAULTS.modelBreakerWindowMs);
  const events = (local.rateLimitEvents.get(modelKey) || []).filter(e => e.time >= cutoff);
  local.rateLimitEvents.set(modelKey, events);
  return events;
}

export async function clearModelRateLimitEvents(modelKey) {
  local.rateLimitEvents.delete(modelKey);
  await stateDel(keyModelEvents(modelKey));
}

export async function setModelBreaker(modelKey, patch = {}) {
  if (!modelKey) return null;
  const now = nowMs();
  const current = local.modelBreakers.get(modelKey) || {};
  const next = {
    modelKey,
    state: patch.state || current.state || 'closed',
    reason: patch.reason ?? current.reason ?? '',
    until: Number(patch.until ?? current.until ?? 0),
    retryAfterMs: Number(patch.retryAfterMs ?? current.retryAfterMs ?? 0),
    eventCount: Number(patch.eventCount ?? current.eventCount ?? 0),
    lastSuccessAt: patch.lastSuccessAt ?? current.lastSuccessAt ?? 0,
    lastFailureAt: patch.lastFailureAt ?? current.lastFailureAt ?? 0,
    updatedAt: now,
  };
  if (next.state === 'closed') next.until = 0;
  local.modelBreakers.set(modelKey, next);
  const ttl = next.until && next.until > now ? next.until - now : 24 * 60 * 60 * 1000;
  await stateSetJson(keyModelBreaker(modelKey), next, ttl);
  return next;
}

export function getModelBreaker(modelKey, now = nowMs()) {
  const b = local.modelBreakers.get(modelKey);
  if (!b) return { modelKey, state: 'closed', reason: '', until: 0, retryAfterMs: 0 };
  if (b.until && b.until <= now && ['open', 'degraded'].includes(b.state)) {
    const half = { ...b, state: 'half_open', reason: 'cooldown_expired', retryAfterMs: 0, updatedAt: now };
    local.modelBreakers.set(modelKey, half);
    stateSetJson(keyModelBreaker(modelKey), half, 24 * 60 * 60 * 1000).catch(() => {});
    return half;
  }
  return b;
}

export async function clearModelBreaker(modelKey) {
  local.modelBreakers.set(modelKey, { modelKey, state: 'closed', reason: 'manual_clear', until: 0, retryAfterMs: 0, updatedAt: nowMs() });
  await stateDel(keyModelBreaker(modelKey));
}

function accountQuotaScore(account) {
  const c = account?.credits;
  if (!c || typeof c !== 'object') return 100;
  const d = typeof c.dailyPercent === 'number' ? c.dailyPercent : 100;
  const w = typeof c.weeklyPercent === 'number' ? c.weeklyPercent : 100;
  return Math.max(0, Math.min(100, Math.min(d, w)));
}

function accountModelRateLimitUntil(account, modelKey, now = nowMs()) {
  if (!account) return 0;
  let until = 0;
  if (account.rateLimitedUntil && account.rateLimitedUntil > now) until = Math.max(until, account.rateLimitedUntil);
  const modelUntil = account._modelRateLimits?.[modelKey] || account.modelRateLimits?.[modelKey] || account.availabilityCooldowns?.[modelKey] || 0;
  if (modelUntil && modelUntil > now) until = Math.max(until, modelUntil);
  const globalUntil = account.availabilityCooldowns?.['*'] || 0;
  if (globalUntil && globalUntil > now) until = Math.max(until, globalUntil);
  const cd = account?.id ? getAccountModelCooldown(account.id, modelKey, now) : null;
  if (cd?.until && cd.until > now) until = Math.max(until, cd.until);
  return until;
}

function normalizeHealthEntry(entry, modelKey) {
  const successCount = Math.max(0, Number(entry?.successCount || 0));
  const failureCount = Math.max(0, Number(entry?.failureCount || 0));
  const latencySamples = Math.max(0, Number(entry?.latencySamples || 0));
  const avgLatencyMs = Number(entry?.avgLatencyMs || entry?.latencyMs || 0);
  return {
    modelKey: entry?.modelKey || modelKey,
    accountId: entry?.accountId || '',
    email: entry?.email || '',
    servedModel: entry?.servedModel || modelKey,
    lastSuccessAt: Number(entry?.lastSuccessAt || 0),
    lastFailureAt: Number(entry?.lastFailureAt || 0),
    lastRateLimitedAt: Number(entry?.lastRateLimitedAt || 0),
    lastLatencyMs: Number(entry?.lastLatencyMs || entry?.latencyMs || 0),
    avgLatencyMs,
    latencySamples,
    successCount,
    failureCount,
    lastError: String(entry?.lastError || ''),
    updatedAt: Number(entry?.updatedAt || entry?.lastSuccessAt || entry?.lastFailureAt || nowMs()),
  };
}

function scoreHealthEntry(entry, account = null, now = nowMs(), cfg = getAvailabilityConfig()) {
  const h = normalizeHealthEntry(entry, entry?.modelKey || '');
  const freshMs = Math.max(1000, Number(cfg.hotPoolFreshMs) || DEFAULTS.hotPoolFreshMs);
  const failurePenaltyMs = Math.max(1000, Number(cfg.accountScoreFailurePenaltyMs) || DEFAULTS.accountScoreFailurePenaltyMs);
  const successAge = h.lastSuccessAt ? Math.max(0, now - h.lastSuccessAt) : Infinity;
  const failureAge = h.lastFailureAt ? Math.max(0, now - h.lastFailureAt) : Infinity;
  const cooldownUntil = accountModelRateLimitUntil(account, h.modelKey, now);
  const coolingDown = cooldownUntil > now;
  const fresh = Number.isFinite(successAge) && successAge <= freshMs;
  if (!h.accountId) return { score: -Infinity, fresh: false, coolingDown, cooldownUntil, reason: 'missing_account_id' };
  if (account && account.status && account.status !== 'active') {
    return { score: -Infinity, fresh: false, coolingDown: true, cooldownUntil: 0, reason: `account_${account.status}` };
  }
  if (coolingDown) return { score: -Infinity, fresh: false, coolingDown, cooldownUntil, reason: 'cooldown' };

  let score = 0;
  if (Number.isFinite(successAge)) {
    const recency = Math.max(0, 1 - successAge / freshMs);
    score += 420 * recency;
    score += fresh ? 80 : 20;
  }
  score += Math.min(160, Math.log1p(h.successCount) * 45);
  const latency = h.avgLatencyMs || h.lastLatencyMs || 0;
  if (latency > 0) score += Math.max(0, 140 - latency / 40);
  if (account) {
    score += accountQuotaScore(account);
    score -= Math.min(160, Number(account._inflight || 0) * 35);
  }
  if (Number.isFinite(failureAge) && failureAge <= failurePenaltyMs) {
    const penalty = Math.max(0, 1 - failureAge / failurePenaltyMs);
    score -= 260 * penalty;
  }
  if (h.lastRateLimitedAt && now - h.lastRateLimitedAt <= failurePenaltyMs * 2) {
    const penalty = Math.max(0, 1 - (now - h.lastRateLimitedAt) / (failurePenaltyMs * 2));
    score -= 180 * penalty;
  }
  score -= Math.min(120, h.failureCount * 12);
  return {
    score: Math.round(score),
    fresh,
    coolingDown: false,
    cooldownUntil: 0,
    reason: score > 0 ? 'hot' : 'weak_score',
  };
}

function accountMapFrom(accounts = []) {
  return new Map((accounts || []).filter(a => a?.id).map(a => [a.id, a]));
}

function sortedHotPool(modelKey, accounts = [], { includeCooling = false } = {}) {
  const cfg = getAvailabilityConfig();
  const now = nowMs();
  const byId = accountMapFrom(accounts);
  const hasAccountContext = Array.isArray(accounts);
  const rows = getHealthyAccounts(modelKey).map(raw => {
    const h = normalizeHealthEntry(raw, modelKey);
    const account = byId.get(h.accountId) || null;
    const scored = hasAccountContext && (!account || (account.status || 'active') !== 'active')
      ? { score: -Infinity, fresh: false, coolingDown: true, cooldownUntil: 0, reason: account ? `account_${account.status}` : 'account_missing' }
      : scoreHealthEntry(h, account, now, cfg);
    return {
      ...h,
      ...scored,
      ageMs: h.lastSuccessAt ? Math.max(0, now - h.lastSuccessAt) : 0,
      accountStatus: account?.status || '',
    };
  }).filter(h => includeCooling || !h.coolingDown);
  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.lastSuccessAt || 0) - (a.lastSuccessAt || 0);
  });
  const cap = Math.max(1, Number(cfg.hotPoolMaxPerModel) || DEFAULTS.hotPoolMaxPerModel);
  return rows.slice(0, cap);
}

export async function recordHealthyAccount({ modelKey, accountId, email = '', servedModel = '', latencyMs = 0, source = 'availability_router' }) {
  if (!modelKey || !accountId) return;
  const cfg = getAvailabilityConfig();
  const now = nowMs();
  const arr = local.modelHealth.get(modelKey) || [];
  const idx = arr.findIndex(x => x.accountId === accountId);
  const prev = idx >= 0 ? normalizeHealthEntry(arr[idx], modelKey) : null;
  const safeLatency = Math.max(0, Number(latencyMs) || 0);
  const prevSamples = prev?.latencySamples || 0;
  const nextSamples = safeLatency > 0 ? Math.min(1000, prevSamples + 1) : prevSamples;
  const avgLatencyMs = safeLatency > 0
    ? Math.round((((prev?.avgLatencyMs || safeLatency) * prevSamples) + safeLatency) / Math.max(1, nextSamples))
    : (prev?.avgLatencyMs || 0);
  const next = {
    modelKey,
    accountId,
    email,
    servedModel: servedModel || modelKey,
    lastSuccessAt: now,
    lastFailureAt: prev?.lastFailureAt || 0,
    lastRateLimitedAt: prev?.lastRateLimitedAt || 0,
    lastLatencyMs: safeLatency || prev?.lastLatencyMs || 0,
    avgLatencyMs,
    latencySamples: nextSamples,
    successCount: (prev?.successCount || 0) + 1,
    failureCount: prev?.failureCount || 0,
    lastError: '',
    updatedAt: now,
  };
  if (idx >= 0) arr.splice(idx, 1);
  arr.unshift(next);
  const capped = arr.slice(0, Math.max(1, Number(cfg.hotPoolMaxPerModel) || DEFAULTS.hotPoolMaxPerModel));
  local.modelHealth.set(modelKey, capped);
  await stateSetJson(keyModelHealth(modelKey), capped, 7 * 24 * 60 * 60 * 1000);
  try {
    recordAccountModelHealth({ ...next, source });
  } catch (e) {
    log.debug(`availability: failed to record health history for ${accountId}/${modelKey}: ${e.message}`);
  }
  const b = getModelBreaker(modelKey);
  if (b.state === 'half_open') {
    await setModelBreaker(modelKey, { state: 'closed', reason: 'healthy_account_success', lastSuccessAt: now });
  } else if (b.state === 'open' || b.state === 'degraded') {
    await setModelBreaker(modelKey, { ...b, lastSuccessAt: now });
  }
}

export async function recordUnhealthyAccount({ modelKey, accountId, email = '', error = '', rateLimited = false, latencyMs = 0 }) {
  if (!modelKey || !accountId) return;
  const now = nowMs();
  const arr = local.modelHealth.get(modelKey) || [];
  const idx = arr.findIndex(x => x.accountId === accountId);
  const prev = idx >= 0 ? normalizeHealthEntry(arr[idx], modelKey) : {
    modelKey,
    accountId,
    email,
    servedModel: modelKey,
  };
  const next = {
    ...prev,
    email: email || prev.email || '',
    lastFailureAt: now,
    lastRateLimitedAt: rateLimited ? now : (prev.lastRateLimitedAt || 0),
    lastLatencyMs: Math.max(0, Number(latencyMs) || prev.lastLatencyMs || 0),
    failureCount: (prev.failureCount || 0) + 1,
    lastError: String(error || '').slice(0, 240),
    updatedAt: now,
  };
  if (idx >= 0) arr.splice(idx, 1);
  arr.unshift(next);
  const cap = Math.max(1, Number(getAvailabilityConfig().hotPoolMaxPerModel) || DEFAULTS.hotPoolMaxPerModel);
  const capped = arr.slice(0, cap);
  local.modelHealth.set(modelKey, capped);
  await stateSetJson(keyModelHealth(modelKey), capped, 7 * 24 * 60 * 60 * 1000);
}

export function getHealthyAccounts(modelKey) {
  return [...(local.modelHealth.get(modelKey) || [])];
}

export function getLocalModelHealthEntries() {
  const out = [];
  for (const [modelKey, arr] of local.modelHealth) {
    for (const h of arr || []) out.push(normalizeHealthEntry(h, h.modelKey || modelKey));
  }
  return out;
}

export async function removeHealthyAccount(modelKey, accountId) {
  const arr = (local.modelHealth.get(modelKey) || []).filter(x => x.accountId !== accountId);
  local.modelHealth.set(modelKey, arr);
  await stateSetJson(keyModelHealth(modelKey), arr, 7 * 24 * 60 * 60 * 1000);
}

export async function purgeAccountAvailabilityState(accountId, { reason = 'account_removed' } = {}) {
  if (!accountId) return { accountId, cooldownsCleared: 0, healthEntriesRemoved: 0 };
  let cooldownsCleared = 0;
  for (const key of [...local.accountCooldowns.keys()]) {
    if (key.startsWith(`${accountId}|`)) {
      local.accountCooldowns.delete(key);
      cooldownsCleared++;
    }
  }
  const cooldownKeys = await stateKeys(`${PREFIX}:acct_cd:${accountId}:*`);
  for (const key of cooldownKeys) {
    await stateDel(key);
  }
  cooldownsCleared += cooldownKeys.length;

  let healthEntriesRemoved = 0;
  const modelKeys = new Set(local.modelHealth.keys());
  const healthKeys = await stateKeys(`${PREFIX}:model_health:*`);
  for (const key of healthKeys) {
    const modelKey = key.slice(`${PREFIX}:model_health:`.length);
    if (modelKey) modelKeys.add(modelKey);
  }
  for (const modelKey of modelKeys) {
    const redisArr = await stateGetJson(keyModelHealth(modelKey));
    const current = Array.isArray(redisArr) ? redisArr : (local.modelHealth.get(modelKey) || []);
    const filtered = current.filter(x => x?.accountId !== accountId);
    const removed = current.length - filtered.length;
    if (removed <= 0) continue;
    healthEntriesRemoved += removed;
    if (filtered.length) {
      local.modelHealth.set(modelKey, filtered);
      await stateSetJson(keyModelHealth(modelKey), filtered, 7 * 24 * 60 * 60 * 1000);
    } else {
      local.modelHealth.delete(modelKey);
      await stateDel(keyModelHealth(modelKey));
    }
  }
  log.info(`availability: purged account ${accountId} state (${reason}); cooldowns=${cooldownsCleared}, health=${healthEntriesRemoved}`);
  return { accountId, cooldownsCleared, healthEntriesRemoved };
}

export function getPreferredHotAccountIds(modelKey, accounts = []) {
  return sortedHotPool(modelKey, accounts)
    .filter(x => x.score > 0)
    .map(x => x.accountId);
}

export function getPreferredHealthyAccountIds(modelKey, accounts = []) {
  const hot = getPreferredHotAccountIds(modelKey, accounts);
  if (hot.length) return hot;
  return getHealthyAccounts(modelKey).map(x => x.accountId);
}

export function getHotPoolRows(modelKey, accounts = [], opts = {}) {
  return sortedHotPool(modelKey, accounts, opts);
}

export function getHotPoolStats(modelKey, accounts = []) {
  const cfg = getAvailabilityConfig();
  const rows = sortedHotPool(modelKey, accounts, { includeCooling: true });
  const ready = rows.filter(x => !x.coolingDown && x.score > 0);
  const fresh = ready.filter(x => x.fresh);
  const target = Math.max(0, Number(cfg.hotPoolMinPerModel) || DEFAULTS.hotPoolMinPerModel);
  const max = Math.max(1, Number(cfg.hotPoolMaxPerModel) || DEFAULTS.hotPoolMaxPerModel);
  const latencies = ready.map(x => x.avgLatencyMs || x.lastLatencyMs || 0).filter(Boolean);
  return {
    modelKey,
    target,
    max,
    total: rows.length,
    ready: ready.length,
    fresh: fresh.length,
    deficit: Math.max(0, target - fresh.length),
    fillRate: target > 0 ? Math.min(1, fresh.length / target) : 1,
    avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
    topAccounts: ready.slice(0, 5),
  };
}

export function getAccountHotScores(account, now = nowMs()) {
  if (!account?.id) return [];
  const tracked = new Set(getTrackedAvailabilityModels());
  const out = [];
  for (const [modelKey, arr] of local.modelHealth) {
    if (!tracked.has(modelKey)) continue;
    const hit = (arr || []).find(h => h.accountId === account.id);
    if (!hit) continue;
    const h = normalizeHealthEntry(hit, modelKey);
    const scored = scoreHealthEntry(h, account, now, getAvailabilityConfig());
    out.push({
      modelKey,
      score: scored.score,
      fresh: scored.fresh,
      coolingDown: scored.coolingDown,
      cooldownUntil: scored.cooldownUntil,
      reason: scored.reason,
      lastSuccessAt: h.lastSuccessAt,
      lastFailureAt: h.lastFailureAt,
      successCount: h.successCount,
      failureCount: h.failureCount,
      avgLatencyMs: h.avgLatencyMs,
      lastError: h.lastError,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

export function getFallbackForModel(modelKey, requestMeta = {}) {
  const cfg = getAvailabilityConfig();
  if (cfg.autoFallback === 'off') return null;
  const candidate = pickRateLimitFallback(modelKey);
  if (!candidate) return null;
  if (requestMeta?.requires1m && !candidate.includes('1m')) return null;
  return candidate;
}

export function getRouteAdvice(modelKey, requestMeta = {}) {
  const breaker = getModelBreaker(modelKey);
  const healthyAccountIds = getPreferredHealthyAccountIds(modelKey, requestMeta?.accounts || []);
  const hasHealthyAccounts = healthyAccountIds.length > 0;
  const fallbackModel = ['open', 'degraded'].includes(breaker.state)
    ? getFallbackForModel(modelKey, requestMeta)
    : null;
  return {
    modelKey,
    breaker,
    healthyAccountIds,
    hasHealthyAccounts,
    fallbackModel,
    shouldFallback: !!fallbackModel && breaker.state === 'open' && !hasHealthyAccounts,
    shouldShortCircuit: breaker.state === 'open' && !hasHealthyAccounts,
    retryAfterMs: breaker.until ? Math.max(1000, breaker.until - nowMs()) : breaker.retryAfterMs || 0,
  };
}

export async function withModelProbeLock(modelKey, fn) {
  return stateWithLock(keyProbeLock(modelKey), 10_000, fn);
}

async function syncPattern(pattern, apply) {
  const keys = await stateKeys(pattern);
  for (const key of keys) {
    const value = await stateGetJson(key);
    if (value) apply(value);
  }
}

export async function syncAvailabilityStateOnce() {
  await pingSharedState().catch(() => {});
  await syncPattern(`${PREFIX}:acct_cd:*`, upsertLocalCooldown);
  await syncPattern(`${PREFIX}:model_breaker:*`, b => {
    if (b?.modelKey) local.modelBreakers.set(b.modelKey, b);
  });
  await syncPattern(`${PREFIX}:model_health:*`, arr => {
    if (Array.isArray(arr) && arr[0]?.modelKey) local.modelHealth.set(arr[0].modelKey, arr);
  });
  await syncPattern(`${PREFIX}:model_rl_events:*`, arr => {
    if (Array.isArray(arr) && arr[0]?.modelKey) local.rateLimitEvents.set(arr[0].modelKey, arr);
  });
  await pruneAvailabilityState({ includeUntrackedModels: true, reason: 'state_sync' });
  local.lastSyncAt = nowMs();
}

export async function pruneAvailabilityState({ accounts = null, includeUntrackedModels = true, reason = 'manual_prune' } = {}) {
  const tracked = new Set(getTrackedAvailabilityModels());
  const accountById = accounts ? new Map((accounts || []).map(a => [a.id, a])) : null;
  const isActiveAccount = (accountId) => {
    if (!accountById) return true;
    const account = accountById.get(accountId);
    return !!account && (account.status || 'active') === 'active';
  };
  const out = {
    cooldownsRemoved: 0,
    healthEntriesRemoved: 0,
    healthKeysRemoved: 0,
    breakerKeysRemoved: 0,
    eventKeysRemoved: 0,
  };

  const cooldownKeys = await stateKeys(`${PREFIX}:acct_cd:*`);
  for (const key of cooldownKeys) {
    const rest = key.slice(`${PREFIX}:acct_cd:`.length);
    const sep = rest.indexOf(':');
    const accountId = sep >= 0 ? rest.slice(0, sep) : '';
    const modelKey = sep >= 0 ? rest.slice(sep + 1) : '*';
    if (includeUntrackedModels && modelKey !== '*' && !tracked.has(modelKey)) {
      local.accountCooldowns.delete(cooldownMapKey(accountId, modelKey));
      await stateDel(key);
      out.cooldownsRemoved++;
      continue;
    }
    if (!isActiveAccount(accountId)) {
      local.accountCooldowns.delete(cooldownMapKey(accountId, modelKey));
      await stateDel(key);
      out.cooldownsRemoved++;
    }
  }
  for (const key of [...local.accountCooldowns.keys()]) {
    const [accountId, modelKey = '*'] = key.split('|');
    if ((includeUntrackedModels && modelKey !== '*' && !tracked.has(modelKey)) || !isActiveAccount(accountId)) {
      local.accountCooldowns.delete(key);
      out.cooldownsRemoved++;
    }
  }

  const healthKeys = await stateKeys(`${PREFIX}:model_health:*`);
  const modelKeys = new Set([...local.modelHealth.keys()]);
  for (const key of healthKeys) {
    const modelKey = key.slice(`${PREFIX}:model_health:`.length);
    if (modelKey) modelKeys.add(modelKey);
  }
  for (const modelKey of modelKeys) {
    const redisArr = await stateGetJson(keyModelHealth(modelKey));
    const current = Array.isArray(redisArr) ? redisArr : (local.modelHealth.get(modelKey) || []);
    if (includeUntrackedModels && !tracked.has(modelKey)) {
      if (current.length) out.healthEntriesRemoved += current.length;
      if (local.modelHealth.has(modelKey)) local.modelHealth.delete(modelKey);
      await stateDel(keyModelHealth(modelKey));
      out.healthKeysRemoved++;
      continue;
    }
    const filtered = current.filter(x => isActiveAccount(x?.accountId));
    const removed = current.length - filtered.length;
    if (removed > 0) out.healthEntriesRemoved += removed;
    if (filtered.length) {
      local.modelHealth.set(modelKey, filtered);
      if (removed > 0) await stateSetJson(keyModelHealth(modelKey), filtered, 7 * 24 * 60 * 60 * 1000);
    } else if (current.length || local.modelHealth.has(modelKey)) {
      local.modelHealth.delete(modelKey);
      await stateDel(keyModelHealth(modelKey));
      if (current.length) out.healthKeysRemoved++;
    }
  }

  if (includeUntrackedModels) {
    const breakerKeys = await stateKeys(`${PREFIX}:model_breaker:*`);
    for (const key of breakerKeys) {
      const modelKey = key.slice(`${PREFIX}:model_breaker:`.length);
      if (!modelKey || tracked.has(modelKey)) continue;
      local.modelBreakers.delete(modelKey);
      await stateDel(key);
      out.breakerKeysRemoved++;
    }
    for (const modelKey of [...local.modelBreakers.keys()]) {
      if (tracked.has(modelKey)) continue;
      local.modelBreakers.delete(modelKey);
      out.breakerKeysRemoved++;
    }
    const eventKeys = await stateKeys(`${PREFIX}:model_rl_events:*`);
    for (const key of eventKeys) {
      const modelKey = key.slice(`${PREFIX}:model_rl_events:`.length);
      if (!modelKey || tracked.has(modelKey)) continue;
      local.rateLimitEvents.delete(modelKey);
      await stateDel(key);
      out.eventKeysRemoved++;
    }
    for (const modelKey of [...local.rateLimitEvents.keys()]) {
      if (tracked.has(modelKey)) continue;
      local.rateLimitEvents.delete(modelKey);
      out.eventKeysRemoved++;
    }
  }

  const total = out.cooldownsRemoved + out.healthEntriesRemoved + out.healthKeysRemoved + out.breakerKeysRemoved + out.eventKeysRemoved;
  if (total) log.info(`availability: pruned stale state (${reason}); ${JSON.stringify(out)}`);
  return out;
}

export function startAvailabilityStateSync() {
  if (local.syncTimer) return;
  syncAvailabilityStateOnce().catch(e => log.warn(`availability: initial sync failed: ${e.message}`));
  local.syncTimer = setInterval(() => {
    syncAvailabilityStateOnce().catch(e => log.debug(`availability: sync failed: ${e.message}`));
  }, 5000);
  local.syncTimer.unref?.();
}

export function stopAvailabilityStateSync() {
  if (local.syncTimer) clearInterval(local.syncTimer);
  local.syncTimer = null;
}

export async function forceModelProbe(modelKey, probeFn) {
  if (!modelKey || typeof probeFn !== 'function') return { ok: false, error: 'invalid_probe' };
  const locked = await withModelProbeLock(modelKey, async () => {
    try {
      const result = await probeFn();
      await setModelBreaker(modelKey, { state: 'closed', reason: 'manual_probe_success', lastSuccessAt: nowMs() });
      return { ok: true, result };
    } catch (e) {
      await setModelBreaker(modelKey, { state: 'degraded', reason: `manual_probe_failed:${e.message}`, lastFailureAt: nowMs() });
      return { ok: false, error: e.message };
    }
  });
  if (!locked.acquired) return { ok: false, error: 'probe_already_running' };
  return locked.result;
}

function aliasForModel(modelKey) {
  try {
    return publicModelAliases().filter(a => a.targetKey === modelKey).map(a => a.publicName);
  } catch {
    return [];
  }
}

function splitTrackedModelPatterns() {
  return normalizePatternList(getAvailabilityConfig().trackedModelPatterns)
    .split('\n')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function wildcardToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function modelNameCandidates(modelKey) {
  const info = MODELS[modelKey] || {};
  return [...new Set([
    modelKey,
    info.name,
    info.modelUid,
    ...aliasForModel(modelKey),
  ].filter(Boolean).map(s => String(s).toLowerCase()))];
}

export function isTrackedAvailabilityModel(modelKey) {
  const patterns = splitTrackedModelPatterns();
  if (!patterns.length) return true;
  const candidates = modelNameCandidates(modelKey);
  return patterns.some(pattern => {
    const rx = wildcardToRegex(pattern);
    return candidates.some(name => rx.test(name));
  });
}

export function getTrackedAvailabilityModels() {
  return Object.keys(MODELS).filter(isTrackedAvailabilityModel).sort();
}

export function getAccountAvailabilitySummary(account, now = nowMs()) {
  if (!account) return null;
  const tracked = new Set(getTrackedAvailabilityModels());
  const byModel = new Map();
  const addCooldown = (cd) => {
    if (!cd || cd.accountId !== account.id) return;
    const modelKey = cd.modelKey || '*';
    if (modelKey !== '*' && !tracked.has(modelKey)) return;
    if (!cd.until || cd.until <= now) return;
    const prev = byModel.get(modelKey);
    if (!prev || (cd.until || 0) > (prev.until || 0)) {
      byModel.set(modelKey, { ...cd, modelKey, remainingMs: Math.max(0, cd.until - now) });
    }
  };
  for (const cd of getLocalAccountCooldowns()) addCooldown(cd);
  if (account.rateLimitedUntil && account.rateLimitedUntil > now) {
    addCooldown({
      accountId: account.id,
      email: account.email || '',
      modelKey: '*',
      source: 'auth_rate_limit',
      until: account.rateLimitedUntil,
      updatedAt: now,
    });
  }
  if (account._modelRateLimits && typeof account._modelRateLimits === 'object') {
    for (const [modelKey, until] of Object.entries(account._modelRateLimits)) {
      addCooldown({
        accountId: account.id,
        email: account.email || '',
        modelKey,
        source: 'auth_model_rate_limit',
        until,
        updatedAt: now,
      });
    }
  }
  if (account.modelRateLimits && typeof account.modelRateLimits === 'object') {
    for (const [modelKey, until] of Object.entries(account.modelRateLimits)) {
      addCooldown({
        accountId: account.id,
        email: account.email || '',
        modelKey,
        source: 'auth_model_rate_limit',
        until,
        updatedAt: now,
      });
    }
  }
  const cooldowns = [...byModel.values()].sort((a, b) => (a.until || 0) - (b.until || 0));
  const global = cooldowns.find(cd => cd.modelKey === '*') || null;
  const healthModels = [];
  for (const [modelKey, arr] of local.modelHealth) {
    if (!tracked.has(modelKey)) continue;
    const hit = (arr || []).find(h => h.accountId === account.id);
    const normalized = hit ? normalizeHealthEntry(hit, modelKey) : null;
    const scored = normalized ? scoreHealthEntry(normalized, account, now, getAvailabilityConfig()) : null;
    if (hit) healthModels.push({
      modelKey,
      score: scored?.score || 0,
      fresh: !!scored?.fresh,
      coolingDown: !!scored?.coolingDown,
      lastSuccessAt: normalized.lastSuccessAt || 0,
      lastFailureAt: normalized.lastFailureAt || 0,
      successCount: normalized.successCount || 0,
      failureCount: normalized.failureCount || 0,
      avgLatencyMs: normalized.avgLatencyMs || 0,
      lastError: normalized.lastError || '',
      servedModel: normalized.servedModel || modelKey,
    });
  }
  healthModels.sort((a, b) => b.score - a.score || b.lastSuccessAt - a.lastSuccessAt);
  let state = 'healthy';
  if (account.status === 'disabled') state = 'disabled';
  else if (account.status === 'banned') state = 'banned';
  else if (account.status && account.status !== 'active') state = 'error';
  else if (global) state = 'global_cd';
  else if (cooldowns.length > 0) state = 'partial_cd';
  const nextAvailableAt = cooldowns.length ? Math.min(...cooldowns.map(cd => cd.until || now)) : 0;
  return {
    state,
    cooldownCount: cooldowns.filter(cd => cd.modelKey !== '*').length,
    trackedModelCount: tracked.size,
    healthyModelCount: healthModels.length,
    globalCooldownUntil: global?.until || 0,
    nextAvailableAt,
    cooldowns,
    healthyModels: healthModels,
  };
}

export function getAccountsAvailabilitySummary(accounts = []) {
  const now = nowMs();
  const out = new Map();
  for (const account of accounts || []) {
    if (account?.id) out.set(account.id, getAccountAvailabilitySummary(account, now));
  }
  return out;
}

function breakerRows(accounts = []) {
  const trackedKeys = new Set(getTrackedAvailabilityModels());
  const keys = new Set([...trackedKeys]);
  for (const modelKey of local.modelBreakers.keys()) if (trackedKeys.has(modelKey)) keys.add(modelKey);
  for (const modelKey of local.modelHealth.keys()) if (trackedKeys.has(modelKey)) keys.add(modelKey);
  for (const modelKey of local.rateLimitEvents.keys()) if (trackedKeys.has(modelKey)) keys.add(modelKey);
  return [...keys].sort().map(modelKey => {
    const breaker = getModelBreaker(modelKey);
    const events = getLocalRateLimitEvents(modelKey);
    const health = getHealthyAccounts(modelKey);
    const hotPool = getHotPoolStats(modelKey, accounts);
    const fallbackTarget = getFallbackForModel(modelKey);
    const tracked = isTrackedAvailabilityModel(modelKey);
    return {
      modelKey,
      publicAliases: aliasForModel(modelKey),
      tracked,
      state: breaker.state || 'closed',
      reason: breaker.reason || '',
      eventCount: events.length,
      healthyAccounts: health.length,
      hotPoolReady: hotPool.ready,
      hotPoolFresh: hotPool.fresh,
      hotPoolTarget: hotPool.target,
      hotPoolDeficit: hotPool.deficit,
      avgLatencyMs: hotPool.avgLatencyMs,
      fallbackTarget,
      retryAfterMs: breaker.until ? Math.max(0, breaker.until - nowMs()) : 0,
      nextProbeAt: breaker.until || 0,
      lastSuccessAt: breaker.lastSuccessAt || health[0]?.lastSuccessAt || 0,
      lastFailureAt: breaker.lastFailureAt || 0,
      updatedAt: breaker.updatedAt || 0,
    };
  }).filter(row => row.tracked);
}

export function getAvailabilitySnapshot(accounts = []) {
  const now = nowMs();
  const accountById = new Map((accounts || []).map(a => [a.id, a]));
  const cooldowns = getLocalAccountCooldowns().filter(cd => {
    const acct = accountById.get(cd.accountId);
    return !!acct && (acct.status || 'active') === 'active';
  }).map(cd => {
    const acct = accountById.get(cd.accountId) || {};
    return {
      ...cd,
      email: cd.email || acct.email || '',
      remainingMs: Math.max(0, cd.until - now),
    };
  });
  const modelBreakers = breakerRows(accounts);
  const trackedModelKeys = getTrackedAvailabilityModels();
  const healthyAccounts = [];
  for (const [modelKey, arr] of local.modelHealth) {
    for (const h of arr) {
      const normalized = normalizeHealthEntry(h, modelKey);
      const account = accountById.get(normalized.accountId) || null;
      if (!account || (account.status || 'active') !== 'active') continue;
      const scored = scoreHealthEntry(normalized, account, now, getAvailabilityConfig());
      healthyAccounts.push({
        ...normalized,
        ...scored,
        email: normalized.email || account?.email || '',
      });
    }
  }
  healthyAccounts.sort((a, b) => b.score - a.score || b.lastSuccessAt - a.lastSuccessAt);
  const hotPools = trackedModelKeys.map(modelKey => {
    const stats = getHotPoolStats(modelKey, accounts);
    return {
      ...stats,
      topAccounts: stats.topAccounts.map(h => ({
        ...h,
        email: h.email || accountById.get(h.accountId)?.email || '',
      })),
    };
  });
  const openOrDegraded = modelBreakers.filter(m => ['open', 'degraded', 'half_open'].includes(m.state));
  const hotPoolTarget = hotPools.reduce((n, p) => n + (p.target || 0), 0);
  const hotPoolFresh = hotPools.reduce((n, p) => n + (p.fresh || 0), 0);
  return {
    ok: true,
    config: getAvailabilityConfig(),
    sharedState: sharedStateStatus(),
    lastSyncAt: local.lastSyncAt,
    summary: {
      modelCount: modelBreakers.length,
      trackedModelCount: trackedModelKeys.length,
      openOrDegradedModels: openOrDegraded.length,
      accountModelCooldowns: cooldowns.length,
      healthyAccounts: healthyAccounts.length,
      hotPoolModelsReady: hotPools.filter(p => !p.deficit).length,
      hotPoolFresh,
      hotPoolTarget,
      hotPoolFillRate: hotPoolTarget > 0 ? Math.min(1, hotPoolFresh / hotPoolTarget) : 1,
    },
    modelBreakers,
    hotPools,
    cooldowns,
    healthyAccounts,
    accountAvailability: [...getAccountsAvailabilitySummary(accounts).entries()].map(([accountId, availability]) => ({ accountId, availability })),
    fallbackRules: trackedModelKeys.map(modelKey => ({
      modelKey,
      fallbackTarget: getFallbackForModel(modelKey),
      provider: MODELS[modelKey]?.provider || '',
    })).filter(x => x.fallbackTarget),
  };
}
