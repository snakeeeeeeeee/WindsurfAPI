import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testDataDir = mkdtempSync(join(tmpdir(), 'wfapi-av-worker-'));
mkdirSync(testDataDir, { recursive: true });
process.env.WINDSURFAPI_SQLITE_PATH = join(testDataDir, 'windsurfapi.sqlite');
process.env.WINDSURFAPI_DB_IMPORT_JSON_ON_EMPTY = '0';

const {
  clearAccountModelCooldown,
  clearModelBreaker,
  getHotPoolStats,
  getModelBreaker,
  removeHealthyAccount,
  recordHealthyAccount,
  updateAvailabilityConfig,
} = await import('../src/availability-router.js');
const { setDynamicProxyConfig } = await import('../src/dynamic-proxy.js');
const { runAvailabilityWorkerCycleForTest, runAvailabilityWorkerOnce, stopAvailabilityWorker } = await import('../src/availability-worker.js');

const originalCfg = {
  mode: 'aggressive',
  workerEnabled: true,
  workerBatchAccounts: 20,
  workerBatchModels: 4,
  workerProbeMode: 'selective_model',
  workerIntervalMs: 60000,
  backgroundProbePerModel: 2,
  backgroundProbeGlobal: 5,
  modelBreakerThreshold: 3,
  modelBreakerWindowMs: 3000,
  modelBreakerMinMs: 60000,
    autoFallback: 'same_family',
    hotPoolMinPerModel: 2,
    hotPoolMaxPerModel: 10,
    hotPoolFreshMs: 600000,
    requestProbeEnabled: true,
    requestProbeConcurrency: 3,
    requestProbeBudgetMs: 2000,
    fastSwitchMaxAttempts: 2,
    fastSwitchBudgetMs: 3000,
    accountScoreFailurePenaltyMs: 300000,
    trackedModelPatterns: 'claude-sonnet-4.6*,claude-opus-4-7*',
};

const accounts = [
  {
    id: 'acct-worker-1',
    email: 'worker1@example.com',
    status: 'active',
    availableModels: ['claude-sonnet-4.6', 'claude-opus-4-7-high'],
    blockedModels: [],
  },
  {
    id: 'acct-worker-2',
    email: 'worker2@example.com',
    status: 'active',
    availableModels: ['claude-sonnet-4.6', 'claude-opus-4-7-high'],
    blockedModels: [],
  },
];

const secrets = new Map(accounts.map(a => [a.id, { ...a, apiKey: `key-${a.id}` }]));

function deps(overrides = {}) {
  return {
    getAccountInternal: id => secrets.get(id),
    markRateLimited: () => {},
    clearAccountRateLimit: () => {},
    updateCapability: () => {},
    reportError: () => {},
    reportBanSignal: () => {},
    looksLikeBanSignal: () => false,
    ...overrides,
  };
}

afterEach(async () => {
  updateAvailabilityConfig(originalCfg);
  setDynamicProxyConfig({ enabled: false, password: '' });
  stopAvailabilityWorker();
  for (const a of accounts) {
    await clearAccountModelCooldown(a.id, '*');
    await clearAccountModelCooldown(a.id, 'claude-sonnet-4.6');
    await clearAccountModelCooldown(a.id, 'claude-opus-4-7-high');
    await removeHealthyAccount('claude-sonnet-4.6', a.id);
    await removeHealthyAccount('claude-opus-4-7-high', a.id);
  }
  await clearModelBreaker('claude-sonnet-4.6');
  await clearModelBreaker('claude-opus-4-7-high');
});

describe('availability-worker', () => {
  it('does not run probes when disabled', async () => {
    let checks = 0;
    const result = await runAvailabilityWorkerCycleForTest({
      accounts,
      cfg: { ...originalCfg, workerEnabled: false },
      deps: deps({ checkRateLimit: async () => { checks++; return { hasCapacity: true }; } }),
    });
    assert.equal(result.skipped, true);
    assert.equal(checks, 0);
    assert.equal(result.counts.skipped, 1);
  });

  it('cheap_only checks account capacity without model probes', async () => {
    let modelProbes = 0;
    const result = await runAvailabilityWorkerCycleForTest({
      accounts,
      cfg: { ...originalCfg, workerProbeMode: 'cheap_only', workerBatchAccounts: 2 },
      deps: deps({
        checkRateLimit: async () => ({ hasCapacity: true, messagesRemaining: 10 }),
        probeModel: async () => { modelProbes++; return { ok: true }; },
      }),
    });
    assert.equal(result.counts.accountsChecked, 2);
    assert.equal(result.counts.modelsChecked, 0);
    assert.equal(modelProbes, 0);
  });

  it('selective_model probes only tracked configured Claude families', async () => {
    updateAvailabilityConfig({
      ...originalCfg,
      trackedModelPatterns: 'claude-sonnet-4.6*,claude-opus-4-7-high',
    });
    const seen = [];
    const result = await runAvailabilityWorkerCycleForTest({
      accounts,
      cfg: {
        ...originalCfg,
        workerProbeMode: 'selective_model',
        workerBatchAccounts: 2,
        workerBatchModels: 3,
        backgroundProbePerModel: 1,
        backgroundProbeGlobal: 3,
        trackedModelPatterns: 'claude-sonnet-4.6*,claude-opus-4-7-high',
      },
      deps: deps({
        checkRateLimit: async () => ({ hasCapacity: true }),
        probeModel: async ({ modelKey }) => { seen.push(modelKey); return { ok: true }; },
      }),
    });
    assert.ok(result.counts.modelsChecked > 0);
    assert.ok(seen.length > 0);
    assert.ok(seen.every(m => m === 'claude-sonnet-4.6' || m === 'claude-opus-4-7-high'));
  });

  it('skips Opus 4.7 thinking UIDs while upstream LS does not register them', async () => {
    updateAvailabilityConfig({
      ...originalCfg,
      trackedModelPatterns: 'claude-opus-4-7*',
    });
    const probeAccounts = [{
      ...accounts[0],
      availableModels: ['claude-opus-4-7-high', 'claude-opus-4-7-high-thinking'],
    }];
    const seen = [];
    const result = await runAvailabilityWorkerCycleForTest({
      accounts: probeAccounts,
      cfg: {
        ...originalCfg,
        workerProbeMode: 'aggressive_model',
        workerBatchAccounts: 1,
        workerBatchModels: 20,
        backgroundProbePerModel: 1,
        backgroundProbeGlobal: 20,
        trackedModelPatterns: 'claude-opus-4-7*',
      },
      deps: deps({
        checkRateLimit: async () => ({ hasCapacity: true }),
        probeModel: async ({ modelKey }) => { seen.push(modelKey); return { ok: true }; },
      }),
    });
    assert.ok(result.counts.modelsChecked > 0);
    assert.ok(seen.some(m => m === 'claude-opus-4-7-high'));
    assert.ok(!seen.some(m => m.includes('thinking')));
  });

  it('records rate limits and opens breaker after worker model probe failures', async () => {
    updateAvailabilityConfig({
      ...originalCfg,
      modelBreakerThreshold: 1,
      modelBreakerWindowMs: 3000,
      modelBreakerMinMs: 1000,
      trackedModelPatterns: 'claude-opus-4-7-high',
    });
    const result = await runAvailabilityWorkerCycleForTest({
      accounts: [accounts[0]],
      cfg: {
        ...originalCfg,
        modelBreakerThreshold: 1,
        modelBreakerWindowMs: 3000,
        modelBreakerMinMs: 1000,
        workerBatchAccounts: 1,
        workerBatchModels: 1,
        backgroundProbePerModel: 1,
        backgroundProbeGlobal: 1,
        trackedModelPatterns: 'claude-opus-4-7-high',
      },
      deps: deps({
        checkRateLimit: async () => ({ hasCapacity: true }),
        probeModel: async () => { throw new Error('rate limit resets in 1m'); },
      }),
    });
    assert.equal(result.counts.rateLimited, 1);
    assert.equal(getModelBreaker('claude-opus-4-7-high').state, 'open');
  });

  it('fills hot-pool deficits with concurrent model probes', async () => {
    updateAvailabilityConfig({
      ...originalCfg,
      hotPoolMinPerModel: 2,
      trackedModelPatterns: 'claude-opus-4-7-high',
    });
    const seen = [];
    const result = await runAvailabilityWorkerCycleForTest({
      accounts,
      cfg: {
        ...originalCfg,
        hotPoolMinPerModel: 2,
        workerBatchAccounts: 2,
        workerBatchModels: 1,
        backgroundProbePerModel: 2,
        backgroundProbeGlobal: 2,
        trackedModelPatterns: 'claude-opus-4-7-high',
      },
      deps: deps({
        checkRateLimit: async () => ({ hasCapacity: true }),
        probeModel: async ({ account, modelKey }) => {
          seen.push(`${account.id}:${modelKey}`);
          await new Promise(resolve => setTimeout(resolve, account.id.endsWith('1') ? 20 : 5));
          return { ok: true };
        },
      }),
    });
    assert.equal(result.counts.modelsChecked, 2);
    assert.equal(seen.length, 2);
    const stats = getHotPoolStats('claude-opus-4-7-high', accounts);
    assert.equal(stats.deficit, 0);
    assert.equal(stats.fresh, 2);
  });

  it('prefers probing non-hot accounts when topping up a model pool', async () => {
    updateAvailabilityConfig({
      ...originalCfg,
      hotPoolMinPerModel: 2,
      trackedModelPatterns: 'claude-opus-4-7-high',
    });
    await recordHealthyAccount({ modelKey: 'claude-opus-4-7-high', accountId: 'acct-worker-1', email: 'worker1@example.com' });
    const seen = [];
    await runAvailabilityWorkerCycleForTest({
      accounts,
      cfg: {
        ...originalCfg,
        hotPoolMinPerModel: 2,
        workerBatchAccounts: 2,
        workerBatchModels: 1,
        backgroundProbePerModel: 1,
        backgroundProbeGlobal: 1,
        trackedModelPatterns: 'claude-opus-4-7-high',
      },
      deps: deps({
        checkRateLimit: async () => ({ hasCapacity: true }),
        probeModel: async ({ account }) => { seen.push(account.id); return { ok: true }; },
      }),
    });
    assert.deepEqual(seen, ['acct-worker-2']);
  });

  it('does not get stuck if dynamic proxy maintenance fails while model probing is disabled', async () => {
    updateAvailabilityConfig({ ...originalCfg, mode: 'passive_strong', workerEnabled: false });
    setDynamicProxyConfig({ enabled: true, workerIntervalMs: 60000, workerBatchSize: 1, password: 'test' });

    const badAccounts = {
      map() {
        throw new Error('bad_accounts');
      },
    };
    const first = await runAvailabilityWorkerOnce('test_bad_accounts', { accounts: badAccounts });
    assert.equal(first.success, false);
    assert.match(first.error, /bad_accounts/);

    const second = await runAvailabilityWorkerOnce('test_recovery', { accounts });
    assert.equal(second.success, true);
    assert.equal(second.skipped, true);
    assert.equal(second.reason, 'availability_disabled_dynamic_proxy_maintained');
  });
});
