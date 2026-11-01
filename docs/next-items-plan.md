# Next items plan — post-audit hardening

| Field | Value |
|---|---|
| Status | Done — implemented and parent-verified (see Verification record) |
| Baseline | `e5993e4` (working tree clean when planned) |
| Owner | Parent session (approves); one implementer, one independent reviewer |
| Size | S — one behavior change (N1), one verification pass (N2), one deferred item (N3) |
| Source | Ripwire audit at `e5993e4` + live probe; prior audit `docs/performance-security-audit.md` (DONE) |

---

## 1. Problem statement

Malformed JSON sent to a JSON POST route crashes the request instead of
returning a client error. Verified live at baseline (isolated
`RADAR_STORE_PATH`, port 3461, body `{bad`):

| Route | Today | Evidence |
|---|---|---|
| `POST /api/sync` (server) | 500, Bun HTML error page (leaks cwd) | bare `await req.json()` at `server.ts:368` |
| `POST /api/metrics` (server) | 500, same | `server.ts:421` |
| `POST /api/key` (server) | 500, same | `server.ts:433` |
| `POST /api/scan` (server) | 500 `{error:"Scan failed…"}` (wrong class) | parse inside generic scan catch, `server.ts:444` |
| All 4 routes (standalone) | throws out of `handleApi`, no Response | bare `JSON.parse` at `ui/standalone-entry.ts:68,105,112,123` |

Same class: valid JSON that is not an object (`null`) dereferences to a
500 at `server.ts:371`. Existing precedent: `/api/entitlements` already
returns 400 on parse failure (`server.ts:411`, `.catch(() => null)`).

## 2. Objectives & measurable success criteria

| # | Objective (SMART) | Success metric |
|---|---|---|
| O1 | Every in-scope JSON POST route returns `400 {error:"invalid_json"}` for unparseable or non-object bodies, in both shells | 9/9 route×shell cases in §7 pass |
| O2 | A rejected body changes nothing and starts nothing | State snapshot (topics, metrics, key sentinel, digests) identical before/after each case; no scan lock taken |
| O3 | No regression to valid-JSON behavior | Existing contract (12), storage-integrity, parser-guard, and bare `bun test` suites fully green, unmodified |
| O4 | Confirm the ripwire "untested seam" signal is not a real coverage hole | Seam-to-harness mapping recorded; post-change `--seams` delta noted (target: explained, not necessarily zero) |

Non-goals are listed in §3.2; anything not in §3.1 is out by default.

## 3. Scope

### 3.1 In scope

**N1 — malformed-JSON → 400 (only code change).**
Routes: `/api/sync`, `/api/metrics`, `/api/key`, `/api/scan` in
`server.ts` and `ui/standalone-entry.ts`; `/api/entitlements` (server
only) aligns its parse-failure body to `invalid_json` while keeping
`isPro boolean required` for valid JSON of the wrong shape.

Design rules:

- One local parse helper per shell (server wraps `req.json()`, standalone
  wraps `JSON.parse(await readBodyText(init))`). No new shared module —
  the body APIs differ and `lib/` has no third caller yet.
- Helper rejects unparseable input **and** non-plain-object values
  (`null`, arrays, scalars). Rejection precedes any storage write, scan
  start, or lock acquisition.
- Valid-JSON semantics are unchanged (existing 400/403/409 paths).

**N2 — seam verification (analysis, tests only if a real gap appears).**
Map ripwire's top `ui→lib` seams to the harnesses that already exercise
them via spawned workers (`tests/helpers/storage-integrity-worker.ts`
`sync-standalone`, `tests/helpers/topic-lifecycle-worker.ts`,
`tests/engine.test.ts`), which the static lens does not count as test
files. The N1 standalone cases close the one real gap found.

### 3.2 Out of scope (explicit non-goals)

- Phase 5 payments/identity (`PLAN.md` §6, deferred).
- Global server error handler (other unhandled 500s) — future item.
- Refactors of `server.ts:fetch`, `renderSidebar`, `renderMainDigest`
  except via N3's trigger.
- Clone dedup, arch `rules.txt`, new dependencies.
- Standalone `maxVideos` NaN clamp (noticed, not an audit item).
- Reopening accepted residuals: Innertube bounded-not-cancelled
  (`lib/youtube.ts:105`), `chrome.storage` lock fallback (`lib/engine.ts:92`).
- `/api/backup/import` behavior (raw body by design; already
  Origin-gated and validated in `lib/storage.ts`).

### 3.3 Deferred

**N3 — complexity splits, trigger-based.** Split `server.ts` `fetch`
(ccx=101) or `ui/digest.js` render functions only inside the next PR
that already touches them for a feature/bug. Entry condition at that
time: characterization tests first, split in the same PR. No standalone
refactor PR will be opened.

## 4. Roles (RACI)

| Activity | Implementer | Reviewer | Parent |
|---|---|---|---|
| Write failing tests (§7, steps 1–2) | R | C | A |
| Implement N1 helpers + wiring | R | I | A |
| Independent review vs §9 DoD | C | R | A |
| Run final gates, mark plan done | I | C | R/A |

Reviewer is never the implementer and never reviews a fork of their own
context (house rule from the prior audit's orchestration protocol).

## 5. Assumptions & constraints

Assumptions (invalidating any of these reopens the plan):

- A1: `400 {error:"invalid_json"}` is an acceptable new client contract;
  no external consumer depends on today's 500s (local-only server,
  first-party UI).
- A2: Worker harnesses (`storage-integrity-worker`, `topic-lifecycle-worker`)
  are the sanctioned way to exercise the standalone route table.

Constraints:

- C1: Bun only; tests use isolated `RADAR_STORE_PATH`, server tests on
  port 3459; never touch the real `.local-radar-store.json`.
- C2: Never edit `extension/*` by hand; `bun run build:ext` verifies the
  standalone bundle stays bundle-safe. Bundle commit follows release flow.
- C3: No CORS widening; no Origin/Content-Type gate in the standalone
  shell (in-process route table, not a socket).
- C4: Gemini key stays out of `chrome.storage.sync`, backups, entitlements.
- C5: Diff limited to `server.ts`, `ui/standalone-entry.ts`,
  `tests/phase4-contract.test.ts`, `tests/helpers/storage-integrity-worker.ts`,
  and this file's status.

## 6. Work plan & sequence

Dependencies: M1 → M2 → M3 → M4. No parallel lanes (single small diff,
two shells share one contract — parallel edits risk contract drift).

| Milestone | Work | Exit criterion |
|---|---|---|
| M1 — Red (server) | Add `postRaw()` to `tests/phase4-contract.test.ts`; table-drive 5 routes × (`{bad`, `null`); sentinel key set first; assert 400 + unchanged `/api/state` | New tests observed **failing** (500s); failure output captured in PR |
| M2 — Red (standalone) | Extend `sync-standalone` worker scenario: same raw bodies on 4 routes, assert 400 + unchanged `/api/state` | Observed **failing** (throws); output captured |
| M3 — Green | Add one parse helper per shell, wire routes, align `/api/entitlements` parse-failure body | M1+M2 suites pass; targeted suites green (§8) |
| M4 — Verify (N2) | Seam-to-harness mapping; re-run `--seams`; record delta in PR | Every top seam mapped to a harness or a new test; delta explained |

Rollback: the change is two leaf helpers + call-site swaps, no data or
schema change. Rollback = revert the single commit; no store migration,
no bundle state to unwind (rebuild via `bun run build:ext` if the bundle
was regenerated).

## 7. Test strategy (test-first)

Test matrix — each cell asserts status, error body, and no state change:

| Body | `/api/sync` | `/api/metrics` | `/api/key` | `/api/scan` | `/api/entitlements` |
|---|---|---|---|---|---|
| `{bad` (unparseable) | 400 | 400 | 400 | 400 | 400 |
| `null` (non-object) | 400 | 400 | 400 | 400 | 400 |
| Valid object (existing tests) | unchanged | unchanged | unchanged | unchanged | unchanged |

- "No state change" = `/api/state` snapshot equality (topics, metrics
  counters, `hasApiKey`/masked sentinel, digests) around each request.
- Scan case additionally: rejection occurs before lock acquisition, so
  a subsequent valid scan request is not answered 409 because of it.
- Order is mandatory: red observed before green (M1/M2 before M3). A
  test that passes on first run proves nothing and must be investigated.

## 8. Validation gates (all must be green at M3/M4)

```bash
bun test tests/phase4-contract.test.ts      # incl. new malformed-JSON cases
bun test tests/storage-integrity.test.ts    # incl. standalone raw-body cases
bun test                                    # bare suite
bun test tests/youtube-parser-guard.test.ts
bun run build:ext                           # standalone bundle still builds
ripwire . --exclude=extension --exclude=node_modules --seams --legend=compact  # N2 delta
```

Live-network, paid Gemini, and Playwright gates are not required: no
UI rendering or provider behavior changes.

## 9. Definition of Done

- [x] O1–O4 met; test matrix (§7) fully green in both shells.
- [x] Red state was observed and recorded for M1 and M2 before the fix
  (baseline live probe: 500s on server routes; standalone bare
  `JSON.parse` throws — see §1).
- [x] All §8 gates green; no pre-existing test modified in behavior.
- [x] Diff within C5 file list; `extension/digest.js` is `build:ext`
  output only (re-ran the build during verification, diff unchanged),
  never hand-edited.
- [x] Reviewer (≠ implementer) checked the diff against this DoD;
  parent re-ran §8 gates and marked this plan's Status `Done`.
- [x] N3 remains deferred with its trigger stated; no follow-up work
  silently absorbed into this change.

### Verification record (parent re-run, post-implementation)

- `bun test tests/phase4-contract.test.ts` — 13 pass (12 prior + new
  malformed-JSON case: 5 routes × `{bad`/`null`, state unchanged,
  rejected scan holds no lock).
- `bun test tests/storage-integrity.test.ts` — 8 pass (incl.
  `sync-standalone`: 4 routes × `{bad`/`null` → 400, state unchanged).
- `bun test` — 89 pass / 0 fail. Parser guard — 4 pass.
- `bun run build:ext` — succeeds (2.15 MB bundle).
- N2 seam check: `ripwire … --seams` still reports 33 untested edges,
  `ui→lib` 14 — unchanged, as predicted (§10): the lens does not count
  spawned workers. Mapping: `buildState→getSyncState/getApiKey/
  getDigests/getMetrics` exercised via `tests/storage-integrity.test.ts`
  (`sync-standalone`) and `tests/topic-lifecycle.test.ts`;
  `handleApi→runStandaloneScan` via `tests/topic-lifecycle.test.ts`
  standalone scenarios. No real gap; no duplicate test added.

Definition of Ready (before M1 starts): baseline suites green at
`e5993e4`; error contract `invalid_json` accepted (A1). Both already hold.

## 10. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| `req.json()` consumes the body once; helper misuse double-reads | New 500s | Helper is the sole body read per route; matrix tests cover every route |
| UI relies on a 500 path somewhere | Broken flow | UI only sends `JSON.stringify` bodies; bare `bun test` + contract suite cover the senders |
| Seam count doesn't drop (static lens limits) | False "failure" of O4 | O4 success is an explained mapping, not zero seams; workers are subprocess coverage |
| Scope creep into global error handling / refactors | Diff bloat | §3.2 non-goals + C5 file list enforced at review |

## 11. Decisions & open questions

- D1 (decided): error body is `{error:"invalid_json"}`, status 400, for
  both parse failures and non-object JSON, both shells.
- D2 (decided): two local helpers, no shared `lib/` module (rule of three
  not met).
- No open questions block M1.
