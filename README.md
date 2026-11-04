# Topic Digest for YouTube

Subscribe to topics, not channels. It scans YouTube, drops clickbait and Shorts, reads the timed transcripts, and produces deep, type-aware summaries with clickable `[MM:SS]` timestamps.

TypeScript + Bun. One shared engine (`lib/`) runs in the local dashboard and the Chrome/Brave extension scaffold.

> **Disclaimer:** Unofficial project. Not affiliated with, endorsed by, or sponsored by YouTube or Google LLC. YouTube is a trademark of Google LLC.

## What you get

- **Topic-first discovery** — search recent videos per topic, not per channel.
- **Anti-slop filter** — scores titles, chapters, engagement and duration before spending Gemini tokens.
- **Video-type-aware digests** — `tutorial`, `news_analysis`, `podcast_interview`, `review_comparison`, each with chapter breakdowns and a watch/skim/skip verdict.
- **Cross-video synthesis** — consensus, disagreements and what is new across the scanned videos.
- **Scalable sidebar** — topic filter box, `All | Ready | ★ Starred` tabs, starred topics pinned on top, starter packs auto-collapse at 4+ topics.
- **Time saved** — local counter shown in the header (`⏱️ 20m saved • 8 videos distilled`), plus a prominent `☕ Support me` button.
- **Read Aloud and 1-click Export/Import** of topics, pinned channels, digests, metrics and seen-video IDs.

## Quick start (dashboard)

Requirements: [Bun](https://bun.com) 1.4+ and a Gemini API key ([get one free](https://aistudio.google.com/apikey)).

```bash
bun install
cp .env.example .env.local     # then put your key in .env.local
bun run ui
```

Open <http://localhost:3456>. You can also paste the key in the `⚙️` Settings drawer instead of using `.env.local`; it is stored locally.

Click a starter topic or add your own, then `Scan Topic Now`.

## CLI

Same engine and same local store, useful for testing:

```bash
bun run scan "AI Coding Agents" 3
```

It prints the filtered candidates, transcript stats, per-video summaries and the cross-video synthesis.

## Chrome / Brave / Edge extension

```bash
bun run build:ext        # standalone prod bundle (no server needed)
bun run build:ext:dev    # dev shell — requires `bun run ui` on :3456
bun run package:chrome   # build + dist/yt-topic-radar-v<version>.zip + verify
```

## Firefox extension

```bash
bun run build:ext:firefox  # standalone prod bundle for Firefox (no server needed)
bun run package:firefox  # build + dist/yt-topic-radar-firefox-v<version>.zip + verify
```

The Firefox build is the same bundle with a variant manifest (`sidebar_action` instead of `side_panel`, `background.scripts` instead of `service_worker`, plus the `gecko.id` AMO requires). It is packaged and statically verified, but **not yet load- or scan-tested in a real Firefox** — load-test it before distributing. To try it, open `about:debugging → This Firefox → Load Temporary Add-on` and select the `extension-firefox/manifest.json` file (not the folder). The gecko id (`topic-digest-youtube@yt-topic-radar`) is permanent once signed and must be globally unique on AMO. For distribution, upload the zip to AMO for signing (unlisted) to get an installable `.xpi`.

`package:chrome` refuses localhost/dev artifacts, writes a reproducible zip (fixed mtimes, sorted entries), and runs `scripts/verify-package.ts` (permissions, DNR ruleset, no RSS/alarm code). Store copy and disclosure drafts live in `store/`.

Then open `chrome://extensions`, enable Developer mode, **Load unpacked**, and pick `extension/`. For a `.crx`, use **Pack extension** on the same page and keep the generated `.pem` private for future updates.

The **prod** build works with **no Bun server**: the dashboard's `/api/*` calls are served in-page by `ui/standalone-entry.ts` + `lib/engine.ts`, storage is `chrome.storage`/IndexedDB, and a static DNR ruleset rewrites the `Origin` header so YouTube's Innertube API accepts requests from the extension. Standalone v1 ships with Pro disabled (`__RADAR_PRO_ENABLED__=false`): unlimited topics, no Pro toggle, no RSS polling.

The **dev** build (`build:ext:dev`) remains the thin shell over `bun run ui` at `http://localhost:3456`, including Phase 4 Pro RSS polling.

## Free vs Pro

| | Free | Pro |
| :--- | :--- | :--- |
| Topics | Up to 5 | Unlimited |
| Scans | Manual `Scan Topic Now` | Manual + background RSS polling of pinned channels (30 min) |
| New-video alerts | — | Chrome notifications (max 3 per channel per poll) + toolbar badge |

Unlock Pro with the `Pro (I paid)` toggle in the Settings drawer (manual unlock in Phase 4; real payment/licence tracking is Phase 5). This table applies to server/dev mode — the standalone prod build ships Pro off (unlimited topics, no RSS).

## Configuration

| Setting | Where | Default |
| :--- | :--- | :--- |
| Gemini API key | `.env.local` or Settings drawer | — |
| Server port | `PORT` env var | `3456` |
| Gemini models | `MODEL_CANDIDATES` in `lib/summarizer.ts` | `gemini-3-flash-preview` → `gemini-3.8-flash` → `gemini-3.5-flash` → `gemini-flash-latest` |
| Support URL / freemium limit | `MONETIZATION_CONFIG` in `lib/storage.ts` | `freemium`, 5 free topics, Razorpay |
| Test store path | `RADAR_STORE_PATH` env var | `.local-radar-store.json` |

Model names change; the fallback chain handles keys that do not have the newest model yet.

## API

| Route | Method | Purpose |
| :--- | :--- | :--- |
| `/api/state` | GET | Topics, digests, metrics, monetization, entitlements, key status |
| `/api/sync` | POST | Update topics, pinned channels, `topicMeta`, `telemetryOptIn` (403 if free tier would grow beyond 5 topics) |
| `/api/entitlements` | POST | Set `{ isPro }` (manual Pro unlock) |
| `/api/key` | POST | Save the Gemini API key locally |
| `/api/scan` | POST | Search → filter → transcript → summarize → synthesize |
| `/api/metrics` | POST | Increment `timestampClick` / `ttsPlay` |
| `/api/rss?channelId=` | GET | Latest videos for a pinned channel (Pro only, 403 otherwise) |
| `/api/backup/export` | GET | Download backup JSON |
| `/api/backup/import` | POST | Merge backup JSON (no duplicates) |

## Data & privacy

- Extension: `chrome.storage.sync` for topics/pins/preferences, `chrome.storage.local` + IndexedDB for the API key, digests and seen videos.
- CLI/dashboard: `.local-radar-store.json` (gitignored). The in-process cache serializes writes so concurrent actions do not overwrite each other.
- The API key is never included in backups and is only sent to Google's Gemini API.
- Usage metrics are local-only and the `"Share anonymous usage stats"` toggle is **off** by default; no analytics endpoint is wired.

## Project layout

```
index.ts              CLI entry + self-checks
server.ts             Local Bun API server
lib/youtube.ts        Search, anti-slop scoring, transcripts, RSS
lib/summarizer.ts     Gemini schema, chunking, model fallback
lib/storage.ts        Browser/CLI persistence, metrics, backups, monetization config
ui/digest.html        Dashboard (served at http://localhost:3456)
extension/            Manifest V3 side panel + built copy of the dashboard
PLAN.md               Product plan, architecture decisions and DoDs
```

Run the regression checks with:

```bash
bun -e 'import { runSelfChecks } from "./index.ts"; await runSelfChecks(); console.log("self-checks passed")'
```

## Status

Phase 1 (engine), Phase 2 (dashboard), Phase 2.5 (sidebar UX, metrics, support CTA), Phase 3 (extension side panel) and Phase 4 (Pro gating, background RSS alarms, notifications) are implemented and signed off. Next: Phase 5 real payments/licence tracking. See `PLAN.md`.
