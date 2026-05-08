# Progress

## 2026-05-08

- Created working plan for simplifying HA into passive routing plus dynamic proxy maintenance.
- Recorded git-history findings: active Claude probes are historically known to burn quota, and max account attempts had previously been raised from 3 to 10.
- Changed backend defaults to `passive_strong`: no request probe, no background Claude model probe, fast switch up to 9 switches / 10 accounts.
- Kept dynamic proxy maintenance active even when availability model worker is disabled; saving availability/dynamic-proxy config now triggers a maintenance reschedule.
- Simplified Dashboard copy and primary fields around passive routing and dynamic proxy auto-rotation; moved low-level HA knobs into an advanced `<details>` section.
- Added worker regression coverage: dynamic proxy maintenance failure while model probing is disabled no longer leaves the worker stuck.
- Verification passed: targeted `node --check`, dashboard non-module script parse check, `node --test test/availability-router.test.js test/availability-worker.test.js test/runtime-config-sqlite.test.js test/sqlite-persistence.test.js`, and `git diff --check`.
