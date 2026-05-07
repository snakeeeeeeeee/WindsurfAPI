import { log } from './config.js';
import {
  recordAvailabilityProbeEvent,
  recordAvailabilityWorkerRun,
} from './db.js';
import { checkMessageRateLimit } from './windsurf-api.js';
import { WindsurfClient } from './client.js';
import { ensureLs, getLsFor } from './langserver.js';
import { getEffectiveProxy } from './dashboard/proxy-config.js';
import {
  getDynamicProxyConfig,
  getDynamicProxySummary,
  getDynamicProxyWorkerPlan,
  rotateAccountDynamicProxy,
  markDynamicProxyFailure,
} from './dynamic-proxy.js';
import { isProxyError } from './proxy-test.js';
import { getModelInfo } from './models.js';
import {
  clearAccountModelCooldown,
  getAccountModelCooldown,
  getAvailabilityConfig,
  getHotPoolStats,
  getPreferredHotAccountIds,
  getLocalAccountCooldowns,
  getModelBreaker,
  getTrackedAvailabilityModels,
  keyWorkerLock,
  markAccountModelCooldown,
  recordHealthyAccount,
  recordRateLimitEvent,
  setModelBreaker,
} from './availability-router.js';
import { stateWithLock } from './shared-state.js';
import {
  clearAccountRateLimit as authClearAccountRateLimit,
  getAccountInternal as authGetAccountInternal,
  getAccountList as authGetAccountList,
  looksLikeBanSignal as authLooksLikeBanSignal,
  markRateLimited as authMarkRateLimited,
  reportBanSignal as authReportBanSignal,
  reportError as authReportError,
  updateCapability as authUpdateCapability,
} from './auth.js';

const DEFAULT_STATUS = {
  running: false,
  enabled: false,
  lastRunAt: 0,
  nextRunAt: 0,
  lastDurationMs: 0,
  lastLockAcquired: false,
  lastReason: '',
  lastError: '',
  counts: {
    accountsChecked: 0,
    modelsChecked: 0,
    success: 0,
    rateLimited: 0,
    failed: 0,
    skipped: 0,
    hotPoolDeficit: 0,
  },
  hotPools: [],
  nextPriorityModels: [],
  dynamicProxy: {
    enabled: false,
    bound: 0,
    expiringSoon: 0,
    failed: 0,
    suspended: 0,
    unbound: 0,
    checked: 0,
    rebound: 0,
    failedCount: 0,
    skipped: 0,
    lastError: '',
  },
};

let status = structuredClone(DEFAULT_STATUS);
let timer = null;
let accountCursor = 0;
let modelCursor = 0;
let runningPromise = null;

function nowMs() {
  return Date.now();
}

function clampInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function freshCounts() {
  return {
    accountsChecked: 0,
    modelsChecked: 0,
    success: 0,
    rateLimited: 0,
    failed: 0,
    skipped: 0,
    hotPoolDeficit: 0,
  };
}

function freshDynamicProxyStatus(accounts = []) {
  const cfg = getDynamicProxyConfig();
  const summary = getDynamicProxySummary(accounts);
  return {
    enabled: !!cfg.enabled,
    ...summary,
    checked: 0,
    rebound: 0,
    failedCount: 0,
    skipped: 0,
    lastError: '',
  };
}

function rotateSlice(items, cursor, size) {
  if (!items.length || size <= 0) return { selected: [], nextCursor: cursor };
  const out = [];
  for (let i = 0; i < Math.min(size, items.length); i++) {
    out.push(items[(cursor + i) % items.length]);
  }
  return { selected: out, nextCursor: (cursor + out.length) % items.length };
}

function isRateLimitError(err) {
  const msg = String(err?.message || err || '');
  return /rate limit|rate_limit|too many requests|quota|capacity|resets?\s+in/i.test(msg);
}

function isAuthError(err) {
  const msg = String(err?.message || err || '');
  return /unauthenticated|invalid api key|invalid_grant|permission_denied.*account|unauthorized/i.test(msg);
}

function rateLimitCooldownMs(message = '') {
  const reset = String(message || '').match(/resets?\s+in\s*:?\s*((?:(?:\d+)\s*[hms]\s*)+)/i);
  if (reset) {
    let total = 0;
    for (const part of reset[1].matchAll(/(\d+)\s*([hms])/gi)) {
      const n = Number(part[1]);
      const unit = part[2].toLowerCase();
      if (unit === 'h') total += n * 60 * 60 * 1000;
      else if (unit === 'm') total += n * 60 * 1000;
      else total += n * 1000;
    }
    if (total > 0) return total;
  }
  const m = String(message || '').match(/(?:retry (?:after|in)|after)\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (unit.startsWith('h')) return n * 60 * 60 * 1000;
    if (unit.startsWith('m')) return n * 60 * 1000;
    return n * 1000;
  }
  if (/about an hour|in an hour|try again in.*hour/i.test(message)) return 60 * 60 * 1000;
  return 60 * 1000;
}

function modelInfoOrThrow(modelKey) {
  const info = getModelInfo(modelKey);
  if (!info) throw new Error(`unknown_model:${modelKey}`);
  if (!info.modelUid && !(info.enumValue && info.enumValue > 0)) throw new Error(`model_not_probeable:${modelKey}`);
  return info;
}

function isKnownUnsupportedProbeModel(modelKey) {
  const key = String(modelKey || '');
  // Chat routing already keeps Opus 4.7 thinking requests on the base UID
  // until upstream LS registers these thinking UIDs. Keep the background
  // probe worker aligned so it does not spam harmless "model not found" logs.
  return /^claude-opus-4-7(?:-|$).*thinking$/i.test(key)
    && process.env.WINDSURFAPI_OPUS47_THINKING_UIDS !== '1';
}

function selectModels(cfg, accounts, now = nowMs()) {
  if (cfg.workerProbeMode === 'cheap_only') return [];
  const tracked = getTrackedAvailabilityModels().filter(modelKey => !isKnownUnsupportedProbeModel(modelKey));
  const limit = clampInt(cfg.workerBatchModels, 4, 0, 100);
  if (!tracked.length || limit <= 0) return [];
  if (cfg.workerProbeMode === 'aggressive_model') {
    const rotated = rotateSlice(tracked, modelCursor, limit);
    modelCursor = rotated.nextCursor;
    return rotated.selected;
  }

  const cooldowns = getLocalAccountCooldowns();
  const priority = [];
  const add = (m) => {
    if (m && tracked.includes(m) && !priority.includes(m)) priority.push(m);
  };

  for (const modelKey of tracked) {
    const b = getModelBreaker(modelKey, now);
    if (['open', 'degraded', 'half_open'].includes(b.state)) add(modelKey);
  }
  for (const modelKey of tracked) {
    if (getHotPoolStats(modelKey, accounts).deficit > 0) add(modelKey);
  }
  const soon = now + Math.max(1000, Math.floor((cfg.workerIntervalMs || 60000) * 2));
  for (const cd of cooldowns) {
    if (cd.modelKey && cd.modelKey !== '*' && cd.until <= soon) add(cd.modelKey);
  }

  const rotated = rotateSlice(tracked, modelCursor, limit);
  modelCursor = rotated.nextCursor;
  for (const modelKey of rotated.selected) add(modelKey);
  return priority.slice(0, limit);
}

function selectAccounts(cfg, accounts) {
  const active = (accounts || []).filter(a => a.status === 'active');
  const limit = clampInt(cfg.workerBatchAccounts, 20, 0, 1000);
  const rotated = rotateSlice(active, accountCursor, limit);
  accountCursor = rotated.nextCursor;
  return rotated.selected;
}

function accountCanProbeModel(account, modelKey, now = nowMs()) {
  if (!account || account.status !== 'active') return false;
  if (getAccountModelCooldown(account.id, '*', now)) return false;
  if (getAccountModelCooldown(account.id, modelKey, now)) return false;
  if (account.availabilityCooldowns?.['*'] && account.availabilityCooldowns['*'] > now) return false;
  if (account.availabilityCooldowns?.[modelKey] && account.availabilityCooldowns[modelKey] > now) return false;
  if (account.rateLimitedUntil && account.rateLimitedUntil > now) return false;
  if (account.modelRateLimits?.[modelKey] && account.modelRateLimits[modelKey] > now) return false;
  if (account.availableModels?.length && !account.availableModels.includes(modelKey)) return false;
  if ((account.blockedModels || []).includes(modelKey)) return false;
  return true;
}

function accountCanManualProbeModel(account, modelKey) {
  if (!account || account.status !== 'active') return false;
  if (account.availableModels?.length && !account.availableModels.includes(modelKey)) return false;
  if ((account.blockedModels || []).includes(modelKey)) return false;
  return true;
}

function pickModelProbeCandidates(accounts, modelKey, perModelLimit) {
  const hotIds = new Set(getPreferredHotAccountIds(modelKey, accounts));
  const candidates = (accounts || []).filter(a => accountCanProbeModel(a, modelKey));
  candidates.sort((a, b) => {
    const ah = hotIds.has(a.id) ? 1 : 0;
    const bh = hotIds.has(b.id) ? 1 : 0;
    if (ah !== bh) return ah - bh;
    return (a.lastUsed || 0) - (b.lastUsed || 0);
  });
  return candidates.slice(0, Math.max(0, perModelLimit));
}

async function probeModelCandidatesConcurrent({ candidates, modelKey, cfg, counts, deps, remainingRef, expired }) {
  const limit = Math.max(0, Math.min(candidates.length, Number(remainingRef.value) || 0));
  const batch = candidates.slice(0, limit);
  if (!batch.length) return { succeeded: 0, results: [] };
  remainingRef.value -= batch.length;
  const results = await Promise.all(batch.map(async account => {
    if (expired()) {
      counts.skipped++;
      return { account, ok: false, skipped: true };
    }
    const secret = deps.getAccountInternal ? deps.getAccountInternal(account.id) : authGetAccountInternal(account.id);
    if (!secret?.apiKey) {
      counts.skipped++;
      return { account, ok: false, skipped: true, error: 'missing_api_key' };
    }
    return {
      account,
      ...(await handleModelProbe({ account, secret, modelKey, cfg, counts, deps })),
    };
  }));
  return {
    succeeded: results.filter(r => r.ok).length,
    results,
  };
}

async function defaultProbeModel({ account, secret, modelKey, maxRuntimeMs }) {
  const proxy = getEffectiveProxy(account.id) || null;
  const info = modelInfoOrThrow(modelKey);
  await ensureLs(proxy);
  const ls = getLsFor(proxy);
  if (!ls) throw new Error('ls_unavailable');
  const client = new WindsurfClient(secret.apiKey, ls.port, ls.csrfToken);
  const messages = [
    {
      role: 'user',
      content: 'Availability probe. Reply exactly: OK',
    },
  ];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(8000, Math.min(45000, Number(maxRuntimeMs) || 30000)));
  if (info.modelUid) {
    try {
      const chunks = await client.cascadeChat(messages, info.enumValue || 0, info.modelUid, {
        displayModel: modelKey,
        signal: controller.signal,
      });
      const text = chunks.map(c => c.text || '').join('');
      return { ok: true, text: text.slice(0, 120), usage: chunks.usage || null };
    } finally {
      clearTimeout(timeout);
    }
  }
  try {
    const chunks = await client.rawGetChatMessage(messages, info.enumValue || 0, modelKey);
    const text = chunks.map(c => c.text || '').join('');
    return { ok: true, text: text.slice(0, 120) };
  } finally {
    clearTimeout(timeout);
  }
}

async function handleAccountCapacity({ account, secret, cfg, counts, deps }) {
  counts.accountsChecked++;
  const checkFn = deps.checkRateLimit || checkMessageRateLimit;
  const proxy = getEffectiveProxy(account.id) || null;
  const rl = await checkFn(secret.apiKey, proxy, account);
  if (rl?.hasCapacity === false) {
    counts.rateLimited++;
    const retryAfterMs = Math.max(1000, Number(rl.retryAfterMs || cfg.modelBreakerMinMs || 60000));
    const markRateLimitedFn = deps.markRateLimited || authMarkRateLimited;
    markRateLimitedFn(secret.apiKey, retryAfterMs);
    await markAccountModelCooldown({
      accountId: account.id,
      email: account.email,
      modelKey: '*',
      durationMs: retryAfterMs,
      source: 'worker_capacity_rate_limit',
      reason: 'checkMessageRateLimit:no_capacity',
    });
    recordProbeHistory({
      account,
      probeType: 'capacity',
      ok: false,
      rateLimited: true,
      retryAfterMs,
      error: 'checkMessageRateLimit:no_capacity',
      details: rl,
    });
    return { ok: false, rateLimited: true, retryAfterMs };
  }
  counts.success++;
  const clearAccountRateLimitFn = deps.clearAccountRateLimit || authClearAccountRateLimit;
  clearAccountRateLimitFn(account.id, '__global__');
  await clearAccountModelCooldown(account.id, '*');
  recordProbeHistory({
    account,
    probeType: 'capacity',
    ok: true,
    details: { remaining: rl?.messagesRemaining ?? null },
  });
  return { ok: true, remaining: rl?.messagesRemaining ?? null };
}

function recordProbeHistory(event) {
  try {
    recordAvailabilityProbeEvent({
      accountId: event.account?.id || event.accountId || '',
      email: event.account?.email || event.email || '',
      modelKey: event.modelKey || '',
      probeType: event.probeType || '',
      ok: !!event.ok,
      rateLimited: !!event.rateLimited,
      retryAfterMs: event.retryAfterMs || 0,
      error: event.error || '',
      details: event.details || {},
    });
  } catch (e) {
    log.debug(`availability-worker: failed to record probe history: ${e.message}`);
  }
}

async function handleModelProbe({ account, secret, modelKey, cfg, counts, deps }) {
  counts.modelsChecked++;
  const probeFn = deps.probeModel || defaultProbeModel;
  const updateCapabilityFn = deps.updateCapability || authUpdateCapability;
  const markRateLimitedFn = deps.markRateLimited || authMarkRateLimited;
  const clearAccountRateLimitFn = deps.clearAccountRateLimit || authClearAccountRateLimit;
  const reportErrorFn = deps.reportError || authReportError;
  const reportBanSignalFn = deps.reportBanSignal || authReportBanSignal;
  const looksLikeBanSignalFn = deps.looksLikeBanSignal || authLooksLikeBanSignal;
  try {
    const result = await probeFn({ account, secret, modelKey, maxRuntimeMs: cfg.workerMaxRuntimeMs });
    counts.success++;
    await clearAccountModelCooldown(account.id, modelKey);
    clearAccountRateLimitFn(account.id, modelKey);
    await recordHealthyAccount({ modelKey, accountId: account.id, email: account.email, servedModel: modelKey });
    await setModelBreaker(modelKey, {
      state: 'closed',
      reason: 'worker_probe_success',
      lastSuccessAt: nowMs(),
    });
    updateCapabilityFn(secret.apiKey, modelKey, true, 'availability_worker');
    recordProbeHistory({
      account,
      modelKey,
      probeType: 'model',
      ok: true,
      details: { text: result?.text || '', usage: result?.usage || null },
    });
    return { ok: true, result };
  } catch (err) {
    const msg = err?.message || String(err);
    if (account?.id && isProxyError(err)) {
      counts.failed++;
      await markDynamicProxyFailure(account.id, err, { autoRebind: true });
      updateCapabilityFn(secret.apiKey, modelKey, false, 'proxy_error');
      recordProbeHistory({
        account,
        modelKey,
        probeType: 'model',
        ok: false,
        error: msg,
        details: { proxyError: true },
      });
      return { ok: false, error: msg, proxyError: true };
    }
    if (isRateLimitError(err)) {
      counts.rateLimited++;
      const retryAfterMs = Math.max(1000, rateLimitCooldownMs(msg) || cfg.modelBreakerMinMs || 60000);
      markRateLimitedFn(secret.apiKey, retryAfterMs, modelKey);
      await markAccountModelCooldown({
        accountId: account.id,
        email: account.email,
        modelKey,
        durationMs: retryAfterMs,
        source: 'worker_model_rate_limit',
        reason: msg.slice(0, 240),
      });
      await recordRateLimitEvent({
        modelKey,
        accountId: account.id,
        email: account.email,
        retryAfterMs,
        reason: `worker_probe:${msg}`,
      });
      updateCapabilityFn(secret.apiKey, modelKey, false, 'rate_limit');
      recordProbeHistory({
        account,
        modelKey,
        probeType: 'model',
        ok: false,
        rateLimited: true,
        retryAfterMs,
        error: msg,
      });
      return { ok: false, rateLimited: true, retryAfterMs, error: msg };
    }
    counts.failed++;
    if (isAuthError(err)) reportErrorFn(secret.apiKey);
    if (looksLikeBanSignalFn(msg)) reportBanSignalFn(secret.apiKey, msg);
    else updateCapabilityFn(secret.apiKey, modelKey, false, 'transport_error');
    recordProbeHistory({
      account,
      modelKey,
      probeType: 'model',
      ok: false,
      error: msg,
    });
    return { ok: false, error: msg };
  }
}

async function runDynamicProxyMaintenance(accounts = [], deps = {}) {
  const cfg = getDynamicProxyConfig();
  const out = freshDynamicProxyStatus(accounts);
  if (!cfg.enabled) return out;
  const plan = getDynamicProxyWorkerPlan(accounts);
  const batch = plan.slice(0, Math.max(0, Number(cfg.workerBatchSize) || 0));
  const concurrency = Math.max(1, Math.round(Number(cfg.workerConcurrency) || 1));
  let idx = 0;
  async function worker() {
    while (idx < batch.length) {
      const item = batch[idx++];
      if (!item?.accountId) {
        out.skipped++;
        continue;
      }
      out.checked++;
      try {
        const rotateFn = deps.rotateDynamicProxy || rotateAccountDynamicProxy;
        await rotateFn(item.accountId, { force: true });
        out.rebound++;
      } catch (e) {
        out.failedCount++;
        out.lastError = e.message || String(e);
        log.warn(`dynamic-proxy-worker: ${item.accountId} ${item.reason || ''} failed: ${out.lastError}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, batch.length || 1) }, () => worker()));
  const summary = getDynamicProxySummary(accounts);
  return { ...out, ...summary };
}

export async function runAvailabilityWorkerCycleForTest({ accounts = [], cfg = {}, deps = {} } = {}) {
  const effectiveCfg = { ...getAvailabilityConfig(), ...cfg };
  const counts = freshCounts();
  const dynamicProxy = await runDynamicProxyMaintenance(accounts, deps);
  if (!effectiveCfg.workerEnabled || effectiveCfg.mode === 'off') {
    counts.skipped++;
    return { skipped: true, reason: 'disabled', counts, dynamicProxy };
  }
  const deadline = nowMs() + Math.max(1000, Number(effectiveCfg.workerMaxRuntimeMs) || 30000);
  const expired = () => nowMs() >= deadline;
  const selectedAccounts = selectAccounts(effectiveCfg, accounts);
  const models = selectModels(effectiveCfg, accounts);
  const hotPoolsBefore = models.map(modelKey => getHotPoolStats(modelKey, accounts));
  counts.hotPoolDeficit = hotPoolsBefore.reduce((n, p) => n + (p.deficit || 0), 0);
  for (const account of selectedAccounts) {
    if (expired()) {
      counts.skipped++;
      break;
    }
    const secret = deps.getAccountInternal ? deps.getAccountInternal(account.id) : authGetAccountInternal(account.id);
    if (!secret?.apiKey) {
      counts.skipped++;
      continue;
    }
    try {
      await handleAccountCapacity({ account, secret, cfg: effectiveCfg, counts, deps });
    } catch (err) {
      counts.failed++;
      log.warn(`availability-worker: account probe failed for ${account.email || account.id}: ${err.message}`);
    }
  }

  if (models.length) {
    const active = selectedAccounts.filter(a => a.status === 'active');
    const globalLimit = Number.isFinite(Number(effectiveCfg.backgroundProbeGlobal))
      ? Number(effectiveCfg.backgroundProbeGlobal)
      : active.length * models.length;
    const perModelLimit = Math.max(0, Math.round(Number(effectiveCfg.backgroundProbePerModel) || 0));
    const remainingModelProbes = { value: Math.max(0, Math.round(globalLimit)) };
    for (const modelKey of models) {
      if (expired()) {
        counts.skipped++;
        break;
      }
      if (remainingModelProbes.value <= 0 || perModelLimit <= 0) {
        counts.skipped++;
        continue;
      }
      const hotStats = getHotPoolStats(modelKey, accounts);
      const targetAttempts = Math.max(1, Math.min(perModelLimit, hotStats.deficit || perModelLimit));
      const candidates = pickModelProbeCandidates(active, modelKey, targetAttempts);
      if (!candidates.length) {
        counts.skipped++;
        continue;
      }
      const probeResult = await probeModelCandidatesConcurrent({
        candidates,
        modelKey,
        cfg: effectiveCfg,
        counts,
        deps,
        remainingRef: remainingModelProbes,
        expired,
      });
      const modelSucceeded = probeResult.succeeded > 0;
      if (!modelSucceeded) {
        const b = getModelBreaker(modelKey);
        if (b.state === 'closed') {
          await setModelBreaker(modelKey, {
            state: 'degraded',
            reason: 'worker_probe_no_success',
            retryAfterMs: effectiveCfg.modelBreakerMinMs,
            until: nowMs() + Math.max(1000, effectiveCfg.modelBreakerMinMs || 60000),
            lastFailureAt: nowMs(),
          });
        }
      }
    }
  }
  const hotPoolsAfter = models.map(modelKey => getHotPoolStats(modelKey, accounts));
  return {
    skipped: false,
    counts,
    dynamicProxy,
    models,
    accounts: selectedAccounts.map(a => a.id),
    hotPools: hotPoolsAfter,
    nextPriorityModels: hotPoolsAfter.filter(p => p.deficit > 0).map(p => p.modelKey),
  };
}

export async function probeAvailabilityModelOnce(modelKey, { accountId = '', maxRuntimeMs = 0, limit = 0, deps = {} } = {}) {
  const cfg = { ...getAvailabilityConfig() };
  if (Number(maxRuntimeMs) > 0) cfg.workerMaxRuntimeMs = Math.max(500, Number(maxRuntimeMs));
  const counts = freshCounts();
  const accounts = (deps.accounts || authGetAccountList())
    .filter(a => a.status === 'active')
    .filter(a => !accountId || a.id === accountId)
    .filter(a => accountCanManualProbeModel(a, modelKey));
  const probeLimit = accountId ? 1 : Math.max(1, Math.round(Number(limit || cfg.probeConcurrencyPerModel) || 1));
  const selected = pickModelProbeCandidates(accounts, modelKey, probeLimit);
  const results = [];
  await Promise.all(selected.map(async account => {
    const secret = deps.getAccountInternal ? deps.getAccountInternal(account.id) : authGetAccountInternal(account.id);
    if (!secret?.apiKey) {
      counts.skipped++;
      results.push({ id: account.id, email: account.email, ok: false, error: 'missing_api_key' });
      return;
    }
    const r = await handleModelProbe({ account, secret, modelKey, cfg, counts, deps });
    results.push({
      id: account.id,
      email: account.email,
      ok: !!r.ok,
      rateLimited: !!r.rateLimited,
      retryAfterMs: r.retryAfterMs || 0,
      error: r.error || '',
    });
  }));
  if (!results.length) return { success: false, error: 'no_probe_candidate', counts, results };
  const success = results.some(r => r.ok);
  return { success, counts, results, error: success ? '' : 'no_account_passed_model_probe' };
}

function scheduleNext() {
  if (timer) clearTimeout(timer);
  const cfg = getAvailabilityConfig();
  const dpCfg = getDynamicProxyConfig();
  const availabilityBase = cfg.workerEnabled && cfg.mode !== 'off' ? Math.max(1000, cfg.workerIntervalMs || 60000) : Infinity;
  const dynamicBase = dpCfg.enabled ? Math.max(1000, dpCfg.workerIntervalMs || 60000) : Infinity;
  const base = Math.min(availabilityBase, dynamicBase, 60000);
  const jitter = Math.max(0, cfg.workerJitterMs || 0);
  const delay = base + (jitter ? Math.floor(Math.random() * jitter) : 0);
  status.nextRunAt = Date.now() + delay;
  timer = setTimeout(() => {
    runAvailabilityWorkerOnce('timer').catch(e => log.warn(`availability-worker: timer run failed: ${e.message}`));
  }, delay);
  timer.unref?.();
}

export async function runAvailabilityWorkerOnce(reason = 'manual', deps = {}) {
  if (runningPromise) return runningPromise;
  runningPromise = (async () => {
    const cfg = getAvailabilityConfig();
    const start = Date.now();
    let finalResult = null;
    status.enabled = !!cfg.workerEnabled && cfg.mode !== 'off';
      if (!status.enabled) {
      status.lastReason = reason;
      status.lastError = '';
      status.counts = { ...freshCounts(), skipped: 1 };
      status.hotPools = [];
      status.nextPriorityModels = [];
      status.dynamicProxy = await runDynamicProxyMaintenance(deps.accounts || authGetAccountList(), deps);
      scheduleNext();
      finalResult = { success: true, skipped: true, status: getAvailabilityWorkerStatus() };
      recordWorkerRunHistory({ start, reason, result: finalResult, lockAcquired: false });
      return finalResult;
    }
    status.running = true;
    status.lastRunAt = start;
    status.lastReason = reason;
    status.lastError = '';
    status.counts = freshCounts();
    const lockTtl = Math.max(5000, Number(cfg.workerMaxRuntimeMs || 30000) + 5000);
    try {
      const lock = await stateWithLock(keyWorkerLock(), lockTtl, async () => {
        const accounts = deps.accounts || authGetAccountList();
        return runAvailabilityWorkerCycleForTest({ accounts, cfg, deps });
      });
      status.lastLockAcquired = !!lock.acquired;
      if (!lock.acquired) {
        status.counts = { ...freshCounts(), skipped: 1 };
        status.hotPools = [];
        status.nextPriorityModels = [];
        status.dynamicProxy = lock.result?.dynamicProxy || freshDynamicProxyStatus(deps.accounts || authGetAccountList());
        status.lastError = 'worker_lock_busy';
        finalResult = { success: true, skipped: true, reason: 'lock_busy', status: getAvailabilityWorkerStatus() };
        recordWorkerRunHistory({ start, reason, result: finalResult, lockAcquired: false });
        return finalResult;
      }
      status.counts = lock.result?.counts || freshCounts();
      status.hotPools = lock.result?.hotPools || [];
      status.nextPriorityModels = lock.result?.nextPriorityModels || [];
      status.dynamicProxy = lock.result?.dynamicProxy || freshDynamicProxyStatus(deps.accounts || authGetAccountList());
      finalResult = { success: true, ...(lock.result || {}), status: getAvailabilityWorkerStatus() };
      recordWorkerRunHistory({ start, reason, result: finalResult, lockAcquired: true });
      return finalResult;
    } catch (err) {
      status.lastError = err.message || String(err);
      log.warn(`availability-worker: run failed: ${status.lastError}`);
      finalResult = { success: false, error: status.lastError, status: getAvailabilityWorkerStatus() };
      recordWorkerRunHistory({ start, reason, result: finalResult, lockAcquired: status.lastLockAcquired });
      return finalResult;
    } finally {
      status.running = false;
      status.lastDurationMs = Date.now() - start;
      scheduleNext();
      runningPromise = null;
    }
  })();
  return runningPromise;
}

function recordWorkerRunHistory({ start, reason, result, lockAcquired }) {
  try {
    recordAvailabilityWorkerRun({
      startedAt: start,
      finishedAt: Date.now(),
      reason,
      lockAcquired,
      skipped: !!result?.skipped,
      success: result?.success !== false,
      error: result?.error || '',
      counts: result?.counts || result?.status?.counts || {},
      models: result?.models || [],
      accounts: result?.accounts || [],
    });
  } catch (e) {
    log.debug(`availability-worker: failed to record run history: ${e.message}`);
  }
}

export function startAvailabilityWorker() {
  if (timer) return;
  const cfg = getAvailabilityConfig();
  status.enabled = !!cfg.workerEnabled && cfg.mode !== 'off';
  scheduleNext();
  if (status.enabled) {
    setTimeout(() => {
      runAvailabilityWorkerOnce('startup').catch(e => log.warn(`availability-worker: startup run failed: ${e.message}`));
    }, 1500).unref?.();
  }
  log.info(`availability-worker: started (enabled=${status.enabled}, mode=${cfg.workerProbeMode})`);
}

export function stopAvailabilityWorker() {
  if (timer) clearTimeout(timer);
  timer = null;
  status.nextRunAt = 0;
}

export function getAvailabilityWorkerStatus() {
  return structuredClone(status);
}
