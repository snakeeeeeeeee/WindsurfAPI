import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmp;

async function loadModules() {
  const db = await import('../src/db.js');
  const runtime = await import('../src/runtime-config.js');
  const dynamic = await import('../src/dynamic-proxy.js');
  const proxyConfig = await import('../src/dashboard/proxy-config.js');
  return { db, runtime, dynamic, proxyConfig };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wfapi-dynamic-proxy-'));
  process.env.DATA_DIR = tmp;
  process.env.WINDSURFAPI_SQLITE_PATH = join(tmp, 'windsurfapi.sqlite');
  process.env.WINDSURFAPI_DB_IMPORT_JSON_ON_EMPTY = '0';
  process.env.WINDSURFAPI_DYNAMIC_PROXY_ENABLED = '1';
  process.env.WINDSURFAPI_DYNAMIC_PROXY_PASSWORD = 'secret-pw';
});

afterEach(async () => {
  try {
    const { db, dynamic } = await loadModules();
    dynamic._setDynamicProxyTestHooks({});
    db.closeDatabaseForTest();
  } catch {}
  delete process.env.DATA_DIR;
  delete process.env.WINDSURFAPI_SQLITE_PATH;
  delete process.env.WINDSURFAPI_DB_IMPORT_JSON_ON_EMPTY;
  delete process.env.WINDSURFAPI_DYNAMIC_PROXY_ENABLED;
  delete process.env.WINDSURFAPI_DYNAMIC_PROXY_PASSWORD;
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

describe('dynamic proxy bindings', () => {
  it('generates Novproxy username placeholders and masks password in config', async () => {
    const { dynamic } = await loadModules();
    const cfg = dynamic.getDynamicProxyConfig();
    const generated = dynamic.generateNovproxyCredentials({ ...cfg, region: 'US', state: 'New Jersey', ttlMinutes: 120 }, 'SID123');
    assert.match(generated.username, /region-US/);
    assert.match(generated.username, /st-New Jersey/);
    assert.match(generated.username, /sid-SID123/);
    assert.match(generated.username, /t-120/);
    assert.equal(dynamic.getDynamicProxyConfigMasked().hasPassword, true);
    assert.equal(Object.hasOwn(dynamic.getDynamicProxyConfigMasked(), 'password'), false);
  });

  it('binds an account after verification and returns strict effective proxy', async () => {
    const { db, dynamic, proxyConfig } = await loadModules();
    db.saveAccountJson({ id: 'acct-dp-a', email: 'a@example.com', apiKey: 'key-a', status: 'active' });
    dynamic._setDynamicProxyTestHooks({
      skipAfterBindingChanged: true,
      testProxy: async () => ({
        egressIp: '73.197.251.49',
        country: 'US',
        region: 'New Jersey',
        city: 'Colonia',
        ispOrg: 'AS7922 Comcast Cable Communications, LLC',
        latencyMs: 12,
      }),
    });
    const result = await dynamic.bindAccountDynamicProxy('acct-dp-a', { force: true });
    assert.equal(result.success, true);
    assert.equal(result.binding.egressIp, '73.197.251.49');
    assert.equal(result.binding.hasPassword, true);
    assert.equal(Object.hasOwn(result.binding, 'password'), false);
    const px = proxyConfig.getEffectiveProxy('acct-dp-a');
    assert.equal(px.strict, true);
    assert.equal(px.dynamicBinding, true);
    assert.equal(px.accountId, 'acct-dp-a');
    assert.equal(px.password, 'secret-pw');
  });

  it('expired bindings do not become effective proxies', async () => {
    const { db, proxyConfig } = await loadModules();
    db.saveAccountJson({ id: 'acct-dp-exp', email: 'e@example.com', apiKey: 'key-e', status: 'active' });
    db.saveAccountProxyBinding({
      accountId: 'acct-dp-exp',
      provider: 'novproxy',
      protocol: 'http',
      host: 'us.novproxy.io',
      port: 1000,
      username: 'u',
      password: 'p',
      status: 'active',
      expiresAt: Date.now() - 1000,
    });
    assert.equal(proxyConfig.getEffectiveProxy('acct-dp-exp'), null);
    assert.equal(db.getAccountProxyBinding('acct-dp-exp').status, 'expired');
  });

  it('manual account proxy is used when no active dynamic binding exists', async () => {
    const { db, proxyConfig } = await loadModules();
    db.saveAccountJson({ id: 'acct-dp-manual', email: 'm@example.com', apiKey: 'key-m', status: 'active' });
    proxyConfig.setAccountProxy('acct-dp-manual', { type: 'http', host: '1.1.1.1', port: 8080, username: '', password: '' });
    const px = proxyConfig.getEffectiveProxy('acct-dp-manual');
    assert.deepEqual(px, { type: 'http', host: '1.1.1.1', port: 8080, username: '', password: '' });
  });
});
