import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const BUSINESS_ENV_KEYS = [
  'WINDSURFAPI_PUBLIC_MODEL_ALIASES',
  'WINDSURFAPI_PUBLIC_MODEL_ALIAS_HIDE_TARGETS',
  'WINDSURFAPI_ANTHROPIC_REPORTED_CACHE_BUCKETS',
  'WINDSURFAPI_ANTHROPIC_REPORTED_USAGE_BASIS',
  'WINDSURFAPI_ANTHROPIC_REPORTED_OUTPUT_BASIS',
  'WINDSURFAPI_ANTHROPIC_REPORTED_CACHE_MAX_ENTRIES',
  'WINDSURFAPI_ANTHROPIC_REPORTED_CACHE_CREATION_TAIL_RATIO',
  'WINDSURFAPI_ANTHROPIC_REPORTED_FRESH_INPUT_TOKENS',
  'WINDSURFAPI_ANTHROPIC_REPORTED_CACHE_HIT_RATE',
  'WINDSURFAPI_ANTHROPIC_REPORTED_CACHE_CREATION_RATE',
  'CASCADE_REUSE_HASH_SYSTEM',
  'CASCADE_REUSE_HASH_TOOL_ARGS',
  'CASCADE_REUSE_SINGLE_TOOL_ALIAS',
  'CASCADE_REUSE_ALLOW_SHARED_API_KEY',
  'CASCADE_POLL_INTERVAL_MS',
  'CASCADE_POLL_FAST_MS',
  'CASCADE_POLL_FAST_UNTIL_MS',
  'CASCADE_POLL_MID_MS',
  'CASCADE_POLL_MID_UNTIL_MS',
  'WINDSURFAPI_TRANSIENT_STALL_SWITCH_MAX_ATTEMPTS',
  'CASCADE_DEBUG_DUMP_PROMPT',
];

let tmp;
let savedEnv;

function moduleSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function loadRuntime() {
  return import(`../src/runtime-config.js?case=${moduleSuffix()}`);
}

async function loadDb() {
  return import(`../src/db.js?case=${moduleSuffix()}`);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wfapi-runtime-sqlite-'));
  savedEnv = {};
  for (const key of [
    ...BUSINESS_ENV_KEYS,
    'DATA_DIR',
    'WINDSURFAPI_SQLITE_PATH',
    'WINDSURFAPI_DB_IMPORT_JSON_ON_EMPTY',
    'WINDSURFAPI_AVAILABILITY_MODE',
    'WINDSURFAPI_MODEL_BREAKER_THRESHOLD',
  ]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.DATA_DIR = tmp;
  process.env.WINDSURFAPI_SQLITE_PATH = join(tmp, 'windsurfapi.sqlite');
  process.env.WINDSURFAPI_DB_IMPORT_JSON_ON_EMPTY = '0';
});

afterEach(async () => {
  try {
    const db = await import('../src/db.js');
    db.closeDatabaseForTest();
  } catch {}
  for (const [key, value] of Object.entries(savedEnv || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

describe('runtime-config SQLite defaults', () => {
  it('imports availability and business env defaults into an empty database', async () => {
    process.env.WINDSURFAPI_AVAILABILITY_MODE = 'conservative';
    process.env.WINDSURFAPI_MODEL_BREAKER_THRESHOLD = '7';
    process.env.WINDSURFAPI_PUBLIC_MODEL_ALIASES = 'public-a=internal-a';
    process.env.WINDSURFAPI_ANTHROPIC_REPORTED_USAGE_BASIS = 'hybrid';
    process.env.CASCADE_REUSE_HASH_SYSTEM = '0';
    process.env.CASCADE_REUSE_HASH_TOOL_ARGS = '0';
    process.env.CASCADE_REUSE_SINGLE_TOOL_ALIAS = '1';
    process.env.CASCADE_POLL_FAST_MS = '150';
    process.env.WINDSURFAPI_TRANSIENT_STALL_SWITCH_MAX_ATTEMPTS = '2';
    process.env.CASCADE_DEBUG_DUMP_PROMPT = '1';

    const runtime = await loadRuntime();

    assert.deepEqual(runtime.getAvailabilityRuntimeConfig().mode, 'conservative');
    assert.equal(runtime.getAvailabilityRuntimeConfig().modelBreakerThreshold, 7);
    assert.equal(runtime.getBusinessEnvConfig().WINDSURFAPI_PUBLIC_MODEL_ALIASES, 'public-a=internal-a');
    assert.equal(runtime.getBusinessEnvConfig().WINDSURFAPI_ANTHROPIC_REPORTED_USAGE_BASIS, 'hybrid');
    assert.equal(runtime.getBusinessEnvConfig().CASCADE_REUSE_HASH_SYSTEM, '0');
    assert.equal(runtime.getBusinessEnvConfig().CASCADE_REUSE_HASH_TOOL_ARGS, '0');
    assert.equal(runtime.getBusinessEnvConfig().CASCADE_REUSE_SINGLE_TOOL_ALIAS, '1');
    assert.equal(runtime.getBusinessEnvConfig().CASCADE_POLL_FAST_MS, '150');
    assert.equal(runtime.getBusinessEnvConfig().WINDSURFAPI_TRANSIENT_STALL_SWITCH_MAX_ATTEMPTS, '2');
    assert.equal(runtime.getBusinessEnvConfig().CASCADE_DEBUG_DUMP_PROMPT, '1');
  });

  it('keeps existing SQLite business env authoritative over later env changes', async () => {
    process.env.WINDSURFAPI_PUBLIC_MODEL_ALIASES = 'first=target-a';
    process.env.WINDSURFAPI_ANTHROPIC_REPORTED_USAGE_BASIS = 'official';
    let runtime = await loadRuntime();
    assert.equal(runtime.getBusinessEnvConfig().WINDSURFAPI_PUBLIC_MODEL_ALIASES, 'first=target-a');

    process.env.WINDSURFAPI_PUBLIC_MODEL_ALIASES = 'second=target-b';
    process.env.WINDSURFAPI_ANTHROPIC_REPORTED_USAGE_BASIS = 'client';
    runtime = await loadRuntime();

    assert.equal(runtime.getBusinessEnvConfig().WINDSURFAPI_PUBLIC_MODEL_ALIASES, 'first=target-a');
    assert.equal(runtime.getBusinessEnvConfig().WINDSURFAPI_ANTHROPIC_REPORTED_USAGE_BASIS, 'official');
    assert.equal(process.env.WINDSURFAPI_PUBLIC_MODEL_ALIASES, 'first=target-a');
    assert.equal(process.env.WINDSURFAPI_ANTHROPIC_REPORTED_USAGE_BASIS, 'official');
  });

  it('persists dashboard-style business env updates and clears removed keys from process env', async () => {
    process.env.WINDSURFAPI_PUBLIC_MODEL_ALIASES = 'boot=target';
    let runtime = await loadRuntime();

    runtime.setBusinessEnvConfig({
      WINDSURFAPI_PUBLIC_MODEL_ALIASES: 'runtime=target',
      WINDSURFAPI_ANTHROPIC_REPORTED_USAGE_BASIS: 'hybrid',
      CASCADE_REUSE_HASH_TOOL_ARGS: '0',
      CASCADE_REUSE_SINGLE_TOOL_ALIAS: '1',
      CASCADE_POLL_INTERVAL_MS: '500',
      WINDSURFAPI_TRANSIENT_STALL_SWITCH_MAX_ATTEMPTS: '2',
      CASCADE_DEBUG_DUMP_PROMPT: '1',
    });
    assert.equal(process.env.WINDSURFAPI_PUBLIC_MODEL_ALIASES, 'runtime=target');
    assert.equal(process.env.WINDSURFAPI_ANTHROPIC_REPORTED_USAGE_BASIS, 'hybrid');
    assert.equal(process.env.CASCADE_REUSE_HASH_TOOL_ARGS, '0');
    assert.equal(process.env.CASCADE_REUSE_SINGLE_TOOL_ALIAS, '1');
    assert.equal(process.env.CASCADE_POLL_INTERVAL_MS, '500');
    assert.equal(process.env.WINDSURFAPI_TRANSIENT_STALL_SWITCH_MAX_ATTEMPTS, '2');
    assert.equal(process.env.CASCADE_DEBUG_DUMP_PROMPT, '1');

    runtime.setBusinessEnvConfig({
      WINDSURFAPI_ANTHROPIC_REPORTED_USAGE_BASIS: '',
      CASCADE_REUSE_HASH_TOOL_ARGS: '',
      CASCADE_REUSE_SINGLE_TOOL_ALIAS: '',
      CASCADE_POLL_INTERVAL_MS: '',
      WINDSURFAPI_TRANSIENT_STALL_SWITCH_MAX_ATTEMPTS: '',
      CASCADE_DEBUG_DUMP_PROMPT: '',
    });
    runtime = await loadRuntime();

    assert.equal(runtime.getBusinessEnvConfig().WINDSURFAPI_PUBLIC_MODEL_ALIASES, 'runtime=target');
    assert.equal(runtime.getBusinessEnvConfig().WINDSURFAPI_ANTHROPIC_REPORTED_USAGE_BASIS, undefined);
    assert.equal(runtime.getBusinessEnvConfig().CASCADE_REUSE_HASH_TOOL_ARGS, undefined);
    assert.equal(runtime.getBusinessEnvConfig().CASCADE_REUSE_SINGLE_TOOL_ALIAS, undefined);
    assert.equal(runtime.getBusinessEnvConfig().CASCADE_POLL_INTERVAL_MS, undefined);
    assert.equal(runtime.getBusinessEnvConfig().WINDSURFAPI_TRANSIENT_STALL_SWITCH_MAX_ATTEMPTS, undefined);
    assert.equal(runtime.getBusinessEnvConfig().CASCADE_DEBUG_DUMP_PROMPT, undefined);
    assert.equal(process.env.WINDSURFAPI_PUBLIC_MODEL_ALIASES, 'runtime=target');
    assert.equal(process.env.WINDSURFAPI_ANTHROPIC_REPORTED_USAGE_BASIS, undefined);
    assert.equal(process.env.CASCADE_REUSE_HASH_TOOL_ARGS, undefined);
    assert.equal(process.env.CASCADE_REUSE_SINGLE_TOOL_ALIAS, undefined);
    assert.equal(process.env.CASCADE_POLL_INTERVAL_MS, undefined);
    assert.equal(process.env.WINDSURFAPI_TRANSIENT_STALL_SWITCH_MAX_ATTEMPTS, undefined);
    assert.equal(process.env.CASCADE_DEBUG_DUMP_PROMPT, undefined);
  });

  it('migrates only untouched legacy aggressive availability defaults to passive defaults', async () => {
    const db = await loadDb();
    db.setJson('runtime', 'config', {
      availability: {
        mode: 'aggressive',
        probeConcurrencyPerModel: 3,
        backgroundProbePerModel: 2,
        backgroundProbeGlobal: 5,
        modelBreakerMinMs: 60000,
        modelBreakerThreshold: 3,
        modelBreakerWindowMs: 3000,
        autoFallback: 'same_family',
        workerEnabled: true,
        workerIntervalMs: 60000,
        workerBatchAccounts: 20,
        workerBatchModels: 4,
        workerProbeMode: 'selective_model',
        workerJitterMs: 5000,
        workerMaxRuntimeMs: 30000,
        hotPoolMinPerModel: 5,
        hotPoolMaxPerModel: 30,
        hotPoolFreshMs: 600000,
        requestProbeEnabled: true,
        requestProbeConcurrency: 3,
        requestProbeBudgetMs: 2000,
        fastSwitchMaxAttempts: 2,
        fastSwitchBudgetMs: 3000,
        accountScoreFailurePenaltyMs: 300000,
      },
    });

    const runtime = await loadRuntime();
    const av = runtime.getAvailabilityRuntimeConfig();
    assert.equal(av.mode, 'passive_strong');
    assert.equal(av.workerEnabled, false);
    assert.equal(av.workerProbeMode, 'cheap_only');
    assert.equal(av.requestProbeEnabled, false);
    assert.equal(av.fastSwitchMaxAttempts, 9);
  });

  it('does not migrate intentionally customized aggressive availability config', async () => {
    const db = await loadDb();
    db.setJson('runtime', 'config', {
      availability: {
        mode: 'aggressive',
        backgroundProbePerModel: 2,
        backgroundProbeGlobal: 5,
        workerEnabled: true,
        workerBatchModels: 2,
        workerProbeMode: 'selective_model',
        hotPoolMinPerModel: 5,
        requestProbeEnabled: true,
        fastSwitchMaxAttempts: 4,
        fastSwitchBudgetMs: 3000,
      },
    });

    const runtime = await loadRuntime();
    const av = runtime.getAvailabilityRuntimeConfig();
    assert.equal(av.mode, 'aggressive');
    assert.equal(av.workerEnabled, true);
    assert.equal(av.fastSwitchMaxAttempts, 4);
  });
});
