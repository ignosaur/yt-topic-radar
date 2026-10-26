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
- **AI Summarization (`lib/summarizer.ts`):** `@google/genai` (Gemini 2.5 Flash — 1M context window + structured JSON Schema output)
- **Storage (`lib/storage.ts`):** `chrome.storage.sync` + `chrome.storage.local` + `IndexedDB` (`idb-keyval`) in the browser extension, plus 1-click JSON Export/Import backup; local JSON cache when testing via CLI.
- **Audio Read-Out (Phase 3):** Browser native `window.speechSynthesis` (free) or Kokoro-82M / OpenAI TTS

---

## 5. Topic Subscription UI, Storage Architecture & User Flow

### A. Topic Subscription UI (Starter Packs + Custom Search)
- **Curated Starter Topics (Onboarding Grid):** 1-click topic pills grouped by category to avoid blank-page paralysis:
  - *Tech & AI:* `AI Coding Agents`, `Local LLMs`, `System Design`, `Rust & Go`
  - *Finance & Markets:* `Macroeconomics`, `Value Investing`, `Crypto Infrastructure`
  - *Science & Health:* `Longevity & Science`, `Space & Physics`
- **Custom Topic Input:** `+ Add any topic...` input in the sidebar for arbitrary user queries (e.g., `"Next.js performance"`, `"PostgreSQL indexing"`).
- **AI Sub-Topic & Channel Suggestions:** After scanning a topic, suggest narrower sub-topics and offer a `[📌 Pin Channel]` button for high-signal creators discovered during the scan.

### B. State Persistence (`lib/storage.ts` — Zero Cloud DB Required for MVP)
1. **`chrome.storage.sync` (Up to 100 KB, auto-synced across user's Chrome profile):**
   - Subscribed topics, pinned channel IDs, and scan preferences (e.g., scan frequency, minimum video duration).
2. **`chrome.storage.local` + `IndexedDB` (`idb-keyval`, gigabytes of local storage):**
   - Gemini API key (`chrome.storage.local` only for security).
   - Generated video summaries, cross-video topic syntheses, seen/dismissed video IDs (prevents re-summarizing seen videos), and cached transcripts.
3. **1-Click Export / Import JSON Safeguard:**
   - **`[Export Backup .json]`**: Downloads a timestamped `yt-topic-radar-backup-YYYY-MM-DD.json` containing all topics, pinned channels, and saved digests (excludes secret API key by default).
   - **`[Import Backup .json]`**: Restores and merges topics, channels, and digest history in one click without duplicates.

### C. End-to-End User Flow
1. **Install & Open Extension:** Opens the full-tab **Topic Radar Dashboard**.
2. **30-Second Setup:** Paste Gemini API key + click 2–3 Starter Topic pills (or type a custom topic).
3. **Scan Topic:** Click `[Scan Now]` (or let background `chrome.alarms` poll). Progress indicator shows: *Searching YouTube → Filtering 15 videos down to top 4 → Summarizing...*
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
   - Pass timestamped transcript to **Gemini 2.5 Flash** with strict structured schema:
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

- **Phase 1 — Core Engine (`bun run` TypeScript CLI Prototype):**
  - Build `lib/youtube.ts`, `lib/summarizer.ts`, and `lib/storage.ts` to search a topic, filter top videos, fetch timed transcripts, and run structured Gemini summarization + cross-video topic synthesis.
- **Phase 2 — Digest Dashboard UI (WXT + React + Tailwind):**
  - Onboarding Starter Topic pills + custom topic sidebar, Cross-Video Synthesis card, Video Digest cards with clickable `[MM:SS]` links, and 1-click JSON Export/Import backup.
- **Phase 3 — Browser Extension Side Panel (`chrome.sidePanel`) & Read Aloud:**
  - Docked Side Panel view next to YouTube playback + 1-click `window.speechSynthesis` audio read-out.
- **Phase 4 — Channel Pinning & RSS Auto-Polling:**
  - Let users pin discovered high-signal channels to their topics for zero-cost background RSS updates.

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
- **Context:** In `ui/digest.html:196`, the green status dot (`hasDigest`) is rendered inside `renderAll()`. However, when `btnScanTopic` finishes (`ui/digest.html:598`), the `finally` block only calls `renderMainDigest()`, leaving `#topicsList` stale until the user clicks a different topic.
- **Goal:** Ensure a topic's status dot turns green and displays its video count immediately upon scan completion without switching topics.
- **Scope:** `ui/digest.html` (`btnScanTopic` handler at lines `574–600` and `#topicsList` row template at lines `185–214`).
- **Constraints:** No extra network round-trips; update state in-memory from the `/api/scan` response and re-render both panes in one pass.
- **Definition of Done (DoD):**
  - [ ] Clicking `Scan Topic Now` on an unscanned (gray dot) topic turns its sidebar dot emerald-green (`bg-emerald-400`) the instant `/api/scan` succeeds, without clicking another topic.
  - [ ] Scanned topics display a compact video count badge (e.g., `2`) in the sidebar row.

---

### Task 2: Scalable Sidebar UX for Growing Subscribed & AI-Suggested Topics
- **Context:** `SyncState` (`lib/storage.ts:10–14`) stores a flat `topics: string[]`, `/api/sync` (`server.ts:59`) only persists `topics`, `pinnedChannels`, and `minDurationSec`, and `ui/digest.html:184–214` renders a flat vertical list with "Starter Topic Packs" permanently expanded below it.
- **Goal:** Keep the sidebar fast to navigate when a user has 15–50+ custom topics and AI-suggested sub-topics.
- **Scope:**
  - `lib/storage.ts`: Add optional `topicMeta?: Record<string, { starred?: boolean }>` to `SyncState` and merge it inside `importBackupJson()`.
  - `server.ts`: Preserve `topicMeta` in `POST /api/sync`.
  - `ui/digest.html`: Add search/filter input, status filter tabs (`All | Ready | ★ Starred`), star/pin toggle (`☆/★`) that pins favorites to the top of the list, and auto-collapsing `<details>` wrapper for Starter Topic Packs when `topics.length >= 4`.
- **Constraints:** Existing `topics: string[]` arrays without `topicMeta` must continue to work with zero migration errors.
- **Definition of Done (DoD):**
  - [ ] Users can filter subscribed topics by text query and switch between `All`, `Ready` (scanned), and `★ Starred` tabs.
  - [ ] Clicking `☆` on any topic stars/pins it to the top of the list and persists across reloads and JSON backup exports/imports.
  - [ ] The "Starter Topic Packs" section automatically collapses into a single `<details>` accordion once the user has `>= 4` subscribed topics.

---

### Task 3: Privacy-Safe Usage Instrumentation & "Time Saved" Metrics
- **Context:** Currently, `searchAndFilterTopic()` (`lib/youtube.ts:108`) discards how many low-signal/short videos were filtered out, `VideoSummary` (`lib/summarizer.ts:17`) does not retain `durationSec`, and `lib/storage.ts` records no usage telemetry.
- **Goal:** Track local product usage & user value metrics (`scansCompleted`, `videosSummarized`, `slopVideosFiltered`, `secondsSaved`, `timestampClicks`, `ttsPlays`, `backupsExported`) and provide an opt-in hook for anonymous product analytics.
- **Scope:**
  - `lib/youtube.ts`: Add `searchAndFilterTopicWithStats()` (or attach stats) to report `slopFilteredCount` alongside selected candidates.
  - `lib/summarizer.ts`: Copy `durationSec` from `VideoCandidate` onto `VideoSummary`.
  - `lib/storage.ts`: Add `UsageMetrics` interface, `getMetrics()`, `recordMetric()`, include `metrics` in `BackupPayload` (`exportBackupJson` / `importBackupJson`), and add `telemetryOptIn?: boolean` to `SyncState`.
  - `server.ts`: Return `metrics` in `GET /api/state`, auto-increment scan/video/time-saved counters in `POST /api/scan`, and expose `POST /api/metrics` for UI interaction events (`timestampClicks`, `ttsPlays`).
- **Constraints:** 100% local-first by default; never log or transmit API keys or private user data.
- **Definition of Done (DoD):**
  - [ ] Every completed scan increments `scansCompleted`, `videosSummarized`, `slopVideosFiltered`, and `secondsSaved` (calculated from video `durationSec` minus estimated reading time).
  - [ ] Clicking `[MM:SS]` timestamps, `🔊 Read Aloud`, and `⬇️ Export .json` increments `timestampClicks`, `ttsPlays`, and `backupsExported` via `/api/metrics`.
  - [ ] `UsageMetrics` persists across restarts and is included in 1-click JSON Export/Import backups.
  - [ ] Settings drawer includes an opt-in toggle (`"Share anonymous usage stats"`) and displays the detailed metrics breakdown.

---

### Task 4: Value-Driven Support / Tip Link & Config-Ready Pro Tier Hook
- **Context:** Users currently get full BYOK summarization at $0 server cost to the developer, but there is no visible indicator of how much time the tool has saved them and no way for happy users to tip/support or unlock Pro features.
- **Goal:** Surface a live **"⏱️ X.X hrs saved"** value badge paired with a **`☕ Support / Tip`** CTA, plus a single configuration object to enable a Freemium/Pro topic limit later without refactoring.
- **Scope:**
  - `lib/storage.ts`: Export `MONETIZATION_CONFIG` (`mode: "free_byok" | "freemium"`, `freeTopicLimit: 10`, `supportUrl: string`).
  - `ui/digest.html`: Render the live `"⏱️ X.X hrs saved • Y videos distilled"` pill in the header/sidebar footer alongside a `☕ Support` button linked to `supportUrl`.
- **Constraints:** Must not block or nag BYOK users in default `"free_byok"` mode; non-intrusive 1-line footer/header placement.
- **Definition of Done (DoD):**
  - [ ] Top header / sidebar footer displays live formatted time saved (e.g., `⏱️ 20m saved • 2 videos distilled`) calculated from `state.metrics` (with fallback calculation from existing cached digests so current data immediately shows non-zero value).
  - [ ] Clicking `☕ Support` opens the configured donation/tip URL (Ko-fi / Buy Me a Coffee / Stripe Payment Link) in a new tab.
  - [ ] `MONETIZATION_CONFIG` is exposed in `/api/state` so switching `mode` to `"freemium"` enforces `freeTopicLimit` with an upgrade prompt in 0 code changes.
