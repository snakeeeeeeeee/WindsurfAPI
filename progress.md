# Progress Log

## 2026-05-08 Strong Availability / Low Latency

- Started implementation of scored per-model hot pools, worker refill behavior, fast request routing, and Dashboard visibility.
- Current HA baseline already has Redis cooldowns, model breakers, worker probes, simple healthy account lists, and account availability summaries.
- This phase must preserve prior SQLite persistence work and avoid reverting existing uncommitted changes.
- Added scored hot-pool records on top of existing Redis model health, with latency/success/failure/rate-limit fields and Dashboard snapshots.
- Updated auth account selection to rank by scored hot-pool order before existing inflight/quota/RPM/LRU rules.
- Updated availability worker to prioritize hot-pool deficits, probe non-hot candidates first, and run bounded concurrent model probes.
- Added request cold-start probing with small prompts, request-specific probe concurrency/budget, and fast-switch attempt/budget limits.
- Dashboard now exposes hot-pool config, request probe config, model hot-pool table, worker hot-pool deficit, account score/latency/error details.
- Verification passed: syntax checks for availability router/worker/chat/runtime-config/dashboard API, dashboard script parse, availability-router test, availability-worker test, git diff --check.

## 2026-05-07 SQLite Persistence

- Started implementation of SQLite persistence plan.
- Confirmed Docker currently uses Node 20, while local Node 22 supports `node:sqlite`; Docker baseline must move to Node 22.
- Confirmed current long-lived JSON stores:
  - `accounts.json` in `src/auth.js`
  - `runtime-config.json` in `src/runtime-config.js`
  - `proxy.json` in `src/dashboard/proxy-config.js`
  - `model-access.json` in `src/dashboard/model-access.js`
  - `stats.json` in `src/dashboard/stats.js`
- Confirmed `/data` is already persisted by docker compose.

- Finished persistence API inspection. Account persistence should keep the current full object snapshot while indexing id/apiKey/email/status/tier/method for dashboard/routing queries.
- Runtime config must preserve the existing `_rawState.availability` behavior so env defaults apply until the dashboard saves availability settings.

- Implemented SQLite persistence (`src/db.js`) with migrations, WAL, one-time JSON import, KV config helpers, account snapshots, and availability history tables.
- Switched `auth.js`, `runtime-config.js`, proxy config, model access, and stats to SQLite as durable source of truth.
- Added worker/probe/health history recording and updated default tracked probe models to the exact Claude list requested.
- Updated Dockerfile to Node 22, compose/env docs for `/data/windsurfapi.sqlite`, and README/dashboard wording from runtime-config.json to SQLite.
- Verification passed: `node --check` for affected modules/tests, `node --test test/sqlite-persistence.test.js`, `test/availability-router.test.js`, `test/availability-worker.test.js`, `test/audit-fixes.test.js`, `test/dashboard-syntax.test.js`, `test/credentials-runtime.test.js`, `test/dashboard-api.test.js`, and `git diff --check`.
