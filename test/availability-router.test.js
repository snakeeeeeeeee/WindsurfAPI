import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testDataDir = mkdtempSync(join(tmpdir(), 'wfapi-av-router-'));
mkdirSync(testDataDir, { recursive: true });
process.env.WINDSURFAPI_SQLITE_PATH = join(testDataDir, 'windsurfapi.sqlite');
process.env.WINDSURFAPI_DB_IMPORT_JSON_ON_EMPTY = '0';

const {
  clearAccountModelCooldown,
  clearModelBreaker,
  getAccountAvailabilitySummary,
  getAvailabilityConfig,
  getAvailabilitySnapshot,
  getHotPoolStats,
  getModelBreaker,
  getPreferredHealthyAccountIds,
  getRouteAdvice,
  isTrackedAvailabilityModel,
  markAccountModelCooldown,
  purgeAccountAvailabilityState,
  recordHealthyAccount,
  recordRateLimitEvent,
  removeHealthyAccount,
  updateAvailabilityConfig,
} = await import('../src/availability-router.js');

const touchedModels = new Set();
const touchedCooldowns = [];
const originalCfg = getAvailabilityConfig();

afterEach(async () => {
  updateAvailabilityConfig(originalCfg);
  for (const m of touchedModels) await clearModelBreaker(m);
  for (const [acct, model] of touchedCooldowns.splice(0)) await clearAccountModelCooldown(acct, model);
  for (const m of touchedModels) await removeHealthyAccount(m, 'acct-test');
  touchedModels.clear();
});

describe('availability-router', () => {
  it('records account/model cooldowns in the dashboard snapshot', async () => {
    await markAccountModelCooldown({
      accountId: 'acct-test',
      email: 'acct@example.com',
      modelKey: 'claude-opus-4-7-high',
      durationMs: 5000,
      source: 'test',
    });
    touchedCooldowns.push(['acct-test', 'claude-opus-4-7-high']);

    const snap = getAvailabilitySnapshot([{ id: 'acct-test', email: 'acct@example.com' }]);
    const row = snap.cooldowns.find(x => x.accountId === 'acct-test');
    assert.ok(row);
    assert.equal(row.modelKey, 'claude-opus-4-7-high');
    assert.ok(row.remainingMs > 0);
  });

  it('opens a model breaker after threshold rate-limit events', async () => {
    const modelKey = 'claude-opus-4-7-high';
    touchedModels.add(modelKey);
    updateAvailabilityConfig({
      mode: 'aggressive',
      modelBreakerThreshold: 2,
      modelBreakerWindowMs: 3000,
      modelBreakerMinMs: 1000,
      autoFallback: 'same_family',
    });

    await recordRateLimitEvent({ modelKey, accountId: 'a1', retryAfterMs: 1000 });
    assert.equal(getModelBreaker(modelKey).state, 'closed');
    await recordRateLimitEvent({ modelKey, accountId: 'a2', retryAfterMs: 1000 });
    assert.equal(getModelBreaker(modelKey).state, 'open');
  });

  it('tracks healthy accounts and exposes same-family fallback rules', async () => {
    const modelKey = 'claude-opus-4-7-high';
    touchedModels.add(modelKey);
    await recordHealthyAccount({ modelKey, accountId: 'acct-test', email: 'acct@example.com', servedModel: modelKey });

    const snap = getAvailabilitySnapshot([{ id: 'acct-test', email: 'acct@example.com' }]);
    assert.ok(snap.healthyAccounts.some(x => x.accountId === 'acct-test' && x.modelKey === modelKey));
    assert.ok(snap.fallbackRules.some(x => x.modelKey === modelKey && x.fallbackTarget === 'claude-opus-4-7-medium'));
  });

  it('scores hot pool accounts and prioritizes fresh high-score entries', async () => {
    const modelKey = 'claude-opus-4-7-high';
    touchedModels.add(modelKey);
    updateAvailabilityConfig({
      hotPoolMinPerModel: 2,
      hotPoolMaxPerModel: 5,
      hotPoolFreshMs: 600000,
      accountScoreFailurePenaltyMs: 300000,
    });
    await recordHealthyAccount({ modelKey, accountId: 'acct-test', email: 'acct@example.com', latencyMs: 800 });
    await recordHealthyAccount({ modelKey, accountId: 'acct-other', email: 'other@example.com', latencyMs: 2500 });
    await recordHealthyAccount({ modelKey, accountId: 'acct-test', email: 'acct@example.com', latencyMs: 700 });

    const accounts = [
      { id: 'acct-test', email: 'acct@example.com', status: 'active', credits: { dailyPercent: 90, weeklyPercent: 90 }, _inflight: 0 },
      { id: 'acct-other', email: 'other@example.com', status: 'active', credits: { dailyPercent: 50, weeklyPercent: 50 }, _inflight: 3 },
    ];
    const ids = getPreferredHealthyAccountIds(modelKey, accounts);
    assert.equal(ids[0], 'acct-test');
    const stats = getHotPoolStats(modelKey, accounts);
    assert.equal(stats.target, 2);
    assert.equal(stats.fresh, 2);
    assert.equal(stats.deficit, 0);
    assert.ok(stats.topAccounts[0].score > stats.topAccounts[1].score);

    await removeHealthyAccount(modelKey, 'acct-other');
  });

  it('routes an open breaker to same-family fallback without probing accounts', async () => {
    const modelKey = 'claude-opus-4-7-high';
    touchedModels.add(modelKey);
    updateAvailabilityConfig({ mode: 'aggressive', autoFallback: 'same_family' });
    await recordRateLimitEvent({ modelKey, accountId: 'a1', retryAfterMs: 1000 });
    await recordRateLimitEvent({ modelKey, accountId: 'a2', retryAfterMs: 1000 });
    await recordRateLimitEvent({ modelKey, accountId: 'a3', retryAfterMs: 1000 });

    const advice = getRouteAdvice(modelKey);
    assert.equal(advice.breaker.state, 'open');
    assert.equal(advice.shouldFallback, true);
    assert.equal(advice.shouldShortCircuit, true);
    assert.equal(advice.fallbackModel, 'claude-opus-4-7-medium');
  });

  it('does not short-circuit an open breaker when a healthy account exists', async () => {
    const modelKey = 'claude-opus-4-7-high';
    touchedModels.add(modelKey);
    updateAvailabilityConfig({ mode: 'aggressive', autoFallback: 'same_family' });
    await recordHealthyAccount({ modelKey, accountId: 'acct-test', email: 'acct@example.com' });
    await recordRateLimitEvent({ modelKey, accountId: 'a1', retryAfterMs: 1000 });
    await recordRateLimitEvent({ modelKey, accountId: 'a2', retryAfterMs: 1000 });
    await recordRateLimitEvent({ modelKey, accountId: 'a3', retryAfterMs: 1000 });

    const advice = getRouteAdvice(modelKey, {
      accounts: [{ id: 'acct-test', email: 'acct@example.com', status: 'active' }],
    });
    assert.equal(advice.breaker.state, 'open');
    assert.equal(advice.hasHealthyAccounts, true);
    assert.equal(advice.shouldFallback, false);
    assert.equal(advice.shouldShortCircuit, false);
    assert.equal(advice.fallbackModel, 'claude-opus-4-7-medium');
  });

  it('does not downgrade 1m requests to a non-1m fallback target', async () => {
    const modelKey = 'claude-sonnet-4.6-1m';
    touchedModels.add(modelKey);
    updateAvailabilityConfig({ mode: 'aggressive', autoFallback: 'same_family' });
    await recordRateLimitEvent({ modelKey, accountId: 'a1', retryAfterMs: 1000 });
    await recordRateLimitEvent({ modelKey, accountId: 'a2', retryAfterMs: 1000 });
    await recordRateLimitEvent({ modelKey, accountId: 'a3', retryAfterMs: 1000 });

    const advice = getRouteAdvice(modelKey, { requires1m: true });
    assert.equal(advice.breaker.state, 'open');
    assert.equal(advice.shouldFallback, false);
    assert.equal(advice.shouldShortCircuit, true);
    assert.equal(advice.fallbackModel, null);
  });

  it('limits dashboard tracked models to configured Claude families', () => {
    updateAvailabilityConfig({
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
    });
    const snap = getAvailabilitySnapshot([]);
    assert.ok(snap.modelBreakers.some(x => x.modelKey === 'claude-sonnet-4.6'));
    assert.ok(snap.modelBreakers.some(x => x.modelKey === 'claude-opus-4.6'));
    assert.ok(snap.modelBreakers.some(x => x.modelKey === 'claude-opus-4-7-high'));
    assert.ok(snap.modelBreakers.some(x => x.modelKey === 'claude-opus-4-7-xhigh'));
    assert.ok(snap.modelBreakers.some(x => x.modelKey === 'claude-opus-4-7-max'));
    assert.ok(snap.modelBreakers.some(x => x.modelKey === 'claude-4.5-haiku'));
    assert.ok(!snap.modelBreakers.some(x => x.modelKey === 'gpt-5.5-medium'));
    assert.equal(isTrackedAvailabilityModel('claude-opus-4-7-xhigh'), true);
    assert.equal(isTrackedAvailabilityModel('claude-opus-4-7-max'), true);
    assert.equal(isTrackedAvailabilityModel('claude-opus-4-7-high-thinking'), false);
    assert.equal(isTrackedAvailabilityModel('gpt-5.5-medium'), false);
  });

  it('allows dashboard config to override tracked model patterns', () => {
    updateAvailabilityConfig({ trackedModelPatterns: 'gpt-5.5*' });
    const snap = getAvailabilitySnapshot([]);
    assert.ok(snap.modelBreakers.some(x => x.modelKey === 'gpt-5.5-medium'));
    assert.ok(!snap.modelBreakers.some(x => x.modelKey === 'claude-sonnet-4.6'));
    assert.equal(isTrackedAvailabilityModel('gpt-5.5-xhigh'), true);
    assert.equal(isTrackedAvailabilityModel('claude-opus-4-7-high'), false);
  });

  it('builds compact account availability summaries without scanning full matrices', async () => {
    const modelKey = 'claude-opus-4-7-high';
    touchedModels.add(modelKey);
    await markAccountModelCooldown({
      accountId: 'acct-test',
      email: 'acct@example.com',
      modelKey,
      durationMs: 5000,
      source: 'test',
    });
    touchedCooldowns.push(['acct-test', modelKey]);
    await recordHealthyAccount({ modelKey: 'claude-sonnet-4.6', accountId: 'acct-test', email: 'acct@example.com' });
    touchedModels.add('claude-sonnet-4.6');

    const summary = getAccountAvailabilitySummary({ id: 'acct-test', email: 'acct@example.com', status: 'active' });
    assert.equal(summary.state, 'partial_cd');
    assert.equal(summary.cooldownCount, 1);
    assert.ok(summary.cooldowns.some(cd => cd.modelKey === modelKey && cd.remainingMs > 0));
    assert.ok(summary.healthyModels.some(h => h.modelKey === 'claude-sonnet-4.6'));
  });

  it('purges current cooldown and hot-pool state for removed accounts', async () => {
    const modelKey = 'claude-opus-4-7-high';
    touchedModels.add(modelKey);
    await markAccountModelCooldown({
      accountId: 'acct-test',
      email: 'acct@example.com',
      modelKey,
      durationMs: 5000,
      source: 'test',
    });
    touchedCooldowns.push(['acct-test', modelKey]);
    await recordHealthyAccount({ modelKey, accountId: 'acct-test', email: 'acct@example.com' });

    let snap = getAvailabilitySnapshot([{ id: 'acct-test', email: 'acct@example.com', status: 'active' }]);
    assert.ok(snap.cooldowns.some(cd => cd.accountId === 'acct-test'));
    assert.ok(snap.healthyAccounts.some(h => h.accountId === 'acct-test'));

    const purged = await purgeAccountAvailabilityState('acct-test', { reason: 'test_removed' });
    assert.ok(purged.cooldownsCleared >= 1);
    assert.ok(purged.healthEntriesRemoved >= 1);
    snap = getAvailabilitySnapshot([{ id: 'acct-test', email: 'acct@example.com', status: 'active' }]);
    assert.ok(!snap.cooldowns.some(cd => cd.accountId === 'acct-test'));
    assert.ok(!snap.healthyAccounts.some(h => h.accountId === 'acct-test'));
  });

  it('does not count disabled or deleted accounts as hot-pool ready', async () => {
    const modelKey = 'claude-opus-4-7-high';
    touchedModels.add(modelKey);
    updateAvailabilityConfig({ hotPoolMinPerModel: 1 });
    await recordHealthyAccount({ modelKey, accountId: 'acct-test', email: 'acct@example.com' });

    const disabled = getAvailabilitySnapshot([{ id: 'acct-test', email: 'acct@example.com', status: 'disabled' }]);
    const disabledPool = disabled.hotPools.find(p => p.modelKey === modelKey);
    assert.equal(disabledPool.ready, 0);
    assert.equal(disabledPool.fresh, 0);
    assert.equal(disabledPool.deficit, 1);
    assert.ok(!disabled.healthyAccounts.some(h => h.accountId === 'acct-test'));

    const deleted = getAvailabilitySnapshot([]);
    const deletedPool = deleted.hotPools.find(p => p.modelKey === modelKey);
    assert.equal(deletedPool.ready, 0);
    assert.equal(deletedPool.fresh, 0);
    assert.equal(deletedPool.deficit, 1);
  });
});
