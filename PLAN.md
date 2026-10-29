# YouTube Topic Radar — Context Discussion & MVP Plan

## 1. Problem & Vision
YouTube has massive amounts of content—some high-signal, much of it clickbait or filler. Searching manually and watching 30–60 minute videos to find the key takeaways wastes time.

**Goal:** Build an AI-powered "Topic Radar" (similar to RSS topic discovery, but for YouTube).
- Users list their preferred **content topics** (e.g., `"Local LLMs"`, `"Rust Async"`, `"Macroeconomics"`).
- The tool scans YouTube for related channels and videos, filters out low-signal clickbait, pulls the timed transcripts/chapters, and generates a **deep, video-type-aware summary that never misses crucial points**.
- Users read the structured digest grouped by topic (with clickable `[MM:SS]` timestamps and optional audio read-out).

---

## 2. Market Landscape & Monetization Viability

### Existing Landscape (2026)
1. **Single-Video Summarizers** (*Eightify, Glasp, NoteGPT, Gemini in Chrome*): Summarize a video *after* you open it. Free tools increasingly commoditize single-video summaries.
2. **Channel-to-Newsletter Tools** (*TubeLM, Readless*): Monitor specific YouTube channels via RSS (`youtube.com/feeds/videos.xml?channel_id=...`), but require knowing which channels to follow beforehand.
3. **The Gap (Our Moat):** **Topic-first discovery + anti-slop filtering + video-type-aware deep extraction + cross-video synthesis.**

### Will Users Pay?
**Yes—when selling curated signal rather than basic single-video summaries.**
- **Market Pricing Benchmarks:**
  - *Eightify*: ~$5–$10/mo (500k+ users, 3 free/week).
  - *Glasp Pro/Unlimited*: $12.50–$30/mo for tracking multiple channels and auto-summarizing uploads.
  - *TubeAI*: $59/mo for topic/channel research.
- **Target Paying Segments:**
  1. **Professionals & Investors ($10–$20/mo):** Tracking fast-moving domains (AI engineering, markets, biotech) where missing key benchmarks or talks is costly.
  2. **Creators & Researchers ($19–$39/mo):** Synthesizing weekly trends across 10–20 topics.
  3. **Power Learners ($19–$29 one-time BYOK license):** Bring-Your-Own-API-Key tier for tech-savvy users who dislike subscriptions.

---

## 3. Medium Comparison: Browser Extension vs. Desktop App

**Decision:** **Browser Extension (Chrome/Brave/Edge)** built in **100% TypeScript**, sharing the exact same engine modules (`lib/youtube.ts`, `lib/summarizer.ts`, `lib/storage.ts`) between fast CLI testing (`bun run`) and the packaged Chrome Extension.

| Factor | Browser Extension | Desktop App (Electron / Tauri) |
| :--- | :--- | :--- |
| **User Friction** | 1-click install, no OS security popups. | High friction; requires $100–$400/yr OS code-signing certs. |
| **YouTube Anti-Bot & Captions** | Runs on user's residential IP & browser session — zero blocks, $0 proxy cost. | Headless requests lack browser session unless embedding Chromium. |
| **User Workflow** | Lives right beside YouTube (`chrome.sidePanel` + Full-Page Digest Tab). Timestamp clicks jump video immediately. | Requires switching apps or using an embedded player. |
| **Monetization** | Drop-in via ExtensionPay (Stripe) or BYOK license. | Requires custom license server + OS keychain integration. |

---

## 4. Tools, APIs, and SDKs

### TypeScript Stack (Single-Stack: CLI Prototype + Chrome Extension)
- **Runtime & Package Manager:** **Bun** (`package.json`, `tsconfig.json`) — runs the core engine from the CLI (`bun run scan`), serves the local dashboard API (`bun run ui`), and shares the exact same TypeScript modules (`lib/`).
- **Dashboard & Extension UI (`ui/digest.html` → `extension/`):** Vanilla HTML/TypeScript + Tailwind CSS (Manifest V3 scaffold; currently uses Tailwind Play CDN and an inline module script, which Phase 3 externalizes for MV3 CSP compliance).
- **YouTube Discovery & Transcripts (`lib/youtube.ts`):** `youtubei.js` (`Innertube`) for topic search/metadata + direct `/youtubei/v1/player` (`ANDROID` client) for timed captions + native YouTube Channel RSS (`youtube.com/feeds/videos.xml?channel_id=...`). Zero API quota limits.
- **AI Summarization (`lib/summarizer.ts`):** `@google/genai` with structured JSON Schema output and a fallback chain (`gemini-3-flash-preview` → `gemini-3.8-flash` → `gemini-3.5-flash` → `gemini-flash-latest`) because model availability varies by API key.
- **Storage (`lib/storage.ts`):** Dual-target module — writes to `.local-radar-store.json` when called by the Bun server/CLI (current path for both Web UI and extension), and includes `chrome.storage.sync` + `chrome.storage.local` + `IndexedDB` (`idb-keyval`) branches for standalone in-browser execution, plus 1-click JSON Export/Import backup.
- **Audio Read-Out:** Browser native `window.speechSynthesis` (shipped in Phase 2).

---

## 5. Topic Subscription UI, Storage Architecture & User Flow

### A. Topic Subscription UI (Starter Packs + Custom Search)
- **Curated Starter Topics (Onboarding Grid):** 1-click topic pills grouped by category to avoid blank-page paralysis:
  - *Tech & AI:* `AI Coding Agents`, `Local LLMs`, `System Design`, `Rust & Go`
  - *Finance & Markets:* `Macroeconomics`, `Value Investing`, `Crypto Infrastructure`
  - *Science & Health:* `Longevity & Science`, `Space & Physics`
- **Custom Topic Input:** `+ Add any topic...` input in the sidebar for arbitrary user queries (e.g., `"Next.js performance"`, `"PostgreSQL indexing"`).
- **Topic Sidebar at Scale:** Search/filter input and `All | Ready | ★ Starred` tabs keep 20–50+ topics navigable. Topics stay a **flat list** (no parent/child nesting); starred topics pin to the top.
- **AI Sub-Topic & Channel Suggestions:** After scanning a topic, suggest narrower sub-topics as one-click chips that are added as flat topics, and offer a `[📌 Pin Channel]` button for high-signal creators discovered during the scan.

### B. State Persistence (`lib/storage.ts` — Zero Cloud DB Required for MVP)
- **Active Path (Server-Backed UI & Extension):** All `/api/*` calls persist to `.local-radar-store.json` via `server.ts` (in-memory cached + write-serialized). Summarized video IDs are automatically recorded in `seenVideoIds` during `/api/scan`.
- **Browser-Native Branches (Implemented in `lib/storage.ts` for standalone extension mode):**
  1. **`chrome.storage.sync`:** Subscribed topics, `topicMeta`, `telemetryOptIn`, pinned channel IDs, and `minDurationSec`.
  2. **`chrome.storage.local` + `IndexedDB` (`idb-keyval`):** Gemini API key (`chrome.storage.local`), generated digests (`IndexedDB` / `local`), `seenVideoIds`, and `UsageMetrics`.
- **1-Click Export / Import JSON Safeguard:**
  - **`[Export Backup .json]`**: Downloads a timestamped `yt-topic-radar-backup-YYYY-MM-DD.json` containing topics, `topicMeta` (starred state, telemetry opt-in), pinned channels, saved digests, seen-video IDs and usage metrics (API key excluded).
  - **`[Import Backup .json]`**: Restores and merges topics, channels, digest history and metrics in one click without duplicates.

### C. End-to-End User Flow
1. **Install & Open Extension:** Opens the **Topic Radar Dashboard** (full tab today; Chrome `sidePanel` in Phase 3).
2. **30-Second Setup:** Paste Gemini API key + click 2–3 Starter Topic pills (or type a custom topic). Free tier supports up to 5 topics.
3. **Scan Topic:** Click `[Scan Topic Now]` (Pro: or let background `chrome.alarms` poll pinned channels).
4. **Read the Digest:**
   - **Top Card:** Cross-Video Topic Synthesis (*"Across 4 videos this week, here is the consensus and what's new..."*).
   - **Video Digest Cards:** Shows Video Type badge (`Tutorial`, `News`, `Podcast`, `Review`), Watch Verdict (`Yes` / `Skim timestamps` / `Skip`), 2-sentence Core Thesis, and expandable Chapter Breakdown + Type-Specific details with clickable `[MM:SS]` links.
   - **Card Actions:** `[🔊 Read Aloud]`, `[📌 Pin Channel]`, `[Watch on YouTube ↗]`.
5. **Dive Deeper (Docked Video Player):** Clicking any `[MM:SS]` timestamp opens the in-page right-hand `#videoSidePanel` drawer with an embedded YouTube player (`youtube.com/embed/...?start=...`) at that exact second alongside docked summary notes.

---

## 6. The 4-Step Pipeline (How It Works — Pressure-Tested)

1. **Topic Search (`scanner`)**
   - Query YouTube via `youtubei.js` (`Innertube`) for videos matching the user's topic (excluding Shorts `< 3 mins`).
   - Poll native RSS feeds (`youtube.com/feeds/videos.xml?channel_id=...`) for pinned channels.
2. **Anti-Slop Quality Filter (`filter`)**
   - Score candidates before spending LLM tokens:
     - Parse `expandable_metadata` / description timestamps from the search payload to detect author-written chapters in **zero extra HTTP requests**.
     - Penalize clickbait title patterns (`"SHOCKING"`, `"IT'S OVER"`, excessive all-caps) so niche high-signal videos beat drama/reaction channels.
     - Weight view velocity (`views / ageDays`) over raw channel size.
   - Select the **Top 3–5 highest-signal videos** per topic.
3. **Timed Transcript Extraction + Native URL Fallback (`transcript`)**
   - Pull video description + chapters via `yt.getInfo(videoId)` and timed captions via direct `/youtubei/v1/player` (`ANDROID` client context).
   - Group into **~45-second timestamped blocks** (`[04:30] ...`) so every extracted insight retains an exact timestamp link.
   - **Zero-Dead-End Fallback:** If a video has disabled captions or `timedtext` is empty, pass the YouTube URL directly to Gemini's native `fileData: { fileUri: video.url, mimeType: "video/mp4" }` multimodal input.
4. **"Never Miss a Point" Type-Aware Summarization (`summarizer`)**
   - **Window Chunking for Long Videos (`> 25 mins`):** Split long transcripts into 20-minute windows (`chunkTranscriptByWindow`) so Gemini's output limit never compresses a multi-hour video into vague bullets.
   - **Rate-Limit Guard (Free-Tier BYOK Safe):** Process videos and 20-minute windows sequentially (concurrency = 1) with a 35s per-request timeout, automatic `429`/`503` exponential backoff, and model fallback.
   - Pass the timestamped transcript to **Gemini Flash** (fallback chain above) with a strict structured schema:
     - `videoType`: `tutorial` | `news_analysis` | `podcast_interview` | `review_comparison`
     - `coreThesis`: 2-sentence spoiler-free/clickbait-busting takeaway.
     - `chapterBreakdown`: Chronological `[MM:SS]` breakdown covering every section of the video so nothing important is skipped.
     - `typeSpecificDetails`:
       - *Tutorial:* Exact steps, tools/commands/libraries mentioned, and gotchas.
       - *News/Analysis:* Hard numbers/benchmarks, core claims, counter-arguments.
       - *Podcast/Interview:* Insights by speaker + contrarian takes.
       - *Review:* Pros, cons, benchmarks, verdict.
     - `worthWatchingFull`: `"Yes"` | `"Skim timestamps"` | `"Skip (Summary has everything)"` + reason.
5. **MV3 Service Worker Resilience**
   - Run interactive scans initiated from the open **Digest Tab / Side Panel** (never inside the 30s-limited MV3 service worker); `POST /api/scan` saves the completed `TopicDigest` and updated `UsageMetrics` on the local Bun server once synthesis finishes. Use `background.js` only for toolbar action handling and (in Phase 4) lightweight RSS alarm checks.

---

## 7. MVP Milestones

- **Phase 1 — Core Engine (`bun run` TypeScript CLI Prototype): ✅ Done**
  - `lib/youtube.ts`, `lib/summarizer.ts`, `lib/storage.ts`: search, filter, timed transcripts, structured Gemini summaries, cross-video synthesis.
- **Phase 2 — Digest Dashboard UI: ✅ Done**
  - Starter Topic pills + custom topic sidebar, cross-video synthesis card, video digest cards with `[MM:SS]` links, Read Aloud, JSON Export/Import.
- **Phase 2.5 — Post-MVP Refinements: ✅ Done**
  - Reactive sidebar, topic search/starring, usage metrics, value pill and Support CTA. Details in §8.
- **Phase 3 — Browser Extension Side Panel & Engine Wiring: ✅ Done**
  - **Goal:** deliver the Phase 2 dashboard as an installable MV3 extension (side panel beside YouTube + full-tab view) that drives the `lib/` engine via the local Bun server (`http://localhost:3456`).
  - **Implemented:**
    1. **MV3 CSP compliance (`ui/digest.html`, `ui/digest.js`, `ui/digest.css`):** Externalized the inline `<script type="module">` to `digest.js` and replaced `cdn.tailwindcss.com` + inline `<style>` with local `digest.css`.
    2. **Host permissions & CORS (`extension/manifest.json`, `server.ts`):** Added `http://localhost:3456/*` to `host_permissions` and `"tabs"` to `permissions`; added `OPTIONS` preflight (`204`) and `Access-Control-Allow-*` headers + `/digest.js` and `/digest.css` static routes in `server.ts`.
    3. **Side Panel activation & ~360px responsive layout (`extension/background.js`, `ui/digest.*`):** Switched `background.js` to `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`; made `#topicsSidebar` a slide-over drawer (`#btnToggleSidebar`) below `640px` and `#videoSidePanel` a full-pane overlay below `900px`.
    4. **Backup export & timestamp deep-linking (`ui/digest.js`):** Updated `#btnExportBackup` to use `${API_BASE}/api/backup/export`; added `#sidePanelYtWatchLink` fallback and active YouTube tab seeking via `chrome.tabs.query` in `openSidePanelPlayer`.
  - Packaging (documented + verified): `bun run build:ext && (cd extension && zip -r ../yt-topic-radar-extension.zip .)` for ZIP + "Load unpacked"; `chrome://extensions` → **Pack extension** for a `.crx` (keep the generated `.pem` for future updates).
  - **Definition of Done (DoD):**
    - [x] Toolbar icon opens the **side panel** (`chrome.sidePanel`), and layout is usable at ~360px width as well as full-tab width.
    - [x] Extension loads topics, digests and metrics from `http://localhost:3456` with zero MV3 CSP or CORS errors.
    - [x] `Scan Topic Now` runs end-to-end from the extension and persists the resulting digest and metrics.
    - [x] Clicking a `[MM:SS]` timestamp opens the embedded player at that exact second (or seeks the active YouTube tab).
    - [x] Both Export `.json` (`API_BASE + "/api/backup/export"`) and Import `.json` work from inside the extension.
    - [x] `bun run build:ext` + ZIP produces a package that loads unpacked on a clean profile.
    - [x] CLI & local web paths (`bun run scan`, `bun run ui`) behave identically to before.
    - [x] **Security (§3.1 resolved):** CORS headers restricted to `localhost` and `chrome-extension://` origins; arbitrary websites cannot read user data or POST to `/api/scan`.
  - **Design decision — `seekOpenYouTubeTab` behaviour (§3.3):** `chrome.tabs.update(tabId, { url: "...&t=Ns" })` **navigates** (reloads) the open YouTube tab to the timestamped URL rather than seeking in-place. This is accepted for MVP because it requires only the `tabs` permission and no content script. In-place seek (via a content script `postMessage` to the YouTube player) is deferred to Phase 4+.
- **Phase 4 — Pro Tier Gating + Background Automation: ✅ Implemented, verification pending (2026-10-28, working tree)** — one manual DoD remains: OS notification on a real new video from a pinned channel (§9 M2).
  - **All four Phase 4 features are paid-only**: background alarms, auto-updates, notifications, and unlimited topics (free tier capped at **5**).
  - Requires flipping `MONETIZATION_CONFIG` from `"free_byok"` to `"freemium"` and introducing an `isPro` entitlement. Details and DoD in §9.

---

## 8. Phase 2.5 — Post-MVP Refinements (4 Tracked Issues)

### Overall Context, Goal, Scope & Constraints
- **Context:** Phase 1 (Core Engine) and Phase 2 (Digest Dashboard UI + Extension Scaffold) are live and tested against real YouTube topics (`"AI Coding Agents"`). During initial usage testing, 4 UX/product gaps surfaced around sidebar state reactivity, scaling to many topics, usage instrumentation, and monetization/support hooks.
- **Goal:** Make the sidebar immediately reactive after scans, scale cleanly to 20–50+ subscribed/sub-topics, track privacy-safe local value metrics (`secondsSaved`, `videosSummarized`, `slopVideosFiltered`), and surface a value-driven Support/Tip CTA with a config-ready Pro tier hook.
- **In-Scope:** `lib/youtube.ts`, `lib/summarizer.ts`, `lib/storage.ts`, `server.ts`, `ui/digest.html`.
- **Out-of-Scope (Constraints):**
  - No external cloud database or mandatory user login.
  - Must remain 100% backward-compatible with existing `.local-radar-store.json`, `IndexedDB`, and exported `.json` backup files.
  - Never transmit raw user API keys or browsing history to external analytics endpoints.

---

### Task 1: Immediate Sidebar Topic Green Status & Video Count Badge After Scan
- **Context:** The green status dot (`hasDigest`) is rendered by `renderSidebar()`. Before this task, the `btnScanTopic` `finally` block only called `renderMainDigest()`, leaving `#topicsList` stale until the user clicked a different topic.
- **Goal:** Ensure a topic's status dot turns green and displays its video count immediately upon scan completion without switching topics.
- **Scope:** `ui/digest.html` (`btnScanTopic` handler and the `#topicsList` row template inside `renderSidebar()`).
- **Constraints:** No extra network round-trips; update state in-memory from the `/api/scan` response and re-render both panes in one pass.
- **Definition of Done (DoD):**
  - [x] Clicking `Scan Topic Now` on an unscanned (gray dot) topic turns its sidebar dot emerald-green (`bg-emerald-400`) the instant `/api/scan` succeeds, without clicking another topic.
  - [x] Scanned topics display a compact video count badge (e.g., `2`) in the sidebar row.

---

### Task 2: Scalable Sidebar UX for Growing Subscribed & AI-Suggested Topics
- **Context:** `SyncState` (`lib/storage.ts`) stores a flat `topics: string[]` plus optional `topicMeta?: Record<string, { starred?: boolean }>` and `telemetryOptIn`. `POST /api/sync` persists all five fields. The sidebar renders a flat vertical list with "Starter Topic Packs" permanently expanded below it.
- **Goal:** Keep the sidebar fast to navigate when a user has 15–50+ custom topics and AI-suggested sub-topics (stored flat, no parent/child nesting).
- **Scope:**
  - `lib/storage.ts`: Add optional `topicMeta?: Record<string, { starred?: boolean }>` to `SyncState` and merge it inside `importBackupJson()`.
  - `server.ts`: Preserve `topicMeta` in `POST /api/sync`.
  - `ui/digest.html`: Add search/filter input, status filter tabs (`All | Ready | ★ Starred`), star/pin toggle (`☆/★`) that pins favorites to the top of the list, and auto-collapsing `<details>` wrapper for Starter Topic Packs when `topics.length >= 4`.
- **Constraints:** Existing `topics: string[]` arrays without `topicMeta` must continue to work with zero migration errors.
- **Definition of Done (DoD):**
  - [x] Users can filter subscribed topics by text query and switch between `All`, `Ready` (scanned), and `★ Starred` tabs.
  - [x] Clicking `☆` on any topic stars/pins it to the top of the list and persists across reloads and JSON backup exports/imports.
  - [x] The "Starter Topic Packs" section automatically collapses into a single `<details>` accordion once the user has `>= 4` subscribed topics.

---

### Task 3: Privacy-Safe Usage Instrumentation & "Time Saved" Metrics
- **Context:** Currently, `searchAndFilterTopic()` (`lib/youtube.ts:108`) discards how many low-signal/short videos were filtered out, `VideoSummary` (`lib/summarizer.ts:17`) does not retain `durationSec`, and `lib/storage.ts` records no usage telemetry.
- **Goal:** Track local product usage & user value metrics (`scansCompleted`, `videosSummarized`, `slopVideosFiltered`, `secondsSaved`, `timestampClicks`, `ttsPlays`, `backupsExported`) and provide an opt-in hook for anonymous product analytics.
- **Scope:**
  - `lib/youtube.ts`: Add `searchAndFilterTopicWithStats()` (or attach stats) to report `slopFilteredCount` alongside selected candidates.
  - `lib/summarizer.ts`: Copy `durationSec` from `VideoCandidate` onto `VideoSummary`.
  - `lib/storage.ts`: Add `UsageMetrics` interface, `getMetrics()`, `updateMetrics()`, include `metrics` in `BackupPayload` (`exportBackupJson` / `importBackupJson`), add `telemetryOptIn?: boolean` to `SyncState`, and derive a baseline from cached digests so existing users see non-zero value.
  - `server.ts`: Return `metrics` in `GET /api/state`, auto-increment scan/video/time-saved counters in `POST /api/scan`, and expose `POST /api/metrics` for UI interaction events (`timestampClicks`, `ttsPlays`).
- **Constraints:** 100% local-first by default; never log or transmit API keys or private user data.
- **Definition of Done (DoD):**
  - [x] Every completed scan increments `scansCompleted`, `videosSummarized`, `slopVideosFiltered`, and `secondsSaved` (calculated from video `durationSec` minus estimated reading time).
  - [x] Clicking `[MM:SS]` timestamps and `🔊 Read Aloud` increments `timestampClicks` / `ttsPlays` via `/api/metrics`; `⬇️ Export .json` increments `backupsExported` inside `exportBackupJson()`.
  - [x] `UsageMetrics` persists across restarts and is included in 1-click JSON Export/Import backups.
  - [x] Settings drawer includes an opt-in toggle (`"Share anonymous usage stats"`) and displays the detailed metrics breakdown.

---

### Task 4: Value-Driven Support / Tip Link & Config-Ready Pro Tier Hook
- **Context:** Users currently get full BYOK summarization at $0 server cost to the developer, but there is no visible indicator of how much time the tool has saved them and no way for happy users to tip/support or unlock Pro features.
- **Goal:** Surface a live **"⏱️ X.X hrs saved"** value badge paired with a **`☕ Support / Tip`** CTA, plus a single configuration object to enable a Freemium/Pro topic limit later without refactoring.
- **Scope:**
  - `lib/storage.ts`: Export `MONETIZATION_CONFIG` (`mode: "free_byok" | "freemium"`, `freeTopicLimit: 5`, `supportUrl: string`).
  - `ui/digest.html`: Render the live `"⏱️ X.X hrs saved • Y videos distilled"` pill in the header/sidebar footer alongside a `☕ Support` button linked to `supportUrl`.
- **Constraints:** Must not block or nag BYOK users in default `"free_byok"` mode; non-intrusive 1-line footer/header placement.
- **Superseded by Phase 4 (§9):** the default `"free_byok"` mode is replaced by `"freemium"` once Phase 4 lands (free cap stays 5).
- **Definition of Done (DoD):**
  - [x] Top header / sidebar footer displays live formatted time saved (e.g., `⏱️ 20m saved • 2 videos distilled`) calculated from `state.metrics` (with fallback calculation from existing cached digests so current data immediately shows non-zero value).
  - [x] Clicking `☕ Support` opens the configured donation/tip URL (Ko-fi / Buy Me a Coffee / Stripe Payment Link) in a new tab.
  - [x] `MONETIZATION_CONFIG` is exposed in `/api/state` so switching `mode` to `"freemium"` enforces `freeTopicLimit` with an upgrade prompt in 0 code changes.

---

## 9. Phase 4 — Pro Tier: Gating, Background Alarms, Auto-Updates & Notifications

### Overall Context, Goal, Scope & Constraints
- **Context:** Phase 2.5 shipped `MONETIZATION_CONFIG` as a config hook only — the app runs in `"free_byok"` mode with `freeTopicLimit: 5` and a `canAddMoreTopics()` check that never fires. Phase 4 turns the four automation features into the paid tier.
- **Decision:** **Background alarms, auto-updates, notifications and unlimited topics are Pro-only.** Free tier keeps manual scans and is capped at **5 topics**.
- **Goal:** Establish an `isPro` entitlement boundary enforced on both UI and server, then build the paid automation on top of it.
- **In-Scope:** `lib/storage.ts`, `server.ts`, `ui/digest.html`, `extension/manifest.json`, `extension/background.js`.
- **Constraints:**
  - Free users must not be able to trigger polling at all — not just hide the button.
  - Entitlement checks must be enforced server-side (`POST /api/sync`, `GET /api/rss`), not only in the UI.
  - Local-first and backward compatible: existing `.local-radar-store.json`, `IndexedDB` and exported `.json` backups keep working. No entitlement data in backups.
  - No new dependency for licence checking in this phase — a local `isPro` flag is enough; swap in a real licence key later.

### Implementation Plan (KISS / YAGNI — saved 2026-10-28)

**Core idea:** the Bun server is the only source of truth. The background worker asks the server (`GET /api/state`) instead of mirroring state into `chrome.storage.local`. One store branch, two small background storage keys (`rssSeen`, `rssUnread`), no new dependencies.

**Cut (YAGNI):** `chrome.storage`/IndexedDB entitlement branches (dead code — only the server runs `lib/storage.ts`); `isPro`+`pinnedChannels` mirror + `onChanged` sync wiring; separate `lastSeenByChannel`/notified-set/badge stores; poll-interval UI; per-topic badge; extension test harness (manual checklist instead); auto-scan on new video; content-script seek; new upgrade URL (reuse `proUpgradeUrl`).

**Agreed decisions:**
- Alarm interval: `POLL_MINUTES = 30`, single `rss-poll` alarm, sequential per-channel polling.
- `GET /api/rss` for free: `403 { error: "upgrade_required" }` (checked before any fetch).
- Notification click: full tab `digest.html?topic=<enc>` primary; `chrome.sidePanel.open({ windowId })` best-effort `.catch(() => {})`.
- Badge: total new (`""` / `N` / `"9+"`), cleared on digest open, scan, or notification click.
- Over-limit users: grandfathered — server rejects only **growth** beyond `max(current, 5)`; delete/star/pin/scan always allowed.
- Backup import: free users clamped to `max(current topics, 5)` topics (never truncates existing topics); Pro unlimited. Pins/meta filtered to kept topics; digests retained.
- First poll per channel: seed silently (record all current RSS IDs, notify nothing). Same on pin-added and re-upgrade.
- Payments/identity: manual `Unlock Pro (I paid)` toggle only; real tracking is Phase 5.

#### M0a — Test isolation (do first, one line)
- `lib/storage.ts:82`: `const CLI_STORE_PATH = process.env.RADAR_STORE_PATH || ".local-radar-store.json";`
- Tests spawn `PORT=3459 RADAR_STORE_PATH=/tmp/<tmp>.json bun run server.ts` from repo root (temp cwd does not work — `server.ts` serves `ui/*` cwd-relative). Extension still hard-codes `localhost:3456`, so this isolates API/UI tests only.
- **DoD:** contract tests never touch the real `.local-radar-store.json` (hash unchanged before/after).

#### M1 — Entitlement + 5-topic cap (one slice)
- **Files:** `lib/storage.ts`, `server.ts`, `ui/digest.js`, `ui/digest.html` → `bun run build:ext`.
- `lib/storage.ts`: flip `mode` to `"freemium"`; add `getEntitlements()`/`setEntitlements()` reading/writing a top-level `entitlements: { isPro: boolean }` key in the CLI store only (getter `store.entitlements?.isPro ?? false`; mutate the cached object, never spread-replace; never added to `BackupPayload`). In `importBackupJson`, clamp merged topics to `max(current topics, 5)` when `!isPro` and filter `pinnedChannels`/`topicMeta` to kept topics (digests retained).
- `server.ts`: `GET /api/state` adds `entitlements`; new `POST /api/entitlements { isPro }` (400 unless `isPro` is a boolean); `POST /api/sync` returns `403` only when `!isPro` and the request grows topics beyond `max(current, 5)`; `GET /api/rss` returns `403` for free before the missing-`channelId` branch and before fetching.
- `ui/digest.js`: `canAddMoreTopics()` blocks when `!isPro && topics.length >= 5` with *"Free limit (5 topics) reached — upgrade for unlimited topics + RSS auto-updates and alerts."*; `saveSync` checks `res.ok` and on failure `await loadState()` + error toast (server state wins, no rollback code), and every `loadState` repairs a dangling `activeTopic` to a subscribed topic; Settings checkbox `Pro (I paid)` → `POST /api/entitlements`, check `res.ok`, then `await loadState()` and re-render checkbox from `state.entitlements?.isPro` (like `telemetryToggle`); in extension context, on successful Pro toggle call `chrome.alarms.create("rss-poll", { periodInMinutes: 30 })` and on downgrade `chrome.alarms.clear("rss-poll")` — free installs create no alarm; footer upgrade line only when free and at cap. UI reads `state.entitlements?.isPro` as single source of truth.
- **DoD:**
  - [x] `/api/state` returns `monetization.mode === "freemium"`, `freeTopicLimit: 5`, `entitlements.isPro`; survives reload; absent from backup export.
  - [x] 6th topic blocked in all 3 UI paths (add form `:873`, starter pills `:470`, subtopic chips `:668`) and via direct `POST /api/sync` (403 free / 200 Pro); topics 1–5 unchanged; over-limit free user can still delete/star/pin.

#### M2 — Background poll + notifications (Pro only)
- **Files:** `extension/background.js`, `extension/manifest.json`, `extension/icon.png` (copy of `assets/logo-256.png`), `ui/digest.js` (`?topic=` + badge clear).
- `manifest.json`: add `"notifications"` to `permissions`, add `icons`/`default_icon` pointing at `icon.png`.
- `background.js` (~90 lines, no imports; all listeners registered synchronously at top level; server URL hard-coded — the `window.fetch` shim cannot run in a service worker):
  - `ensureAlarm()`: backstop on install/startup only — fetch `/api/state`, create `rss-poll` (`periodInMinutes: 30`) only if Pro and missing (never reset the countdown). Primary lifecycle is the digest page (M1): on Pro toggle it creates/clears the alarm directly **and** sends a `proChanged` runtime message so the service worker authoritatively creates/clears it (covers toggles from contexts where the page-level `chrome.alarms` call can't reach the worker). Free installs create no alarm.
  - On alarm: `fetch /api/state`; on network failure **or** non-OK/unparseable response, abort and touch nothing (never treat errors as `!isPro`). If `!isPro`: clear alarm + badge and return. For each pinned channel sequentially with per-channel `try/catch`: `GET /api/rss?channelId=`; skip on non-200 (only `200` with a non-empty list advances state; an empty list never seeds).
  - Storage keys `rssSeen: { [channelId]: string[] }` (last 50 IDs) and `rssUnread: number`. First sight of a channel (with videos): store all current IDs, notify nothing. Otherwise, mark **all** new IDs seen, notify only the first 3 (rest silently seen — no stale queue); write each ID into the set **before** `chrome.notifications.create("rss|<enc topic>|<videoId>", …)` so a service-worker kill can never duplicate. Same channel under two topics: first topic wins. Persist per channel as you go; badge from `rssUnread` (`""` / `N` / `"9+"`).
  - `chrome.storage.onChanged`: only when `area === "local"` and `rssUnread` becomes `0`, clear the badge; write nothing in response.
  - `notifications.onClicked`: parse topic from the notification ID, clear notification, set `rssUnread = 0` (badge clears via the listener), `chrome.tabs.create({ url: chrome.runtime.getURL("digest.html?topic=" + enc) })`, then best-effort `sidePanel.open({ windowId: tab.windowId }).catch(() => {})`.
- `ui/digest.js`: apply `?topic=` **once** on initial load (then strip it with `history.replaceState`); later loads only repair a dangling `activeTopic`. On initial load and after a successful scan, in extension context, reset `rssUnread = 0` in `chrome.storage.local` guarded by `chrome.storage?.local` inside `try/catch` (plain `chrome` exists on ordinary web pages).
- **DoD (manual Chrome checklist — no automated harness in this phase):**
  - [x] Free: `chrome.alarms.getAll()` empty; Pro: exactly one periodic `rss-poll` alarm. (Verified in headless Chromium MV3 smoke, 2026-10-28: free `[]`, Pro at startup `["rss-poll:30"]`.)
  - [ ] New video on a pinned channel: exactly one notification across two alarm runs; badge shows total; click opens digest tab on that topic; badge clears on digest open. (Partially verified: `?topic=` opens the correct topic and is stripped from the URL; write-before-notify dedup is code-reviewed. OS-level notification requires a real pinned channel publishing — manual check pending.)
  - [x] Downgrade clears the alarm without browser restart; server stopped → no errors, no state advance, resumes next cycle. (Alarm clear wired on toggle + free poll; server-down path touches nothing by construction and contract tests keep the real store hash unchanged.)

#### M3 — Tests, docs, packaging
- Single `bun test` contract file against the M0a-isolated server: `/api/state` shape, cap 403-free/200-Pro, growth-only rule, RSS 403-free, backup excludes entitlements, import clamps free to `max(current, 5)`.
- README: monetization table → `freemium` + 5-topic cap + four Pro features; Phase 4 status; re-affirm extension requires `bun run ui`. Regenerate ZIP from the committed tree (current ZIP is stale) and verify `bun run build:ext` diff is clean.
- **Before M1:** checkpoint-commit the working tree and copy `.local-radar-store.json` aside. Rollback = `git revert` + restore that copy; alarms/badge in the Chrome profile are cleared manually (in the checklist above).
- **DoD:**
  - [x] `bunx tsc --noEmit` clean; contract tests green; real store hash unchanged by tests. (Contract tests 6/6 green. `tsc` has only pre-existing errors in untouched files: `demo_*.spec.ts`, `lib/storage.ts:79 indexedDB`, `lib/youtube.ts sort_by` — no new errors from Phase 4 files.)
  - [x] README reflects `freemium` + cap + Pro features; packaging (ZIP / `.crx`) reproducible.

#### Implementation progress & evidence (2026-10-28)
- **Status: implemented.** M0a, M1, M2, M3 landed in the working tree (uncommitted — checkpoint is a store backup at `/tmp/yt-topic-radar-store-backup.json`, current store SHA-256 `dc89d9d9…`, not a git commit).
- **Decisions taken during implementation:** downgrade also clears `rssSeen` (both in `background.js` free-poll and the digest toggle) so re-upgrade re-seeds silently, per the "seed on re-upgrade" rule; badge counts only *notified* videos (≤3/channel/poll), the rest are silently seen.
- **Evidence:**
  - `bun test tests/phase4-contract.test.ts` — 6/6 pass (state/freemium, 5-ok/6-403, RSS 403, boolean validation, backup excludes entitlements, grandfather re-save/growth/import-clamp). Real store SHA-256 identical before/after each run.
  - Playwright `tests/responsive-layout.spec.ts` — 7/7 pass against an isolated store.
  - Headless Chromium MV3 smoke (persistent context, real extension): service worker loads; free `chrome.alarms.getAll()` = `[]`; Pro at startup = `["rss-poll:30"]`; digest renders with 0 page errors; `digest.html?topic=Local LLMs` opens that topic and strips the param; `rssUnread` storage round-trips.
  - `bun test` on the whole repo also picks up the pre-existing Playwright `demo_*.spec.ts` files and fails on them (Playwright `test.describe` under Bun) — unrelated to Phase 4; run the contract file directly.
  - Extension ZIP regenerated from the working tree (6 files including `icon.png`).
- **Remaining manual check:** OS notification on a real new video from a pinned channel (DoD above).
- **Out-of-plan scope in the same working tree (pre-existing, not Phase 4):** the server-offline guard in `ui/digest.js`/`ui/digest.css` (~100 lines: offline banner, button disabling, `isServerUnreachable` classifying any `TypeError` as offline). It predates this implementation, is exercised by no test, and should be committed/split separately from the Phase 4 milestone commits so it can be reverted independently.
- **Review follow-ups (2026-10-28):** status wording is "implemented, verification pending" until the notification check passes; the MV3 smoke is committed as `tests/extension-smoke.mjs` (run manually against an isolated `:3456` server) so M2 evidence is reproducible; `bun run test:contract` runs the contract file directly.

### Recommended implementation order
1. M0a (one line) → M1 (paid boundary) → M2 (automation on the gate) → M3 (tests/docs/packaging).
2. Every `ui/` edit ships with `bun run build:ext` in the same commit — never hand-edit `extension/digest.*`.

### Phase 5 (deferred) — Real Payments + Identity
- Phase 4 ships manual unlock only; it cannot know who paid.
- Phase 5: separate Pro payment link (do not reuse tip link) + webhook → licence key (UUID/JWT with email) → paste-to-unlock in Settings → server-side signature verify → persist `{ isPro, email, keyHash }` outside backups, plus revoke/refund handling. Provider choice (ExtensionPay vs Stripe/Razorpay key) to be decided there.

### Demo asset (not shipped)
A 35s silent walkthrough (`YT-Topic-Radar-Personal-Finance-Demo-With-Results.mp4`) was produced with Playwright recording + `ffmpeg` captions: add "Personal Finance" → Top 2 → scan → scroll results and synthesis. Recording scripts (`demo_*.spec.ts`), `demo-videos*/` and the extension ZIP are local artifacts, not part of the product build.
