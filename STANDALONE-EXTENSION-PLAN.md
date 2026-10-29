# Standalone Chrome Extension — Implementation Plan (KISS/YAGNI)

Status: **Signed-off scope, NOT yet implemented.** Implementation starts at the M0 spike gate.
Saved: 2026-10-28. Supersedes the earlier standalone plan discussion in-session.

## Decisions locked (by product owner)

| # | Decision |
|---|---|
| 1 | **Chrome first.** Brave is covered by the Chrome Web Store listing. Edge official listing, Firefox, Safari: deferred. |
| 2 | **`bun run ui` is DEV-only fallback.** Prod extension contains no localhost code path or permission. Mode is chosen at build time, never runtime. |
| 3 | **Close tab/panel → scan cancels.** Scan runs in the page clicked (side panel or Dashboard tab). Closing aborts; no partial digest saved; previous digest for the topic stays intact; metrics/seen only increment on completion. No hand-off, no checkpoint/resume, no background/offscreen scanning in v1. |
| 4 | **Spike failure → stop & re-decide.** If the M0 browser spike fails (e.g. Innertube blocked from `chrome-extension://`), implementation halts and the owner picks a fallback. No silent scope change (no YouTube Data API fallback pre-authorized). |
| 5 | **Manual data migration.** Existing server data (`.local-radar-store.json`) moves via Export `.json` (dev UI) → Import (standalone). API key is excluded from backups by design and is re-pasted. No auto-import. |
| 6 | **Unlisted beta first.** First Chrome Web Store release is unlisted for testers; flipping to public requires separate explicit owner approval. |

## Goal / Problem

- **Goal:** A user on any computer installs the extension from the Chrome Web Store, pastes their own Gemini API key, and scans topics end-to-end — with no Bun, no local server, nothing else running.
- **Problem today:** The extension is a thin shell over `bun run ui` (`http://localhost:3456`). Without the server, starter packs are blank (come from `GET /api/state`), the Gemini key shows missing (stored server-side), and every action fails silently. Verified 2026-10-28 by loading the extension standalone in Chrome.

## Architecture (keep what's already shaped for this)

- The UI/engine seam already exists: `ui/digest.js:1-19` overrides `fetch("/api/*")`. That shim is the only integration point — route it to a local handler instead of refactoring call sites.
- `lib/storage.ts` already has browser backends, no rewrite needed:
  - `chrome.storage.sync` — topics/settings (`lib/storage.ts:124-151`)
  - `chrome.storage.local` — Gemini key (`lib/storage.ts:153-179`)
  - IndexedDB (`idb-keyval`) — digests, metrics, seen IDs (`lib/storage.ts:181-289`)
  - `STARTER_TOPICS` constant (`lib/storage.ts:49-53`)
- Scan pipeline is ~50 lines (`server.ts:149-202`), portable near-verbatim into the page.
- No backend, no accounts, no telemetry server. BYOK key + user's residential IP is the whole design.

### The build (3 small pieces)

1. **`lib/engine.ts`** (~60 lines): port of `server.ts:149-202` — search → transcript → summarize → synthesize → `saveTopicDigest` / `updateMetrics`. Optional progress string only; no framework, no job state machine.
2. **`ui/standalone-entry.ts`** (~80 lines): installs `window.__RADAR_STANDALONE__` with a small route table for the existing `/api/*` paths (state, sync, key, metrics, scan, backup export/import) backed by `lib/` + `engine.ts`, then imports `ui/digest.js`. Backup export uses a Blob download (replaces `window.location.href` at `ui/digest.js:928`).
3. **Build switch (`package.json`):** `bun build ui/standalone-entry.ts --target browser` → output written as `extension/digest.js` (the bundle *is* digest.js; `digest.html` unchanged).
   - `bun run build:ext` = prod bundle + prod manifest.
   - `bun run build:ext:dev` = today's plain `ui/` copy + localhost manifest (name suffixed "(Dev)" so builds are distinguishable in `chrome://extensions`).
   - `@google/genai/web` and the `youtubei.js` browser entry are selected via Bun build aliasing — zero source changes to `lib/summarizer.ts` / `lib/youtube.ts` unless M0 proves otherwise. The dynamic `node:fs/promises` imports in `lib/storage.ts:98,118` must not execute (or must be externalized) in the browser bundle — M0 verifies.

## Milestones (prioritized, independently verifiable)

### M0 — Browser spike (GO/NO-GO GATE)
- **Scope:** Throwaway bundle loaded in an unpacked extension page. Search 1 topic (`lib/youtube.ts`), fetch 1 timed transcript, run 1 Gemini summary (`lib/summarizer.ts`), write + read back via IndexedDB.
- **DoD:** All four steps succeed from a `chrome-extension://` page; zero console/CSP errors; DevTools Network shows **zero** `localhost:3456` requests; caption-fetch hostnames recorded (decides if a `*.googlevideo.com` host permission is needed).
- **Tests:** Manual DevTools checklist only. No unit tests for a throwaway.
- **Risks:** Innertube 403 / PO-token requirement in browser; `eval` in bundle (MV3 CSP); `node:` import leakage. **Recovery: STOP, report evidence, owner re-decides (Decision 4).** Nothing else starts until M0 passes.

### M1 — Standalone build
- **Scope:** The 3 build pieces above. Prod manifest: remove `http://localhost:3456/*` and unused `alarms`; add caption host permission only if M0 evidence requires it; keep `storage`, `sidePanel`, `tabs`. Includes the close→cancel behaviour (Decision 3) and the "keep this open while scanning" hint.
- **Dependencies:** M0 passed.
- **DoD (clean Chrome profile, no Bun running):** install → starter packs visible → save Gemini key → key persists across full browser restart → add topic → scan with `maxVideos=1`, then 3 → digest renders identically to server mode → `[MM:SS]` player works → Export/Import round-trips topics+digests+metrics (key excluded, re-paste works).
- **Cancel test:** start a 3-video scan, close the page mid-scan, reopen → previous digest unchanged, no metrics/seen increments (they only happen on completion).
- **Tests (lightweight):** existing `tests/responsive-layout.spec.ts` still green against dev server; one new Playwright persistent-context smoke (`--load-extension`, no server) asserting starter packs render + key save persists after page reload. Real-key 1-video scan = manual checklist.
- **Risks:** `chrome.storage.sync` quota (topics payload is small — fine); bundle first-paint cost (~1.1 MB est.). **Recovery:** dev path (`bun run ui` + `build:ext:dev`) remains fully functional and untouched throughout.

### M2 — Store packaging
- **Scope:** Icons 16/32/48/128 generated from `assets/logo-256.png` (manifest currently has none), version bump, `package:chrome` script → versioned zip in `dist/`, privacy policy page, store listing copy + per-permission justifications + data-disclosure form ("no developer server; key stored locally in `chrome.storage.local`; data sent only to YouTube/Google at user direction with user's own key").
- **Dependencies:** M1.
- **DoD:** Zip loads unpacked on a second machine/clean profile with no dev setup and passes the M1 scan checklist; permission list is minimal, each justified in writing.
- **Tests:** Fresh-profile install + M1 checklist on that second profile.

### M3 — Unlisted beta launch
- **Scope:** Chrome Web Store submission as **unlisted** (Decision 6), tester install link, soak period. Public flip is a separate owner approval, not part of M3.
- **Dependencies:** M2 + operational items below.
- **DoD:** Listing approved; an external tester completes the M1 checklist unaided (no instructions beyond "paste your Gemini key"). Brave installs from the same listing.
- **Risks:** Store review questions on host permissions / remote code. **Recovery:** respond with justifications or reduce permissions; dev builds unaffected.

## Explicitly out of scope (YAGNI)

Firefox / Safari / official Edge listing · Phase 4 Pro (`MONETIZATION_CONFIG` freemium flip, alarms, notifications, unlimited topics) · background/offscreen scanning · checkpoint/resume · scan hand-off between panel and tab · auto-migration from the server store · YouTube Data API fallback · in-place timestamp seek (tab navigation stays, per Phase 3 decision) · any change to `bun run ui` behaviour · accounts/cloud sync (Export/Import JSON is the portability story).

## Readiness check

| Question | Answer |
|---|---|
| What will change? | Extension works with no Bun/server: before = blank/dead standalone; after = install → paste key → scan, all in-browser. |
| What is excluded? | See out-of-scope list above. |
| What needs your decision? | **No material product decisions remain.** Operational only (below). |
| How will it be built? | Existing fetch-shim seam + existing browser storage branches + 50-line pipeline port + Bun browser bundle as `extension/digest.js`. |
| How will success be proved? | M0 DevTools evidence; M1 clean-profile checklist + 1 Playwright extension smoke; cancel test; M2 second-machine install. |
| What could go wrong? | M0 Innertube/CSP failure → stop-and-re-decide gate. Store review pushback → permission reduction. Dev mode is the always-working fallback. |

## Operational items (needed at M3, not before)

- [ ] Whose Chrome Web Store developer account ($5 one-time) publishes the listing.
- [ ] Support / privacy-policy contact email and hosting URL for the policy page.
- [ ] A spare Gemini API key (test quota) for M0/M1 verification scans.
