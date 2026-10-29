# YouTube Topic Radar — Plan (active)

> Completed work (Phases 1–3, 2.5) is archived in `docs/phase-history.md`.
> Commands and architecture live in `README.md` and `AGENTS.md` — this file
> holds product decisions and active work only, not duplicated setup docs.

## 1. Problem & Vision

YouTube is high-volume, much of it clickbait or filler; watching 30–60 min
videos to find takeaways wastes time.

**Goal:** topic-first radar — users subscribe to **topics** (e.g. `"Local LLMs"`,
`"Macroeconomics"`), the tool scans YouTube, filters slop, pulls timed
transcripts/chapters, and produces a **deep, video-type-aware digest that never
misses crucial points**, with clickable `[MM:SS]` timestamps + optional read-aloud.

## 2. Market Landscape & Monetization Viability

1. **Single-video summarizers** (*Eightify, Glasp, NoteGPT, Gemini in Chrome*):
   summarize after you open a video; increasingly commoditized.
2. **Channel-to-newsletter tools** (*TubeLM, Readless*): monitor channels via
   RSS (`youtube.com/feeds/videos.xml?channel_id=...`), but require knowing
   channels upfront.
3. **The gap (moat):** **topic-first discovery + anti-slop filtering +
   video-type-aware deep extraction + cross-video synthesis.**

Users pay for curated signal, not basic summaries. Benchmarks: Eightify ~$5–10/mo,
Glasp $12.50–30/mo, TubeAI $59/mo. Segments: professionals/investors ($10–20/mo),
creators/researchers ($19–39/mo), power learners (one-time BYOK license).

## 3. Medium Decision

**Browser Extension (Chrome/Brave/Edge), 100% TypeScript**, sharing `lib/` between
CLI testing and the packaged extension. Rationale: 1-click install (no OS
code-signing); runs on the user's residential IP/session (zero blocks, $0 proxy);
lives beside YouTube (`chrome.sidePanel` + digest tab); monetization via
ExtensionPay/BYOK. The extension is a thin shell over the local Bun server
(`http://localhost:3456`) — see `AGENTS.md`.

## 4. The 4-Step Pipeline (pressure-tested spec)

1. **Topic search (`scanner`)** — `youtubei.js` (`Innertube`) per-topic search
   (Shorts `< 3 min` excluded); native RSS polling for pinned channels.
2. **Anti-slop filter (`filter`)** — score before spending LLM tokens: author
   chapters parsed from search payload (zero extra requests); clickbait-title
   penalties (`"SHOCKING"`, all-caps); view velocity (`views / ageDays`) over
   channel size. Top 3–5 per topic.
3. **Timed transcripts + native fallback (`transcript`)** — `yt.getInfo()` +
   `/youtubei/v1/player` (`ANDROID`) grouped into **~45s blocks** (`[04:30] ...`).
   Zero-dead-end fallback: empty/disabled captions → pass the YouTube URL to
   Gemini native `fileData` multimodal input.
4. **Type-aware summarization (`summarizer`)** — `> 25 min` videos split into
   20-min windows (`chunkTranscriptByWindow`); sequential processing
   (concurrency 1), 35s timeout, `429`/`503` backoff + model fallback.
   Strict schema: `videoType` (`tutorial` | `news_analysis` | `podcast_interview` |
   `review_comparison`), 2-sentence `coreThesis`, full `[MM:SS]` `chapterBreakdown`,
   type-specific details (tutorial steps/gotchas; news numbers/counter-arguments;
   podcast insights-by-speaker; review pros/cons/verdict), `worthWatchingFull`
   verdict + reason.
5. **MV3 resilience** — interactive scans run from the open Digest Tab / Side
   Panel, never inside the 30s-limited MV3 service worker; `background.js` handles
   toolbar actions + lightweight RSS alarm checks only.

## 5. Phase 4 — Pro Tier: shipped, one manual check left

**Status: implemented** (commits `447a7f4`, `50adb93`). All automated DoDs green;
one manual DoD remains below.

- **Decision:** background alarms, auto-updates, notifications, unlimited topics
  are **Pro-only**. Free keeps manual scans, capped at **5 topics**.
- **Constraints:** free users cannot trigger polling at all (server-enforced, not
  just hidden UI); entitlement checks in `POST /api/sync` and `GET /api/rss`;
  backward compatible (no entitlement data in backups); local `isPro` flag only —
  real licence tracking is Phase 5.
- **Design (KISS/YAGNI):** Bun server is the only source of truth; background
  worker asks `GET /api/state`, no `chrome.storage` state mirror (keys kept:
  `rssSeen`, `rssUnread` only). Cut: entitlement branches in browser storage,
  `onChanged` sync wiring, per-topic badge, poll-interval UI, auto-scan on new
  video, content-script seek, separate upgrade URL (reuse `proUpgradeUrl`).
- **Agreed rules:** `POLL_MINUTES = 30`, single `rss-poll` alarm, sequential
  per-channel polling; free `GET /api/rss` → `403 { error: "upgrade_required" }`;
  notification click opens full-tab `digest.html?topic=<enc>` (+ best-effort
  `sidePanel.open().catch(() => {})`); badge = total new (`""`/`N`/`"9+"`),
  cleared on digest open/scan/notification click; over-limit free users
  grandfathered (server rejects only **growth** beyond `max(current, 5)`);
  backup import clamps free to `max(current, 5)` (never truncates; digests kept);
  first poll per channel seeds silently; payments = manual `Unlock Pro (I paid)`
  toggle.
- **Test isolation (durable rule):** tests spawn the server from the repo root
  with `PORT=3459` + `RADAR_STORE_PATH=<tmp>/store.json` (temp cwd does not work —
  `server.ts` serves `ui/*` cwd-relative). Contract tests must never touch the
  real `.local-radar-store.json`. See `AGENTS.md`.

### Definition of Done

- [x] `/api/state` returns `monetization.mode === "freemium"`, `freeTopicLimit: 5`,
  `entitlements.isPro` (survives reload, absent from backups).
- [x] 6th topic blocked in all 3 UI paths + direct `POST /api/sync`
  (403 free / 200 Pro); over-limit free users can still delete/star/pin.
- [x] Free: no `rss-poll` alarm; Pro: exactly one. Downgrade clears it without
  restart. Server down → poll touches nothing, resumes next cycle.
- [x] Contract tests green: `bun test tests/phase4-contract.test.ts` (6/6:
  state/freemium, 5-ok/6-403, RSS 403, boolean validation, backup excludes
  entitlements, grandfather re-save/growth/import-clamp) with real store hash
  unchanged. Parser guard green: `bun test tests/youtube-parser-guard.test.ts`.
  (Note: `tsc --noEmit` is **not** a gate — it has pre-existing errors in
  untouched files: `demo_*.spec.ts`, `lib/storage.ts:79 indexedDB`,
  `lib/youtube.ts sort_by`.)
- [x] README reflects freemium + cap + Pro features; ZIP regenerated from the
  committed tree; `bun run build:ext` diff clean.
- [ ] **Manual (owner: maintainer, trigger: next real publish from a pinned
  channel):** new video → exactly one notification across two alarm runs, badge
  shows total, click opens the digest on that topic, badge clears on open.
  Verified live except the real-publish trigger (2026-10-29, headed Chromium on
  a real GNOME desktop against the real `background.js`: startup `rss-poll:30`
  for Pro / `[]` for free; empty real feed never seeds; first sight seeds IDs
  with 0 notifications; new video → `rssUnread` 1, badge `"1"`, single
  notification object `rss|<topic>|<videoId>`; second run → 0 repeats;
  downgrade clears alarm + state + badge without restart). The real D-Bus
  `Notify` signal was captured at the OS: app `Google Chrome for Testing`,
  summary = channel name, body = video title, icon = extension `icon.png`,
  actions `default/Activate` (a duplicate bus echo came from a system watcher;
  Chrome holds exactly one notification object). Feed bytes were stubbed at the
  SW `fetch` boundary because this sandbox gets `404` for **all**
  `youtube.com/feeds` channels — the diff/notify/badge/click-target code paths
  exercised are identical. Residual for the real event: toast pixel rendering +
  physical click activation only (no input automation exists here; Shell `Eval`
  is restricted; `?topic=` routing + URL strip already verified live). If no
  real publish event occurs, this stays open — it does not block Phase 5.

## 6. Phase 5 (deferred) — Real Payments + Identity

Phase 4 cannot know who paid. Phase 5: separate Pro payment link (not the tip
link) + webhook → licence key (UUID/JWT with email) → paste-to-unlock in Settings
→ server-side signature verify → persist `{ isPro, email, keyHash }` outside
backups, plus revoke/refund handling. Provider (ExtensionPay vs Stripe/Razorpay)
decided there.
