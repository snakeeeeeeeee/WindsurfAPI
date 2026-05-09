/**
 * POST /v1/messages — Anthropic Messages API compatibility layer.
 *
 * Translates Anthropic request/response format to/from the internal OpenAI
 * format so Claude Code and any Anthropic SDK client can connect directly.
 *
 * Streaming path is a real-time translator: it pipes the OpenAI SSE stream
 * from handleChatCompletions through a response shim that parses each
 * chat.completion.chunk and emits the equivalent Anthropic message_start /
 * content_block_* / message_delta / message_stop events as bytes arrive.
 * No buffering, so first-token latency matches the upstream Cascade stream.
 */

import { createHash, randomUUID } from 'crypto';
import { handleChatCompletions } from './chat.js';
import { log } from '../config.js';

function genMsgId() {
  return 'msg_' + randomUUID().replace(/-/g, '').slice(0, 24);
}

// Anthropic Messages API tool types whose execution lives on Anthropic's
// servers, not the client. The proxy treats these as opt-out: it cannot
// satisfy server_tool_result delivery without implementing each one
// against Cascade, so they're stripped from the request rather than
// translated into normal function tools.
//   web_search_20250305     server-side web search
//   code_execution_20250522 server-side python sandbox
//   advisor_20260301        Anthropic Advisor Strategy (sonnet+opus pair)
const SERVER_SIDE_ANTHROPIC_TOOL_TYPES = new Set([
  'web_search_20250305',
  'code_execution_20250522',
  'advisor_20260301',
]);

function sha256Hex(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function anthropicReportedCacheBucketsEnabled() {
  return process.env.WINDSURFAPI_ANTHROPIC_REPORTED_CACHE_BUCKETS === '1';
}

function reportedAnthropicUsageBasis() {
  const raw = String(process.env.WINDSURFAPI_ANTHROPIC_REPORTED_USAGE_BASIS || '').trim().toLowerCase();
  if (!raw) return 'upstream';
  if (raw === 'client' || raw === 'request' || raw === 'payload') return 'client';
  if (raw === 'official' || raw === 'anthropic' || raw === 'cache') return 'official';
  if (raw === 'hybrid' || raw === 'mixed') return 'hybrid';
  return 'upstream';
}

function reportedAnthropicOutputBasis(usageBasis = reportedAnthropicUsageBasis()) {
  const raw = String(process.env.WINDSURFAPI_ANTHROPIC_REPORTED_OUTPUT_BASIS || '').trim().toLowerCase();
  if (raw === 'response' || raw === 'content' || raw === 'client') return 'response';
  if (raw === 'upstream' || raw === 'cascade' || raw === 'server') return 'upstream';
  return usageBasis === 'official' ? 'response' : 'upstream';
}

function reportedAnthropicCacheMaxEntries() {
  const raw = String(process.env.WINDSURFAPI_ANTHROPIC_REPORTED_CACHE_MAX_ENTRIES || '').trim();
  if (!raw) return 10000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 10000;
  return Math.max(100, Math.min(1000000, Math.floor(n)));
}

function reportedAnthropicCacheCreationTailRatio() {
  const raw = String(process.env.WINDSURFAPI_ANTHROPIC_REPORTED_CACHE_CREATION_TAIL_RATIO || '').trim();
  if (!raw) return 0.15;
  let n = Number(raw.replace(/%$/, ''));
  if (!Number.isFinite(n) || n < 0) return 0.15;
  if (n > 1) n = n / 100;
  return Math.max(0, Math.min(1, n));
}

function reportedAnthropicFreshInputTokens() {
  const raw = String(process.env.WINDSURFAPI_ANTHROPIC_REPORTED_FRESH_INPUT_TOKENS || '').trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function reportedAnthropicCacheHitRate() {
  const raw = String(process.env.WINDSURFAPI_ANTHROPIC_REPORTED_CACHE_HIT_RATE || '').trim();
  if (!raw) return 0;
  let n = Number(raw.replace(/%$/, ''));
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > 1) n = n / 100;
  if (n <= 0) return 0;
  return Math.min(1, n);
}

function cacheReadForVisibleHitRate(freshInput, cacheCreation, rate) {
  if (!rate || rate <= 0 || rate >= 1) return 0;
  const numerator = rate * (freshInput + cacheCreation);
  const denominator = 1 - rate;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.ceil((numerator / denominator) - 1e-9);
}

function reportedAnthropicCacheCreationRate() {
  const raw = String(process.env.WINDSURFAPI_ANTHROPIC_REPORTED_CACHE_CREATION_RATE || '').trim();
  if (!raw) return 1;
  let n = Number(raw.replace(/%$/, ''));
  if (!Number.isFinite(n) || n < 0) return 1;
  if (n > 1) n = n / 100;
  if (n < 0) return 1;
  return Math.min(1, n);
}

function reportedAnthropicIncludeUpstreamPrefix() {
  return process.env.WINDSURFAPI_ANTHROPIC_REPORTED_INCLUDE_UPSTREAM_PREFIX === '1';
}

function reportedAnthropicExtraPrefixTokens() {
  const raw = String(process.env.WINDSURFAPI_ANTHROPIC_REPORTED_EXTRA_PREFIX_TOKENS || '').trim();
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function reportedAnthropicPrefixBucket() {
  const raw = String(process.env.WINDSURFAPI_ANTHROPIC_REPORTED_PREFIX_BUCKET || '').trim().toLowerCase();
  if (raw === 'cache_read' || raw === 'read' || raw === 'cached' || raw === 'hit') return 'cache_read';
  if (raw === 'cache_creation' || raw === 'creation' || raw === 'write' || raw === 'cache_write') return 'cache_creation';
  return 'auto';
}

function scaleAnthropicCacheCreationSplit(split, reportedTotal) {
  if (!split || typeof split !== 'object') return split;

  const raw5m = Number(split.ephemeral_5m_input_tokens) || 0;
  const raw1h = Number(split.ephemeral_1h_input_tokens) || 0;
  const rawTotal = raw5m + raw1h;
  if (reportedTotal <= 0 || rawTotal <= 0) {
    return {
      ephemeral_5m_input_tokens: 0,
      ephemeral_1h_input_tokens: 0,
    };
  }

  const reported5m = Math.floor((reportedTotal * raw5m) / rawTotal);
  return {
    ephemeral_5m_input_tokens: reported5m,
    ephemeral_1h_input_tokens: reportedTotal - reported5m,
  };
}

function nonNegativeInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function normalizeAnthropicCacheCreationSplit(split, reportedTotal) {
  const total = nonNegativeInteger(reportedTotal);
  if (!split || typeof split !== 'object') {
    return {
      ephemeral_5m_input_tokens: total,
      ephemeral_1h_input_tokens: 0,
    };
  }

  const normalized = {
    ephemeral_5m_input_tokens: nonNegativeInteger(split.ephemeral_5m_input_tokens),
    ephemeral_1h_input_tokens: nonNegativeInteger(split.ephemeral_1h_input_tokens),
  };
  const splitTotal = normalized.ephemeral_5m_input_tokens + normalized.ephemeral_1h_input_tokens;
  if (splitTotal === total) return normalized;
  if (splitTotal <= 0 && total > 0) {
    return {
      ephemeral_5m_input_tokens: total,
      ephemeral_1h_input_tokens: 0,
    };
  }
  return scaleAnthropicCacheCreationSplit(normalized, total);
}

// Real Claude Code 2.1.120 traffic carries metadata.user_id as a
// JSON-encoded string with shape {device_id, account_uuid, session_id}.
// Older Anthropic SDK clients send a plain string. The proxy currently
// derives callerKey from API key + IP/UA, which means every Claude Code
// client behind the same key shares one cascade pool — leading to cross-
// device session bleed. Extract a stable per-user tag from metadata so
// the pool can isolate concurrent users.
export function extractCallerSubKey(body) {
  const userId = body?.metadata?.user_id;
  if (typeof userId !== 'string' || !userId) return '';
  let parsed = null;
  try { parsed = JSON.parse(userId); } catch {}
  let tag = '';
  if (parsed && typeof parsed === 'object') {
    tag = parsed.device_id || parsed.deviceId
      || parsed.session_id || parsed.sessionId
      || parsed.account_uuid || parsed.accountUuid
      || '';
  } else {
    tag = userId;
  }
  if (!tag) return '';
  return sha256Hex(tag).slice(0, 16);
}

function collectCachePolicy(body, { strip = false } = {}) {
  let breakpointCount = 0;
  let has1h = false;
  const visit = (block) => {
    if (!block || typeof block !== 'object') return;
    const cc = block.cache_control;
    if (cc && typeof cc === 'object' && cc.type === 'ephemeral') {
      breakpointCount++;
      if (cc.ttl === '1h') has1h = true;
      if (strip) delete block.cache_control;
    }
  };
  if (Array.isArray(body.tools)) for (const t of body.tools) visit(t);
  if (Array.isArray(body.system)) for (const s of body.system) visit(s);
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (Array.isArray(m.content)) for (const c of m.content) visit(c);
    }
  }
  // Also accept top-level cache_control hint (auto-caching mode).
  if (body.cache_control && typeof body.cache_control === 'object') {
    if (body.cache_control.type === 'ephemeral') {
      breakpointCount++;
      if (body.cache_control.ttl === '1h') has1h = true;
    }
    if (strip) delete body.cache_control;
  }
  return { has1h, breakpointCount };
}

function estimateTextTokens(text) {
  if (typeof text !== 'string' || !text) return 0;
  return Math.ceil(text.length / 4);
}

function jsonForUsageEstimate(value) {
  try {
    return JSON.stringify(value, (key, val) => {
      if (key === 'cache_control') return undefined;
      if (key === 'data' && typeof val === 'string' && val.length > 256) {
        return `[base64:${val.length}]`;
      }
      return val;
    }) || '';
  } catch {
    return '';
  }
}

function estimateJsonTokens(value) {
  return estimateTextTokens(jsonForUsageEstimate(value));
}

function estimateImageTokens(block) {
  const data = block?.source?.data;
  if (typeof data === 'string' && data.length > 0) {
    const approxBytes = Math.ceil((data.length * 3) / 4);
    return Math.max(256, Math.min(4096, Math.ceil(approxBytes / 768) * 85));
  }
  return 1200;
}

function estimateAnthropicContentTokens(content) {
  if (typeof content === 'string') return estimateTextTokens(content);
  if (!Array.isArray(content)) return estimateJsonTokens(content);

  let tokens = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      tokens += estimateTextTokens(block.text || '');
    } else if (block.type === 'thinking') {
      tokens += estimateTextTokens(block.thinking || '') + estimateTextTokens(block.signature || '');
    } else if (block.type === 'image') {
      tokens += estimateImageTokens(block);
    } else if (block.type === 'tool_use') {
      tokens += 8 + estimateTextTokens(block.name || '') + estimateJsonTokens(block.input || {});
    } else if (block.type === 'tool_result') {
      tokens += 8 + estimateAnthropicContentTokens(block.content);
    } else if (block.type === 'document') {
      tokens += 1000 + estimateJsonTokens({ ...block, source: undefined });
    } else {
      tokens += estimateJsonTokens(block);
    }
  }
  return tokens;
}

function estimateAnthropicResponseContentTokens(content) {
  return estimateAnthropicContentTokens(content);
}

export function estimateAnthropicClientPromptTokens(body) {
  let tokens = 0;

  if (typeof body?.system === 'string') {
    tokens += estimateTextTokens(body.system);
  } else if (Array.isArray(body?.system)) {
    for (const block of body.system) tokens += estimateAnthropicContentTokens([block]);
  }

  if (Array.isArray(body?.tools)) {
    for (const tool of body.tools) tokens += 8 + estimateJsonTokens(tool);
  }
  if (body?.tool_choice) tokens += estimateJsonTokens(body.tool_choice);

  if (Array.isArray(body?.messages)) {
    for (const message of body.messages) {
      tokens += 4;
      tokens += estimateAnthropicContentTokens(message?.content);
    }
  }

  return Math.max(1, tokens);
}

export function estimateAnthropicClientTailTokens(body) {
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return estimateAnthropicClientPromptTokens(body);
  }

  let startIndex = 0;
  for (let i = body.messages.length - 1; i >= 0; i--) {
    if (body.messages[i]?.role === 'assistant') {
      startIndex = i + 1;
      break;
    }
  }

  let tokens = 0;
  for (const message of body.messages.slice(startIndex)) {
    tokens += estimateMessageTokens(message);
  }
  return Math.max(1, tokens);
}

function cacheTtlMs(ttl) {
  return ttl === '1h' ? 60 * 60 * 1000 : 5 * 60 * 1000;
}

function stripCacheControlForHash(value) {
  if (Array.isArray(value)) return value.map(stripCacheControlForHash);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (key === 'cache_control') continue;
    out[key] = stripCacheControlForHash(val);
  }
  return out;
}

function canonicalCacheSegment(value) {
  return jsonForUsageEstimate(stripCacheControlForHash(value));
}

function messageForCacheSegment(message) {
  if (!message || typeof message !== 'object') return message;
  return {
    role: message.role,
    content: stripCacheControlForHash(message.content),
  };
}

function estimateSystemBlockTokens(block) {
  return estimateAnthropicContentTokens([block]);
}

function estimateToolTokens(tool) {
  return 8 + estimateJsonTokens(tool);
}

function estimateMessageTokens(message) {
  return 4 + estimateAnthropicContentTokens(message?.content);
}

// Every prior boundary in the request is a candidate prefix hash, so a
// current-request breakpoint can match a cache entry stored by a prior
// request that placed its own breakpoint anywhere earlier in the common
// prefix (not just within the last N blocks). The candidate list is
// consumed immediately inside buildOfficialReportedUsageCandidate and the
// map lookups are O(1), so the iteration cost stays well under 1 ms even
// for multi-hundred-block conversations.

function extractAnthropicCacheBreakpoints(body) {
  const segments = [];
  const boundaries = [];
  let parts = [];
  let tokens = 0;

  const prefixAtCurrentBoundary = () => ({
    tokens: Math.max(1, tokens),
    hash: sha256Hex(parts.join('\n')),
    blockIndex: boundaries.length,
  });
  const addBoundary = () => {
    if (!parts.length) return null;
    const boundary = prefixAtCurrentBoundary();
    boundary.blockIndex = boundaries.length + 1;
    boundaries.push(boundary);
    return boundary;
  };
  const addPart = (kind, value, tokenCount, { boundary = true } = {}) => {
    const canonical = canonicalCacheSegment({ kind, value });
    parts.push(canonical);
    tokens += tokenCount;
    if (boundary) addBoundary();
    return canonical;
  };
  const pushBreakpoint = (ttl) => {
    if (!parts.length) return;
    const exact = boundaries[boundaries.length - 1] || prefixAtCurrentBoundary();
    const previous = boundaries.slice(0, Math.max(0, boundaries.length - 1));
    segments.push({
      ttl: ttl === '1h' ? '1h' : '5m',
      tokens: exact.tokens,
      hash: exact.hash,
      blockIndex: exact.blockIndex,
      hitCandidates: [...previous, exact],
    });
  };
  const maybeBreakpoint = (value) => {
    const cc = value?.cache_control;
    if (cc && typeof cc === 'object' && cc.type === 'ephemeral') pushBreakpoint(cc.ttl);
  };

  if (Array.isArray(body?.tools)) {
    for (const tool of body.tools) {
      addPart('tool', stripCacheControlForHash(tool), estimateToolTokens(tool));
      maybeBreakpoint(tool);
    }
  }

  if (typeof body?.system === 'string') {
    addPart('system', body.system, estimateTextTokens(body.system));
  } else if (Array.isArray(body?.system)) {
    for (const block of body.system) {
      addPart('system', stripCacheControlForHash(block), estimateSystemBlockTokens(block));
      maybeBreakpoint(block);
    }
  }

  if (Array.isArray(body?.messages)) {
    for (const message of body.messages) {
      if (Array.isArray(message?.content)) {
        addPart('message_role', { role: message.role }, 4, { boundary: false });
        for (const block of message.content) {
          const tokenCount = estimateAnthropicContentTokens([block]);
          addPart('message_block', { role: message.role, content: stripCacheControlForHash(block) }, tokenCount);
          maybeBreakpoint(block);
        }
      } else {
        addPart('message', messageForCacheSegment(message), estimateMessageTokens(message));
      }
    }
  }

  if (body?.cache_control && typeof body.cache_control === 'object' && body.cache_control.type === 'ephemeral') {
    pushBreakpoint(body.cache_control.ttl);
  }

  return segments.slice(-4);
}

const reportedAnthropicCacheEntries = new Map();
const reportedAnthropicSyntheticTailEntries = new Map();

export function resetReportedAnthropicCacheForTests() {
  reportedAnthropicCacheEntries.clear();
  reportedAnthropicSyntheticTailEntries.clear();
}

function pruneReportedAnthropicCache(now = Date.now()) {
  const maxEntries = reportedAnthropicCacheMaxEntries();
  for (const [key, entry] of reportedAnthropicCacheEntries) {
    if (!entry || entry.expiresAt <= now) reportedAnthropicCacheEntries.delete(key);
  }
  while (reportedAnthropicCacheEntries.size > maxEntries) {
    const oldestKey = reportedAnthropicCacheEntries.keys().next().value;
    if (!oldestKey) break;
    reportedAnthropicCacheEntries.delete(oldestKey);
  }
  for (const [key, entry] of reportedAnthropicSyntheticTailEntries) {
    if (!entry || entry.expiresAt <= now) reportedAnthropicSyntheticTailEntries.delete(key);
  }
  while (reportedAnthropicSyntheticTailEntries.size > maxEntries) {
    const oldestKey = reportedAnthropicSyntheticTailEntries.keys().next().value;
    if (!oldestKey) break;
    reportedAnthropicSyntheticTailEntries.delete(oldestKey);
  }
}

function reportedCacheScope(body, context = {}) {
  return [
    context.callerKey || '',
    body?.model || 'claude-sonnet-4.6',
  ].join('|');
}

function syntheticTailKey(scope) {
  return `${scope}|synthetic-tail`;
}

function readSyntheticTailTokens(scope, now = Date.now()) {
  pruneReportedAnthropicCache(now);
  const entry = reportedAnthropicSyntheticTailEntries.get(syntheticTailKey(scope));
  if (!entry || entry.expiresAt <= now) return 0;
  return entry.tokens;
}

function recordSyntheticTailTokens(scope, tokens, now = Date.now()) {
  const n = nonNegativeInteger(tokens);
  if (n <= 0) return;
  pruneReportedAnthropicCache(now);
  const key = syntheticTailKey(scope);
  const existing = reportedAnthropicSyntheticTailEntries.get(key);
  const existingTokens = existing && existing.expiresAt > now ? existing.tokens : 0;
  reportedAnthropicSyntheticTailEntries.set(key, {
    tokens: existingTokens + n,
    expiresAt: now + cacheTtlMs('5m'),
    lastSeenAt: now,
  });
  pruneReportedAnthropicCache(now);
}

function buildOfficialReportedUsageBasis(body, context = {}) {
  if (!anthropicReportedCacheBucketsEnabled()) return null;
  if (reportedAnthropicUsageBasis() !== 'official') return null;

  return buildOfficialReportedUsageCandidate(body, context);
}

function buildOfficialReportedUsageCandidate(body, context = {}) {
  if (!anthropicReportedCacheBucketsEnabled()) return null;

  const now = Date.now();
  pruneReportedAnthropicCache(now);
  const totalPromptTokens = estimateAnthropicClientPromptTokens(body);
  const breakpoints = extractAnthropicCacheBreakpoints(body);
  const scope = reportedCacheScope(body, context);
  let cacheRead = 0;
  let cacheCreation = 0;
  let cacheCreation5m = 0;
  let cacheCreation1h = 0;
  let bestHit = null;

  for (const bp of breakpoints) {
    const candidates = Array.isArray(bp.hitCandidates) && bp.hitCandidates.length
      ? bp.hitCandidates
      : [bp];
    for (const candidate of candidates) {
      const key = `${scope}|${bp.ttl}|${candidate.hash}`;
      const hit = reportedAnthropicCacheEntries.get(key);
      if (hit && hit.expiresAt > now && (!bestHit || hit.tokens > bestHit.tokens)) {
        bestHit = { ...hit, key, ttl: bp.ttl };
      }
    }
  }

  if (bestHit) {
    cacheRead = bestHit.tokens;
    reportedAnthropicCacheEntries.set(bestHit.key, {
      ...bestHit,
      lastSeenAt: now,
    });
  }

  const creationCandidates = breakpoints
    .filter(bp => bp.tokens > cacheRead)
    .map(bp => {
      const key = `${scope}|${bp.ttl}|${bp.hash}`;
      const existing = reportedAnthropicCacheEntries.get(key);
      return { ...bp, key, existing };
    })
    .filter(bp => !(bp.existing && bp.existing.expiresAt > now));
  const selectedCreation = creationCandidates.length
    ? creationCandidates.reduce((best, bp) => (bp.tokens > best.tokens ? bp : best), creationCandidates[0])
    : null;
  if (selectedCreation) {
    const bp = selectedCreation;
    const uncachedTail = Math.max(0, bp.tokens - cacheRead);
    const tailCap = cacheRead > 0
      ? Math.max(1, Math.ceil(cacheRead * reportedAnthropicCacheCreationTailRatio()))
      : uncachedTail;
    const createTokens = Math.min(uncachedTail, tailCap);
    cacheCreation += createTokens;
    if (bp.ttl === '1h') cacheCreation1h += createTokens;
    else cacheCreation5m += createTokens;
    reportedAnthropicCacheEntries.set(bp.key, {
      tokens: bp.tokens,
      expiresAt: now + cacheTtlMs(bp.ttl),
      lastSeenAt: now,
    });
  }
  pruneReportedAnthropicCache(now);

  const freshOverride = reportedAnthropicFreshInputTokens();
  const freshInput = freshOverride === null
    ? Math.max(1, totalPromptTokens - cacheRead - cacheCreation)
    : freshOverride;
  return {
    promptTotal: totalPromptTokens,
    input_tokens: freshInput,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
    cache_creation: {
      ephemeral_5m_input_tokens: cacheCreation5m,
      ephemeral_1h_input_tokens: cacheCreation1h,
    },
    skipConfiguredCacheRewrite: true,
  };
}

function upstreamReportedUsageBasis(usage = {}) {
  const cacheRead = nonNegativeInteger(
    usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens,
  );
  const cacheCreation = nonNegativeInteger(usage.cache_creation_input_tokens);
  const promptTotal = nonNegativeInteger(usage.prompt_tokens ?? usage.input_tokens);
  const freshOverride = reportedAnthropicFreshInputTokens();
  const freshInput = freshOverride === null
    ? Math.max(0, promptTotal - cacheRead)
    : freshOverride;
  const cacheCreationSplit = normalizeAnthropicCacheCreationSplit(
    usage.cache_creation,
    cacheCreation,
  );

  return {
    promptTotal,
    input_tokens: freshInput,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
    cache_creation: cacheCreationSplit,
    skipConfiguredCacheRewrite: true,
  };
}

function buildHybridReportedUsageBasis(body, context = {}, upstreamUsage = {}) {
  if (!anthropicReportedCacheBucketsEnabled()) return null;
  if (reportedAnthropicUsageBasis() !== 'hybrid') return null;

  const upstreamBasis = upstreamReportedUsageBasis(upstreamUsage);
  if (upstreamBasis.cache_read_input_tokens > 0) return upstreamBasis;

  const officialBasis = buildOfficialReportedUsageCandidate(body, context);
  if (!officialBasis || officialBasis.cache_read_input_tokens <= 0) return upstreamBasis;

  const conservativeCreation = Math.min(
    upstreamBasis.cache_creation_input_tokens,
    Number(officialBasis.cache_creation_input_tokens) || 0,
  );
  const freshOverride = reportedAnthropicFreshInputTokens();
  const promptTotal = Math.max(
    Number(officialBasis.promptTotal) || 0,
    (Number(officialBasis.input_tokens) || 0)
      + (Number(officialBasis.cache_read_input_tokens) || 0)
      + (Number(officialBasis.cache_creation_input_tokens) || 0),
  );
  const freshInput = freshOverride === null
    ? Math.max(1, promptTotal - officialBasis.cache_read_input_tokens - conservativeCreation)
    : freshOverride;

  return {
    promptTotal,
    input_tokens: freshInput,
    cache_creation_input_tokens: conservativeCreation,
    cache_read_input_tokens: officialBasis.cache_read_input_tokens,
    cache_creation: scaleAnthropicCacheCreationSplit(
      officialBasis.cache_creation,
      conservativeCreation,
    ),
    skipConfiguredCacheRewrite: true,
  };
}

function upstreamReportedPrefixTokens(usage = {}) {
  const cacheRead = nonNegativeInteger(
    usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens,
  );
  const cacheCreation = nonNegativeInteger(usage.cache_creation_input_tokens);
  return Math.max(cacheRead, cacheCreation);
}

function applyReportedSystemPrefixFloor(anthropicUsage, usage = {}, opts = {}) {
  if (!anthropicReportedCacheBucketsEnabled()) return anthropicUsage;

  const upstreamPrefix = reportedAnthropicIncludeUpstreamPrefix()
    ? upstreamReportedPrefixTokens(usage)
    : 0;
  const extraPrefix = reportedAnthropicExtraPrefixTokens();
  const syntheticRead = opts.reportedCacheScope
    ? readSyntheticTailTokens(opts.reportedCacheScope)
    : 0;
  const prefixFloor = upstreamPrefix + extraPrefix + syntheticRead;
  if (prefixFloor <= 0) return anthropicUsage;

  const currentRead = Number(anthropicUsage.cache_read_input_tokens) || 0;
  const currentCreation = Number(anthropicUsage.cache_creation_input_tokens) || 0;
  const bucket = reportedAnthropicPrefixBucket();
  if (bucket === 'cache_read') {
    const cacheRead = Math.max(currentRead, prefixFloor);
    const reportedTailTokens = nonNegativeInteger(opts.reportedTailTokens);
    const tailCreation = reportedTailTokens > 0
      ? reportedTailTokens
      : Math.max(0, (Number(anthropicUsage.input_tokens) || 0) + currentCreation);
    const cacheCreation = tailCreation;
    if (opts.reportedCacheScope) recordSyntheticTailTokens(opts.reportedCacheScope, cacheCreation);
    return {
      ...anthropicUsage,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreation,
      cache_creation: normalizeAnthropicCacheCreationSplit(anthropicUsage.cache_creation, cacheCreation),
    };
  }
  if (bucket === 'cache_creation') {
    const cacheCreation = Math.max(currentCreation, prefixFloor);
    return {
      ...anthropicUsage,
      cache_creation_input_tokens: cacheCreation,
      cache_creation: scaleAnthropicCacheCreationSplit(anthropicUsage.cache_creation, cacheCreation),
    };
  }
  if (currentRead > 0) {
    return {
      ...anthropicUsage,
      cache_read_input_tokens: Math.max(currentRead, prefixFloor),
    };
  }
  if (currentCreation > 0) {
    const cacheCreation = Math.max(currentCreation, prefixFloor);
    return {
      ...anthropicUsage,
      cache_creation_input_tokens: cacheCreation,
      cache_creation: scaleAnthropicCacheCreationSplit(anthropicUsage.cache_creation, cacheCreation),
    };
  }
  return {
    ...anthropicUsage,
    cache_creation_input_tokens: prefixFloor,
    cache_creation: { ephemeral_5m_input_tokens: prefixFloor, ephemeral_1h_input_tokens: 0 },
  };
}

function buildClientReportedUsageBasis(body) {
  if (!anthropicReportedCacheBucketsEnabled()) return null;
  if (reportedAnthropicUsageBasis() !== 'client') return null;

  const promptTokens = estimateAnthropicClientPromptTokens(body);
  const policy = collectCachePolicy(body, { strip: false });
  const cacheCreation = promptTokens;
  const cacheCreationSplit = policy.has1h
    ? { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cacheCreation }
    : { ephemeral_5m_input_tokens: cacheCreation, ephemeral_1h_input_tokens: 0 };

  return {
    promptTotal: promptTokens,
    input_tokens: promptTokens,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: 0,
    cache_creation: cacheCreationSplit,
  };
}

// Anthropic prompt caching (`cache_control`) — verified spec:
//   - shape: { type: 'ephemeral', ttl?: '5m' | '1h' }, default ttl 5m
//   - placeable on tools[], system[] blocks, messages[].content[] blocks
//   - prefix-cumulative, ordered tools → system → messages
//   - max 4 breakpoints per request
//
// Cascade upstream doesn't speak this dialect — its own caching layer
// reports cacheReadTokens/cacheWriteTokens that already flow through
// chat.js → openAIToAnthropic. We strip the markers before forwarding
// (so they don't leak into Cascade requests) and expose a policy
// summary for downstream stages: TTL hint for the conversation pool,
// 5m vs 1h split attribution in usage.cache_creation.
//
// Returns: { has1h, breakpointCount } describing the request.
function extractCachePolicy(body) {
  return collectCachePolicy(body, { strip: true });
}

// ─── Anthropic → OpenAI request translation ──────────────────

function anthropicToOpenAI(body) {
  const cachePolicy = extractCachePolicy(body);
  const mapAnthropicToolChoice = (toolChoice) => {
    if (!toolChoice || typeof toolChoice !== 'object') return toolChoice;
    if (toolChoice.type === 'auto') return 'auto';
    if (toolChoice.type === 'any') return 'required';
    if (toolChoice.type === 'none') return 'none';
    if (toolChoice.type === 'tool' && toolChoice.name) {
      return { type: 'function', function: { name: toolChoice.name } };
    }
    return toolChoice;
  };
  const pruneToolChoice = (toolChoice, forwardedTools) => {
    if (!toolChoice || !forwardedTools.length) return undefined;
    if (toolChoice.type === 'function') {
      const names = new Set(forwardedTools.map(t => t.function?.name).filter(Boolean));
      return names.has(toolChoice.function?.name) ? toolChoice : undefined;
    }
    return toolChoice;
  };
  const messages = [];
  const toolNameById = new Map();
  if (body.system) {
    const sysText = typeof body.system === 'string'
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map(b => b.text || '').join('\n')
        : '';
    if (sysText) messages.push({ role: 'system', content: sysText });
  }
  for (const m of (body.messages || [])) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (typeof m.content === 'string') {
      messages.push({ role, content: m.content });
    } else if (Array.isArray(m.content)) {
      const textParts = [];
      const imageParts = [];
      const toolCalls = [];
      const toolResults = [];
      for (const block of m.content) {
        if (block.type === 'text') {
          textParts.push(block.text || '');
        } else if (block.type === 'image') {
          imageParts.push(block);
        } else if (block.type === 'thinking') {
          // Thinking blocks from assistant history — skip; the model will regenerate
        } else if (block.type === 'tool_use' && role === 'assistant') {
          const id = block.id || `call_${randomUUID().slice(0, 8)}`;
          toolNameById.set(id, block.name || '');
          toolCalls.push({
            id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
          });
        } else if (block.type === 'tool_result') {
          let content = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map(b => b.text || '').join('\n')
              : JSON.stringify(block.content);
          content = annotateRiskyReadToolResult(content, {
            toolName: toolNameById.get(block.tool_use_id),
            isError: !!block.is_error,
          });
          toolResults.push({ role: 'tool', tool_call_id: block.tool_use_id, content });
        }
      }
      if (toolCalls.length) {
        messages.push({
          role: 'assistant',
          content: textParts.length ? textParts.join('\n') : null,
          tool_calls: toolCalls,
        });
      } else if (imageParts.length) {
        const contentArr = [...imageParts];
        if (textParts.length) contentArr.push({ type: 'text', text: textParts.join('\n') });
        messages.push({ role, content: contentArr });
      } else if (textParts.length) {
        messages.push({ role, content: textParts.join('\n') });
      }
      for (const tr of toolResults) messages.push(tr);
    }
  }
  // Anthropic exposes a growing set of "server-side" tool types where
  // the service itself runs the work and the client only opts in via
  // type. The proxy can't honor any of these (each needs its own stage-2
  // implementation - Cascade-side opus advisor pass, web-search bridge,
  // sandbox code exec). Drop them silently from the OpenAI-shaped tools
  // forwarded upstream; otherwise the upstream model is free to invent
  // a normal function tool_use for "advisor" the client will never get
  // a server_tool_result for.
  const droppedServerTools = [];
  const tools = (body.tools || []).reduce((acc, t) => {
    if (t?.type && SERVER_SIDE_ANTHROPIC_TOOL_TYPES.has(t.type)) {
      droppedServerTools.push(t.type);
      return acc;
    }
    acc.push({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || {},
      },
    });
    return acc;
  }, []);
  if (droppedServerTools.length) {
    log.info(`messages: dropped ${droppedServerTools.length} server-side tool(s) [${[...new Set(droppedServerTools)].join(',')}] - proxy does not implement them yet`);
  }
  const forwardedToolChoice = pruneToolChoice(
    body.tool_choice ? mapAnthropicToolChoice(body.tool_choice) : undefined,
    tools,
  );
  // Claude Code 2.x and Anthropic SDK clients send response shape and
  // reasoning controls inside body.output_config — output_config.effort
  // mirrors OpenAI's reasoning_effort, and output_config.format carries
  // structured-output schemas Anthropic-side instead of OpenAI's
  // response_format. The internal handler speaks OpenAI dialect, so
  // unwrap both here so chat.js sees them on the path it already knows.
  const oc = body.output_config;
  const ocEffort = oc?.effort;
  const ocFormat = oc?.format;
  let translatedResponseFormat = null;
  if (ocFormat?.type === 'json_schema' && ocFormat.schema) {
    translatedResponseFormat = {
      type: 'json_schema',
      json_schema: {
        name: ocFormat.name || 'response',
        schema: ocFormat.schema,
        strict: ocFormat.strict !== false,
      },
    };
  } else if (ocFormat?.type === 'json_object') {
    translatedResponseFormat = { type: 'json_object' };
  }
  return {
    model: body.model || 'claude-sonnet-4.6',
    messages,
    max_tokens: body.max_tokens || 8192,
    stream: !!body.stream,
    ...(tools.length ? { tools } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    ...(body.top_p != null ? { top_p: body.top_p } : {}),
    ...(body.stop_sequences ? { stop: body.stop_sequences } : {}),
    ...(forwardedToolChoice ? { tool_choice: forwardedToolChoice } : {}),
    ...(body.thinking ? { thinking: body.thinking } : {}),
    ...(ocEffort ? { reasoning_effort: ocEffort } : {}),
    ...(translatedResponseFormat ? { response_format: translatedResponseFormat } : {}),
    ...(cachePolicy.breakpointCount > 0 ? { __cachePolicy: cachePolicy } : {}),
  };
}

export { extractCachePolicy };

export function annotateRiskyReadToolResult(content, { toolName = '', isError = false } = {}) {
  if (toolName !== 'Read' || typeof content !== 'string' || !content) return content;
  const lower = content.toLowerCase();
  const isOversizeNoContent = isError
    && /file content \([^)]+\) exceeds maximum allowed size/i.test(content)
    && /use offset and limit parameters/i.test(content);
  // Claude Code Read tool emits real file bodies in "<lineno>\t<line>" form.
  // Stub strings (cached/unchanged/truncated) never use that prefix, so the
  // presence of a line-numbered line means we're looking at actual content
  // and keyword heuristics would only false-positive on user code/comments.
  const looksLikeRealBody = /^\s*\d+\t/m.test(content);
  const isCachedStub = !looksLikeRealBody && (
    /(?:file )?(?:content )?(?:unchanged|cached)/i.test(content)
    || /(?:内容未变更|已缓存)/.test(content)
  ) && content.length < 2000;
  const mentionsTruncation = !looksLikeRealBody
    && /truncated|截断|丢失/.test(lower);
  if (!isOversizeNoContent && !isCachedStub && !mentionsTruncation) return content;

  return `${content}\n\n[WindsurfAPI note: This Read result does not prove the full file body is available in the current conversation. If the task depends on full file contents, use Read with offset/limit or another content-bearing tool result before returning PASS.]`;
}

// ─── OpenAI → Anthropic non-stream response translation ──────

export function openAIToAnthropic(result, model, msgId, opts = {}) {
  const choice = result.choices?.[0];
  const usage = result.usage || {};
  const content = [];
  if (choice?.message?.reasoning_content) {
    content.push({ type: 'thinking', thinking: choice.message.reasoning_content });
  }
  if (choice?.message?.tool_calls?.length) {
    if (choice.message.content) content.push({ type: 'text', text: choice.message.content });
    for (const tc of choice.message.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function?.name || 'unknown',
        input,
      });
    }
  } else if (choice?.message?.content) {
    content.push({ type: 'text', text: choice.message.content });
  }
  if (!content.length) {
    content.push({ type: 'text', text: '' });
  }
  const stopMap = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use' };
  const usageOpts = { ...opts };
  if (reportedAnthropicOutputBasis() === 'response') {
    usageOpts.reportedOutputTokens = estimateAnthropicResponseContentTokens(content);
  }
  return {
    id: msgId,
    type: 'message',
    role: 'assistant',
    content,
    model: model || result.model,
    stop_reason: stopMap[choice?.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: buildAnthropicUsage(usage, usageOpts),
  };
}

// Anthropic's prompt-caching usage shape carries BOTH the legacy flat
// fields (cache_creation_input_tokens, cache_read_input_tokens) AND the
// newer nested split (cache_creation: { ephemeral_5m_input_tokens,
// ephemeral_1h_input_tokens }, GA since 2025-08-18). Emit both so SDK
// callers on either schema see consistent numbers — the flat total
// equals ephemeral_5m + ephemeral_1h. When chat.js doesn't supply a
// split (no cache_control on the request) we attribute the whole
// creation count to the 5m bucket since that's the spec default.
function buildAnthropicUsage(usage, opts = {}) {
  const cacheRead = usage.cache_read_input_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? 0;
  const cacheCreationFlat = usage.cache_creation_input_tokens || 0;
  const split = usage.cache_creation && typeof usage.cache_creation === 'object'
    ? {
        ephemeral_5m_input_tokens: usage.cache_creation.ephemeral_5m_input_tokens || 0,
        ephemeral_1h_input_tokens: usage.cache_creation.ephemeral_1h_input_tokens || 0,
      }
    : { ephemeral_5m_input_tokens: cacheCreationFlat, ephemeral_1h_input_tokens: 0 };
  // v2.0.68 (#118): Anthropic semantics for input_tokens DIFFER from OpenAI.
  // OpenAI: prompt_tokens = freshInput + cacheRead (cached_tokens is a subset).
  // Anthropic: input_tokens = freshInput ONLY; cache_read_input_tokens and
  //            cache_creation_input_tokens are siblings (mutually exclusive).
  // The OpenAI prompt_tokens we receive here already follows the OpenAI
  // convention (chat.js buildUsageBody puts freshInput+cacheRead in
  // prompt_tokens). To get Anthropic's freshInput we subtract the cached
  // subset. Negative values clamp to 0 (defensive against upstream skew).
  const promptTotal = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const freshInput = Math.max(0, promptTotal - cacheRead);
  const anthropicUsage = {
    input_tokens: freshInput,
    output_tokens: opts.reportedOutputTokens ?? usage.completion_tokens ?? usage.output_tokens ?? 0,
    cache_creation_input_tokens: cacheCreationFlat,
    cache_read_input_tokens: cacheRead,
    cache_creation: split,
  };
  if (opts.reportedUsageBasis && typeof opts.reportedUsageBasis === 'object') {
    const basis = typeof opts.reportedUsageBasis.resolve === 'function'
      ? opts.reportedUsageBasis.resolve(usage)
      : opts.reportedUsageBasis;
    if (!basis || typeof basis !== 'object') {
      return applyReportedSystemPrefixFloor(applyAnthropicReportedCacheBuckets(anthropicUsage, {
        promptTotal,
        cacheRead,
      }), usage, opts);
    }
    const basisUsage = {
      ...anthropicUsage,
      input_tokens: Number(basis.input_tokens) || 0,
      cache_creation_input_tokens: Number(basis.cache_creation_input_tokens) || 0,
      cache_read_input_tokens: Number(basis.cache_read_input_tokens) || 0,
      cache_creation: basis.cache_creation || {
        ephemeral_5m_input_tokens: Number(basis.cache_creation_input_tokens) || 0,
        ephemeral_1h_input_tokens: 0,
      },
    };
    if (basis.skipConfiguredCacheRewrite) return applyReportedSystemPrefixFloor(basisUsage, usage, opts);
    return applyReportedSystemPrefixFloor(applyAnthropicReportedCacheBuckets(basisUsage, {
      promptTotal: Number(basis.promptTotal) || Number(basis.input_tokens) || 0,
      cacheRead: Number(basis.cache_read_input_tokens) || 0,
      useBaseRateFloor: false,
    }), usage, opts);
  }
  return applyReportedSystemPrefixFloor(applyAnthropicReportedCacheBuckets(anthropicUsage, {
    promptTotal,
    cacheRead,
  }), usage, opts);
}

function applyAnthropicReportedCacheBuckets(anthropicUsage, { promptTotal = 0, cacheRead = 0, useBaseRateFloor = true } = {}) {
  if (!anthropicReportedCacheBucketsEnabled()) return anthropicUsage;

  const freshOverride = reportedAnthropicFreshInputTokens();
  const rate = reportedAnthropicCacheHitRate();
  const creationRate = reportedAnthropicCacheCreationRate();
  const reportedFresh = freshOverride === null ? anthropicUsage.input_tokens : freshOverride;
  const originalCacheCreation = Number(anthropicUsage.cache_creation_input_tokens) || 0;
  const cacheCreation = Math.floor(originalCacheCreation * creationRate);
  const cacheCreationSplit = scaleAnthropicCacheCreationSplit(
    anthropicUsage.cache_creation,
    cacheCreation,
  );
  const baseTotal = Math.max(
    Number(promptTotal) || 0,
    (Number(anthropicUsage.input_tokens) || 0) + (Number(cacheRead) || 0),
  );
  const rateCacheRead = useBaseRateFloor && rate > 0 ? Math.ceil(baseTotal * rate) : 0;
  const visibleRateCacheRead = cacheReadForVisibleHitRate(reportedFresh, cacheCreation, rate);
  const reportedCacheRead = Math.max(
    Number(anthropicUsage.cache_read_input_tokens) || 0,
    rateCacheRead,
    visibleRateCacheRead,
  );

  return {
    ...anthropicUsage,
    input_tokens: reportedFresh,
    cache_creation_input_tokens: cacheCreation,
    cache_creation: cacheCreationSplit,
    cache_read_input_tokens: reportedCacheRead,
  };
}

// ─── Streaming translator: intercepts OpenAI SSE, emits Anthropic SSE ──

class AnthropicStreamTranslator {
  constructor(res, msgId, model, opts = {}) {
    this.res = res;
    this.msgId = msgId;
    this.model = model;
    this.reportedUsageBasis = opts.reportedUsageBasis || null;
    this.reportedTailTokens = opts.reportedTailTokens || 0;
    this.reportedCacheScope = opts.reportedCacheScope || '';
    this.reportedOutputBasis = opts.reportedOutputBasis || reportedAnthropicOutputBasis();
    this.reportedOutputTokens = 0;
    // Current content block: null | { type, index }
    // type: 'text' | 'thinking' | 'tool_use'
    this.current = null;
    this.blockIndex = 0;
    this.toolCallBufs = new Map();   // index → { id, name, argsBuffered }
    this.finalUsage = null;
    this.stopReason = 'end_turn';
    this.messageStarted = false;
    this.messageStopped = false;
    this.pendingSseBuf = '';
  }

  send(event, data) {
    if (!this.res.writableEnded) {
      this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }

  startMessage() {
    if (this.messageStarted) return;
    this.messageStarted = true;
    this.send('message_start', {
      type: 'message_start',
      message: {
        id: this.msgId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        },
      },
    });
  }

  startBlock(type, extra = {}) {
    this.closeCurrentBlock();
    this.current = { type, index: this.blockIndex };
    let content_block;
    if (type === 'text') content_block = { type: 'text', text: '' };
    else if (type === 'thinking') content_block = { type: 'thinking', thinking: '' };
    else if (type === 'tool_use') content_block = { type: 'tool_use', id: extra.id, name: extra.name, input: {} };
    this.send('content_block_start', {
      type: 'content_block_start',
      index: this.blockIndex,
      content_block,
    });
  }

  closeCurrentBlock() {
    if (!this.current) return;
    this.send('content_block_stop', { type: 'content_block_stop', index: this.current.index });
    this.blockIndex++;
    this.current = null;
  }

  emitTextDelta(text) {
    if (!text) return;
    if (this.reportedOutputBasis === 'response') this.reportedOutputTokens += estimateTextTokens(text);
    if (this.current?.type !== 'text') this.startBlock('text');
    this.send('content_block_delta', {
      type: 'content_block_delta',
      index: this.current.index,
      delta: { type: 'text_delta', text },
    });
  }

  emitThinkingDelta(text) {
    if (!text) return;
    if (this.reportedOutputBasis === 'response') this.reportedOutputTokens += estimateTextTokens(text);
    if (this.current?.type !== 'thinking') this.startBlock('thinking');
    this.send('content_block_delta', {
      type: 'content_block_delta',
      index: this.current.index,
      delta: { type: 'thinking_delta', thinking: text },
    });
  }

  emitToolCallDelta(toolCall) {
    const idx = toolCall.index ?? 0;
    let existing = this.toolCallBufs.get(idx);
    const id = toolCall.id || existing?.id;
    const name = toolCall.function?.name || existing?.name;
    const argsChunk = toolCall.function?.arguments || '';

    if (!existing) {
      existing = { id, name, blockIndex: null, argsBuffered: '', pendingArgs: '' };
      this.toolCallBufs.set(idx, existing);
    } else {
      if (id) existing.id = id;
      if (name) existing.name = name;
    }
    const buf = this.toolCallBufs.get(idx);
    if (buf.blockIndex == null && buf.id && buf.name) {
      this.startBlock('tool_use', { id: buf.id, name: buf.name });
      buf.blockIndex = this.current.index;
      if (buf.pendingArgs) {
        const pending = buf.pendingArgs;
        buf.pendingArgs = '';
        buf.argsBuffered += pending;
        this.send('content_block_delta', {
          type: 'content_block_delta',
          index: buf.blockIndex,
          delta: { type: 'input_json_delta', partial_json: pending },
        });
      }
    }
    if (argsChunk) {
      if (buf.blockIndex == null) {
        buf.pendingArgs += argsChunk;
        return;
      }
      buf.argsBuffered += argsChunk;
      this.send('content_block_delta', {
        type: 'content_block_delta',
        index: buf.blockIndex,
        delta: { type: 'input_json_delta', partial_json: argsChunk },
      });
    }
  }

  processChunk(chunk) {
    if (chunk.error) {
      this.error(chunk.error);
      return;
    }
    this.startMessage();
    const choice = chunk.choices?.[0];
    if (choice) {
      const delta = choice.delta || {};
      if (delta.reasoning_content) this.emitThinkingDelta(delta.reasoning_content);
      if (delta.content) this.emitTextDelta(delta.content);
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) this.emitToolCallDelta(tc);
      }
      if (choice.finish_reason) {
        const stopMap = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use' };
        this.stopReason = stopMap[choice.finish_reason] || 'end_turn';
      }
    }
    if (chunk.usage) this.finalUsage = chunk.usage;
  }

  finish() {
    if (this.messageStopped) return;
    this.messageStopped = true;
    // Ensure message_start is always sent — when the upstream stream
    // fails before any content arrives (e.g. cascade immediate error,
    // new-api timeout), Claude Code still expects a complete event
    // sequence. Without this, the client sees message_delta + stop
    // with no preceding start and reports "Content block not found".
    if (!this.messageStarted) this.startMessage();
    this.closeCurrentBlock();
    const u = this.finalUsage || {};
    this.send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: this.stopReason, stop_sequence: null },
      usage: buildAnthropicUsage(u, {
        reportedUsageBasis: this.reportedUsageBasis,
        reportedTailTokens: this.reportedTailTokens,
        reportedCacheScope: this.reportedCacheScope,
        ...(this.reportedOutputBasis === 'response'
          ? { reportedOutputTokens: Math.max(1, this.reportedOutputTokens) }
          : {}),
      }),
    });
    this.send('message_stop', { type: 'message_stop' });
  }

  error(err) {
    if (this.messageStopped) return;
    this.messageStopped = true;
    this.closeCurrentBlock();
    this.send('error', {
      type: 'error',
      error: {
        type: err?.type || 'api_error',
        message: err?.message || 'Upstream stream error',
      },
    });
  }

  // SSE parser — handleChatCompletions writes `data: {...}\n\n` frames;
  // accumulate and flush each complete frame as a translated event.
  feed(rawChunk) {
    this.pendingSseBuf += typeof rawChunk === 'string' ? rawChunk : rawChunk.toString('utf8');
    let idx;
    while ((idx = this.pendingSseBuf.indexOf('\n\n')) !== -1) {
      const frame = this.pendingSseBuf.slice(0, idx);
      this.pendingSseBuf = this.pendingSseBuf.slice(idx + 2);
      const lines = frame.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') continue;
        try {
          this.processChunk(JSON.parse(payload));
        } catch (e) {
          log.warn(`Messages SSE parse error: ${e.message}`);
        }
      }
    }
  }
}

// ─── Fake ServerResponse that pipes writes into the translator ──

function createCaptureRes(translator, realRes) {
  const listeners = new Map();
  const fire = (event) => {
    const cbs = listeners.get(event) || [];
    for (const cb of cbs) { try { cb(); } catch {} }
  };
  return {
    writableEnded: false,
    headersSent: false,
    writeHead() { this.headersSent = true; },
    write(chunk) {
      // chat.js writes SSE heartbeat comments (`: ping\n\n`) every 15s
      // while Cascade is slow-polling its trajectory. The translator
      // only parses `data:` lines, so pings are silently dropped —
      // leaving the real Anthropic stream quiet for minutes until a
      // CDN/proxy/client decides the connection is dead and bails. Pass
      // heartbeat comments straight through so Claude Code stays happy.
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (str.startsWith(':') && realRes && !realRes.writableEnded) {
        try { realRes.write(str); } catch {}
      }
      translator.feed(chunk);
      return true;
    },
    end(chunk) {
      if (this.writableEnded) return;
      if (chunk) translator.feed(chunk);
      translator.finish();
      this.writableEnded = true;
      fire('close');
    },
    // Fire 'close' without marking writableEnded=true so chat.js's
    // close handler sees an un-ended stream and triggers its abort path.
    _clientDisconnected() { fire('close'); },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
    once(event, cb) {
      const self = this;
      const wrapped = function onceWrapper() {
        self.off(event, wrapped);
        cb.apply(self, arguments);
      };
      return self.on(event, wrapped);
    },
    off(event, cb) {
      const arr = listeners.get(event);
      if (arr) {
        const idx = arr.indexOf(cb);
        if (idx !== -1) arr.splice(idx, 1);
      }
      return this;
    },
    removeListener(event, cb) { return this.off(event, cb); },
    emit() { return true; },
  };
}

// ─── Main entry ───────────────────────────────────────────────

export async function handleMessages(body, context = {}) {
  const msgId = genMsgId();
  const requestedModel = body.model || 'claude-sonnet-4.6';
  const wantStream = !!body.stream;
  const chatHandler = context.handleChatCompletions || handleChatCompletions;
  // Augment callerKey with the per-user tag from metadata.user_id when
  // present so the cascade pool can isolate concurrent Claude Code users
  // sharing one API key. Bare API-key callers and other client SDKs that
  // do not send metadata.user_id keep the original callerKey unchanged.
  const subKey = extractCallerSubKey(body);
  const effectiveContext = subKey
    ? { ...context, callerKey: `${context.callerKey || ''}:user:${subKey}` }
    : context;
  const reportedUsageRequestBody = reportedAnthropicUsageBasis() === 'hybrid'
    ? structuredClone(body)
    : body;
  const reportedUsageBasis = buildOfficialReportedUsageBasis(reportedUsageRequestBody, effectiveContext)
    || buildClientReportedUsageBasis(reportedUsageRequestBody)
    || (reportedAnthropicUsageBasis() === 'hybrid'
      ? { resolve: usage => buildHybridReportedUsageBasis(reportedUsageRequestBody, effectiveContext, usage) }
      : null);
  const reportedTailTokens = estimateAnthropicClientTailTokens(reportedUsageRequestBody);
  const reportedScope = reportedCacheScope(reportedUsageRequestBody, effectiveContext);
  const outputBasis = reportedAnthropicOutputBasis();
  const openaiBody = anthropicToOpenAI(body);

  if (!wantStream) {
    const result = await chatHandler({
      ...openaiBody,
      stream: false,
      __route: 'messages',
      __skipReportedUsageOverrides: anthropicReportedCacheBucketsEnabled(),
    }, effectiveContext);
    if (result.status !== 200) {
      return {
        status: result.status,
        body: {
          type: 'error',
          error: {
            type: result.body?.error?.type || 'api_error',
            message: result.body?.error?.message || 'Unknown error',
          },
        },
      };
    }
    return {
      status: 200,
      body: openAIToAnthropic(result.body, requestedModel, msgId, {
        reportedUsageBasis,
        reportedTailTokens,
        reportedCacheScope: reportedScope,
      }),
    };
  }

  // Streaming path — ask handleChatCompletions for its streaming handler and
  // point its writes at our translator shim. This lets the upstream Cascade
  // poll loop drive the downstream SSE in real time — no buffer-then-replay.
  const streamResult = await chatHandler({
    ...openaiBody,
    stream: true,
    __route: 'messages',
    __skipReportedUsageOverrides: anthropicReportedCacheBucketsEnabled(),
  }, effectiveContext);

  if (!streamResult.stream) {
    // The OpenAI path returned a non-stream error (e.g. 403 model_not_entitled)
    return {
      status: streamResult.status || 502,
      body: {
        type: 'error',
        error: {
          type: streamResult.body?.error?.type || 'api_error',
          message: streamResult.body?.error?.message || 'Upstream error',
        },
      },
    };
  }

  return {
    status: 200,
    stream: true,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
    async handler(realRes) {
      const translator = new AnthropicStreamTranslator(realRes, msgId, requestedModel, {
        reportedUsageBasis,
        reportedTailTokens,
        reportedCacheScope: reportedScope,
        reportedOutputBasis: outputBasis,
      });
      const captureRes = createCaptureRes(translator, realRes);

      // Forward client disconnect so the upstream cascade is cancelled.
      // We don't call captureRes.end() here — that would set writableEnded=true
      // and suppress the abort path inside chat.js's stream handler.
      realRes.on('close', () => {
        if (!captureRes.writableEnded) captureRes._clientDisconnected();
      });

      try {
        await streamResult.handler(captureRes);
      } catch (e) {
        log.error(`Messages stream error: ${e.message}`);
        translator.error({ type: 'api_error', message: e.message });
      }

      if (!realRes.writableEnded) realRes.end();
    },
  };
}
