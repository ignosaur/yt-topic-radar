# Phase history (archived 2026-10-29)

Completed phases, moved out of `PLAN.md` to keep the active plan short.
All DoDs below were checked. Product decisions and active work live in `PLAN.md`;
commands and architecture live in `README.md` / `AGENTS.md`.

## Phase 1 — Core Engine: done

`lib/youtube.ts`, `lib/summarizer.ts`, `lib/storage.ts`: search, filter,
timed transcripts, structured Gemini summaries, cross-video synthesis.

## Phase 2 — Digest Dashboard UI: done

Starter Topic pills + custom topic sidebar, cross-video synthesis card,
video digest cards with `[MM:SS]` links, Read Aloud, JSON Export/Import.

## Phase 2.5 — Post-MVP Refinements: done

Reactive sidebar, topic search/starring, usage metrics, value pill + Support CTA.
Four tracked issues, each shipped with Context / Goal / Scope / Constraints / DoD:

1. **Sidebar green status after scan** — `btnScanTopic` updates state in-memory
   from the `/api/scan` response and re-renders both panes (no extra round-trips).
   DoD: dot turns emerald + video-count badge appears instantly. [x]
2. **Scalable sidebar** — `topicMeta` starring + `All | Ready | ★ Starred` tabs +
   search filter; Starter Packs auto-collapse at `>= 4` topics. Backward compatible
   with `topics` arrays lacking `topicMeta`. [x]
3. **Usage instrumentation** — `searchAndFilterTopicWithStats()`,
   `durationSec` on `VideoSummary`, `UsageMetrics` + `getMetrics()`/`updateMetrics()`,
   `telemetryOptIn`, `POST /api/metrics`. 100% local-first. [x]
4. **Support CTA + Pro hook** — live "time saved" pill + `☕ Support` link;
   `MONETIZATION_CONFIG` (`mode`, `freeTopicLimit: 5`, `supportUrl`).
   Default `"free_byok"` superseded by Phase 4 `"freemium"`. [x]

Design decision carried forward: `seekOpenYouTubeTab` **navigates** (reloads) the
open YouTube tab to the timestamped URL (tabs permission only, no content script).
In-place seek deferred to Phase 4+ (still deferred).

## Phase 3 — MV3 side panel: done (commit `608d1e0`)

1. MV3 CSP compliance: inline `<script type="module">` → `digest.js`,
   Tailwind CDN + inline `<style>` → local `digest.css`.
2. `http://localhost:3456/*` in `host_permissions` + `"tabs"` permission;
   `OPTIONS` preflight + `Access-Control-Allow-*` + `/digest.js` + `/digest.css`
   routes in `server.ts`.
3. `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`;
   sidebar becomes slide-over drawer `< 640px`, `#videoSidePanel` full overlay `< 900px`.
4. Export via `${API_BASE}/api/backup/export`; `#sidePanelYtWatchLink` fallback +
   active-tab seeking via `chrome.tabs.query`.
5. Packaging: `bun run build:ext && (cd extension && zip -r ../yt-topic-radar-extension.zip .)`
   for ZIP + Load unpacked; `chrome://extensions` → Pack extension for `.crx`
   (keep `.pem` private).

Security (§3.1 resolved): CORS restricted to `localhost` + `chrome-extension://`.
