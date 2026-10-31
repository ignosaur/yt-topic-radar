# Standalone Chrome Extension — Implementation Plan (KISS/YAGNI)

Status: **M0–M2 implemented; M3 prep automated.** M0 passed; M1 is done (all boxes green); M2 produces a verified `dist/yt-topic-radar-v1.0.0.zip` but is blocked on owner items; M3 has a GO/NO-GO preflight and a passing packaged-zip acceptance run, and is blocked on owner submission inputs. M4 deferred.
Saved: 2026-10-28. Supersedes the earlier standalone plan discussion in-session.
Amended: 2026-10-29 — Pro gated behind `__RADAR_PRO_ENABLED__` (OFF in v1, activation M4); RSS deferred; M0 dry-run findings + M1/M2 implementation evidence recorded below.

## Decisions locked (by product owner)

| # | Decision |
|---|---|
| 1 | **Chrome first.** Brave is covered by the Chrome Web Store listing. Edge official listing, Firefox, Safari: deferred. |
| 2 | **`bun run ui` is DEV-only fallback.** Prod extension contains no localhost code path or permission. Mode is chosen at build time, never runtime. |
| 3 | **Close tab/panel → scan cancels.** Scan runs in the page clicked (side panel or Dashboard tab). Closing aborts; no partial digest saved; previous digest for the topic stays intact; metrics/seen only increment on completion. No hand-off, no checkpoint/resume, no background/offscreen scanning in v1. |
| 4 | **Spike failure → stop & re-decide.** If the M0 browser spike fails (e.g. Innertube blocked from `chrome-extension://`), implementation halts and the owner picks a fallback. No silent scope change (no YouTube Data API fallback pre-authorized). |
| 5 | **Manual data migration.** Existing server data (`.local-radar-store.json`) moves via Export `.json` (dev UI) → Import (standalone). API key is excluded from backups by design and is re-pasted. No auto-import. |
| 6 | **Unlisted beta first.** First Chrome Web Store release is unlisted for testers; flipping to public requires separate explicit owner approval. |
| 7 | **Pro behind a build-time feature flag, OFF in standalone v1.** Standalone prod ships with `__RADAR_PRO_ENABLED__=false` (Bun `--define`, never a runtime toggle — same build-time rule as Decision 2). Flag off = **no paywall**: unlimited topics, Pro toggle + upgrade UI hidden, standalone `/api/entitlements` is a no-op, backup import does not clamp topics. Server/dev-mode Pro (Phase 4) is untouched. Full standalone Pro is deferred to M4. |
| 8 | **No RSS in standalone v1.** `alarms`/`notifications` stay out of the prod manifest — manifest permissions cannot be feature-flagged (the store reviews them even if unused). A standalone-native RSS worker (worker reads `chrome.storage` + fetches YouTube feeds directly, no server) is a fast-follow after M4 (it is a Pro feature, so it requires the flag on), activated separately from the flag flip itself. |
| 9 | **In-browser Innertube requires a DNR header rewrite — proven necessary.** YouTube blocks `youtubei` calls by request origin (`chrome-extension://` → 403, `https://www.youtube.com` → 200, proven 2026-10-29). Standalone therefore ships a static `declarativeNetRequestWithHostAccess` ruleset that sets `Origin`/`Referer`/`Sec-Fetch-*` to `https://www.youtube.com` for `//youtube.com/youtubei/*`. Accepted risks: extra store-review scrutiny of header modification; keep the ruleset narrowly scoped (youtubei only, XHR only, no wildcard hosts). If review rejects it, the fallback is a content script in a `youtube.com` tab — requires a new owner decision, not a silent swap. |

## Goal / Problem

- **Goal:** A user on any computer installs the extension from the Chrome Web Store, pastes their own Gemini API key, and scans topics end-to-end — with no Bun, no local server, nothing else running.
- **Problem today:** The extension is a thin shell over `bun run ui` (`http://localhost:3456`). Without the server, starter packs are blank (come from `GET /api/state`), the Gemini key shows missing (stored server-side), and every action fails silently. Verified 2026-10-28 by loading the extension standalone in Chrome.

## Architecture (keep what's already shaped for this)

- The UI/engine seam already exists: `ui/digest.js:7-25` overrides `fetch("/api/*")`. That shim is the only integration point — route it to a local handler instead of refactoring call sites. One shim change is required: today it prefixes `/api/*` with `http://localhost:3456` whenever `chrome.runtime.getURL` exists and never checks `__RADAR_STANDALONE__`; the standalone build must make it dispatch to the local route table instead (call sites unchanged).
- `lib/storage.ts` already has browser backends for the v1 paths, no rewrite needed:
  - `chrome.storage.sync` — topics/settings (`lib/storage.ts:129-156`)
  - `chrome.storage.local` — Gemini key (`lib/storage.ts:158-184`)
  - IndexedDB (`idb-keyval`) — digests, metrics, seen IDs (`lib/storage.ts:198-306`)
  - `STARTER_TOPICS` constant (`lib/storage.ts:49-53`)
  - **Exception (deferred to M4):** `getEntitlements`/`setEntitlements` (`lib/storage.ts:186-196`) have *no* browser branch — they always hit the CLI file store (`node:fs/promises`, `process.env`). With the Pro flag off (Decision 7) no standalone v1 path depends on them; adding the browser branch is M4 work, not a v1 blocker.
- **Pro feature flag (Decision 7):** the only monetization code standalone v1 carries is flag checks in the standalone route table (below) plus one small `lib/storage.ts` change — `importBackupJson(raw, opts?: { enforceTopicLimit?: boolean })`, defaulting to today's behaviour so the server and Phase 4 contract tests are unchanged. Standalone import passes `enforceTopicLimit: false`. When M4 flips the flag, the flag-off paths retire; they are the v1 shipping paths until then, not dead code.
- Scan pipeline is ~65 lines (`server.ts:72-138`, `runScan`), portable near-verbatim into the page (one change: buffer seen IDs to completion, per piece 1).
- No backend, no accounts, no telemetry server. BYOK key + user's residential IP is the whole design.

### The build (5 small pieces)

1. **`lib/engine.ts`** (~235 lines incl. scan lock + backfill attempt cap): port of `server.ts:72-138` (`runScan`) — search → transcript → summarize → synthesize → `saveTopicDigest` / `updateMetrics`. Optional progress string only; no framework, no job state machine. Seen IDs are buffered and committed only on completion (Decision 3), unlike the server loop's per-video `markVideoSeen`. **Includes the scan lock** replacing the server's single-flight guard (`server.ts:292-305`): `{topic, since}` in `chrome.storage.local`, 10-min stale expiry (matching `SCAN_STALE_MS`); a second page (tab vs panel) starting a scan while locked gets the existing `scan_in_progress` behaviour in the UI.
2. **`ui/standalone-entry.ts`** (~160 lines): **first import is a fetch-bind patch** — youtubei.js's web shim captures `globalThis.fetch` unbound (`platform/web.js`), which Chrome rejects with "Illegal invocation"; `globalThis.fetch = globalThis.fetch.bind(globalThis)` must execute before `lib/youtube.ts` evaluates (verified in dry-run). Then installs `window.__RADAR_STANDALONE__` with a small route table for the existing `/api/*` paths (state, sync, key, metrics, scan, entitlements, backup export/import) backed by `lib/` + `engine.ts`, then `await import("./digest.js")` (dynamic import — a static import would hoist and run the dashboard before the patch/route table exist). Backup export uses a Blob download (replaces `window.location.href` at `ui/digest.js:1099`). **All Pro behaviour is gated here by `__RADAR_PRO_ENABLED__`** (see flag matrix below).
3. **Build switch (`package.json`):** `bun build ui/standalone-entry.ts --target browser --conditions=browser --minify-syntax --define __RADAR_STANDALONE_BUILD__="true" --define __RADAR_PRO_ENABLED__="false" --define 'process.env.RADAR_STORE_PATH'='".local-radar-store.json"' --define 'process.env.GEMINI_API_KEY'='""'` → output written as `extension/digest.js` (the bundle *is* digest.js; `digest.html` unchanged). The `process.env.*` defines are **required, not optional**: `lib/storage.ts:82,110,168` read them (line 82 at module top level — without defines the bundle crashes on load with `process is not defined`; verified in dry-run). `__RADAR_STANDALONE_BUILD__` is what lets `--minify-syntax` dead-code-eliminate the dev/localhost branch and the Pro alarm/`proChanged`/`rssUnread` wiring from the prod bundle (verified: 0 occurrences).
   - `bun run build:ext` = prod bundle + prod manifest + slim prod background worker (piece 4) + DNR ruleset (piece 5).
   - `bun run build:ext:dev` = today's plain `ui/` copy + localhost manifest (name suffixed "(Dev)" so builds are distinguishable in `chrome://extensions`).
   - `@google/genai/web` and the `youtubei.js` browser entry are selected via Bun build aliasing — zero source changes to `lib/summarizer.ts` / `lib/youtube.ts` unless M0 proves otherwise. The dynamic `node:fs/promises` imports in `lib/storage.ts:103,123` must not execute (or must be externalized) in the browser bundle — M0 verifies.
4. **Slim prod background worker:** prod `background.js` contains only `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` (+ action-click fallback). No `fetch`, no alarms, no notifications, no badge, no localhost string. The Phase 4 worker ships only in dev builds.
5. **DNR ruleset (proven required by M0):** `extension/rules.json` + `"declarativeNetRequestWithHostAccess"` permission, one rule — set `Origin: https://www.youtube.com`, `Referer: https://www.youtube.com/`, `Sec-Fetch-Site/Mode/Dest` for `||youtube.com/youtubei/` with `resourceTypes: ["xmlhttprequest"]`. Without it every in-browser search/transcript call is `403` (Decision 9). Static rules only — no `declarativeNetRequestFeedback`, no dynamic rules, no wildcard hosts.

#### Pro flag matrix — everything Pro is behind `__RADAR_PRO_ENABLED__`

| Pro feature (Phase 4) | Flag OFF (standalone v1, shipping) | Flag ON (server/dev today; standalone at M4) |
|---|---|---|
| 5-topic cap (`/api/sync` gate, `canAddMoreTopics`) | No gate; unlimited topics | Gate active |
| Pro toggle + upgrade line in Settings | Hidden (driven by state response) | Visible |
| `entitlements` in `/api/state` + `/api/entitlements` route | Route is a no-op; state reports Pro disabled | Real `{isPro, email, keyHash}` (M4 shape) |
| Backup import topic clamp | `enforceTopicLimit: false` — all topics kept | Clamp to cap (standalone: hard cap) |
| RSS polling, `rss-poll` alarm, notifications, badge, `rssSeen`/`rssUnread` | Absent: slim worker + no `alarms`/`notifications` permissions in prod manifest | Phase 4 worker behaviour |
| `proChanged` message / alarm wiring in UI toggle handler | Not reachable (toggle hidden) | Active |

No Pro feature may bypass the flag: a new Pro surface added to server/dev mode must land behind the same define (or be absent from the standalone route table/worker/manifest) in the same change.

## Milestones — scope, constraints, DoD

> **DoD conventions.** A milestone is done only when every box under its **DoD** is checked *and* its evidence is recorded in this file. "Clean profile" = fresh Chrome profile, no Bun server running, no other extension loaded. "No Pro surface" = flag-off behaviour per the matrix above. Any failed box is a **stop-and-report** (Decision 4), never a waiver; changing a DoD requires explicit owner sign-off, not an edit in passing. `[x]` = verified with evidence, `[ ]` = not yet verified.

| Milestone | Gate it unlocks | Owner approval needed | Status |
|---|---|---|---|
| M0 Browser spike | Any implementation | No | ✅ Passed 2026-10-29 |
| M1 Standalone build | M2 packaging | No | ✅ Done — all boxes green |
| M2 Store packaging | M3 submission | No | ✅ Automated gates green — owner items blocked |
| M3 Unlisted beta | M4 + public listing | Yes — store account + unlisted submission | 🚧 Prep automated — blocked on owner |
| M4 Pro in standalone | Monetized listing | Yes — explicit approval to monetize | Deferred |

### M0 — Browser spike (GO/NO-GO) — ✅ PASSED 2026-10-29

**Scope**
- Throwaway bundle (unpacked extension page) proving the four engine steps run from `chrome-extension://`: topic search (`lib/youtube.ts`), timed transcript, one Gemini summary (`lib/summarizer.ts`), IndexedDB write + read-back.
- Prove the bundle loads at all (no load-time `process` crash) and the three storage branches execute.

**Constraints**
- Throwaway artifacts only — no `lib/`, `ui/`, `extension/` product changes in this milestone.
- Must include the three proven prerequisites, or the spike is guaranteed to fail: DNR header rewrite (Decision 9), `process.env.*` build defines, fetch-bind patch.
- No network call may go to `localhost:3456`.

**DoD**
- [x] Search returns ≥1 filtered candidate from a `chrome-extension://` page.
- [x] `fetchTimestampedTranscript` returns >0 timed blocks for that video.
- [x] `summarizeVideo` returns a schema-valid summary (including the no-captions `fileData` fallback).
- [x] IndexedDB write + read-back succeeds; `chrome.storage.sync` topics and `chrome.storage.local` key round-trip.
- [x] Zero page/console errors and zero CSP violations on the exercised paths.
- [x] Zero `localhost:3456` requests in DevTools Network.
- [x] Caption-fetch hostnames recorded (result: only `www.youtube.com` → `*.googlevideo.com` not needed).
- [x] Bundle loads without a `process is not defined` crash.
- [x] Root cause of the observed `403` recorded (origin-based, not IP) so it is not re-litigated.

**Evidence**
Search: 1 candidate in ~1.9s (`This New AI Architecture Is 31x Faster (NCM)`). Transcript: 19 timed blocks + 16 chapters, ~12.8k chars, ~1.1s. Storage: sync topics, key save/read, digests all OK. Gemini: schema-valid summary via the `fileData` fallback in ~103s. Bundle: 2.19 MB (spike; final prod bundle 2.12 MB). Zero errors, zero localhost traffic. Origin proof: same POST → `200` from `https://www.youtube.com`, `403` from `chrome-extension://` for all 5 clients tried (±`visitorData`); Bun on the same network succeeds.

**Risks / recovery**
DNR header rewrite is the single point of failure; if store review rejects it, the fallback is a content script in a `youtube.com` tab — needs a new owner decision (Decision 9). Gate is open; M1 may start.

### M1 — Standalone build — ✅ done (all boxes green)

**Scope**
- The 5 build pieces above, with `__RADAR_PRO_ENABLED__=false`: `lib/engine.ts` (+ scan lock, seen-buffering), `ui/standalone-entry.ts` (fetch-bind → route table → import `digest.js`), build switch, slim prod worker, DNR ruleset.
- Prod manifest: drop `http://localhost:3456/*`, `alarms`, `notifications`; keep `storage`, `sidePanel`, `tabs`; add `declarativeNetRequestWithHostAccess`; hosts = `https://www.youtube.com/*` + `https://generativelanguage.googleapis.com/*`.
- Close→cancel behaviour (Decision 3) and the "keep this open while scanning" hint.

**Constraints**
- Mode chosen at build time only (Decision 2); no runtime mode switch, no localhost code path or permission in the prod build.
- **No Pro surface is active:** no topic cap, Pro toggle/upgrade UI ships hidden via `proEnabled:false` (hidden, not removed), no entitlements persistence, no import clamp, no RSS/alarm/notification/badge code or permissions (flag matrix).
- Gemini key stays in `chrome.storage.local` — never in `chrome.storage.sync`, backups, or entitlements.
- `bun run ui` behaviour unchanged; dev path (`build:ext:dev`) stays fully functional throughout.
- No new engines/frameworks; no background/offscreen scanning, no resume, no hand-off.

**DoD**
- [x] Prod build loads with no Bun server; starter packs render from local state (Playwright smoke, 2026-10-29).
- [x] Clean-profile run with no other extensions and no Bun server: the scripted manual pass below ran on a fresh profile against the prod build.
- [x] Gemini key saves in `chrome.storage.local` and survives a page reload; key excluded from backups (smoke A4 + backup payload has no key field).
- [x] Key, topics, and digest survive a full quit/relaunch of Chromium on the same profile (R1–R3).
- [x] A 6th topic can be added (smoke A6: `/api/sync` accepted 6 topics).
- [x] Standalone scan `maxVideos=1` returns 200 with 1 summarized video in ~25s, no errors (Playwright E2E, 2026-10-29).
- [x] `maxVideos=3` returns 3 videos and clicking a chapter timestamp sets the player to `start=0` (M3 acceptance A5/A6).
- [x] Export contains no key/entitlements; importing a backup with extra topics gives `topicsCount=13` with no clamp (M3 acceptance A7).
- [x] No Pro toggle visible in Settings (smoke A5); upgrade line follows `proEnabled` in `renderMetricsUI`.
- [x] Prod manifest has no localhost/alarms/notifications permission (`scripts/manifest.prod.json`; `grep` clean).
- [x] Zero `localhost:3456` requests and zero occurrences of the string in the prod bundle (smoke A3 + `grep` = 0).
- [x] Cancel test passes: page closed mid-scan → previous digest, metrics, and seen IDs unchanged (C1–C3); aborted scan leaves a live lock that expires stale (C4), cleaned afterwards (C5).
- [x] Second scan while one is in-flight returns 409 `scan_in_progress` across two pages; lock releases on settle and failed scans commit nothing (L1–L4).
- [x] Engine unit tests pass — 7/7 (`bun test tests/engine.test.ts`, incl. failed seen-write regression).
- [x] Playwright extension smoke passes — 6/6 assertions (`node tests/standalone-smoke.mjs`).
- [x] `tests/responsive-layout.spec.ts` still green — 7/7 against a `PORT=3459` server (2026-10-29).
- [x] Bundle size measured: **2.12 MB** (`--minify-syntax`, prod defines).

**Implementation notes (2026-10-29)**
- `ui/fetch-bind.ts` is the first import of the entry; `ui/digest.js` dispatches `/api/*` to `window.__RADAR_STANDALONE__` when set, otherwise keeps the localhost prefix.
- Pro UI is hidden via `proEnabled:false`, not removed at build time; RSS tokens `chrome.alarms.create`, `proChanged`, `rssUnread` and `localhost:3456` each appear **0 times** in the prod bundle.
- Extract/import route uses `importBackupJson(raw, { enforceTopicLimit: false })`; the server path keeps the default clamp.
- Zip/version packaging lives in M2 (`scripts/package-chrome.ts`, `scripts/verify-package.ts`).

**Tests / evidence**
`bun test tests/engine.test.ts` (7/7), `tests/phase4-contract.test.ts` (7/7), `tests/youtube-parser-guard.test.ts` (4/4), `bunx playwright test tests/responsive-layout.spec.ts` (7/7), `node tests/standalone-smoke.mjs` (6/6), plus a live standalone scan (200, 1 video, ~25s). The four manual boxes were run scripted against the prod build with a dummy key — no Gemini quota was needed, and YouTube search/transcripts supplied the in-flight window (13/13 checks: R1–R4 restart persistence, L1–L4 two-page lock, C1–C5 cancel).

**Risks / recovery**
`chrome.storage.sync` quota is fine for topics (small payload). Final prod bundle is **2.12 MB** (spike was 2.19 MB; both above the ~1.1 MB estimate) — assess first paint. Gemini fallback latency measured at ~103s for one video (≈35s burned per dead model candidate) — progress UI must not look hung. Recovery: dev path (`bun run ui` + `build:ext:dev`) remains fully functional and untouched.

### M2 — Store packaging — ✅ automated gates green; owner items blocked

**Scope**
- Shipped 2026-10-29: version **1.0.0** across prod/dev manifests + `package.json`; `scripts/package-chrome.ts` (version gate, deterministic zip, forbidden-entry refusal, sha256, verifier hook) exposed as `bun run package:chrome`; `scripts/verify-package.ts` (34 checks) as `bun run verify:package`; `store/privacy-policy.html`, `store/permissions.md`, `store/data-disclosure.md`, `store/listing.md`.
- Icons were done earlier: `extension/icons/` 16/32/48/128 (Fig. 02 "Play Origin"), wired through manifest, toolbar, notifications, favicon.
- Disclosure text: no developer server; Gemini key stored locally in `chrome.storage.local` and never synced or included in backups; topics/pins/preferences sync via the user's own Chrome sync; data sent only to YouTube/Google at the user's direction with the user's own key.

**Constraints**
- Zip built from the committed tree only — no dev artifacts, no `.env.local`, no localhost manifest, no `alarms`/`notifications`.
- Permission list minimal; every permission justified in writing (including the DNR header rule, Decision 9).
- No new features; packaging and disclosure only.

**DoD**
- [x] `bun run package:chrome` produces `dist/yt-topic-radar-v1.0.0.zip`; two consecutive runs gave identical sha256 `9f5fd1f3…9136` (fixed mtimes, sorted entries).
- [x] Artifact audit passes — `bun run verify:package` → `PASS 34 checks` (12 entries, slim worker, `rules.json`, no localhost/alarms/notifications/env/maps).
- [x] The extracted zip (not the source tree) loads in a fresh Chromium profile and passes the standalone smoke 6/6 (starter packs, key persistence, no localhost, Pro hidden, 6 topics).
- [ ] Second physical machine + full manual M1 checklist (blocked on owner).
- [x] Version 1.0.0 in prod/dev manifests + `package.json`; archive `yt-topic-radar-v1.0.0.zip` matches (build script fails on mismatch).
- [ ] Privacy policy **drafted** (`store/privacy-policy.html`, self-contained) — blocked on owner hosting + `[OWNER: support email]` / effective date.
- [x] `store/permissions.md` + `store/data-disclosure.md` written against the shipped manifest (permission set and DNR rule checked by the verifier).
- [x] Listing copy drafted (`store/listing.md`: ≤132-char short description, long description, Productivity/English, claims checklist).
- [ ] Screenshots, promo images, support contact, homepage URL (blocked on owner).

**Tests / evidence (2026-10-29)**
- `bun run package:chrome` → `dist/yt-topic-radar-v1.0.0.zip`, 12 entries, sha256 `9f5fd1f3e8a83dc628d2989531a4812f0d9cc2a16ea97b39438b6876d2809136`; rerun produced the identical hash.
- `bun run verify:package` → `PASS 34 checks` (manifest permissions/hosts, DNR rule, slim worker, no localhost/env/maps).
- Extracted the zip into a clean Chromium profile and ran `tests/standalone-smoke.mjs` → 6/6.
- Open: second physical machine, privacy-policy hosting, screenshots/promo images, support contact, homepage URL.

**Risks / recovery**
Icons were done early, so M2 is mostly paperwork. If the DNR rule draws review questions, respond with the Decision 9 justification; do not silently drop it (that would break scans).

### M3 — Unlisted beta launch — 🚧 launch prep automated; submission blocked on owner

**Scope**
- Chrome Web Store submission as **unlisted** (Decision 6), tester install link, soak period.
- Public flip is **not** part of M3 and needs separate explicit approval.

**Constraints**
- Unlisted only; no marketing/public listing.
- No scope additions during soak — fixes only, each with its own evidence.
- Operational items (store account, support/privacy contact, spare Gemini key) must be resolved before submission.

**DoD**
- [ ] Operational items below are all checked off.
- [ ] Listing approved and installable via the tester link.
- [ ] An external tester completes the M1 checklist **unaided** (only instruction: paste your Gemini key).
- [ ] Brave installs and completes the same checklist from the same listing.
- [ ] Soak period shows no blocker-severity defects (scan failure, data loss, localhost dependency); any found are fixed and re-verified.
- [ ] Public-flip decision explicitly deferred to the owner.

**Preparation shipped (2026-10-29)**
- `scripts/preflight-m3.ts` (`bun run preflight:m3`): hard gate over the built zip, version parity (package.json + `scripts/manifest.prod.json` + zip manifest), required `store/` files, owner placeholders, screenshots, and unchecked **pre-submission** steps. Post-approval and "submit for review" sections are excluded so `GO` is reachable. Current result: **NO-GO, blockers=40** (zip OK + verifier PASS + version 1.0.0; 24 owner placeholders / 12 unique, missing `store/screenshots/`, 27 unchecked steps).
- `tests/m3-acceptance.mjs`: opt-in end-to-end run against the **packaged zip** — **PASS 7/7** on 2026-10-29: load with zero errors and no localhost, starter packs, key persistence across reload, 6 topics, 3-video scan (200), timestamp click drives the in-app player (`start=`), export excludes key/entitlements, import keeps all 13 topics (exact count asserted). Re-runs that day hit Gemini quota (429) and a hanging model, so A5/A6 could not re-run; the harness now fails after `M3_SCAN_TIMEOUT_MS` (default 8 min) instead of hanging, and accepts `M3_SCAN_MAX_VIDEOS` for a cheaper run. A7 re-verified 13/13 topics after the assertion was tightened.
- Paperwork: `store/tester-instructions.md` (unaided tester script + report template), `store/submission-checklist.md` (ordered unlisted submission, 38 owner steps, exact artifact/version values), `store/release-notes-v1.0.0.md` (beta notes, exclusions, known limits).

**Tests / evidence**
Tester report(s) recorded in this file; listing ID + approval date; defect log with resolutions. `bun run preflight:m3` must print `GO` before submission.

**Risks / recovery**
Store review questions on host permissions, the DNR header rule, or remote code. Respond with justifications or reduce permissions; dev builds remain unaffected.

### M4 — Pro in standalone (deferred; activates the flag)

**Scope**
- Flip `__RADAR_PRO_ENABLED__` to `true` and land everything the flag was gating per the matrix: browser entitlements branch in `lib/storage.ts` (`chrome.storage.sync`, pre-shaped `{isPro, email, keyHash}` for Phase 5, still excluded from backups); standalone `/api/sync` gate with **hard cap**; import clamp via `enforceTopicLimit: true`; Pro toggle + upgrade UI visible.
- Phase 5 licence verification later replaces the manual flag *value*, not the flag mechanism.

**Constraints**
- Flag-on build only adds the surfaces listed in the matrix — no unrelated features.
- Standalone hard cap is an intentional divergence from server grandfathering; the server path and its Phase 4 contract tests must remain unchanged.
- Gemini key still never in `chrome.storage.sync`, backups, or entitlements (`keyHash` is a licence hash, not the Gemini key).
- Owner must explicitly approve monetizing the standalone listing; M4 does not start on schedule pressure alone.

**DoD**
- [ ] Flag-on build: 5 topics OK, 6th rejected (`upgrade_required`) — hard cap, no grandfathering.
- [ ] Pro toggle persists across a full browser restart (sync-stored entitlements).
- [ ] Import clamps topics to the cap but keeps all digests.
- [ ] Entitlements absent from backup export; `keyHash`/email never write the Gemini key anywhere.
- [ ] Flag-**off** build still passes the full M1 DoD (cap off, no toggle) — both builds verified.
- [ ] Standalone route tests cover the hard cap, toggle persistence, and import clamp.
- [ ] Phase 4 server contract tests still green (server semantics untouched).

**Tests / evidence**
Route tests for the standalone table + the existing `tests/phase4-contract.test.ts` unchanged and green; both flag-on and flag-off builds exercised and recorded.

**Risks / recovery**
Manual unlock is trivially bypassable — accepted until Phase 5 licence verification. Monetization disputes are owner decisions, not engineering ones.

**Separate fast-follow (not part of M4):** standalone-native RSS worker (Decision 8) — worker reads pinned channels + entitlements from `chrome.storage`, fetches `youtube.com/feeds/videos.xml` directly, reuses the Phase 4 seeding/notification/badge rules. Requires adding `alarms` + `notifications` permissions and fresh store-review justification, so it ships as its own change after M4.


## Explicitly out of scope (YAGNI)

Firefox / Safari / official Edge listing · **Pro in standalone v1** (all Pro features behind `__RADAR_PRO_ENABLED__=false`; activation is M4 — server/dev Phase 4 Pro is unaffected) · **RSS/alarms/notifications in standalone v1** (fast-follow after M4, Decision 8) · background/offscreen scanning · checkpoint/resume · scan hand-off between panel and tab · auto-migration from the server store · YouTube Data API fallback · in-place timestamp seek (tab navigation stays, per Phase 3 decision) · any change to `bun run ui` behaviour · accounts/cloud sync (Export/Import JSON is the portability story).

## Readiness check

| Question | Answer |
|---|---|
| What will change? | Extension works with no Bun/server: before = blank/dead standalone; after = install → paste key → scan, all in-browser. |
| What is excluded? | See out-of-scope list above. |
| What needs your decision? | **No material product decisions remain.** Pro is settled by deferral: all Pro features behind `__RADAR_PRO_ENABLED__=false` in v1, activation is M4. Operational only (below). |
| How will it be built? | Existing fetch-shim seam + existing browser storage branches + `lib/engine.ts` pipeline port + Bun browser bundle as `extension/digest.js`, with every Pro feature gated behind one build-time flag. **Built.** |
| How will success be proved? | M0 ✅ passed (sandbox Chromium, 2026-10-29, with the DNR ruleset); M1 automated gates ✅ (engine tests 7/7, smoke 6/6, responsive 7/7, live scan 200); M2 ✅ reproducible zip + 34-check audit + extracted-zip smoke. Remaining: manual M1 checklist and M2 second-machine install. |
| What could go wrong? | Store review rejects the DNR `Origin` rewrite → content-script fallback needs an owner decision (Decision 9). Store review pushback on permissions → reduce/justify. Dev mode is the always-working fallback. M3 is blocked on owner inputs (account, hosted policy, support email, screenshots, testers), surfaced by `bun run preflight:m3`. |

## Operational items (needed at M3, not before)

- [ ] Whose Chrome Web Store developer account ($5 one-time) publishes the listing.
- [ ] Support / privacy-policy contact email and hosting URL for the policy page (draft: `store/privacy-policy.html`).
- [ ] Homepage URL + screenshots/promo tiles for the listing (`store/listing.md` placeholders).
- [ ] Second physical machine + full manual M1 checklist (M2 DoD).
- [x] Spare Gemini API key used for M0/M1 verification scans (M0, live E2E).
