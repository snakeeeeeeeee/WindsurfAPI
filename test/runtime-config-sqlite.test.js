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
  'CASCADE_REUSE_ALLOW_SHARED_API_KEY',
];

let tmp;
let savedEnv;

function moduleSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function loadRuntime() {
  return import(`../src/runtime-config.js?case=${moduleSuffix()}`);
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

    const runtime = await loadRuntime();

    assert.deepEqual(runtime.getAvailabilityRuntimeConfig().mode, 'conservative');
    assert.equal(runtime.getAvailabilityRuntimeConfig().modelBreakerThreshold, 7);
    assert.equal(runtime.getBusinessEnvConfig().WINDSURFAPI_PUBLIC_MODEL_ALIASES, 'public-a=internal-a');
    assert.equal(runtime.getBusinessEnvConfig().WINDSURFAPI_ANTHROPIC_REPORTED_USAGE_BASIS, 'hybrid');
    assert.equal(runtime.getBusinessEnvConfig().CASCADE_REUSE_HASH_SYSTEM, '0');
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
    });
    assert.equal(process.env.WINDSURFAPI_PUBLIC_MODEL_ALIASES, 'runtime=target');
    assert.equal(process.env.WINDSURFAPI_ANTHROPIC_REPORTED_USAGE_BASIS, 'hybrid');

    runtime.setBusinessEnvConfig({
      WINDSURFAPI_ANTHROPIC_REPORTED_USAGE_BASIS: '',
    });
    runtime = await loadRuntime();

    assert.equal(runtime.getBusinessEnvConfig().WINDSURFAPI_PUBLIC_MODEL_ALIASES, 'runtime=target');
    assert.equal(runtime.getBusinessEnvConfig().WINDSURFAPI_ANTHROPIC_REPORTED_USAGE_BASIS, undefined);
    assert.equal(process.env.WINDSURFAPI_PUBLIC_MODEL_ALIASES, 'runtime=target');
    assert.equal(process.env.WINDSURFAPI_ANTHROPIC_REPORTED_USAGE_BASIS, undefined);
  });
});
