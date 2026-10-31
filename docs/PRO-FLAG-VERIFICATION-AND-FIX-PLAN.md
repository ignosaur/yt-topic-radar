# Pro flag + standalone — verification & fix plan

Verified 2026-10-31 against HEAD by direct reads, `ripwire --for/--callers/--uses/--grep`,
a dev→prod rebuild in a temp copy, `bun test tests/engine.test.ts tests/scan-backfill.test.ts
tests/phase4-contract.test.ts` (27 pass), and `bun scripts/verify-package.ts` (34 pass, on
`dist/yt-topic-radar-v1.0.0.zip`). No product code changed by this verification.

**Readiness (after pressure test, §4):** Phase 1 — implementation-ready. Phase 2 —
ready as amended below (2A shape decided, 2B route semantics pinned, 2C test seam
prototyped and proven); 2D remains a gated decision item, 2E a conditional flip.

## 1. Verdicts on the review findings

| # | Finding (from review) | Verdict | Evidence |
|---|---|---|---|
| F1 | `__RADAR_PRO_ENABLED__` used once (`ui/standalone-entry.ts:22,50`); standalone routes are hardcoded off, so flipping it won't enable Pro | **Confirmed** | `standalone-entry.ts:49` `isPro:false`, `:94` sync has no cap, `:133-136` entitlements no-op, `:149` `enforceTopicLimit:false` — none branch on `PRO_ENABLED`. Flip to `true` today = toggle becomes visible but POSTs to a no-op and resets to `false` on `loadState()` |
| F2 | Prod bundle ships Pro UI hidden-not-removed; docs overclaim "removed at build time" | **Partially confirmed** | Fresh prod bundle: `isPro`×17, `proEnabled`×6, `Free limit`×2, `proToggle` in `extension/digest.html` — shipped, hidden by `proEnabled:false`. But the four tokens the doc actually names (`docs/STANDALONE-EXTENSION-PLAN.md:138`: `chrome.alarms`, `proChanged`, `rssUnread`, `localhost:3456`) are genuinely **0** in the bundle. Overclaim is only at `:112` ("no Pro toggle/upgrade UI … ships") |
| F3 | `server.ts` `/api/state` omits `proEnabled`; client defaults missing → enabled | **Confirmed** | `server.ts:250` `monetization: MONETIZATION_CONFIG` (no key); `ui/digest.js:384` `proEnabled !== false`. Works by accident of the default |
| F4 | CORS `origin \|\| "*"` fallback (`server.ts:57`) | **Confirmed, low risk** | Only fires for requests with no `Origin` header, which browsers never treat as cross-origin reads; no `Allow-Credentials`. Hardening, not a vuln |
| F5 | Stale `extension/tts-scan-utils.js` + `_metadata/` in prod output | **Confirmed (tts), handled (_metadata)** | Temp-copy proof: `build:ext:dev` then `build:ext` leaves `tts-scan-utils.js` (prod bundle inlines it via `ui/digest.js:5` import; dev needs the file). It is git-tracked and **is in the shipped zip** (`unzip -Z1`). `_metadata/` is already stripped by `scripts/package-chrome.ts` (`rm` + zip exclude) and forbidden by `verify-package.ts` |
| F6 | `lib/engine.ts` re-implements `collectWithBackfill` | **Confirmed duplication, no behaviour diff except skip-reason string** | `engine.ts:162-195` inline loop vs `lib/youtube.ts:243-282`. Same attempt cap (`requested + MAX_REPLACEMENTS`), same `attemptedCount`, same `stopReason` logic. Only diff: skipped reason `"Video could not be processed."` vs helper's `"Video processing failed"` |
| F7 | `clampMaxVideos` (engine) vs inline clamp (server) diverge | **Rejected as a bug** | Outcomes identical for 0 / NaN / negative / 99 (both → 1…5, default 3); `tests/engine.test.ts:346` pins engine behaviour. Duplicate spelling only — leave it |

Not findings: key never in `chrome.storage.sync`/backup/entitlements; CORS allowlist not
widened; prod manifest/worker carry no `alarms`/`notifications`/`localhost`; standalone
route table covers all 8 `/api/*` the UI calls. Ship verdict unchanged: **OK to ship v1**
after Phase 1 below (all P2).

## 2. Code-flow traces

### 2a. `isPro` — server/dev mode

```
Settings checkbox #proToggle (ui/digest.html:55)
  ui/digest.js:1001 change → POST /api/entitlements {isPro}
    server.ts:293 validate boolean (400) → lib/storage.ts:254 setEntitlements
      → readCliStore/writeCliStore → .local-radar-store.json (RADAR_STORE_PATH in tests)
  ui/digest.js:1015-1043 (skipped when __RADAR_STANDALONE_BUILD__):
    chrome.alarms.create/clear("rss-poll", 30m) · rssSeen/rssUnread reset · badge clear
    chrome.runtime.sendMessage({type:"proChanged", isPro}) → scripts/background.dev.js:118
  loadState() ui/digest.js:291 → GET /api/state
    server.ts:237 getEntitlements (storage.ts:249, CLI-store only) + MONETIZATION_CONFIG
    → state.entitlements / state.monetization   [no proEnabled key → F3]

Reads of state.entitlements.isPro (ui/digest.js:80 isPro()):
  renderMetricsUI:387-400  toggle checked; row hidden iff proEnabled===false;
                           upgrade line iff proEnabled && !isPro() && topics ≥ limit
  canAddMoreTopics:588     (callers :564 starter pill, :782 subtopic pill, :1102 add-topic)
                           proEnabled===false → always true; else toast+block at 5
Server enforcement (source of truth):
  server.ts:275 POST /api/sync   !isPro && next > max(current, 5) → 403 upgrade_required
  server.ts:378 GET /api/rss     !isPro → 403 upgrade_required
  storage.ts:413 importBackupJson (server calls with no opts) → clamp max(current, 5)
RSS worker: background.dev.js:32,42 fetchState → !isPro → clear alarm/badge, return
```

### 2b. `isPro` — standalone prod

```
package.json build:ext --define __RADAR_PRO_ENABLED__="false"
  ui/standalone-entry.ts:22 PRO_ENABLED=false
  buildState:49-50  entitlements:{isPro:false} (hardcoded), monetization.proEnabled=false
  handleApi: /api/entitlements → no-op {isPro:false} · /api/sync → no cap
             /api/backup/import → importBackupJson(..., {enforceTopicLimit:false})
               → storage.ts:413 ternary short-circuits, getEntitlements never called
                 (it is CLI-store-only and would hit node:fs in a browser — F1/M4 blocker)
  ui/digest.js: proEnabled===false → toggle row hidden, upgrade line hidden,
                canAddMoreTopics() always true ⇒ unlimited topics (intended v1)
```

### 2c. Extension builds

```
build:ext      bun build ui/standalone-entry.ts (defines: STANDALONE=true, PRO=false,
               process.env.*) → extension/digest.js (digest.js + engine + tts inlined)
               + cp digest.html/css/favicon + manifest.prod.json + background.prod.js
               + dnr-rules.json → rules.json        [never deletes dev leftovers → F5]
build:ext:dev  cp ui/digest.* + tts-scan-utils.js + manifest.dev.json + background.dev.js
               + rm rules.json        (thin shell, needs `bun run ui` on :3456)
package:chrome build:ext → version check → rm extension/_metadata → zip extension/*
               (includes tts-scan-utils.js today) → verify-package.ts (34 checks)
```

## 3. Fix plan

### Phase 1 — v1 hardening (no owner decision needed; land before next zip)

Four items, each its own commit, any order (1D optional). Each ends with its tests green.

**1A. Explicit `proEnabled` contract (F3)**
- **Goal:** Make Pro visibility an explicit server→UI contract instead of a client-side default.
- **Context:** `server.ts:250` returns `MONETIZATION_CONFIG` without `proEnabled`; `ui/digest.js:384` treats missing as enabled (`!== false`), so dev mode works only by accident of the default. Standalone already sends the key explicitly (`standalone-entry.ts:50`).
- **Scope:** In — `server.ts` `/api/state` response (one line: `monetization: { ...MONETIZATION_CONFIG, proEnabled: true }`), one assertion in `tests/phase4-contract.test.ts` (`data.monetization.proEnabled === true`). Out — `MONETIZATION_CONFIG` shape, `ui/digest.js` rendering logic, standalone entry.
- **Constraints:** No behaviour change in dev UI (it already defaults to enabled); no new field anywhere else; keep `MONETIZATION_CONFIG` as the single source for limit/URLs.
- **DoD:** [ ] Contract test asserts `proEnabled === true` and passes · [ ] `bun test tests/phase4-contract.test.ts` green · [ ] Dev UI still shows Pro toggle + cap (unchanged rendering, now driven by the explicit key).

**1B. CORS fallback (F4)**
- **Goal:** Never emit `Access-Control-Allow-Origin: *` from the local server.
- **Context:** `server.ts:57` `origin || "*"` fires only for no-`Origin` requests, which browsers never treat as cross-origin reads; no `Allow-Credentials` is sent. Hardening only — not an exploitable vuln, so it must stay a one-line fix.
- **Scope:** In — `corsHeaders` (`server.ts:52-60`): if `!allowed` return `{}` regardless of empty origin, else echo `origin`; one contract test (`OPTIONS /api/state` with no `Origin` → no `access-control-allow-origin: *`). Out — the allowlist regexes, allowed methods/headers, any route logic.
- **Constraints:** Allowlist stays localhost + `127.0.0.1` + `chrome-extension://` (do not widen); same-origin UI and extension callers must keep working (they send an allowed `Origin`, or none and don't need CORS).
- **DoD:** [ ] No response from the server carries `Access-Control-Allow-Origin: *` (test proves the no-Origin case) · [ ] `bun test tests/phase4-contract.test.ts` green · [ ] Disallowed-origin behaviour unchanged (no CORS headers).

**1C. Build hygiene + honest docs (F5, F2)**
- **Goal:** Prod zip contains only files the standalone bundle needs, and the docs state exactly what ships (hidden Pro UI, zero RSS code).
- **Context:** Temp-copy proof: `build:ext:dev` → `build:ext` leaves `extension/tts-scan-utils.js`, which is git-tracked and lands in the shipped zip, though the prod bundle inlines it (`ui/digest.js:5`). Doc overclaim is `docs/STANDALONE-EXTENSION-PLAN.md:112` only; the :138 token claim is true today (all four tokens ×0). `_metadata/` is already stripped by `package-chrome.ts` — not in scope.
- **Scope:** In — `package.json` `build:ext` (append `&& rm -f extension/tts-scan-utils.js`; its git deletion in prod-build state is part of the commit), `scripts/verify-package.ts` §6 (add `proChanged`, `rssUnread` to digest.js forbidden tokens), wording at `docs/STANDALONE-EXTENSION-PLAN.md:112,138`. Out — forbidding `isPro`/`proEnabled` in the bundle, any UI fork or build-time stripping, `_metadata/` handling, dev build file list.
- **Constraints:** Dev build keeps copying `tts-scan-utils.js` (plain-`cp` dashboard imports it as a sibling file); hidden-not-removed stays the accepted v1 design — manifest/permissions/worker are the security boundary and `verify-package` already checks them; never edit `extension/*` by hand (change the build, rebuild).
- **DoD:** [ ] Fresh `bun run package:chrome` → `unzip -Z1` shows no `tts-scan-utils.js`, no `_metadata/` · [ ] `verify-package` passes with the two new forbidden tokens · [ ] Doc wording matches the verified bundle counts · [ ] `bun run build:ext:dev` still produces a working dev shell (tts file re-copied).

**1D. Engine dedup (F6)** — optional but cheapest now, while traces are fresh
- **Goal:** One backfill implementation shared by server and standalone scan, so skip/attempt/stop semantics can never drift.
- **Context:** `lib/engine.ts:162-195` hand-rolls the same loop as `lib/youtube.ts:243-282` (`collectWithBackfill`): identical attempt cap, `attemptedCount`, `stopReason`. Only divergence is the skipped-reason string. No live bug — this is drift prevention, sized as a single-commit refactor.
- **Scope:** In — `lib/engine.ts`: import `collectWithBackfill`, replace the inline loop with one call (`process` closure = transcript→summarize, pushing `secondsSaved`/`seenVideoIds` on success only; `isFatal` = `ProviderAvailabilityError || ProviderFailureError`; take `attemptedCount`/`stopReason` from the helper; delete `attemptsLimit`, the hand-rolled `stopReason`, and the now-unused `MAX_REPLACEMENTS` import). Out — `lib/youtube.ts` helper, `server.ts` scan path, `EngineDeps` injection shape, lock/metrics/digest-commit logic in the engine.
- **Constraints:** Preserve every engine behaviour the tests pin: provider errors stay fatal (429/502 mapping in the outer catch), metrics/seen writes only for successes, digest commit + `topic_changed` 409 untouched. Only intended change: skipped reason becomes `"Video processing failed"` (no test asserts the old string; `tests/scan-backfill.test.ts:47,92` already expect the helper's).
- **DoD:** [ ] `bun test tests/engine.test.ts tests/scan-backfill.test.ts` green with no test edits · [ ] Inline loop and `MAX_REPLACEMENTS` arithmetic gone from `lib/engine.ts` (helper is the only copy) · [ ] Standalone scan response shape (`requestedCount/attemptedCount/candidatePoolCount/stopReason/skippedVideos`) unchanged.

Phase 1 gate (all): `bun test tests/engine.test.ts tests/scan-backfill.test.ts
tests/phase4-contract.test.ts` · `bun -e 'import { runSelfChecks } from "./index.ts";
await runSelfChecks()'` · `bun run package:chrome` · `node tests/extension-smoke.mjs`
(server running).

### Phase 2 — M4: make the flag real (DEFERRED — owner approval to monetize required)

Do not start in v1. This is the work F1 actually needs; flipping the define before it
lands produces a visible-but-dead toggle (§2b).

**2A. Browser entitlements storage (F1 prerequisite)**
- **Goal:** `getEntitlements`/`setEntitlements` work in a browser so standalone can persist Pro state at all.
- **Context:** Today both are CLI-store-only (`lib/storage.ts:249-256` → `readCliStore` → `node:fs`), which a browser bundle cannot execute; this — not the define — is what blocks F1. Mirrors the existing `getApiKey` branch pattern (`storage.ts:218-245`).
- **Scope:** In — browser branch in `get/setEntitlements`, branch order mirroring `getApiKey` (`storage.ts:218`): `isBrowserExtension` → `chrome.storage.sync` key **`radarEntitlements`**; else `isIndexedDBAvailable` → idb-keyval key **`radarEntitlements`**; else existing CLI store. Out — backup payload, sync-state storage, Gemini key storage, server/CLI behaviour.
- **Decided shape (supersedes the M4 pre-shape note in `docs/STANDALONE-EXTENSION-PLAN.md`):** store exactly today's `Entitlements { isPro: boolean }` — do **not** widen the interface or persist `email`/`keyHash` speculatively; Phase 5 widens shape + interface together when licence fields have a writer. `setEntitlements` signature unchanged.
- **Constraints:** `lib/storage.ts` stays bundle-safe (no executed `node:fs`/`process.env` in browser branches); Gemini key never enters `chrome.storage.sync`, backups, or entitlements; entitlements stay out of backup export (`tests/m3-acceptance.mjs:458` guards); CLI/server path byte-identical behaviour. Test-mocking constraint: `isBrowserExtension` is a module-level const — the `chrome` global must be installed **before** a dynamic `import()` of `lib/storage.ts`, in a dedicated test process (see 2C harness).
- **DoD:** [ ] With a mocked `chrome.storage.sync`, set→get round-trips `{isPro:true}` with no `node:fs` executed · [ ] Backup export contains no `isPro`/`entitlements`/`geminiApiKey` · [ ] `bun test tests/phase4-contract.test.ts` (CLI path) green unchanged.

**2B. Standalone routes branch on `PRO_ENABLED` (F1)**
- **Goal:** The define — and only the define — switches standalone Pro enforcement on/off.
- **Context:** `ui/standalone-entry.ts:49,94,135,149` hardcode the off behaviour; `ui/digest.js` already keys entirely off `proEnabled` + `isPro()`, so no UI change is needed. Depends on 2A.
- **Scope:** In — `ui/standalone-entry.ts` only: add `getEntitlements, setEntitlements` to the existing `lib/storage` import; `buildState` entitlements = `PRO_ENABLED ? await getEntitlements() : {isPro:false}`; `POST /api/entitlements` (off → current no-op; on → boolean validate 400 + `setEntitlements`, same validation as `server.ts:295`); `POST /api/sync` cap check inserted before `saveSyncState`, written as `PRO_ENABLED && !(await getEntitlements()).isPro && next.topics.length > Math.max(current.topics.length, MONETIZATION_CONFIG.freeTopicLimit)` → `403 upgrade_required` (the `&&` short-circuit keeps flag-off at zero storage reads, exactly today's behaviour); backup import opts = `PRO_ENABLED ? {} : { enforceTopicLimit: false }` (avoids the inverted opt when on). Out — `ui/digest.js`, `/api/rss`, worker/manifest (→ 2D), payments/licence checks (Phase 5).
- **Constraints:** Flag-off behaviour must remain exactly today's v1 (unlimited topics, no-op entitlements, no clamp); flag-on cap semantics mirror the server (grandfathering: shrink/re-save at current count allowed); no runtime mode switch — build-time define only.
- **DoD:** [ ] Flag off: all current standalone behaviours unchanged (2C tests) · [ ] Flag on: 6th topic → 403, toggle round-trips through storage and survives reload, import clamps to `max(current, 5)` · [ ] No change needed in `ui/digest.js` (toggle/upgrade line appear via state alone).

**2C. Standalone Pro tests**
- **Goal:** Prove both flag states of 2B without a real browser profile or Gemini key.
- **Context:** No existing test exercises `standalone-entry` routes with Pro on; `tests/standalone-smoke.mjs` covers flag-off only and needs a built extension. Pressure-tested blockers (§4): `handleApi` is not exported and the entry crashes on import in Bun (`__RADAR_PRO_ENABLED__` undefined, then `window is not defined`); and Bun test shares the module registry across files in one run, so flag-on/off cannot be two test files — `PRO_ENABLED` is read once at first import.
- **Scope:** In — (i) test seam in `ui/standalone-entry.ts`: `export async function handleApi` (one keyword) and guard the last two lines as `if (typeof window !== "undefined") { window.__RADAR_STANDALONE__ = handleApi; await import("./digest.js"); }` — always true in the browser, so shipped behaviour is unchanged (prototyped green in §4); (ii) new `tests/helpers/standalone-pro-harness.ts` (house pattern: `tests/helpers/topic-lifecycle-worker.ts`): sets `globalThis.__RADAR_PRO_ENABLED__` + a `Map`-backed `chrome.storage.sync/local` mock **before** dynamic-importing the entry, calls state/entitlements/sync/import routes, prints results as JSON; (iii) new `tests/standalone-pro.test.ts`: spawns the harness via `Bun.spawnSync` once per flag state (fresh process per state — this is what defeats the shared module registry) with `RADAR_STORE_PATH` pointed at a temp dir, and asserts the JSON. Out — E2E/browser automation, RSS, scan pipeline (covered by `tests/engine.test.ts`).
- **Constraints:** Bun test only (no new deps, no Playwright); no top-level imports of `standalone-entry`/`lib/storage` in the test file (dynamic import inside the harness only); flag state comes from the harness argument, never from editing defines; the seam must not change bundle output behaviour (verify: prod bundle still sets `__RADAR_STANDALONE__` — standalone smoke A1–A6 green).
- **DoD:** [ ] Test passes with flag on (cap 403 at 6 topics, toggle round-trips through `/api/state` after POST, import clamps) and flag off (6 topics 200, entitlements no-op, no clamp) · [ ] Fails if any of the three routes ignores `PRO_ENABLED` (mutation-checked by flipping one route back) · [ ] `node tests/standalone-smoke.mjs` still green on the flag-off prod build (seam is inert in browser) · [ ] Existing suites still green.

**2D. RSS in standalone (M4b — separate change, not part of the flip)**
- **Goal:** Decide and, if approved, build client-side RSS polling for standalone Pro.
- **Context:** Standalone has no `/api/rss` route, no polling worker, and no `alarms`/`notifications` permissions (verified §1); server RSS depends on `localhost:3456`, which prod must never call. This is a new subsystem, not a flag branch — bundling it into 2B would blow up that change.
- **Scope:** In (when approved) — its own design doc first: worker polling via `lib/youtube.ts` RSS, manifest permission additions, `verify-package.ts` expectation updates, badge/notification behaviour parity with `scripts/background.dev.js`. Out — 2A–2C, the entitlements flip, server RSS.
- **Constraints:** No `localhost` in prod, ever; permission additions require their own owner sign-off and a `verify-package` update in the same change; do not start before 2B ships.
- **DoD:** [ ] Design doc approved before code · [ ] (Implementation DoD defined in that doc — deliberately not pre-written here.)

**2E. Flip the define**
- **Goal:** Ship standalone with Pro actually enabled, in one reversible change.
- **Context:** Flipping before 2A–2C lands yields a visible-but-dead toggle (§2b). Phase 5 licence verification later replaces the manual toggle *value*, not this mechanism.
- **Scope:** In — `package.json` `build:ext` define `"false"` → `"true"`; version bump in lockstep (`package.json` + `scripts/manifest.prod.json` + `scripts/manifest.dev.json` — `package-chrome.ts` fails on mismatch, and the Store requires a higher version to update); update the two flag-off acceptance checks that the flip intentionally breaks: `tests/standalone-smoke.mjs` A5 (toggle now **visible**) and A6 (6 topics now 403 until Pro is toggled on in the test, then accepted), and `tests/m3-acceptance.mjs` sync/import checks (~:308, A7) to unlock Pro first; rebuild, repackage. Out — any product code change (all behaviour must already exist behind the flag), RSS (2D), payments (Phase 5).
- **Constraints:** Same change as (or after) 2A–2C merge, never before; explicit owner approval to monetize recorded; full Phase 1 gate + clean-profile standalone smoke re-run on the flipped build before zipping; acceptance-test updates assert the *new* contract (cap-then-unlock), never just delete the old assertions.
- **DoD:** [ ] 2A–2C DoDs all checked · [ ] Owner approval recorded · [ ] Phase 1 gate green on the flipped build · [ ] Updated standalone smoke + m3 acceptance green (A5 visible, A6 capped-then-unlocked) · [ ] All three version fields bumped and equal · [ ] Rollback is the one-line define revert + rebuild (versions may stay bumped).

### Lightweight test strategy — one assert per behaviour, existing harnesses first

Principles: (1) extend a running harness before creating a file; (2) no Playwright for
logic (browser smoke stays for browser-only facts: visibility, persistence, no-localhost);
(3) no new deps, no mock framework — plain `Map`-backed fakes and `Bun.spawnSync`;
(4) a test that can't fail when its item is reverted doesn't count (mutation check in 2C).

| Item | Lightest sufficient test | New file? | Proves |
|---|---|---|---|
| 1A | +1 assertion in the existing state test (`phase4-contract.test.ts:54`): `proEnabled === true` | No | Server sends the explicit key |
| 1B | +1 test in same file: `OPTIONS` with no Origin → header is not `*` (evil-Origin case already implicitly covered by P1; assert both in ~6 lines) | No | No wildcard CORS ever emitted |
| 1C | Extend `verify-package.ts` §6 token list (`proChanged`, `rssUnread`) + gate-command `unzip -Z1 dist/*.zip \| grep tts` returns nothing | No (script + 1 shell check) | Zip contents match the doc claim; don't automate the dev→prod build switch — `package:chrome` + verify already gate what ships |
| 1D | **Zero new tests.** Existing `engine.test.ts` + `scan-backfill.test.ts` must pass unedited; optionally +1 assert on the saved digest in the existing skipped-video test (`engine.test.ts:256` area): `skippedVideos[0].reason === "Video processing failed"` | No | Dedup changed nothing but the intended string |
| 2A | No standalone storage test. Round-trip is proven through the routes by the 2C harness (POST entitlements → GET state), which already installs the chrome mock before dynamic import; backup exclusion is already asserted (`phase4-contract` "backup excludes entitlements", `m3-acceptance.mjs:458`) | No (rides 2C) | Browser branch persists; nothing leaks into backups |
| 2B | 7 route assertions in the 2C harness, JSON-compared by the test: flag-off {state `proEnabled:false`, sync 6 topics → 200, entitlements no-op}; flag-on {sync 6 → 403, sync 5 → 200, POST entitlements true → state `isPro:true`, import 10-topic backup → clamped count} | Harness + test (2C) | The define alone switches enforcement; grandfathering/import semantics match server |
| 2C | The item itself; keep it to the 7 assertions above — resist adding scan/RSS cases (already covered by `engine.test.ts` / smoke) | Yes (only new test files in the plan) | Both flag states, mutation-sensitive |
| 2D | None now. Current no-RSS-in-prod fact is already guarded by `verify-package` (permissions + worker tokens) | No | — (tests arrive with its design doc) |
| 2E | Update-in-place: standalone smoke A5 (visible) + A6 (403 → toggle on → 200) and `m3-acceptance` unlock-first; plus existing `verify-package` on the flipped zip | No | Shipped flipped build behaves; no assertion deleted, only re-contracted |
| Gate | `bun test tests/engine.test.ts tests/scan-backfill.test.ts tests/phase4-contract.test.ts` · self-checks one-liner · `bun run package:chrome` · standalone/extension smoke | No | Whole plan, ~1 min + smokes |

Explicitly not recommended: a storage unit-test file for 2A (duplicates the harness
path), automating the dev→prod build-switch sequence (P5 was a one-off proof;
`verify-package` is the standing guard), and any snapshot/golden test of the bundle
(brittle; token counts in `verify-package` carry the same signal at zero upkeep).

### Explicitly not doing (ponytail) — closed decisions, no DoD; check = grep/test stays green

| Decision | Goal / context | Scope & constraint |
|---|---|---|
| No single-flag merge | Mode (`__RADAR_STANDALONE_BUILD__`: routing/API base) and feature (`__RADAR_PRO_ENABLED__`) are orthogonal; merging them makes M4 inexpressible | Both defines stay; no code may read one where it means the other |
| No build-time stripping of Pro UI (F2) | One shared dashboard beats a forked UI; runtime-hide already verified | Permissions + worker are the boundary; `verify-package` keeps guarding them |
| No `clampScanCount` helper (F7) | Outcomes proven identical; abstraction costs more than the duplication | Two 3-line clamps stay; revisit only if a third scan path appears |
| No runtime mode switch, payments/identity, CORS widening | Build-time mode is an AGENTS.md invariant; payments are Phase 5 | Flag flips are build changes only; allowlist untouched by any item above |

## 4. Pressure-test log (2026-10-31, temp copies only — repo untouched)

| # | Claim under test | Experiment | Result |
|---|---|---|---|
| P1 | CORS `*` is reachable (F4/1B) | Live server on :3461: `OPTIONS /api/state` with no Origin / evil Origin / `chrome-extension://` Origin | No-Origin → `Access-Control-Allow-Origin: *` (confirmed); evil → no CORS headers; allowed → echo. 1B fix targets exactly the first case |
| P2 | Standalone routes can be unit-tested in Bun (2C) | Direct dynamic import of `ui/standalone-entry.ts` with mocked `chrome` | **Fails twice**: `__RADAR_PRO_ENABLED__ is not defined`, then `window is not defined` (top-level `window.__RADAR_STANDALONE__` + `await import("./digest.js")`). Hence the 2C seam (export + `typeof window` guard) — not optional |
| P3 | The 2C seam works and changes nothing in flag-off behaviour | Temp copy with seam applied; harness script sets globals, imports entry, calls `/api/state`, `/api/entitlements`, `/api/sync` (6 topics) | All callable in Bun: `proEnabled:false`, entitlements no-op `false`, sync **200**. Seam proven; browser path unchanged (`window` always defined there) |
| P4 | Two test files can cover flag on + off (2C) | `off.test.ts` + `on.test.ts` in one `bun test` run, each setting the global before dynamic import | **Second file fails** — Bun test shares the module registry across files; `PRO_ENABLED` is frozen at first import. Hence the subprocess harness (house pattern: `tests/helpers/topic-lifecycle-worker.ts`) |
| P5 | Dev→prod build switch is clean (F5/1C) | Temp copy: `build:ext:dev` then `build:ext`, list `extension/` + count bundle tokens | `tts-scan-utils.js` survives into prod (confirmed); bundle tokens: `chrome.alarms`/`proChanged`/`rssUnread`/`localhost:3456` all **0**, `isPro`×17 (F2 confirmed as hidden-not-removed) |
| P6 | Flip is test-neutral (2E) | Grep acceptance suites for flag-off assumptions | **False**: `tests/standalone-smoke.mjs` A5 (toggle hidden) + A6 (6 topics accepted) and `tests/m3-acceptance.mjs` ~:308 assert flag-off behaviour. 2E scope now includes updating them to cap-then-unlock |
| P7 | Phase 1 test baselines hold | `bun test tests/engine.test.ts tests/scan-backfill.test.ts tests/phase4-contract.test.ts`; `bun scripts/verify-package.ts` | 27 pass; 34 checks pass. 1A/1B assertions slot into the existing spawned-server harness (`tests/phase4-contract.test.ts:54`) |

Pressure outcome: F1–F7 verdicts unchanged; gaps found were in the *plan's* Phase 2
testability (P2, P4), acceptance fallout (P6), and the undecided entitlements shape
(2A) — all addressed in the amended items above. No new product findings.

## 5. Risks & rollback

- 1B: if any legitimate caller sends no `Origin` and reads CORS headers (none found —
  UI is same-origin or `chrome-extension://`), it loses only the header, not access.
  Rollback = restore the one line.
- 1C: a dev→prod switch now deletes `tts-scan-utils.js`; `build:ext:dev` re-copies it.
  Rollback = drop the `rm`.
- 1D: only risk is the skip-reason string in stored digests (display-only).
  Rollback = revert the single commit; server path untouched throughout.
- Phase 2 touches the bundle-safety invariant (`lib/storage.ts` must stay free of
  executed `node:fs` in browser branches) — re-run the Phase 1 gate plus a clean-profile
  standalone smoke before flipping the define.
