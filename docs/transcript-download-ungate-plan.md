# Transcript download without the Pro gate — implementation plan

Goal: every user (free or Pro) can download the per-video timestamped
transcript (`.txt`) from a digest card, in **both** shells — the Bun
server/dev build and the standalone extension. All other Pro gates stay
exactly as they are.

Assumption to confirm before starting: "without the Pro gate" means free
in both shells. If only the server/dev build should be ungated, drop
Step 2 and the standalone parts of Steps 5–6; the rest is unchanged.

Progress: implemented — Steps 1–4 landed, all transcript tests green
(23 pass across `transcript-download` + `phase4-contract`); topic-lifecycle
+ storage-integrity suites green (29 pass), prod bundle builds. Step 6
manual QA (both shells) remains.

## 1. Review of the traced steps

| # | Suggested step | Verdict | Notes |
|---|---|---|---|
| 1 | Remove `isPro` check from `GET /api/transcript` in `server.ts` | **Confirmed** | Keep the `videoId` regex (`/^[\w-]{11}$/` → 400) and the empty-blocks → 502 `transcript_unavailable` behaviour. Only the entitlement check goes. |
| 2 | Implement `/api/transcript` in `ui/standalone-entry.ts` instead of hardcoded 403 | **Confirmed, with a correction** | `handleApi` currently does `path = input.split("?")[0]` and never reads the query string, so the new route must parse `videoId` itself (e.g. `new URLSearchParams(input.split("?")[1] ?? "")`). No new bundle dependency: `fetchTimestampedTranscript` is already in the standalone bundle via `lib/engine.ts`. |
| 3 | Render the Transcript button unconditionally in `ui/digest.js` | **Confirmed** | Delete `const transcriptPro = isPro();` and inline the button. Also update the stale comments ("Pro plan feature", "Pro-only; button isn't rendered when free"). |
| 4 | `downloadTranscript()` 403 toast becomes dead code | **Partially** | After ungating neither backend returns 403 for this route, so remove the special "Pro feature — upgrade to unlock" branch and let the existing `!res.ok` path surface `data.error`. Keeping it would be harmless but misleading. |
| 5 | Remove `"transcript_download"` from `MONETIZATION_CONFIG.proFeatures` (`lib/storage.ts`) | **Confirmed (metadata, not function)** | Nothing branches on this list — it is the canonical plan description served in `/api/state`. Removing it keeps the advertised plan honest. Update the comment above it. Do not touch `isPro()`, the topic cap, RSS, or backup gates, which share the helper. |
| 6 | Update `tests/phase4-contract.test.ts` | **Confirmed, with a testing correction** | See Step 5: the new free-path test must not call the route with a *valid* videoId against the real server — that would hit live YouTube and be slow/flaky. Gate removal is provable deterministically with invalid IDs. |

Not touch points (checked): no Settings/HTML copy mentions transcript as
Pro (`ui/digest.html` Pro line lists only topics + RSS), no new
permissions are needed (standalone already fetches transcripts in-browser
during scans), and `transcriptToText()` / the Blob download are
gate-agnostic already.

## 2. Implementation steps (in order)

### Step 1 — Server route (`server.ts`, `/api/transcript`)
- Delete `const { isPro } = await getEntitlements(); if (!isPro) ... 403`.
- Update the route comment: drop "(Pro)".
- Nothing else in the handler changes.

### Step 2 — Standalone route (`ui/standalone-entry.ts`, `/api/transcript`)
- Import `fetchTimestampedTranscript` from `../lib/youtube`.
- Replace the hardcoded `403 upgrade_required` with the same logic as the
  server route: parse `videoId` from the query string → 400 on bad/missing
  ID → 502 on empty blocks or fetch throw → `200 { videoId, blocks }`.
- Replace the "stays locked" comment with a note that the feature is free
  in both shells.
- Leave `/api/backup/*` (still 403) and `/api/entitlements` (still no-op)
  untouched.

### Step 3 — Dashboard (`ui/digest.js`)
- Remove `transcriptPro` and render the `data-transcript` button for every
  video card; fix the two stale comments (render site + binding site).
- In `downloadTranscript()`, delete the `res.status === 403` Pro-toast
  branch; the generic `!res.ok` error path remains.

### Step 4 — Plan metadata (`lib/storage.ts`)
- Remove `"transcript_download"` from `MONETIZATION_CONFIG.proFeatures`
  and adjust the comment so it describes only the remaining Pro features.

### Step 5 — Tests ✅ added (red until Steps 1–4 land)

Test coverage is in place ahead of the implementation (TDD red phase).
Current status and what each case proves:

| File | Cases | Status today | Covers |
|---|---|---|---|
| `tests/transcript-download.test.ts` — API, `server` mode | 1 (worker scenario below) | 🔴 fails: `400` expected, got `403` | Free server route: bad/missing `videoId` → 400, valid ID → 200 + mocked blocks, empty captions → 502 `transcript_unavailable`, fetcher throw → 502 |
| `tests/transcript-download.test.ts` — API, `standalone` mode | 1 (same scenario) | 🔴 fails: `400` expected, got `403` | Same contract through the standalone router — this is the case that exercises the new query-string parsing in Step 2 |
| `tests/transcript-download.test.ts` — dashboard | 5 | 🟢 pass | `transcriptToText` header + `[MM:SS]` format; `downloadTranscript` success (fetch URL, `text/plain` Blob, sanitized `<title>-<videoId>.txt` filename, anchor click, success toast); 502 → error toast, no download; empty blocks → "unavailable" toast; unreachable server → offline mode |
| `tests/phase4-contract.test.ts` — state | 1 (updated) | 🔴 fails: `proFeatures` still contains `transcript_download` | Step 4 metadata: `proFeatures` must **not** contain `"transcript_download"` (`backup_export_import` assertion kept) |
| `tests/phase4-contract.test.ts` — transcript | 1 (rewritten) | 🔴 fails: `400` expected, got `403` | `"transcript: free validates videoId (no Pro gate)"`: with `isPro: false`, `videoId=bogus` → 400 and missing `videoId` → 400. A 400 instead of 403 proves the gate is gone without calling a valid ID, which would hit live YouTube |

Seam: `tests/helpers/topic-lifecycle-worker.ts` gained a `transcript`
scenario (spawned by `tests/transcript-download.test.ts` for both modes).
Its mocked `fetchTimestampedTranscript` returns two blocks for
`dQw4w9WgXcQ`, throws for `fail1234567`, and returns no blocks otherwise;
the worker's fetch guard proves zero external calls. Dashboard tests
source-extract `transcriptToText`/`downloadTranscript` from `ui/digest.js`
with stubbed `fetch`/`document` (the harness pattern already used in
`tests/topic-lifecycle.test.ts`). Deliberately not covered by automated
tests: button *rendering* (inside the large digest renderer — verified
manually in Step 6) and the removed 403 Pro-toast branch (deleted code).

Run: `bun test tests/transcript-download.test.ts tests/phase4-contract.test.ts`
plus the repo self-check
(`bun -e 'import { runSelfChecks } from "./index.ts"; await runSelfChecks()'`).
Expected after Steps 1–4: all transcript cases green; the other
phase4-contract cases (`14 pass` today) must stay green — they pin the
untouched topic/RSS/backup gates.

### Step 6 — Rebuild + manual verification
- Rebuild extension output (never hand-edit `extension/`):
  `bun run build:ext:dev` for the dev shell, `bun run build:ext` for the
  standalone prod bundle (run prod last if preparing a distributable;
  `bun run package:firefox` only if shipping Firefox).
- Manual, server mode (`bun run ui`, entitlements = free): open an existing
  digest → Transcript button visible on every card → click downloads
  `<title>-<videoId>.txt` whose body is `[MM:SS] text` lines; a
  captions-less video shows the "Transcript unavailable" toast, not an
  upgrade toast.
- Manual, standalone: load the prod build unpacked with no server running,
  open a digest, download a transcript the same way.
- Regression spot-check that untouched gates still bite (free): 6th topic
  → 403, `/api/rss` → 403, backup controls hidden / `/api/backup/export`
  → 403.

## 3. Out of scope

- RSS, backup export/import, and the 5-topic free limit remain Pro.
- No caching of transcripts, no `.srt`/`.vtt` formats, no rate limiting —
  the endpoint keeps its current fetch-on-demand behaviour; it uses no
  Gemini quota, so ungating adds no API-key cost.
- Historical docs (`PLAN.md`, phase handoffs) that describe the old gate
  are not rewritten.

## 4. Risks / notes

- The working tree already has unrelated uncommitted changes (incl.
  `server.ts`); diff each file before committing so only the transcript
  hunks land.
- Removing a `proFeatures` entry changes the `/api/state` contract shape;
  the only consumer is the dashboard + contract test, both updated above.
- Rollback is trivial: the change is three small, independent hunks
  (server route, standalone route, UI button) with no data migration.
