import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testDataDir = mkdtempSync(join(tmpdir(), 'wfapi-dashboard-api-'));
mkdirSync(testDataDir, { recursive: true });
process.env.WINDSURFAPI_SQLITE_PATH = join(testDataDir, 'windsurfapi.sqlite');
process.env.WINDSURFAPI_DB_IMPORT_JSON_ON_EMPTY = '0';

const { config } = await import('../src/config.js');
const { configureBindHost } = await import('../src/auth.js');
const { buildBatchProxyBinding, handleDashboardApi } = await import('../src/dashboard/api.js');
const { getBusinessEnvConfig, setBusinessEnvConfig } = await import('../src/runtime-config.js');

const originalDashboardPassword = config.dashboardPassword;
const originalApiKey = config.apiKey;

afterEach(() => {
  config.dashboardPassword = originalDashboardPassword;
  config.apiKey = originalApiKey;
  configureBindHost('0.0.0.0');
  setBusinessEnvConfig({
    WINDSURFAPI_ANTHROPIC_REPORTED_FRESH_INPUT_TOKENS: '',
    WINDSURFAPI_ANTHROPIC_REPORTED_USAGE_BASIS: '',
    CASCADE_REUSE_HASH_SYSTEM: '',
    WINDSURFAPI_TRANSIENT_STALL_SWITCH_MAX_ATTEMPTS: '',
  });
  delete process.env.WINDSURFAPI_ANTHROPIC_REPORTED_FRESH_INPUT_TOKENS;
  delete process.env.WINDSURFAPI_ANTHROPIC_REPORTED_USAGE_BASIS;
  delete process.env.CASCADE_REUSE_HASH_SYSTEM;
  delete process.env.WINDSURFAPI_TRANSIENT_STALL_SWITCH_MAX_ATTEMPTS;
});

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status; },
    end(chunk) { this.body += chunk ? String(chunk) : ''; },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

describe('dashboard batch import proxy binding', () => {
  it('wires a guarded service restart route for Docker/supervisor restarts', () => {
    const api = readFileSync(new URL('../src/dashboard/api.js', import.meta.url), 'utf8');
    const route = api.match(/subpath === '\/service\/restart' && method === 'POST'[\s\S]+?if \(subpath === '\/proxy'/)?.[0] || '';
    assert.match(route, /body\?\.confirm/, 'service restart must require explicit confirmation');
    assert.match(route, /scheduleServiceRestart\('dashboard'\)/, 'service restart must use the scheduler');
    assert.match(api, /let serviceRestartScheduled = false/, 'scheduler must guard repeated clicks');
    assert.match(api, /stopLanguageServerAndWait/, 'service restart should stop the LS pool before exiting');
    assert.match(api, /process\.exit\(0\)/, 'service restart should let Docker or the supervisor restart the API process');
  });

  it('uses nested result.account.id from processWindsurfLogin output', () => {
    const binding = buildBatchProxyBinding(
      { success: true, account: { id: 'acct_123' } },
      'socks5://user:pass@proxy.example.com:1080'
    );
    assert.equal(binding.accountId, 'acct_123');
    assert.deepEqual(binding.proxy, {
      type: 'socks5',
      host: 'proxy.example.com',
      port: 1080,
      username: 'user',
      password: 'pass',
    });
  });

  it('fails closed for dashboard write APIs without auth on non-localhost binds', async () => {
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('0.0.0.0');

    const res = fakeRes();
    await handleDashboardApi('DELETE', '/cache', {}, { headers: {} }, res);

    assert.equal(res.statusCode, 401);
    assert.match(res.json().error, /Unauthorized/);
  });

  it('allows unauthenticated dashboard writes only on localhost binds', async () => {
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('127.0.0.1');

    const res = fakeRes();
    await handleDashboardApi('GET', '/cache', {}, { headers: {} }, res);

    assert.equal(res.statusCode, 200);
  });

  it('accepts dashboard auth headers with timing-safe configured secrets', async () => {
    config.dashboardPassword = 'dash-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');

    const res = fakeRes();
    await handleDashboardApi('GET', '/cache', {}, { headers: { 'x-dashboard-password': 'dash-secret' } }, res);

    assert.equal(res.statusCode, 200);
  });

  it('persists and clears runtime env overrides through /settings/env', async () => {
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('127.0.0.1');

    const save = fakeRes();
    await handleDashboardApi('PUT', '/settings/env', {
      env: {
        WINDSURFAPI_ANTHROPIC_REPORTED_FRESH_INPUT_TOKENS: '1',
        WINDSURFAPI_ANTHROPIC_REPORTED_USAGE_BASIS: 'upstream',
        CASCADE_REUSE_HASH_SYSTEM: '0',
        CASCADE_REUSE_HASH_TOOL_ARGS: '0',
        CASCADE_REUSE_SINGLE_TOOL_ALIAS: '1',
        WINDSURFAPI_TRANSIENT_STALL_SWITCH_MAX_ATTEMPTS: '2',
      },
    }, { headers: {} }, save);

    assert.equal(save.statusCode, 200);
    assert.equal(save.json().env.WINDSURFAPI_ANTHROPIC_REPORTED_FRESH_INPUT_TOKENS, '1');
    assert.equal(process.env.WINDSURFAPI_ANTHROPIC_REPORTED_FRESH_INPUT_TOKENS, '1');
    assert.equal(getBusinessEnvConfig().CASCADE_REUSE_HASH_SYSTEM, '0');
    assert.equal(getBusinessEnvConfig().CASCADE_REUSE_HASH_TOOL_ARGS, '0');
    assert.equal(getBusinessEnvConfig().CASCADE_REUSE_SINGLE_TOOL_ALIAS, '1');
    assert.equal(getBusinessEnvConfig().WINDSURFAPI_TRANSIENT_STALL_SWITCH_MAX_ATTEMPTS, '2');
    assert.equal(process.env.WINDSURFAPI_TRANSIENT_STALL_SWITCH_MAX_ATTEMPTS, '2');

    const clear = fakeRes();
    await handleDashboardApi('PUT', '/settings/env', {
      env: {
        WINDSURFAPI_ANTHROPIC_REPORTED_FRESH_INPUT_TOKENS: '',
      },
    }, { headers: {} }, clear);

    assert.equal(clear.statusCode, 200);
    assert.equal(clear.json().env.WINDSURFAPI_ANTHROPIC_REPORTED_FRESH_INPUT_TOKENS, undefined);
    assert.equal(process.env.WINDSURFAPI_ANTHROPIC_REPORTED_FRESH_INPUT_TOKENS, undefined);

    const read = fakeRes();
    await handleDashboardApi('GET', '/settings/env', {}, { headers: {} }, read);
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().env.WINDSURFAPI_ANTHROPIC_REPORTED_USAGE_BASIS, 'upstream');
    assert.equal(read.json().env.CASCADE_REUSE_HASH_SYSTEM, '0');
  });
});
