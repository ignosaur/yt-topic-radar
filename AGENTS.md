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
- `ui/digest.{html,js,css}` — dashboard source of truth. `extension/` holds a **built copy** + `manifest.json` (MV3 side panel) + `background.js`.

## Gotchas

- **Never edit `extension/digest.*` directly.** After UI changes run `bun run build:ext` (plain `cp ui/digest.* extension/`) and re-zip for distribution.
- **Extension is a thin shell**: it requires `bun run ui` at `http://localhost:3456`. Pro RSS polling (30 min alarms, max 3 notifications/channel/poll) also needs the server up.
- Env: key lives in `.env.local` as `GEMINI_API_KEY` (gitignored) or Settings drawer. Tests isolate state via `RADAR_STORE_PATH` → temp `store.json`; default store `.local-radar-store.json` is gitignored — never commit it or `.env.local`.
- Freemium enforced server-side: 5-topic limit (`MONETIZATION_CONFIG.freeTopicLimit` in `lib/storage.ts`); `/api/sync` growth beyond limit and `/api/rss` without Pro return `403 upgrade_required`. Pro unlock is manual (`POST /api/entitlements {isPro}`) until Phase 5 payments.
- API key is excluded from backup export/import; backups merge without duplicates.
- CORS allowlist is localhost + `chrome-extension://` only — don't widen it.
- `demo_*.spec.ts`, `demo-videos*/`, `*.mp4`, `test-results/` are gitignored throwaway demo artifacts, not product code. Real tests live in `tests/`.
