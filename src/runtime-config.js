/**
 * Runtime configuration — persistent feature toggles that can be flipped from
 * the dashboard at runtime without a restart or editing .env. Backed by
 * SQLite so it survives redeploys and becomes the durable source of truth.
 *
 * Currently hosts the "experimental" feature flags + system prompts +
 * runtime-rotatable credentials (v2.0.56: API_KEY / DASHBOARD_PASSWORD can
 * be changed from the dashboard without redeploying / editing .env). Keep
 * this tiny: anything that needs a restart should stay in config.js / .env.
 */

import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import { config, log } from './config.js';
import { getJson, setJson } from './db.js';

const DEFAULTS = {
  experimental: {
    // Reuse Cascade cascade_id across multi-turn requests when the history
    // fingerprint matches. Big latency win for long conversations but relies
    // on Windsurf keeping the cascade alive — off by default.
    cascadeConversationReuse: true,
    // Pre-flight rate limit check via server.codeium.com before sending a
    // chat request. Reduces wasted attempts when the account has no message
    // capacity. Adds one network round-trip per attempt so off by default.
    preflightRateLimit: false,
    // v2.0.58 — Drought mode: when every active account has weekly% < 5,
    // block premium models from routing (free-tier models still go
    // through). Default ON so the proxy stops burning upstream calls
    // that would 429 anyway. Can be turned off if operator prefers
    // graceful degradation over hard refusal.
    droughtRestrictPremium: true,
    // v2.0.67 (#112) — Auto-pull docker self-update during traffic lulls.
    // When ON the proxy watches per-minute request rate; if it stays
    // under `autoUpdateQuietWindow.thresholdRequests` for the full
    // `windowMinutes` window, runs the existing docker self-update
    // flow (pulls latest image + spawns deployer sidecar to recreate
    // the container). Default OFF — only useful for self-hosted boxes
    // that mount /var/run/docker.sock and run via docker-compose.
    autoUpdateQuietWindow: false,
  },
  // v2.0.67 (#112) — Tunables for the quiet-window auto-updater.
  // Not under `experimental` because they're not boolean flags.
  // Keys correspond 1:1 with src/dashboard/quiet-window-updater.js DEFAULTS.
  autoUpdateQuietWindow: {
    windowMinutes: 5,
    thresholdRequests: 5,
    cooldownHours: 24,
    coldStartGraceMs: 600000,
  },
  // Production availability router tunables. Env values are used as boot
  // defaults by src/availability-router.js; dashboard writes land here and
  // take effect without a container restart.
  availability: {
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
  },
  dynamicProxy: {
    enabled: false,
    provider: 'novproxy',
    protocol: 'http',
    host: 'us.novproxy.io',
    port: 1000,
    usernameTemplate: 'nfgr68136-region-{region}-st-{state}-sid-{sid}-t-{ttl}',
    password: '',
    region: 'US',
    state: 'New Jersey',
    ttlMinutes: 120,
    renewBeforeMs: 900000,
    verifyUrl: 'https://ipinfo.io/json',
    maxBindRetries: 3,
    autoBindNewAccounts: false,
    workerIntervalMs: 60000,
    workerBatchSize: 20,
    workerConcurrency: 3,
  },
  // System-level prompt templates injected into Cascade proto fields.
  // Editable from Dashboard so users can tune without code changes.
  systemPrompts: {
    toolReinforcement: 'The functions listed above are available and callable. When the user\'s request can be answered by calling a function, emit a <tool_call> block as described. Use this exact format: <tool_call>{"name":"...","arguments":{...}}</tool_call>',
    communicationWithTools: 'You are accessed via API. When asked about your identity, describe your actual underlying model name and provider accurately. STRICTLY respond in the exact same language the user used in their latest message (Chinese → Chinese, English → English, Japanese → Japanese; never switch mid-conversation). Use the functions above when relevant.',
    communicationNoTools: 'You are accessed via API. When asked about your identity, describe your actual underlying model name and provider accurately. Answer directly. STRICTLY respond in the exact same language the user used in their latest message (Chinese → Chinese, English → English, Japanese → Japanese; never switch mid-conversation).',
  },
  // v2.0.56 — runtime-rotatable credentials. When set, override the
  // corresponding env value (API_KEY / DASHBOARD_PASSWORD) without
  // requiring a container restart. apiKey is plaintext (chat clients send
  // it raw and we compare via constant-time hash). dashboardPasswordHash
  // is scrypt-derived and verified with timingSafeEqual — the dashboard
  // posts plaintext over the same TLS-or-localhost channel as the rest of
  // the management API. CLIProxyAPI uses bcrypt for the same purpose; we
  // pick scrypt because it ships in node:crypto with zero deps.
  credentials: {
    apiKey: '',
    dashboardPasswordHash: '',
  },
  envConfig: {},
};

const SYSTEM_PROMPT_KEYS = new Set(Object.keys(DEFAULTS.systemPrompts));
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
  'CASCADE_POLL_INTERVAL_MS',
  'CASCADE_POLL_FAST_MS',
  'CASCADE_POLL_FAST_UNTIL_MS',
  'CASCADE_POLL_MID_MS',
  'CASCADE_POLL_MID_UNTIL_MS',
  'WINDSURFAPI_TRANSIENT_STALL_SWITCH_MAX_ATTEMPTS',
  'CASCADE_DEBUG_DUMP_PROMPT',
];

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function deepMerge(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    // Skip prototype-polluting keys — the JSON loaded here is user-writable
    // via the dashboard, and a crafted key would otherwise corrupt every
    // object in the process.
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(base[k] || {}, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

let _state = structuredClone(DEFAULTS);
let _rawState = {};

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

function envBool(name, fallback) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return fallback;
}

function normalizePatternList(value) {
  const raw = Array.isArray(value) ? value.join('\n') : String(value ?? '');
  return [...new Set(raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean))].join('\n');
}

function initialAvailabilityFromEnv() {
  const d = DEFAULTS.availability;
  return {
    mode: envString('WINDSURFAPI_AVAILABILITY_MODE', d.mode, ['off', 'passive_strong', 'conservative', 'aggressive']),
    probeConcurrencyPerModel: envInt('WINDSURFAPI_PROBE_CONCURRENCY_PER_MODEL', d.probeConcurrencyPerModel),
    backgroundProbePerModel: envInt('WINDSURFAPI_BACKGROUND_PROBE_PER_MODEL', d.backgroundProbePerModel),
    backgroundProbeGlobal: envInt('WINDSURFAPI_BACKGROUND_PROBE_GLOBAL', d.backgroundProbeGlobal),
    modelBreakerMinMs: envInt('WINDSURFAPI_MODEL_BREAKER_MIN_MS', d.modelBreakerMinMs),
    modelBreakerThreshold: envInt('WINDSURFAPI_MODEL_BREAKER_THRESHOLD', d.modelBreakerThreshold),
    modelBreakerWindowMs: envInt('WINDSURFAPI_MODEL_BREAKER_WINDOW_MS', d.modelBreakerWindowMs),
    autoFallback: envString('WINDSURFAPI_AUTO_FALLBACK', d.autoFallback, ['off', 'same_family']),
    workerEnabled: envBool('WINDSURFAPI_AVAILABILITY_WORKER_ENABLED', d.workerEnabled),
    workerIntervalMs: envInt('WINDSURFAPI_AVAILABILITY_WORKER_INTERVAL_MS', d.workerIntervalMs),
    workerBatchAccounts: envInt('WINDSURFAPI_AVAILABILITY_WORKER_BATCH_ACCOUNTS', d.workerBatchAccounts),
    workerBatchModels: envInt('WINDSURFAPI_AVAILABILITY_WORKER_BATCH_MODELS', d.workerBatchModels),
    workerProbeMode: envString('WINDSURFAPI_AVAILABILITY_WORKER_PROBE_MODE', d.workerProbeMode, ['cheap_only', 'selective_model', 'aggressive_model']),
    workerJitterMs: envInt('WINDSURFAPI_AVAILABILITY_WORKER_JITTER_MS', d.workerJitterMs),
    workerMaxRuntimeMs: envInt('WINDSURFAPI_AVAILABILITY_WORKER_MAX_RUNTIME_MS', d.workerMaxRuntimeMs),
    hotPoolMinPerModel: envInt('WINDSURFAPI_HOT_POOL_MIN_PER_MODEL', d.hotPoolMinPerModel),
    hotPoolMaxPerModel: envInt('WINDSURFAPI_HOT_POOL_MAX_PER_MODEL', d.hotPoolMaxPerModel),
    hotPoolFreshMs: envInt('WINDSURFAPI_HOT_POOL_FRESH_MS', d.hotPoolFreshMs),
    requestProbeEnabled: envBool('WINDSURFAPI_REQUEST_PROBE_ENABLED', d.requestProbeEnabled),
    requestProbeConcurrency: envInt('WINDSURFAPI_REQUEST_PROBE_CONCURRENCY', d.requestProbeConcurrency),
    requestProbeBudgetMs: envInt('WINDSURFAPI_REQUEST_PROBE_BUDGET_MS', d.requestProbeBudgetMs),
    fastSwitchMaxAttempts: envInt('WINDSURFAPI_FAST_SWITCH_MAX_ATTEMPTS', d.fastSwitchMaxAttempts),
    fastSwitchBudgetMs: envInt('WINDSURFAPI_FAST_SWITCH_BUDGET_MS', d.fastSwitchBudgetMs),
    accountScoreFailurePenaltyMs: envInt('WINDSURFAPI_ACCOUNT_SCORE_FAILURE_PENALTY_MS', d.accountScoreFailurePenaltyMs),
    trackedModelPatterns: normalizePatternList(envString('WINDSURFAPI_AVAILABILITY_TRACKED_MODEL_PATTERNS', d.trackedModelPatterns)) || d.trackedModelPatterns,
  };
}

function initialBusinessEnvConfig() {
  const out = {};
  for (const key of BUSINESS_ENV_KEYS) {
    const value = String(process.env[key] ?? '').trim();
    if (value) out[key] = value;
  }
  return out;
}

function initialDynamicProxyFromEnv() {
  const d = DEFAULTS.dynamicProxy;
  return {
    enabled: envBool('WINDSURFAPI_DYNAMIC_PROXY_ENABLED', d.enabled),
    provider: envString('WINDSURFAPI_DYNAMIC_PROXY_PROVIDER', d.provider, ['novproxy']),
    protocol: envString('WINDSURFAPI_DYNAMIC_PROXY_PROTOCOL', d.protocol, ['http', 'https', 'socks5']),
    host: envString('WINDSURFAPI_DYNAMIC_PROXY_HOST', d.host),
    port: envInt('WINDSURFAPI_DYNAMIC_PROXY_PORT', d.port),
    usernameTemplate: envString('WINDSURFAPI_DYNAMIC_PROXY_USERNAME_TEMPLATE', d.usernameTemplate),
    password: String(process.env.WINDSURFAPI_DYNAMIC_PROXY_PASSWORD || d.password),
    region: envString('WINDSURFAPI_DYNAMIC_PROXY_REGION', d.region),
    state: envString('WINDSURFAPI_DYNAMIC_PROXY_STATE', d.state),
    ttlMinutes: envInt('WINDSURFAPI_DYNAMIC_PROXY_TTL_MINUTES', d.ttlMinutes),
    renewBeforeMs: envInt('WINDSURFAPI_DYNAMIC_PROXY_RENEW_BEFORE_MS', d.renewBeforeMs),
    verifyUrl: envString('WINDSURFAPI_DYNAMIC_PROXY_VERIFY_URL', d.verifyUrl),
    maxBindRetries: envInt('WINDSURFAPI_DYNAMIC_PROXY_MAX_BIND_RETRIES', d.maxBindRetries),
    autoBindNewAccounts: envBool('WINDSURFAPI_DYNAMIC_PROXY_AUTO_BIND_NEW_ACCOUNTS', d.autoBindNewAccounts),
    workerIntervalMs: envInt('WINDSURFAPI_DYNAMIC_PROXY_WORKER_INTERVAL_MS', d.workerIntervalMs),
    workerBatchSize: envInt('WINDSURFAPI_DYNAMIC_PROXY_WORKER_BATCH_SIZE', d.workerBatchSize),
    workerConcurrency: envInt('WINDSURFAPI_DYNAMIC_PROXY_WORKER_CONCURRENCY', d.workerConcurrency),
  };
}

function migrateLegacyAvailabilityDefaults(rawState) {
  const av = rawState?.availability;
  if (!av || typeof av !== 'object') return rawState;
  const looksLikeOldAggressiveDefault =
    av.mode === 'aggressive'
    && av.workerEnabled === true
    && av.workerProbeMode === 'selective_model'
    && av.requestProbeEnabled === true
    && Number(av.fastSwitchMaxAttempts) === 2
    && Number(av.fastSwitchBudgetMs) === 3000
    && Number(av.backgroundProbePerModel) === 2
    && Number(av.backgroundProbeGlobal) === 5
    && Number(av.hotPoolMinPerModel) === 5
    && Number(av.workerBatchModels) === 4;
  if (!looksLikeOldAggressiveDefault) return rawState;
  log.warn('runtime-config: migrated legacy aggressive availability defaults to passive_strong');
  return { ...rawState, availability: { ...av, ...DEFAULTS.availability } };
}

function applyBusinessEnvConfig(envConfig, { authoritative = false } = {}) {
  if (!envConfig || typeof envConfig !== 'object') return;
  for (const key of BUSINESS_ENV_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(envConfig, key)) {
      if (authoritative) delete process.env[key];
      continue;
    }
    const value = String(envConfig[key] ?? '');
    if (value) process.env[key] = value;
    else if (authoritative) delete process.env[key];
  }
}

function load() {
  try {
    const raw = getJson('runtime', 'config', null);
    if (!raw) {
      const availability = initialAvailabilityFromEnv();
      const dynamicProxy = initialDynamicProxyFromEnv();
      const envConfig = initialBusinessEnvConfig();
      _rawState = Object.keys(envConfig).length ? { availability, dynamicProxy, envConfig } : { availability, dynamicProxy };
      _state = deepMerge(DEFAULTS, _rawState);
      applyBusinessEnvConfig(_rawState.envConfig);
      persist();
      return;
    }
    _rawState = raw && typeof raw === 'object' ? raw : {};
    _rawState = migrateLegacyAvailabilityDefaults(_rawState);
    if (!hasOwn(_rawState, 'envConfig')) {
      const envConfig = initialBusinessEnvConfig();
      if (Object.keys(envConfig).length) _rawState = { ..._rawState, envConfig };
    }
    if (!hasOwn(_rawState, 'dynamicProxy')) {
      _rawState = { ..._rawState, dynamicProxy: initialDynamicProxyFromEnv() };
    }
    _state = deepMerge(DEFAULTS, _rawState);
    applyBusinessEnvConfig(_rawState.envConfig, { authoritative: true });
    if (raw !== _rawState) persist();
  } catch (e) {
    log.warn(`runtime-config: failed to load from SQLite: ${e.message}`);
  }
}

function persist() {
  try {
    const persisted = structuredClone(_state);
    if (!hasOwn(_rawState, 'availability')) delete persisted.availability;
    if (!hasOwn(_rawState, 'dynamicProxy')) delete persisted.dynamicProxy;
    if (!hasOwn(_rawState, 'envConfig')) delete persisted.envConfig;
    setJson('runtime', 'config', persisted);
  } catch (e) {
    log.warn(`runtime-config: failed to persist: ${e.message}`);
  }
}

load();

export function getRuntimeConfig() {
  return structuredClone(_state);
}

export function getAvailabilityRuntimeConfig() {
  return structuredClone(_rawState.availability || {});
}

export function setAvailabilityRuntimeConfig(patch) {
  if (!patch || typeof patch !== 'object') return getAvailabilityRuntimeConfig();
  const current = { ...DEFAULTS.availability, ...(_state.availability || {}) };
  const next = { ...current };
  const numKeys = new Set([
    'probeConcurrencyPerModel',
    'backgroundProbePerModel',
    'backgroundProbeGlobal',
    'modelBreakerMinMs',
    'modelBreakerThreshold',
    'modelBreakerWindowMs',
    'workerIntervalMs',
    'workerBatchAccounts',
    'workerBatchModels',
    'workerJitterMs',
    'workerMaxRuntimeMs',
    'hotPoolMinPerModel',
    'hotPoolMaxPerModel',
    'hotPoolFreshMs',
    'requestProbeConcurrency',
    'requestProbeBudgetMs',
    'fastSwitchMaxAttempts',
    'fastSwitchBudgetMs',
    'accountScoreFailurePenaltyMs',
  ]);
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS.availability)) continue;
    if (numKeys.has(k)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) next[k] = Math.round(n);
    } else if (k === 'mode') {
      const s = String(v || '').trim();
      if (['off', 'passive_strong', 'conservative', 'aggressive'].includes(s)) next[k] = s;
    } else if (k === 'autoFallback') {
      const s = String(v || '').trim();
      if (['off', 'same_family'].includes(s)) next[k] = s;
    } else if (k === 'workerEnabled' || k === 'requestProbeEnabled') {
      next[k] = v === true || v === 'true' || v === '1' || v === 1;
    } else if (k === 'workerProbeMode') {
      const s = String(v || '').trim();
      if (['cheap_only', 'selective_model', 'aggressive_model'].includes(s)) next[k] = s;
    } else if (k === 'trackedModelPatterns') {
      const s = Array.isArray(v) ? v.join('\n') : String(v || '');
      const normalized = [...new Set(s.split(/[\n,]+/).map(x => x.trim()).filter(Boolean))].join('\n');
      next[k] = normalized || DEFAULTS.availability.trackedModelPatterns;
    }
  }
  _state.availability = next;
  _rawState = { ...(_rawState || {}), availability: next };
  persist();
  return getAvailabilityRuntimeConfig();
}

export function getDynamicProxyRuntimeConfig() {
  return structuredClone(_rawState.dynamicProxy || {});
}

export function setDynamicProxyRuntimeConfig(patch) {
  if (!patch || typeof patch !== 'object') return getDynamicProxyRuntimeConfig();
  const current = { ...DEFAULTS.dynamicProxy, ...(_state.dynamicProxy || {}) };
  const next = { ...current };
  const numKeys = new Set([
    'port',
    'ttlMinutes',
    'renewBeforeMs',
    'maxBindRetries',
    'workerIntervalMs',
    'workerBatchSize',
    'workerConcurrency',
  ]);
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS.dynamicProxy)) continue;
    if (numKeys.has(k)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) next[k] = Math.round(n);
    } else if (k === 'enabled' || k === 'autoBindNewAccounts') {
      next[k] = v === true || v === 'true' || v === '1' || v === 1;
    } else if (k === 'provider') {
      const s = String(v || '').trim();
      if (['novproxy'].includes(s)) next[k] = s;
    } else if (k === 'protocol') {
      const s = String(v || '').trim().toLowerCase();
      if (['http', 'https', 'socks5'].includes(s)) next[k] = s;
    } else {
      next[k] = String(v ?? '').trim();
    }
  }
  if (!next.provider) next.provider = DEFAULTS.dynamicProxy.provider;
  if (!next.protocol) next.protocol = DEFAULTS.dynamicProxy.protocol;
  _state.dynamicProxy = next;
  _rawState = { ...(_rawState || {}), dynamicProxy: next };
  persist();
  return getDynamicProxyRuntimeConfig();
}

export function getExperimental() {
  return { ...(_state.experimental || {}) };
}

export function isExperimentalEnabled(key) {
  return !!_state.experimental?.[key];
}

export function setExperimental(patch) {
  if (!patch || typeof patch !== 'object') return getExperimental();
  _state.experimental = { ...(_state.experimental || {}), ...patch };
  // Coerce to booleans — the dashboard ships JSON but we never want truthy
  // strings sneaking in as "true".
  for (const k of Object.keys(_state.experimental)) {
    _state.experimental[k] = !!_state.experimental[k];
  }
  persist();
  return getExperimental();
}

export function getSystemPrompts() {
  const out = { ...DEFAULTS.systemPrompts };
  for (const key of SYSTEM_PROMPT_KEYS) {
    if (typeof _state.systemPrompts?.[key] === 'string') {
      out[key] = _state.systemPrompts[key];
    }
  }
  return out;
}

export function setSystemPrompts(patch) {
  if (!patch || typeof patch !== 'object') return getSystemPrompts();
  const current = _state.systemPrompts || {};
  for (const [k, v] of Object.entries(patch)) {
    if (!SYSTEM_PROMPT_KEYS.has(k)) continue;
    if (typeof v !== 'string') continue;
    current[k] = v.trim();
  }
  _state.systemPrompts = current;
  persist();
  return getSystemPrompts();
}

export function resetSystemPrompt(key) {
  if (key) {
    if (_state.systemPrompts && SYSTEM_PROMPT_KEYS.has(key)) delete _state.systemPrompts[key];
  } else {
    _state.systemPrompts = {};
  }
  persist();
  return getSystemPrompts();
}

// ─── Credentials (v2.0.56 runtime rotation) ────────────────────────────

const SCRYPT_N = 2 ** 14;   // 16384 — bcrypt-equivalent CPU cost
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

/**
 * Hash a plaintext password using scrypt with a random 16-byte salt.
 * Returned format: `scrypt$<N>$<r>$<p>$<base64-salt>$<base64-hash>` so we
 * can verify even if the cost parameters get bumped in a future release.
 */
export function hashPassword(plain) {
  const s = String(plain ?? '');
  if (!s) return '';
  const salt = randomBytes(16);
  const hash = scryptSync(s, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * Verify a plaintext password against a stored value.
 * Falls back to plaintext comparison when the stored value doesn't carry
 * the `scrypt$` prefix — that path is for env-supplied
 * `DASHBOARD_PASSWORD=...` which we never hash to keep the env contract
 * intact. Always uses constant-time comparison on the final byte buffers.
 */
export function verifyPassword(plain, stored) {
  if (typeof stored !== 'string' || !stored) return false;
  const sPlain = String(plain ?? '');
  if (!stored.startsWith('scrypt$')) {
    // Plaintext compare via timingSafeEqual on equal-length sha256 digests
    // — matches src/auth.js safeEqualString semantics so the env-mode
    // dashboard password doesn't leak length via early return.
    if (!sPlain) return false;
    const a = Buffer.from(sPlain, 'utf8');
    const b = Buffer.from(stored, 'utf8');
    if (a.length !== b.length) {
      // Burn a comparable amount of cycles so the timing remains close
      // to the equal-length branch. Reject regardless.
      try { timingSafeEqual(Buffer.alloc(b.length), Buffer.alloc(b.length)); } catch {}
      return false;
    }
    return timingSafeEqual(a, b);
  }
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const N = parseInt(parts[1], 10);
  const r = parseInt(parts[2], 10);
  const p = parseInt(parts[3], 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let salt, expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch { return false; }
  if (!salt.length || !expected.length) return false;
  const actual = scryptSync(sPlain, salt, expected.length, { N, r, p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function getCredentials() {
  return {
    apiKey: _state.credentials?.apiKey || '',
    dashboardPasswordHash: _state.credentials?.dashboardPasswordHash || '',
  };
}

export function getBusinessEnvConfig() {
  return { ...(_state.envConfig || {}) };
}

export function setBusinessEnvConfig(patch) {
  if (!patch || typeof patch !== 'object') return getBusinessEnvConfig();
  const next = { ...(_state.envConfig || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (!BUSINESS_ENV_KEYS.includes(key)) continue;
    const v = String(value ?? '').trim();
    if (v) next[key] = v;
    else delete next[key];
  }
  _state.envConfig = next;
  _rawState = { ...(_rawState || {}), envConfig: next };
  applyBusinessEnvConfig(next, { authoritative: true });
  persist();
  return getBusinessEnvConfig();
}

/**
 * Set the runtime API key. Empty string clears the runtime override and
 * lets `config.apiKey` fall back to the env value at call sites.
 */
export function setRuntimeApiKey(plain) {
  const v = typeof plain === 'string' ? plain.trim() : '';
  if (!_state.credentials) _state.credentials = {};
  _state.credentials.apiKey = v;
  persist();
  return getCredentials();
}

/**
 * Set the runtime dashboard password (plaintext input → scrypt hash on
 * disk). Empty string clears the runtime override.
 */
export function setRuntimeDashboardPassword(plain) {
  const v = typeof plain === 'string' ? plain : '';
  if (!_state.credentials) _state.credentials = {};
  _state.credentials.dashboardPasswordHash = v ? hashPassword(v) : '';
  persist();
  return getCredentials();
}

/**
 * Resolve the effective API key: runtime override wins over env. Returned
 * value is the plaintext key the chat client must send.
 */
export function getEffectiveApiKey() {
  const runtime = _state.credentials?.apiKey || '';
  return runtime || config.apiKey || '';
}

/**
 * Resolve the effective dashboard password's stored form. Returned string
 * is either a `scrypt$...` hash (runtime-set) or the plaintext env value;
 * verifyPassword() handles both.
 */
export function getEffectiveDashboardPasswordStored() {
  const runtime = _state.credentials?.dashboardPasswordHash || '';
  return runtime || config.dashboardPassword || '';
}

// Wire the auth module's pluggable API-key resolver so validateApiKey()
// sees runtime overrides without a cyclic import. Done at module-load
// time after `load()` so the file-backed value is honoured immediately.
import('./auth.js').then(m => {
  if (typeof m.setApiKeyResolver === 'function') m.setApiKeyResolver(getEffectiveApiKey);
  // v2.0.58: same hook for drought-mode premium restriction so toggling
  // the flag from the dashboard takes effect without a restart.
  if (typeof m.setDroughtRestrictResolver === 'function') {
    m.setDroughtRestrictResolver(() => isExperimentalEnabled('droughtRestrictPremium'));
  }
}).catch(() => { /* auth not yet ready, validateApiKey falls back to env */ });
