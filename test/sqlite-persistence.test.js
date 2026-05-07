import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tmp;

async function loadDb() {
  return import(`../src/db.js?case=${Date.now()}-${Math.random()}`);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wfapi-sqlite-'));
  process.env.DATA_DIR = tmp;
  process.env.WINDSURFAPI_SQLITE_PATH = join(tmp, 'windsurfapi.sqlite');
  process.env.WINDSURFAPI_DB_IMPORT_JSON_ON_EMPTY = '1';
});

afterEach(async () => {
  try {
    const db = await loadDb();
    db.closeDatabaseForTest();
  } catch {}
  delete process.env.DATA_DIR;
  delete process.env.WINDSURFAPI_SQLITE_PATH;
  delete process.env.WINDSURFAPI_DB_IMPORT_JSON_ON_EMPTY;
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

describe('SQLite persistence layer', () => {
  it('imports legacy JSON stores once when database is empty', async () => {
    writeFileSync(join(tmp, 'accounts.json'), JSON.stringify([
      {
        id: 'acct-a',
        email: 'a@example.com',
        apiKey: 'key-a',
        method: 'api_key',
        status: 'active',
        tier: 'pro',
        refreshToken: 'refresh-secret',
        capabilities: { 'claude-opus-4.6': { ok: true } },
      },
    ]));
    writeFileSync(join(tmp, 'runtime-config.json'), JSON.stringify({
      experimental: { droughtRestrictPremium: false },
      availability: { mode: 'conservative' },
    }));
    writeFileSync(join(tmp, 'proxy.json'), JSON.stringify({
      global: { type: 'http', host: 'proxy.local', port: 8080, password: 'pw' },
      perAccount: {},
    }));
    writeFileSync(join(tmp, 'model-access.json'), JSON.stringify({
      mode: 'allowlist',
      list: ['claude-opus-4.6'],
    }));
    writeFileSync(join(tmp, 'stats.json'), JSON.stringify({
      totalRequests: 7,
      successCount: 6,
    }));

    const db = await loadDb();
    const accounts = db.getAccountsJson();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].refreshToken, 'refresh-secret');
    assert.deepEqual(accounts[0].capabilities, { 'claude-opus-4.6': { ok: true } });
    assert.equal(db.getJson('runtime', 'config').availability.mode, 'conservative');
    assert.equal(db.getJson('proxy', 'config').global.password, 'pw');
    assert.equal(db.getJson('model_access', 'config').mode, 'allowlist');
    assert.equal(db.getJson('stats', 'state').totalRequests, 7);
    assert.equal(db.getMeta('imported_from_json'), '1');
  });

  it('does not overwrite existing database data from changed JSON on later opens', async () => {
    writeFileSync(join(tmp, 'accounts.json'), JSON.stringify([
      { id: 'acct-a', email: 'a@example.com', apiKey: 'key-a', status: 'active' },
    ]));
    let db = await loadDb();
    db.saveAccountJson({ id: 'acct-b', email: 'b@example.com', apiKey: 'key-b', status: 'active' });
    assert.equal(db.getAccountsJson().length, 2);
    db.closeDatabaseForTest();

    writeFileSync(join(tmp, 'accounts.json'), JSON.stringify([
      { id: 'acct-c', email: 'c@example.com', apiKey: 'key-c', status: 'active' },
    ]));

    db = await loadDb();
    const ids = db.getAccountsJson().map(a => a.id).sort();
    assert.deepEqual(ids, ['acct-a', 'acct-b']);
  });

  it('persists account replace/delete and generic JSON config', async () => {
    const db = await loadDb();
    db.replaceAccountsJson([
      { id: 'acct-a', email: 'a@example.com', apiKey: 'key-a', status: 'active', tier: 'pro' },
      { id: 'acct-b', email: 'b@example.com', apiKey: 'key-b', status: 'disabled', tier: 'free' },
    ]);
    db.deleteAccountJson('acct-a');
    db.setJson('runtime', 'config', { availability: { mode: 'aggressive' } });
    db.closeDatabaseForTest();

    const again = await loadDb();
    const accounts = again.getAccountsJson();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].id, 'acct-b');
    assert.equal(again.getJson('runtime', 'config').availability.mode, 'aggressive');
  });

  it('preserves dynamic proxy bindings when accounts are saved without deletion', async () => {
    const db = await loadDb();
    db.replaceAccountsJson([
      { id: 'acct-a', email: 'a@example.com', apiKey: 'key-a', status: 'active' },
      { id: 'acct-b', email: 'b@example.com', apiKey: 'key-b', status: 'active' },
    ]);
    db.saveAccountProxyBinding({
      accountId: 'acct-a',
      provider: 'novproxy',
      protocol: 'http',
      host: 'us.novproxy.io',
      port: 1000,
      username: 'user-a',
      password: 'pw-a',
      status: 'active',
      egressIp: '73.197.251.49',
      expiresAt: Date.now() + 60000,
    });

    db.replaceAccountsJson([
      { id: 'acct-a', email: 'a-renamed@example.com', apiKey: 'key-a', status: 'active' },
      { id: 'acct-b', email: 'b@example.com', apiKey: 'key-b', status: 'disabled' },
    ]);

    assert.equal(db.getAccountProxyBinding('acct-a').egressIp, '73.197.251.49');

    db.replaceAccountsJson([
      { id: 'acct-b', email: 'b@example.com', apiKey: 'key-b', status: 'disabled' },
    ]);

    assert.equal(db.getAccountProxyBinding('acct-a'), null);
  });

  it('records worker/probe/health history rows without throwing', async () => {
    const db = await loadDb();
    const runId = db.recordAvailabilityWorkerRun({
      startedAt: 1000,
      finishedAt: 1250,
      reason: 'test',
      lockAcquired: true,
      counts: { success: 1 },
      models: ['claude-opus-4.6'],
      accounts: ['acct-a'],
    });
    assert.ok(runId > 0);
    db.recordAvailabilityProbeEvent({
      runId,
      accountId: 'acct-a',
      email: 'a@example.com',
      modelKey: 'claude-opus-4.6',
      probeType: 'model',
      ok: true,
    });
    db.recordAccountModelHealth({
      accountId: 'acct-a',
      email: 'a@example.com',
      modelKey: 'claude-opus-4.6',
      successCount: 1,
    });
  });
});
