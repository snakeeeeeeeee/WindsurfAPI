# Findings

## Strong Availability Baseline

- `availability-router.js` stores `model_health` as a recency-capped array and `getPreferredHealthyAccountIds()` returns simple recency order.
- `auth.getApiKey()` already consults preferred healthy IDs before inflight/quota/RPM/LRU, so scoring can be introduced without changing the public account acquisition contract.
- `availability-worker.js` currently rotates account batches and probes selected models sequentially until one success; it does not target a minimum hot-pool size per model.
- Chat paths already record successful accounts and rate-limit events for stream and non-stream, but request cold-start probing and strict fast-switch budgets are not explicit yet.
- Runtime availability config has a field allowlist in `setAvailabilityRuntimeConfig`; new Dashboard/env knobs must be added there or they silently fall back to defaults.
- Existing Redis `model_health` can be upgraded in place to scored hot-pool entries because old rows only need `accountId`, `modelKey`, and `lastSuccessAt` to normalize.

## SQLite Persistence Baseline

- `config.dataDir` is shared `/data` in Docker unless `REPLICA_ISOLATE=1`; compose mounts `./.docker-data/data:/data`.
- JSON persistence is synchronous today, so a synchronous SQLite wrapper can minimize call-site churn.
- Dockerfile uses `node:20-bookworm-slim`; Node 20 has no `node:sqlite`. Local Node 22.17.1 does have `node:sqlite`.
- Existing tests can hang under full `npm test`; focused checks are required.

- Account objects contain secrets and nested mutable state (`refreshToken`, `userStatus`, `capabilities`, `credits`, `blockedModels`), so SQLite phase 1 should persist an exact JSON snapshot and not normalize deeply.
- `runtime-config.js`, `proxy-config.js`, `model-access.js`, and `stats.js` load at import time; `src/db.js` must avoid importing any of them to prevent cycles.

- Tests that import runtime-config/dashboard modules need a temp `WINDSURFAPI_SQLITE_PATH` set before dynamic import, otherwise they create a repo-root `windsurfapi.sqlite`; updated affected focused tests accordingly.
- Node emits `ExperimentalWarning` for `node:sqlite`; this is expected on the current Node 22 runtime.
