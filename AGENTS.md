# AGENTS.md — yt-topic-radar

Bun-only repo (`bun install`, `bun run`, `bun test`). Do not use npm/node/python tooling or dotenv (Bun auto-loads `.env.local`).

## Commands

- Dev server: `bun run ui` (= `bun run server.ts`, port `3456`, override with `PORT`). Serves `ui/digest.html` at `/`.
- CLI (same engine, same store): `bun run scan "Topic" 3`
- Contract tests (spawns server on port 3459 with isolated store): `bun test tests/phase4-contract.test.ts`
- Parser guard: `bun test tests/youtube-parser-guard.test.ts`
- Self-checks (anti-slop scoring, chunking, backup, concurrent writes): `bun -e 'import { runSelfChecks } from "./index.ts"; await runSelfChecks()'`
- Extension smoke: `node tests/extension-smoke.mjs` (requires server running)
- No lint/typecheck configured. `tsconfig.json` is strict + `noEmit`; keep imports ESM (`verbatimModuleSyntax`).

## Architecture (one shared engine, two shells)

- `lib/youtube.ts` — search, anti-slop scoring (`scoreCandidate`), transcripts, RSS.
- `lib/summarizer.ts` — Gemini schema/chunking; model fallback chain `MODEL_CANDIDATES` (names drift — never hardcode a single model).
- `lib/storage.ts` — dual persistence: browser (`chrome.storage` + IndexedDB via `idb-keyval`) vs CLI/server (`.local-radar-store.json`, in-memory cache + serialized writes). Concurrent `saveSyncState`/`updateMetrics` must stay race-free — covered by self-check.
- `server.ts` — `Bun.serve()` API + static `ui/` files. Scan flow: search → filter → transcript → summarize → synthesize; one poisoned video is skipped, never fails the whole scan.
- `ui/digest.{html,js,css}` — dashboard source of truth. `extension/` holds build output (never edit by hand).
- `lib/engine.ts` — browser-safe scan pipeline (port of `server.ts`'s `runScan`) with a `chrome.storage.local` scan lock; used only by the standalone bundle.
- `ui/standalone-entry.ts` — serverless build entry: fetch-bind → `/api/*` route table backed by `lib/` → imports the dashboard. Gated by `__RADAR_PRO_ENABLED__` (OFF in standalone v1).
- `scripts/` — prod/dev manifests, workers and the DNR ruleset copied into `extension/` by the build.
- **Two modes, chosen at build time:** standalone (prod, no server) vs dev (localhost shell).

## Gotchas

- **Never edit `extension/*` directly** — it is build output. After UI changes run `bun run build:ext` (standalone prod bundle) or `bun run build:ext:dev` (plain `ui/` copy + localhost manifest). Rebuild prod before zipping for distribution.
- **Standalone prod needs no server.** It ships a static DNR ruleset (`scripts/dnr-rules.json`) that rewrites `Origin`/`Referer` for `youtube.com/youtubei/*` — without it YouTube returns `403` from `chrome-extension://`. Do not remove it.
- **Dev build is the thin shell**: `build:ext:dev` requires `bun run ui` at `http://localhost:3456`; Pro RSS polling (30 min alarms) also needs the server up. Phase 4 Pro exists only in the dev build / server — standalone ships `__RADAR_PRO_ENABLED__=false` (no cap, no toggle, no RSS).
- `lib/storage.ts` must stay bundle-safe: `process.env.*` reads are replaced by build defines and the `node:fs` imports must stay inside unexecuted CLI branches.
- Env: key lives in `.env.local` as `GEMINI_API_KEY` (gitignored) or Settings drawer. Tests isolate state via `RADAR_STORE_PATH` → temp `store.json`; default store `.local-radar-store.json` is gitignored — never commit it or `.env.local`.
- Freemium is enforced server-side only (dev mode): 5-topic limit (`MONETIZATION_CONFIG.freeTopicLimit` in `lib/storage.ts`); `/api/sync` growth beyond limit and `/api/rss` without Pro return `403 upgrade_required`. Pro unlock is manual (`POST /api/entitlements {isPro}`) until Phase 5 payments. Standalone v1 is flag-off: unlimited topics, no entitlements.
- Gemini key stays in `chrome.storage.local`; never put it in `chrome.storage.sync`, backups, or entitlements.
- API key is excluded from backup export/import; backups merge without duplicates.
- CORS allowlist is localhost + `chrome-extension://` only — don't widen it.
- `demo_*.spec.ts`, `demo-videos*/`, `*.mp4`, `test-results/` are gitignored throwaway demo artifacts, not product code. Real tests live in `tests/`.
