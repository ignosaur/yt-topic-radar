# Audit follow-ups

Saved 2026-11-01.

## Prioritized now (execution order: 5 → 1 → 4 → 7 + 9)

Order rationale: 5 unblocks availability first (10-min lockout pages you), 1 stops silent data loss, 4 stops wasted quota/failed scans, 7 + 9 batch as small correctness fixes.

- **5. Hung search wedges all scans 10 min** (`lib/youtube.ts:103-117,185-194`, `server.ts:133,492-510`, `lib/engine.ts:49`) — singleton `getInnertube` has no per-scan cancel; wrap search step in `Promise.race` with ~60s timeout (override via `RADAR_SCAN_TIMEOUT_MS`), keep single-flight + owner-release untouched. DoD: hung search settles fast with 502, next scan not 409; gate: `server-scan-lifecycle`, `engine`, `phase4-contract` tests.
- **1. Metrics race loses counts** (`lib/storage.ts:260-268,438-490`) — `updateMetrics` read-modify-write outside `withTopicWrite`; wrap it in the existing lock, keep poison-safety line. DoD: 20 parallel increments from 0 end at exactly 20; gate: self-checks + `storage-integrity`, `engine` tests.
- **4. Gemini JSON parsed without a net** (`lib/summarizer.ts:276,292,312,382`, helper at `:325`, classifier at `:138`) — add `parseSummaryJson` (try/catch + shape check, throw sanitized video-local errors on bad JSON), replace 4 call sites. Invalid video output stays replaceable; provider-wide failures still stop the scan. DoD: corrupt reply never stores empty summary, never leaks raw `SyntaxError`; gate: `provider-errors`, `scan-lifecycle`, `engine` tests + new truncated-JSON case.
- **7. Fresh restores show invented stats** (`lib/storage.ts:418-437`) — `slopVideosFiltered: topics.length * 8` is fabricated; set `0`, keep recomputed videos/seconds and preserved click/tts counters. DoD: restore shows 0 for unknown, recomputed fields correct; gate: self-checks + `storage-integrity`.
- **9. RSS titles with `&` render as codes** (`lib/youtube.ts:440-460`, exemplar `:398-403`) — add `decodeXmlEntities` (copy transcript 4-replace chain + `&lt;`/`&gt;`, strip CDATA), apply to videoId/title/published. DoD: entities/CDATA decode, plain titles identical; gate: `youtube-parser-guard` + new decode case.

Constraints across all five: no new deps; keep `lib/storage.ts` bundle-safe (no top-level `node:fs`); don't change lock semantics, prompts/schemas, metrics shape, or CORS.

## Deferred — do later, in this order

- **2. Pro status ignores browser storage** (`lib/storage.ts:360-370`) — `get/setEntitlements` always hit the CLI file; branch like `getSyncState` (extension → IndexedDB → file).
- **3. Backup import silently drops topics** (`lib/storage.ts:640-660`) — over-limit slice drops topics but keeps orphan digests; refuse with `403 upgrade_required` or prune + report.
- **6. Seen-video list unbounded** (`lib/storage.ts:393-435`) — cap at ~2000 recent IDs; RSS tracker already caps at 50.
- **8. Masked-key leak** (`server.ts: /api/state`, `ui/standalone-entry.ts: buildState`) — return `hasApiKey` boolean only.
- **10. Scan pipeline triplicated** (`server.ts:139-290`, `lib/engine.ts:205-390`) — extract shared orchestration with injected deps.
- **11. God functions + untested UI** (`server.ts: fetch`, `lib/storage.ts: validators`, `ui/digest.js: renderSidebar/renderMainDigest`) — route table, per-record validators, one render fixture test first.
- **12. Serial chunk summarization** (`lib/summarizer.ts: multi-window loop`) — 2-at-a-time parallel.
- **13. Tiny helper duplicates** (`formatTimestamp`, `readJsonObject`, `findNewestZip`) — single copy in `lib/`, ~-60 lines.
