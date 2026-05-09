# Progress

## 2026-05-08

- Created working plan for simplifying HA into passive routing plus dynamic proxy maintenance.
- Recorded git-history findings: active Claude probes are historically known to burn quota, and max account attempts had previously been raised from 3 to 10.
- Changed backend defaults to `passive_strong`: no request probe, no background Claude model probe, fast switch up to 9 switches / 10 accounts.
- Kept dynamic proxy maintenance active even when availability model worker is disabled; saving availability/dynamic-proxy config now triggers a maintenance reschedule.
- Simplified Dashboard copy and primary fields around passive routing and dynamic proxy auto-rotation; moved low-level HA knobs into an advanced `<details>` section.
- Added worker regression coverage: dynamic proxy maintenance failure while model probing is disabled no longer leaves the worker stuck.
- Verification passed: targeted `node --check`, dashboard non-module script parse check, `node --test test/availability-router.test.js test/availability-worker.test.js test/runtime-config-sqlite.test.js test/sqlite-persistence.test.js`, and `git diff --check`.
- Verified previous Claude claims around `conversation-pool.js` were not supported by git diff; current work focuses on real Cascade reuse diagnostics and TTFT, not CCTest-only usage cosmetics.
- Removed the `hybrid_max` / cross-caller report cache scope direction after user clarified real usage must be prioritized.
- Added runtime-config support for Cascade polling env keys.
- Added adaptive Cascade polling (`fast` then `mid` then base interval), call-time env reads, and `Cascade done` timing fields: `firstTextTotalMs`, `warmupMs`, `openMs`, `promptBuildMs`, `sendMs`, `pollMs`.
- Added `fingerprintDebug()` and reuse MISS detail logs with hash-only summaries for system/tools/caller/history drift.
- Verification passed: `node --check src/client.js src/handlers/messages.js src/runtime-config.js` (run as separate checks), targeted Messages API cache tests, polling tests, `test/runtime-config-sqlite.test.js`, and `git diff --check`.
- Added Dashboard-backed runtime env overrides at `/dashboard/api/settings/env`, including cache reporting, Cascade reuse hash, and polling knobs; empty values clear SQLite overrides and delete the live `process.env` key.
- Added a Dashboard API test proving `WINDSURFAPI_ANTHROPIC_REPORTED_FRESH_INPUT_TOKENS` can be set and cleared through the runtime env endpoint.
- Added `projectedHashAfter` / `projectedTurnsAfter` to Cascade reuse checkin logs so tool-call chain mismatches can be compared directly with the next request's `projectedHash`.
- Verification passed: `node --check src/dashboard/api.js && node --check src/handlers/chat.js`, `node --test test/dashboard-api.test.js test/runtime-config-sqlite.test.js test/chat-reuse.test.js test/conversation-pool.test.js`, and `git diff --check`.
- Known verification gap: `node --test test/dashboard-syntax.test.js test/check-i18n.test.js` still fails in `check-i18n` because the existing dashboard has many pre-existing hardcoded Chinese strings unrelated to this change; the inline-script syntax checks pass.
- Added `/dashboard/api/service/restart` plus default/sketch Dashboard buttons in the runtime env panel. The route requires `{ confirm: true }`, stops the LS pool with `stopLanguageServerAndWait`, then exits so Docker/PM2 can restart the API and reload persisted config.
- Verification passed for restart UI/API: `node --check src/dashboard/api.js`, `node --test test/dashboard-api.test.js`, `node --test test/dashboard-syntax.test.js`, and `git diff --check`.
- Fixed Cascade reuse fingerprinting for multi-tool continuations: `priorTurnsForBefore()` now drops a contiguous trailing group of `tool` messages instead of only the last tool result, so `assistant tool_calls -> tool results` can round-trip through fpAfter/fpBefore.
- Verification passed for the reuse fix: `node --check src/conversation-pool.js`, `node --test test/conversation-pool.test.js`, `node --test test/chat-reuse.test.js`, and `git diff --check`.
- Added assistant tool_call argument shape normalization for nested `function.arguments`, top-level `arguments`, top-level `argumentsJson`, and `input`, matching common OpenAI-compatible client history variants.
- Made `cleanupOrphanLanguageServers()` skip quietly when `ps` is absent in Alpine/minimal containers, removing startup WARN noise without changing LS startup.
- Verification passed: `node --check src/conversation-pool.js`, `node --check src/langserver.js`, `node --test test/conversation-pool.test.js test/chat-reuse.test.js`, and `git diff --check`.

## 2026-05-09

- Analyzed the latest CCTest run: first-token capture is faster in the new logs, but one request hit a real Cascade cold stall (`75s active without any text/tool`) and stream retry stopped after one account because the stall exceeded the fast-switch budget.
- Changed stream retry gating so `transient_stall` can switch accounts once by default even after the fast-switch time budget elapsed; non-transient errors remain budget-bound. The cap can be adjusted with `WINDSURFAPI_TRANSIENT_STALL_SWITCH_MAX_ATTEMPTS`.
- Fixed a remaining tool-chain reuse mismatch: assistant turns with `tool_calls` now ignore unstable assistant narration in the fingerprint, matching clients that replay the same tool_calls with `content: ""` or `null`. Normal assistant text turns still hash text strictly.
- Added hash-only `projectedTail` diagnostics to reuse MISS/checkin logs so future mismatches can compare recent projected roles, text hashes, tool names/args hashes, and tool-result hashes without leaking prompt content.
- Verification passed: `node --check src/conversation-pool.js`, `node --check src/handlers/chat.js`, `node --test test/conversation-pool.test.js test/chat-reuse.test.js`, and `git diff --check`.
- Analyzed the latest CCTest/new-api run: `cache_read` around `4401` is an upstream Cascade stable-prefix read, not a cumulative sum of prior writes. High multiplier is still mostly from large prompt/tool tails being written and remaining reuse misses, not from the Dashboard config failing to apply.
- Fixed the stream rate-limit burst crash from the log (`context is not defined`) by threading request context into `streamResponse()` via deps and using a local `requestContext` alias. Added a static regression guard to prevent future bare `context.__...` references inside the top-level stream helper.
- Verification passed for the stream context fix: `node --check src/handlers/chat.js`, `node --test test/stream-cache-policy.test.js test/stream-error.test.js test/stream-stall.test.js test/stream-pool-exhausted-error.test.js`, and `node --test test/chat-reuse.test.js test/conversation-pool.test.js`.
- Reviewed the 19:15 CCTest retry: input reporting remains correct at 570, `context is not defined` is gone, rate-limit rotation works, and first-text timing is generally improved; however tool-chain reuse still misses because client replay collapses multi-tool assistant turns to a single `tool_use` and tool argument hashes drift.
- Added `CASCADE_REUSE_HASH_TOOL_ARGS` to optionally ignore tool-call argument values in reuse fingerprints for single-user/CCTest hit-rate tuning, and `CASCADE_REUSE_SINGLE_TOOL_ALIAS` to write additional pool aliases for clients that replay only one tool call from a multi-call assistant turn.
- Exposed both new reuse knobs in runtime config and the Dashboard; added targeted tests for argument-drift reuse and single-tool alias fingerprints.
- Verification passed: `node --check src/conversation-pool.js`, `node --check src/handlers/chat.js`, `node --check src/runtime-config.js`, `node --test test/conversation-pool.test.js test/chat-reuse.test.js`, `node --test test/dashboard-api.test.js test/runtime-config-sqlite.test.js test/dashboard-syntax.test.js`, `node --test test/stream-cache-policy.test.js test/stream-error.test.js test/stream-stall.test.js test/stream-pool-exhausted-error.test.js`, and `git diff --check`.

## 2026-05-10

- Started CCTest target hit-rate write-floor work: add Dashboard/runtime env knobs so `cache_read` mode can keep large read while automatically padding `cache_creation` toward a configured visible hit rate.
- Implemented `WINDSURFAPI_ANTHROPIC_REPORTED_CACHE_TARGET_HIT_RATE` and `WINDSURFAPI_ANTHROPIC_REPORTED_CACHE_TARGET_WRITE_FLOOR`, exposed both in Dashboard runtime env, and added regression tests.
- Verification passed: `node --check src/handlers/messages.js`, `node --check src/runtime-config.js`, `node --test test/messages.test.js`, `node --test test/runtime-config-sqlite.test.js`, `node --test test/dashboard-syntax.test.js`, and `git diff --check`. `test/check-i18n.test.js` still fails only on pre-existing hardcoded Chinese in Dashboard.
- Hot-copied changes into local Docker and verified new-api logs: first request reported `prompt_tokens=1`, `cache_tokens=20000`, `cache_write_tokens=2222`; second request reported `cache_tokens=22222`, `cache_write_tokens=2469`, matching ~90% target hit-rate math.
