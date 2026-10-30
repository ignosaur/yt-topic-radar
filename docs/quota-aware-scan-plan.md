# Quota-aware scans

## Problem and context
Top 3 scans can return fewer results when candidate processing fails. The historical two-video digest predates bounded backfill; a later live probe found Gemini quota exhaustion, but did not prove the historical provider error. Search returned 20 eligible candidates. Both server and standalone pipelines must handle provider failures and synthesis.

## Goal, scope and constraints
Preserve the previous digest on provider-wide quota or rate-limit failure, stop futile replacements, and explain ordinary partial results. Cover both scan paths, fallback, UI and generated extension. Use Bun, isolated stores and mock providers; never persist or expose raw provider errors or credentials. Retain model chain, ranking and two-replacement cap.

## Work and definitions of done
- [x] Classify quota, throttling and ambiguous errors; preserve bounded model fallback. DoD: mocked error-shape, retry and mixed-failure tests pass with sanitized outputs.
- [x] Propagate provider-wide failures through both scan paths and synthesis. DoD: previous digest, metrics and seen IDs remain intact; locks release; server seen writes happen only after digest save.
- [x] Persist partial-scan counts and stopping reason, show actionable messages, support old digests. DoD: boundary tests and UI checks pass; production extension rebuilt.
- [x] Verify with focused tests, contract and lifecycle suites, isolated self-checks and ripwire gates. DoD: failures and environmental blockers recorded below; independent review findings resolved or documented.
- [ ] Verify a fresh Top 3 live scan separately when quota allows. DoD: inspect saved result and counts; do not equate mocked tests with live success.

## Evidence and progress
- Prior read-only search found 20 eligible videos; a Gemini call returned 429. Historical digest lacks the failed-video reason.
- Prior baseline: focused backfill and engine tests passed; combined contract suite had a setup timeout in the sandbox.
- Implementation in progress. Live success not yet verified.

## Verification log (30 October 2026)
- Implemented provider classification, bounded fallback, fatal error propagation in both scan paths, deferred server seen writes, partial diagnostics, dashboard messages and production extension build. Independent review identified mixed-provider failure handling, which was corrected and covered by tests.
- Focused provider, backfill, server-route, standalone and parser tests: 32 passed. Topic lifecycle/parser: 23 passed. Contract suite: 7 passed outside sandbox; sandbox run timed out in server setup. TTS utility tests: 5 passed. Isolated self-checks and extension build passed.
- Ripwire quality-delta returned exit 2: complexity increases for fallback and standalone scan (also generated extension), plus server scan churn. Test-gate returned exit 4, reporting 11 untested impacted symbols including standalone routing and generated extension/background surfaces. These are non-green gates; do not interpret them as passing.
- Live Top 3 acceptance is not verified. Earlier probe returned a Gemini quota 429; no further live scan was run.
- One self-check was inadvertently run against the default store before rerunning in isolation. It increments the stored timestampClicks metric by one and removes its temporary metadata key; it does not intentionally change digests.

- Final focused rerun after review fixes: 30 passed; production extension rebuilt; git diff --check passed. Independent review findings on mixed failure propagation and UI messaging were corrected.
- Follow-up review: verified mixed 503 then 400 produced a replaceable error; corrected classification and added provider, server-route, and standalone regression tests. Focused rerun: 33 passed; extension rebuilt; diff check passed. Ripwire quality and test gates remain non-green; live Top 3 remains unverified.
