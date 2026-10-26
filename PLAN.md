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
- **Runtime & Package Manager:** **Bun** (`package.json`, `tsconfig.json`) — lets us test the core engine directly from the CLI (`bun run`) and share the exact same TypeScript modules inside the Browser Extension.
- **Browser Extension Framework:** **WXT** (`wxt.dev`) + React + TypeScript + Tailwind CSS (Manifest V3)
- **YouTube Discovery & Transcripts (`lib/youtube.ts`):** Direct YouTube Innertube API (`fetch` to `/youtubei/v1/search` and `/youtubei/v1/player`) + native YouTube Channel RSS (`youtube.com/feeds/videos.xml?channel_id=...`). Zero API quota limits, runs directly in-browser or via Bun.
- **AI Summarization (`lib/summarizer.ts`):** `@google/genai` with structured JSON Schema output and a fallback chain (`gemini-3-flash-preview` → `gemini-3.8-flash` → `gemini-3.5-flash` → `gemini-flash-latest`) because model availability varies by API key.
- **Storage (`lib/storage.ts`):** `chrome.storage.sync` + `chrome.storage.local` + `IndexedDB` (`idb-keyval`) in the browser extension, plus 1-click JSON Export/Import backup; local JSON cache when testing via CLI.
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
1. **`chrome.storage.sync` (Up to 100 KB, auto-synced across user's Chrome profile):**
   - Subscribed topics, pinned channel IDs, and scan preferences (e.g., scan frequency, minimum video duration).
2. **`chrome.storage.local` + `IndexedDB` (`idb-keyval`, gigabytes of local storage):**
   - Gemini API key (`chrome.storage.local` only for security).
   - Generated video summaries, cross-video topic syntheses, seen/dismissed video IDs (prevents re-summarizing seen videos), and cached transcripts.
3. **1-Click Export / Import JSON Safeguard:**
   - **`[Export Backup .json]`**: Downloads a timestamped `yt-topic-radar-backup-YYYY-MM-DD.json` containing topics, `topicMeta` (starred state, telemetry opt-in), pinned channels, saved digests, seen-video IDs and usage metrics (API key excluded).
   - **`[Import Backup .json]`**: Restores and merges topics, channels, digest history and metrics in one click without duplicates.

### C. End-to-End User Flow
1. **Install & Open Extension:** Opens the full-tab **Topic Radar Dashboard**.
2. **30-Second Setup:** Paste Gemini API key + click 2–3 Starter Topic pills (or type a custom topic). Free tier supports up to 5 topics.
3. **Scan Topic:** Click `[Scan Now]` (Pro: or let background `chrome.alarms` poll pinned channels). Progress indicator shows: *Searching YouTube → Filtering 15 videos down to top 4 → Summarizing...*
4. **Read the Digest:**
   - **Top Card:** Cross-Video Topic Synthesis (*"Across 4 videos this week, here is the consensus and what's new..."*).
   - **Video Digest Cards:** Shows Video Type badge (`Tutorial`, `News`, `Podcast`, `Review`), Watch Verdict (`Yes` / `Skim timestamps` / `Skip`), 2-sentence Core Thesis, and expandable Chapter Breakdown + Type-Specific details with clickable `[MM:SS]` links.
   - **Card Actions:** `[🔊 Read Aloud]`, `[📌 Pin Channel]`, `[✓ Mark Read]`.
5. **Dive Deeper (Side Panel):** Clicking any `[MM:SS]` timestamp opens the YouTube video at that exact second on the left while keeping the structured summary docked in Chrome's `sidePanel` on the right.

---

## 6. The 4-Step Pipeline (How It Works — Pressure-Tested)

1. **Topic Search (`scanner`)**
   - Query YouTube via `youtubei.js` (`Innertube`) for recent videos matching the user's topic (excluding Shorts `< 3 mins` and livestreams).
   - Poll native RSS feeds (`youtube.com/feeds/videos.xml?channel_id=...`) for pinned channels.
2. **Anti-Slop Quality Filter (`filter`)**
   - Score candidates before spending LLM tokens:
     - Parse `expandableMetadata` directly from the search payload to detect author-written chapters in **zero extra HTTP requests**.
     - Penalize clickbait title patterns (`"SHOCKING"`, `"IT'S OVER"`, excessive all-caps) so niche high-signal videos beat drama/reaction channels.
     - Weight view velocity & engagement over raw channel size.
   - Select the **Top 3–5 highest-signal videos** per topic.
3. **Timed Transcript Extraction + Native URL Fallback (`transcript`)**
   - Pull timed captions + video chapters + description links via `youtubei.js` (`WEB` / `ANDROID` / `IOS` client context).
   - Group into **30–60 second timestamped blocks** (`[04:30] ...`) so every extracted insight retains an exact timestamp link.
   - **Zero-Dead-End Fallback:** If a video has disabled captions or `timedtext` is blocked (`poToken`), pass the YouTube URL directly to Gemini's native `fileData: { fileUri: youtubeUrl }` multimodal input.
4. **"Never Miss a Point" Type-Aware Summarization (`summarizer`)**
   - **Chapter/Window Chunking for Long Videos (`> 25 mins`):** Split long transcripts into 20-minute or chapter windows so Gemini's output limit never compresses a 2-hour video into vague bullets.
   - **Rate-Limit Guard (Free-Tier BYOK Safe):** Cap concurrency to 2 requests with automatic `429` exponential backoff.
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
   - Run interactive scans inside the open **Digest Tab / Side Panel** (never killed by Chrome's 30s MV3 service worker timeout), saving each video summary progressively to `IndexedDB` as soon as it finishes. Use `background.ts` only for lightweight RSS badge checks.

---

## 7. MVP Milestones

- **Phase 1 — Core Engine (`bun run` TypeScript CLI Prototype): ✅ Done**
  - `lib/youtube.ts`, `lib/summarizer.ts`, `lib/storage.ts`: search, filter, timed transcripts, structured Gemini summaries, cross-video synthesis.
- **Phase 2 — Digest Dashboard UI: ✅ Done**
  - Starter Topic pills + custom topic sidebar, cross-video synthesis card, video digest cards with `[MM:SS]` links, Read Aloud, JSON Export/Import.
- **Phase 2.5 — Post-MVP Refinements: ✅ Done**
  - Reactive sidebar, topic search/starring, usage metrics, value pill and Support CTA. Details in §8.
- **Phase 3 — Browser Extension Side Panel & Engine Wiring: 🚧 Partial**
  - Manifest declares `sidePanel`; the dashboard still talks to the local Bun server over `/api/*`, so background messaging remains.
  - Done so far: `ui/digest.html` (copied to `extension/digest.html`) rewrites `/api/*` to `http://localhost:3456` when `chrome.runtime` is present, so the unpacked extension runs against the local Bun server. Clicking the toolbar icon still opens a full tab (`chrome.tabs.create`).
  - Remaining: switch icon click to `chrome.sidePanel.open()`, route API calls through the service worker (avoids CORS/origin quirks), add `http://localhost:3456/*` to `host_permissions`, bundle JS instead of shipping raw module HTML.
  - Packaging (documented + verified): `zip -r yt-topic-radar-extension.zip .` from `extension/` for ZIP + "Load unpacked"; `chrome://extensions` → **Pack extension** for a `.crx` (keep the generated `.pem` for future updates). Chrome blocks arbitrary `.crx` installs, so the ZIP path is the primary distribution channel.
- **Phase 4 — Pro Tier Gating + Background Automation: ⏳ Not started**
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
  - `lib/storage.ts`: Export `MONETIZATION_CONFIG` (`mode: "free_byok" | "freemium"`, `freeTopicLimit: 10`, `supportUrl: string`).
  - `ui/digest.html`: Render the live `"⏱️ X.X hrs saved • Y videos distilled"` pill in the header/sidebar footer alongside a `☕ Support` button linked to `supportUrl`.
- **Constraints:** Must not block or nag BYOK users in default `"free_byok"` mode; non-intrusive 1-line footer/header placement.
- **Superseded by Phase 4 (§9):** the default `"free_byok"` mode and `freeTopicLimit: 10` are replaced by `"freemium"` with a 5-topic free cap once Phase 4 lands.
- **Definition of Done (DoD):**
  - [x] Top header / sidebar footer displays live formatted time saved (e.g., `⏱️ 20m saved • 2 videos distilled`) calculated from `state.metrics` (with fallback calculation from existing cached digests so current data immediately shows non-zero value).
  - [x] Clicking `☕ Support` opens the configured donation/tip URL (Ko-fi / Buy Me a Coffee / Stripe Payment Link) in a new tab.
  - [x] `MONETIZATION_CONFIG` is exposed in `/api/state` so switching `mode` to `"freemium"` enforces `freeTopicLimit` with an upgrade prompt in 0 code changes.

---

## 9. Phase 4 — Pro Tier: Gating, Background Alarms, Auto-Updates & Notifications

### Overall Context, Goal, Scope & Constraints
- **Context:** Phase 2.5 shipped `MONETIZATION_CONFIG` as a config hook only — the app runs in `"free_byok"` mode with `freeTopicLimit: 10` and a `canAddMoreTopics()` check that never fires. Phase 4 turns the four automation features into the paid tier.
- **Decision:** **Background alarms, auto-updates, notifications and unlimited topics are Pro-only.** Free tier keeps manual scans and is capped at **5 topics**.
- **Goal:** Establish an `isPro` entitlement boundary enforced on both UI and server, then build the paid automation on top of it.
- **In-Scope:** `lib/storage.ts`, `server.ts`, `ui/digest.html`, `extension/manifest.json`, `extension/background.js`.
- **Constraints:**
  - Free users must not be able to trigger polling at all — not just hide the button.
  - Entitlement checks must be enforced server-side (`POST /api/sync`, `GET /api/rss`), not only in the UI.
  - Local-first and backward compatible: existing `.local-radar-store.json`, `IndexedDB` and exported `.json` backups keep working. No entitlement data in backups.
  - No new dependency for licence checking in this phase — a local `isPro` flag is enough; swap in a real licence key later.

### Task 1: Entitlements + Freemium Config
- **Context:** `MONETIZATION_CONFIG.mode` is `"free_byok"`, so `canAddMoreTopics()` (`ui/digest.html`) short-circuits and no limit is enforced. `/api/state` exposes `monetization` but no entitlement.
- **Scope:**
  - `lib/storage.ts`: flip `mode` to `"freemium"`, set `freeTopicLimit: 5`; add `getEntitlements()` / `setEntitlements()` returning `{ isPro: boolean }` (default `false`), persisted in `chrome.storage.local` / the CLI store and **excluded** from `BackupPayload`.
  - `server.ts`: return `entitlements` in `GET /api/state`.
  - `ui/digest.html`: read `state.entitlements?.isPro` as the single source of truth for gating (not `mode` alone).
- **DoD:**
  - [ ] `/api/state` returns `monetization.mode === "freemium"`, `freeTopicLimit: 5` and `entitlements.isPro`.
  - [ ] Entitlement survives reload and is absent from exported backup JSON.

### Task 2: Free Tier Cap — 5 Topics
- **Context:** Topic creation happens in three places in `ui/digest.html`: the add-topic form submit handler, the starter-pack pills, and the AI sub-topic chips — all of which already call `canAddMoreTopics()`.
- **Scope:**
  - `ui/digest.html`: `canAddMoreTopics()` blocks when `!isPro && topics.length >= 5`; message reads *"Free limit (5 topics) reached — upgrade for unlimited topics + RSS auto-updates and alerts."* Show a persistent upgrade CTA in the sidebar footer at the cap.
  - `server.ts`: reject `POST /api/sync` when a non-Pro request would grow `topics` beyond 5 (trims or 403) so the limit cannot be bypassed via direct API calls.
- **DoD:**
  - [ ] Adding a 6th topic as a free user is blocked in all three UI paths with the upgrade message.
  - [ ] A direct `POST /api/sync` with 6 topics is rejected for a free user and accepted for Pro.
  - [ ] Topics 1–5 behave exactly as before.

### Task 3: Background Alarms (Pro only)
- **Context:** `extension/manifest.json` already declares `alarms` but `extension/background.js` only calls `chrome.tabs.create` — no alarms are ever created.
- **Scope:** `extension/background.js` creates the RSS alarm on install/startup **only when `isPro`** and clears it on downgrade. Poll pinned channels through the existing `GET /api/rss?channelId=` endpoint on the local Bun server.
- **DoD:**
  - [ ] Pro user gets a periodic alarm; free user has none registered (`chrome.alarms.getAll()` empty).
  - [ ] Downgrading to free clears the alarm without requiring a browser restart.

### Task 4: Auto-Updates + Notifications (Pro only)
- **Context:** `seenVideoIds` already tracks summarised videos in `lib/storage.ts`, and `/api/rss` returns latest videos per pinned channel. Nothing compares them.
- **Scope:**
  - `extension/manifest.json`: add `"notifications"` to `permissions`.
  - `extension/background.js`: on each alarm, diff RSS results against last-seen channel video IDs in `chrome.storage.local`; on new videos, `chrome.notifications.create()` with a click handler that opens the side panel/tab on the relevant topic. Update the badge count.
- **DoD:**
  - [ ] A newly published video on a pinned channel produces exactly one notification per video ID (no repeats across alarm runs).
  - [ ] Clicking the notification opens the digest focused on that topic.
  - [ ] No polling, diffing or notification code runs for free users.

### Task 5: Documentation & Distribution
- **Scope:** README monetization table and Phase 4 status; note that the extension requires `bun run ui` running locally (Phase 3 debt).
- **DoD:**
  - [ ] README configuration table reflects `freemium` + 5-topic cap and lists the four Pro features.
  - [ ] Packaging steps (ZIP / `.crx`) documented and reproducible.

### Recommended implementation order
1. Task 1 (entitlements + config) → 2 (topic cap) — establishes the paid boundary first.
2. Task 3 (alarms) → 4 (auto-updates + notifications) — build on the gate, not before it.
3. Task 5 last.

### Demo asset (not shipped)
A 35s silent walkthrough (`YT-Topic-Radar-Personal-Finance-Demo-With-Results.mp4`) was produced with Playwright recording + `ffmpeg` captions: add "Personal Finance" → Top 2 → scan → scroll results and synthesis. Recording scripts (`demo_*.spec.ts`), `demo-videos*/` and the extension ZIP are local artifacts, not part of the product build.
