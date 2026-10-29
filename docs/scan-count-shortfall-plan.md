# Implementation Plan — Scan count shortfall (KISS/YAGNI)

> Fix for "requested 3 videos, got 2" (`Personal Finance India`,
> digest `2026-10-29T03:56:42.946Z`). The filter and count config were fine:
> one ranked candidate failed during summarization, `runScan` skipped it with no
> replacement (`server.ts:94-107`), and only successes were saved
> (`server.ts:121-127`) with no persisted skip reason. This plan adds the
> smallest backfill + a persisted request/skip record.

## Diagnosis (one paragraph)

`searchAndFilterTopicWithStats` slices to the top N before any attempt
(`lib/youtube.ts:205-207`), so a failed candidate has no standby. The loop then
swallows the error and saves what succeeded. `skippedVideos` is returned over
HTTP (`server.ts:137`) but is not in `TopicDigest` (`lib/summarizer.ts:38-44`),
so after reload the shortfall is invisible. Fix: attempt the next ranked
candidate until N successes (bounded), and store `requestedCount` +
`skippedVideos` in the digest.

## 0. Principles

- **KISS** — one loop change, one additive API field, one UI line. Reuse the
  existing ranked results; no new retry engine, no refactor of `runScan`, no new
  storage layer.
- **YAGNI** — no injectable dependencies, no per-video retry loop, no global
  scan deadline, no telemetry/metric schema changes, no error-redaction
  framework, no rank re-sort (attempt order is already rank order).
- **Anthropic, "Building Effective Agents"** — simplest solution that works,
  predefined workflow, ground truth at each step, guardrail on cost.
  Applied: a hard attempt cap bounds Gemini spend; tests use an isolated
  `RADAR_STORE_PATH`; the persisted digest is the ground truth after reload.

## 1. Success criteria

1. `maxVideos=3`, 2nd-ranked candidate fails → digest has **3** summaries
   (ranks 1, 3, 4) with `requestedCount: 3` and one `skippedVideos` entry.
2. `maxVideos=3`, backfill exhausted (or cap hit) → digest keeps the successes,
   and toast/header say `X of 3 · Y skipped`; no silent shortfall.
3. No failures → exactly 3 summaries and exactly 3 `summarize` calls.
4. Zero successes → existing `502` behavior, no digest overwrite.
5. Old digests/backups without the new fields still load and render.
6. Both shells behave identically; existing test suites stay green.

## 2. Non-goals

- No search/anti-slop/duration changes.
- No whole-video retry (Gemini already has 4-model fallback + 35 s timeout).
- No scan deadline, search timeout, client abort, queueing, or 409 changes —
  that is `docs/external-call-protection-audit.md`.
- No `runScan` dependency-injection refactor, no new metric keys, no schema
  migration, no CORS changes, no new dependencies.

## 2a. Constraints (hard limits — any violation needs reporter sign-off)

- **Tooling:** Bun-only (`bun run`, `bun test`); no npm/node/python, no dotenv;
  tests use an isolated `RADAR_STORE_PATH` temp store.
- **API compatibility:** new digest fields are additive/optional; existing
  response fields keep their names and shapes; `candidates` and
  `slopFilteredCount` behavior is unchanged for CLI and old clients.
- **Quota:** at most `MAX_REPLACEMENTS = 2` extra Gemini attempts per scan;
  never fall back to the entire ranked pool. Stop immediately at `requested`
  successes.
- **Scope:** only Steps 0–2. Search timeout, scan deadline, client abort,
  queueing, RSS, and 409 work remain in `docs/external-call-protection-audit.md`.
- **Single-flight:** `runScan` stays entirely inside the existing owner lock;
  no new `await` between the lock check and set; every early return (including
  the 502 paths) releases it via the existing `finally`.
- **Hanging calls:** no new network call may block the scan without the
  existing per-call protection; a failed candidate is skipped, never allowed
  to fail the whole scan.
- **Secrets/state:** skip reasons truncated to ≤200 chars; never log the Gemini
  key; never commit `.env.local` or `.local-radar-store.json`.
- **Extension parity:** never hand-edit `extension/`; the only accepted diff is
  `bun run build:ext` output (byte-identical to `ui/`).
- **No widening of the CORS allowlist** (`server.ts` localhost +
  `chrome-extension://` only) and no new HTTP routes.
- **No new dependencies**; no storage-schema migration; no backup format change.
- **Latency:** zero added calls on the happy path; backfill starts only after a
  failure and is bounded by the quota cap.

## 3. Work breakdown

### Step 0 — Return the ranked pool (`lib/youtube.ts`)

- Add `rankedPool: VideoCandidate[]` to the return of
  `searchAndFilterTopicWithStats` (all sorted filter passers).
  `candidates` stays `rankedPool.slice(0, maxResults)`; `slopFilteredCount`
  formula unchanged.
- **Gate:** self-checks + parser guard green; CLI output unchanged.

### Step 1 — Bounded backfill + persisted skips (`lib/youtube.ts`, `lib/summarizer.ts`, `server.ts`)

- Add one small helper in `lib/youtube.ts`:
  ```ts
  const MAX_REPLACEMENTS = 2;
  async function collectWithBackfill<T>(
    rankedPool: VideoCandidate[], requested: number,
    process: (v: VideoCandidate) => Promise<T>
  ): Promise<{ results: T[]; skipped: { videoId: string; title: string; reason: string }[] }>
  ```
  Iterate `rankedPool` in order, stop at `requested` results, stop after
  `requested + MAX_REPLACEMENTS` attempts, push `{ videoId, title,
  reason: msg.slice(0, 200) }` on throw. Natural order = rank order.
- `TopicDigest` gains two optional fields:
  `requestedCount?: number`, `skippedVideos?: { videoId; title; reason }[]`.
- `runScan` replaces its `for` loop with `collectWithBackfill(candidatesPool,
  maxVideos, …)` (where the pool is the new `rankedPool`); save
  `requestedCount: maxVideos` and `skippedVideos` when non-empty. Keep the 502
  path and metrics logic unchanged. Log one line:
  `[scan] requested=3 summarized=3 skipped=1`.
- **Gate:** unit tests for the helper (§4) + existing contract tests green.

### Step 2 — Surface it in the UI (`ui/digest.js` → `bun run build:ext`)

- Toast uses the digest: `Summarized 3 videos (1 skipped & replaced)` or
  `Summarized 2 of 3 videos (1 skipped)`.
- One muted line in the synthesis card header when `skippedVideos` is non-empty:
  `X of N summarized · Y skipped`. No modal, no new component.
- **Gate:** manual check in bun tab + extension panel; `diff ui/ extension/`
  clean after `bun run build:ext`.

## 4. Test plan

| Test | Where | Notes |
|---|---|---|
| Backfill: rank-2 fails → results are ranks 1,3,4; one skip recorded | `tests/scan-backfill.test.ts` (new) | Fake `process` callback, no network |
| Cap: more than 2 failures → at most `requested+2` attempts, successes returned | same | Proves quota bound |
| No failures → exactly `requested` calls, zero skips | same | No over-fetch |
| Additive response: digest gains `requestedCount` | extend `tests/phase4-contract.test.ts` | Old assertions unchanged |
| Regressions | contract, parser guard, self-checks, extension smoke | Must stay green |
| Manual | bun tab + extension panel | Criteria 1–6 |

## 5. Definition of Done

- [ ] §1 criteria 1–4 verified by tests; 5–6 verified manually.
- [ ] `bun test tests/phase4-contract.test.ts`, `tests/youtube-parser-guard.test.ts`,
      `tests/scan-backfill.test.ts`, self-checks green.
- [ ] `bun run build:ext` run; `extension/` equals `ui/`.
- [ ] No new deps, no CORS/storage-schema change, no committed store/env files.
- [ ] 409 lock still released on every early return (502 included).

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Backfill burns Gemini quota during an outage | Hard cap: `requested + 2` attempts |
| Replacement is lower-signal than the dropped pick | Backfill only from the filter-passing pool; UI discloses the skip |
| Error text leaks details | Truncate to 200 chars; never log the API key |
| Old digests/backups | Fields are optional; no migration |

## 7. Files touched

- `lib/youtube.ts` (ranked pool + helper) · `lib/summarizer.ts` (optional fields)
- `server.ts` (loop + save) · `ui/digest.js` · `extension/` (generated only)
- `tests/scan-backfill.test.ts` (new) · `tests/phase4-contract.test.ts` (one assertion)

## 8. Review log

**v2 — KISS/YAGNI revision.** Cut from v1: injectable `runScan` exports,
`stage`/`usedNativeFallback` fields, `sanitizeSkipReason`/redaction helper,
rank re-sorting (unnecessary — iteration is rank-ordered), separate docs step,
and 2 of 8 eval criteria folded into others.

**v2.1 — constraints added.** `§2a` now hard-codes tooling, API compatibility,
quota cap, single-flight/early-return, secret handling, extension parity, CORS,
dependency, and latency limits. Open question for the reporter: is
`MAX_REPLACEMENTS = 2` acceptable (vs 1 or unbounded)?

**v3 — implemented (`MAX_REPLACEMENTS = 2` locked).**
- Step 0: `searchAndFilterTopicWithStats` returns `rankedPool` (additive).
- Step 1: `collectWithBackfill` + `SkippedVideo` + `MAX_REPLACEMENTS` in
  `lib/youtube.ts`; `TopicDigest.requestedCount?/skippedVideos?` in
  `lib/summarizer.ts`; `runScan` uses the helper and persists both fields.
- Step 2: toast + synthesis-card skip note; `bun run build:ext` run, `ui/` ↔
  `extension/` byte-identical.
- Tests: `tests/scan-backfill.test.ts` (5 pass) covers backfill order, the
  `+2` attempt cap, no-overfetch, and 200-char reason truncation.
- Verification: parser guard (4), contract (7), self-checks OK; `tsc --noEmit`
  shows no new errors in touched files; live isolated-store scan
  (`maxVideos=1`) persisted `requestedCount: 1` and a 1-video digest.
- Deviation: the §4 "additive contract assertion" was replaced by the live
  integration check — a success path needs a real key/network, which the
  offline contract suite cannot guarantee. The 502/skip path stays covered by
  the existing concurrency test.
