import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmp;

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status; },
    end(chunk) { this.body += chunk ? String(chunk) : ''; },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wfapi-dp-dashboard-'));
  process.env.DATA_DIR = tmp;
  process.env.WINDSURFAPI_SQLITE_PATH = join(tmp, 'windsurfapi.sqlite');
  process.env.WINDSURFAPI_DB_IMPORT_JSON_ON_EMPTY = '0';
});

afterEach(async () => {
  try {
    const db = await import('../src/db.js');
    db.closeDatabaseForTest();
  } catch {}
  delete process.env.DATA_DIR;
  delete process.env.WINDSURFAPI_SQLITE_PATH;
  delete process.env.WINDSURFAPI_DB_IMPORT_JSON_ON_EMPTY;
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

describe('dashboard dynamic proxy API', () => {
  it('saves config and masks password on read', async () => {
    const { config } = await import('../src/config.js');
    const { configureBindHost, _resetLockoutForTests } = await import('../src/auth.js');
    const { handleDashboardApi } = await import('../src/dashboard/api.js');
    const original = {
      apiKey: config.apiKey,
      dashboardPassword: config.dashboardPassword,
      allowPrivateProxyHosts: config.allowPrivateProxyHosts,
    };
    config.apiKey = '';
    config.dashboardPassword = '';
    config.allowPrivateProxyHosts = true;
    configureBindHost('127.0.0.1');
    _resetLockoutForTests();
    try {
      let res = fakeRes();
      await handleDashboardApi(
        'PUT',
        '/dynamic-proxy/config',
        { enabled: true, password: 'secret', host: 'us.novproxy.io', port: 1000 },
        { headers: {}, socket: { remoteAddress: '127.0.0.1' } },
        res
      );
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().config.hasPassword, true);
      assert.equal(Object.hasOwn(res.json().config, 'password'), false);

      res = fakeRes();
      await handleDashboardApi(
        'GET',
        '/dynamic-proxy/config',
        null,
        { headers: {}, socket: { remoteAddress: '127.0.0.1' } },
        res
      );
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().config.hasPassword, true);
      assert.equal(Object.hasOwn(res.json().config, 'password'), false);
    } finally {
      config.apiKey = original.apiKey;
      config.dashboardPassword = original.dashboardPassword;
      config.allowPrivateProxyHosts = original.allowPrivateProxyHosts;
      _resetLockoutForTests();
    }
  });
});
