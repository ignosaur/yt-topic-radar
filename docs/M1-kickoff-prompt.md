# M1 Kickoff — Multi-Agent Development Prompt

Paste this as the first message to the orchestrator agent. It is self-contained.

---

## Mission

Implement **M1 — Standalone build** from `STANDALONE-EXTENSION-PLAN.md`: the Chrome extension must work with **no Bun, no local server, nothing else running**. M0 is passed (2026-10-29): in-browser search/transcript/Gemini/IndexedDB all work **only because** of the DNR header rewrite, the `process.env.*` build defines, and the fetch-bind patch. Do not drop any of the three.

Read first, in this order:
1. `STANDALONE-EXTENSION-PLAN.md` — Decisions 1–9, build pieces 1–5, M1 scope/constraints/DoD.
2. `AGENTS.md` — Bun-only tooling, `build:ext` rule, gotchas.
3. `server.ts:72-138` (`runScan`), `lib/storage.ts`, `lib/youtube.ts`, `lib/summarizer.ts`, `ui/digest.js:1-30` and `:1045-1132`.

## Non-negotiables (violating any = stop and report)

- `__RADAR_PRO_ENABLED__=false` in the prod build. No Pro surface ships: no topic cap, no Pro toggle/upgrade UI, no entitlements persistence, no import clamp, no RSS/alarms/notifications/badge code or permissions.
- Prod build has **no** `localhost` code path and **no** `http://localhost:3456/*` permission.
- Build-time mode only; no runtime mode switch.
- Gemini key stays in `chrome.storage.local` — never `chrome.storage.sync`, backups, or entitlements.
- Closing the page cancels a scan: no partial digest, previous digest intact, seen/metrics only on completion.
- `bun run ui` behaviour unchanged; `build:ext:dev` remains the always-working fallback.
- No new frameworks/dependencies. Bun only.
- Do not edit `extension/digest.*` by hand — it is build output.

## Ownership matrix (one agent per lane; do not edit outside your lane)

| Lane | Files (own) | Forbidden |
|---|---|---|
| A — Engine | `lib/engine.ts`, `tests/engine.test.ts` | everything else |
| B — Packaging | `scripts/manifest.prod.json`, `scripts/manifest.dev.json`, `scripts/background.prod.js`, `scripts/background.dev.js`, `scripts/dnr-rules.json`, `package.json`, `extension/manifest.json`, `extension/background.js`, `extension/rules.json` | `ui/`, `lib/`, `tests/` |
| C — Smoke | `tests/standalone-smoke.mjs` | everything else |
| D — Integration (orchestrator) | `ui/fetch-bind.ts`, `ui/standalone-entry.ts`, `ui/digest.js`, `lib/storage.ts`, `AGENTS.md`, `README.md` | A/B/C files |

Lane D must land the engine interface below **before** A's tests are treated as contract.

## Contract: `lib/engine.ts`

```ts
export interface ScanResponse { status: number; body: unknown }

export interface EngineDeps {
  search: typeof searchAndFilterTopicWithStats;
  transcript: typeof fetchTimestampedTranscript;
  summarize: typeof summarizeVideo;
  synthesize: typeof synthesizeTopicDigest;
  saveDigest: typeof saveTopicDigest;
  markSeen: (videoId: string) => Promise<void>;
  updateMetrics: typeof updateMetrics;
  acquireLock: (topic: string) => Promise<boolean>;
  releaseLock: () => Promise<void>;
}

export const defaultEngineDeps: EngineDeps; // real lib/* + chrome.storage.local lock
export function createEngineDeps(): EngineDeps;
export async function runStandaloneScan(
  topic: string,
  maxVideos: number,
  apiKey: string,
  deps?: EngineDeps
): Promise<ScanResponse>;
```

Behaviour (port of `server.ts:72-138`, plus the M1 changes):
- `maxVideos` clamped to 1..5 (server semantics).
- Search failure → `502` with the same user-facing message.
- Per-video failure → skip and continue; collect `skippedVideos`.
- **Seen IDs buffered**; committed via `markSeen` only after a non-empty result set.
- Zero summaries → `502` + `skippedVideos`, **no** digest/metrics/seen writes.
- Success → `synthesize` → `saveDigest` → `updateMetrics` → mark seen → `{ ok:true, digest, metrics, skippedVideos }`.
- Lock: `{ topic, since }` in `chrome.storage.local` key `radarScanLock`; stale after 10 min (`SCAN_STALE_MS`); a held fresh lock returns `409 { error: "scan_in_progress", topic }`; release in `finally`.
- No `chrome` access outside `defaultEngineDeps`/`createEngineDeps`; tests inject deps.

## Contract: `ui/standalone-entry.ts`

Order matters because ES imports hoist:
1. `import "./fetch-bind.ts"` — binds `globalThis.fetch` before youtubei.js captures it.
2. `import { runStandaloneScan, ... } from "../lib/engine"` and the `lib/storage` fns.
3. Define `async function handleApi(input, init): Promise<Response>` implementing:
   - `GET /api/state` → `{ sync, digests, metrics, entitlements:{isPro:false}, monetization:{...MONETIZATION_CONFIG, proEnabled:false}, starterTopics, hasApiKey, maskedKey }`
   - `POST /api/sync` → save unconditionally (flag off), return `{ ok:true, sync }`
   - `POST /api/key` → `{ ok:true }` or `400`
   - `POST /api/metrics` → timestampClick/ttsPlay deltas, return `{ ok:true, metrics }`
   - `POST /api/scan` → validate topic/key, call `runStandaloneScan`, passthrough status/body
   - `POST /api/entitlements` → flag-off no-op `{ ok:true, entitlements:{isPro:false} }`
   - `GET /api/backup/export` → `Response(json, headers application/json)`
   - `POST /api/backup/import` → `importBackupJson(text, { enforceTopicLimit:false })`
   - anything else → `404`
4. Set `window.__RADAR_STANDALONE__ = handleApi` **before** `await import("./digest.js")`.

## Contract: `ui/digest.js` (Lane D)

- Shim: if `globalThis.__RADAR_STANDALONE__` exists, dispatch `/api/*` to it; otherwise keep today's localhost prefixing. No call-site changes.
- Export button: replace `window.location.href` with `fetch` → Blob → anchor download (works in both modes).
- Pro visibility: hide the `proToggle` label and skip `canAddMoreTopics` gating when `state.monetization?.proEnabled === false`.
- Everything else unchanged; `extension/` copies are produced by the build.

## Contract: `lib/storage.ts` (Lane D)

`importBackupJson(raw, opts?: { enforceTopicLimit?: boolean })` — default `true` (today's behaviour). Standalone passes `false`. No other behaviour change.

## Contract: packaging (Lane B)

- `scripts/manifest.prod.json`: `storage`, `sidePanel`, `tabs`, `declarativeNetRequestWithHostAccess`; hosts `https://www.youtube.com/*`, `https://generativelanguage.googleapis.com/*`; `background.service_worker = background.js`; no localhost, no alarms/notifications.
- `scripts/manifest.dev.json`: today's manifest + `(Dev)` name suffix + localhost + alarms + notifications.
- `scripts/background.prod.js`: side-panel behaviour + action-click fallback only. No fetch, no alarms, no notifications, no badge, no localhost.
- `scripts/background.dev.js`: current Phase 4 worker.
- `scripts/dnr-rules.json`: one rule — set `Origin: https://www.youtube.com`, `Referer: https://www.youtube.com/`, `Sec-Fetch-Site/Mode/Dest`, condition `||youtube.com/youtubei/`, `resourceTypes: ["xmlhttprequest"]`.
- `package.json`:
  - `build:ext` = bun browser bundle of `ui/standalone-entry.ts` with `--conditions=browser --define __RADAR_PRO_ENABLED__="false" --define 'process.env.RADAR_STORE_PATH'='".local-radar-store.json"' --define 'process.env.GEMINI_API_KEY'='""'` → `extension/digest.js`, then copy `ui/digest.html ui/digest.css ui/favicon.ico`, prod manifest/worker/rules.
  - `build:ext:dev` = copy `ui/digest.html ui/digest.js ui/digest.css ui/tts-scan-utils.js ui/favicon.ico`, dev manifest/worker, remove `extension/rules.json`.
  - keep `scan`, `ui`, `test:contract`.

## Verification (run before reporting done)

```bash
bun test tests/engine.test.ts
bun run build:ext && ls -l extension/digest.js extension/manifest.json extension/rules.json
bun run build:ext:dev && ls -l extension/digest.js
node tests/standalone-smoke.mjs   # needs its own built extension dir
```

Plus the M1 manual checklist in the plan (clean profile, no Bun running).

## Reporting format

Return: lanes completed, files touched, commands run + pass/fail, measured bundle size, M1 DoD checkbox status, blockers, and anything you could not verify. Do not claim a DoD box without evidence.
