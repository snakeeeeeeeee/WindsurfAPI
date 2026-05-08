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
