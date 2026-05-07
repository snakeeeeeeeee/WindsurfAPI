import net from 'node:net';
import { config, log } from './config.js';

const DEFAULT_REDIS_URL = process.env.WINDSURFAPI_REDIS_URL || process.env.REDIS_URL || '';
const CONNECT_TIMEOUT_MS = 800;
const COMMAND_TIMEOUT_MS = 1200;

function parseRedisUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'redis:') return null;
    return {
      host: u.hostname || '127.0.0.1',
      port: Number(u.port || 6379),
      password: u.password ? decodeURIComponent(u.password) : '',
      db: u.pathname && u.pathname !== '/' ? Number(u.pathname.slice(1)) : 0,
    };
  } catch {
    return null;
  }
}

function encodeCommand(parts) {
  let out = `*${parts.length}\r\n`;
  for (const part of parts) {
    const s = String(part ?? '');
    out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
  }
  return out;
}

function parseResp(buffer, offset = 0) {
  if (offset >= buffer.length) return null;
  const type = String.fromCharCode(buffer[offset]);
  const lineEnd = buffer.indexOf('\r\n', offset);
  if (lineEnd === -1) return null;
  const line = buffer.slice(offset + 1, lineEnd).toString();
  const next = lineEnd + 2;
  if (type === '+') return { value: line, offset: next };
  if (type === '-') {
    const err = new Error(line);
    err.redis = true;
    throw err;
  }
  if (type === ':') return { value: Number(line), offset: next };
  if (type === '$') {
    const len = Number(line);
    if (len === -1) return { value: null, offset: next };
    const end = next + len;
    if (buffer.length < end + 2) return null;
    return { value: buffer.slice(next, end).toString(), offset: end + 2 };
  }
  if (type === '*') {
    const count = Number(line);
    if (count === -1) return { value: null, offset: next };
    const arr = [];
    let cur = next;
    for (let i = 0; i < count; i++) {
      const parsed = parseResp(buffer, cur);
      if (!parsed) return null;
      arr.push(parsed.value);
      cur = parsed.offset;
    }
    return { value: arr, offset: cur };
  }
  throw new Error(`Unsupported Redis RESP type: ${type}`);
}

class RedisMiniClient {
  constructor(url) {
    this.url = url;
    this.opts = parseRedisUrl(url);
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.queue = [];
    this.connected = false;
    this.connecting = null;
    this.disabledReason = this.opts ? '' : 'redis_url_missing';
  }

  async ensureConnected() {
    if (!this.opts) throw new Error(this.disabledReason || 'redis_url_missing');
    if (this.connected && this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.opts.host, port: this.opts.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('redis_connect_timeout'));
      }, CONNECT_TIMEOUT_MS);
      socket.once('connect', async () => {
        clearTimeout(timer);
        this.socket = socket;
        this.connected = true;
        socket.on('data', chunk => this.onData(chunk));
        socket.on('error', err => this.onDisconnect(err));
        socket.on('close', () => this.onDisconnect());
        try {
          if (this.opts.password) await this.command('AUTH', this.opts.password);
          if (this.opts.db) await this.command('SELECT', this.opts.db);
          resolve();
        } catch (e) {
          socket.destroy();
          reject(e);
        }
      });
      socket.once('error', reject);
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  onDisconnect(err = null) {
    this.connected = false;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    const pending = this.queue.splice(0);
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(err || new Error('redis_disconnected'));
    }
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.queue.length) {
      let parsed;
      try {
        parsed = parseResp(this.buffer, 0);
      } catch (e) {
        const p = this.queue.shift();
        clearTimeout(p.timer);
        p.reject(e);
        this.buffer = Buffer.alloc(0);
        continue;
      }
      if (!parsed) return;
      this.buffer = this.buffer.slice(parsed.offset);
      const p = this.queue.shift();
      clearTimeout(p.timer);
      p.resolve(parsed.value);
    }
  }

  async command(...parts) {
    await this.ensureConnected();
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timer: null };
      pending.timer = setTimeout(() => {
        const idx = this.queue.indexOf(pending);
        if (idx >= 0) this.queue.splice(idx, 1);
        if (this.socket && !this.socket.destroyed) this.socket.destroy();
        reject(new Error('redis_command_timeout'));
      }, COMMAND_TIMEOUT_MS);
      this.queue.push(pending);
      this.socket.write(encodeCommand(parts));
    });
  }
}

const redis = new RedisMiniClient(DEFAULT_REDIS_URL);
const memory = new Map();
let lastError = null;
let lastOkAt = 0;
let redisHealthy = false;

function expireMemoryKey(key) {
  const e = memory.get(key);
  if (!e) return null;
  if (e.expiresAt && e.expiresAt <= Date.now()) {
    memory.delete(key);
    return null;
  }
  return e;
}

async function redisOp(fn) {
  if (!DEFAULT_REDIS_URL) return { ok: false, value: null };
  try {
    const value = await fn(redis);
    lastError = null;
    redisHealthy = true;
    lastOkAt = Date.now();
    return { ok: true, value };
  } catch (e) {
    lastError = e.message || String(e);
    redisHealthy = false;
    log.warn(`shared-state: Redis unavailable, using memory fallback (${lastError})`);
    return { ok: false, value: null };
  }
}

export function sharedStateStatus() {
  return {
    mode: DEFAULT_REDIS_URL ? (lastError ? 'memory_fallback' : 'redis') : 'memory',
    redisUrlConfigured: !!DEFAULT_REDIS_URL,
    redisConnected: !!(redis.connected && redisHealthy && !lastError),
    lastError,
    lastOkAt,
    memoryKeys: memory.size,
    dataDir: config.dataDir,
  };
}

export async function pingSharedState() {
  const pong = await redisOp(r => r.command('PING'));
  return pong.ok && pong.value === 'PONG';
}

export async function stateGet(key) {
  const rv = await redisOp(r => r.command('GET', key));
  if (rv.ok && rv.value != null) return rv.value;
  return expireMemoryKey(key)?.value ?? null;
}

export async function stateSet(key, value, ttlMs = 0) {
  const str = String(value ?? '');
  if (ttlMs > 0) await redisOp(r => r.command('SET', key, str, 'PX', ttlMs));
  else await redisOp(r => r.command('SET', key, str));
  memory.set(key, { value: str, expiresAt: ttlMs > 0 ? Date.now() + ttlMs : 0 });
  return true;
}

export async function stateSetJson(key, value, ttlMs = 0) {
  return stateSet(key, JSON.stringify(value ?? null), ttlMs);
}

export async function stateGetJson(key) {
  const raw = await stateGet(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function stateDel(key) {
  await redisOp(r => r.command('DEL', key));
  memory.delete(key);
  return true;
}

export async function stateKeys(pattern) {
  const keys = await redisOp(r => r.command('KEYS', pattern));
  if (keys.ok && Array.isArray(keys.value)) return keys.value;
  const re = new RegExp('^' + String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  const out = [];
  for (const key of memory.keys()) {
    if (expireMemoryKey(key) && re.test(key)) out.push(key);
  }
  return out;
}

export async function stateWithLock(key, ttlMs, fn) {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let locked = false;
  const redisLocked = await redisOp(r => r.command('SET', key, token, 'NX', 'PX', ttlMs));
  if (redisLocked.ok) {
    if (redisLocked.value !== 'OK') return { acquired: false };
    locked = true;
  }
  if (!locked) {
    const existing = expireMemoryKey(key);
    if (existing) return { acquired: false };
    memory.set(key, { value: token, expiresAt: Date.now() + ttlMs });
    locked = true;
  }
  try {
    const result = await fn();
    return { acquired: true, result };
  } finally {
    const cur = expireMemoryKey(key);
    if (cur?.value === token) memory.delete(key);
    await redisOp(async r => {
      const current = await r.command('GET', key);
      if (current === token) await r.command('DEL', key);
    });
  }
}
