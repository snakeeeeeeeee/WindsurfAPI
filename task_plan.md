# WindsurfAPI Strong Availability / Low Latency Plan

## Goal

Turn account selection from request-time discovery into model-level hot-pool routing: keep known-good accounts warm per tracked model, choose them quickly for user requests, and fail over or return 429 without long waits when a model is unavailable.

## Phases

- [complete] Inspect current HA router, worker, request paths, and dashboard state
- [complete] Add scored hot-pool config, scoring, snapshots, and preferred-account APIs
- [complete] Make worker fill hot-pool deficits and prioritize weak models
- [complete] Add request-path cold-start probes, fast switch budgets, and breaker short-circuit behavior
- [complete] Add Dashboard hot-pool/score/worker visibility and config controls
- [complete] Run focused syntax and targeted tests

## Decisions

- Keep Redis as short-lived hot-pool/CD/breaker state and SQLite as long-term history/config.
- Do not race the real user prompt across multiple accounts.
- Allow small probe prompts to burn a few cheap accounts for faster routing.
- Default request probe: enabled, concurrency 3, budget 2000ms.
- Default fast switch: 2 account switches, total 3000ms.
- Default hot pool: min 5, max 30, fresh window 10 minutes.

## Verification Rule

Avoid full `npm test`. Use `node --check`, direct `node --test test/file.test.js`, dashboard script syntax checks, and `git diff --check`.

## Errors Encountered

| Error | Attempt | Resolution |
|---|---|---|
| `availability-router.test.js` expected hot-pool target 2 but got default 5 | 1 | Added new hot-pool/request-probe config fields to runtime-config persistence allowlist |
