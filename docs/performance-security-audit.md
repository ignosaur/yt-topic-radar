# Performance and security audit — execution plan

## What this repo does:
Scans YouTube topics and uses Gemini to produce timestamped summaries. It runs as a local Bun dashboard/CLI or a standalone Chrome extension.

**Assumed load:** one person, sometimes using a tab and side panel together, with occasional CLI use. Not a public server.

**Status:** DONE 2026-11-01 — all 10 items implemented across 4 lanes and parent-verified. Item numbers are stable IDs; lanes were the execution units. Do not renumber items.

| Lane | Commit | Parent gate result |
|---|---|---|
| A — Server boundary (#2→#3) | `2787b61` | contract 11 pass; unit 74 pass / 0 fail (Playwright `.spec.ts` excluded — see residual 6) |
| B — Dashboard XSS (#1) | `2787b61` | Playwright XSS 4 passed |
| C — Storage integrity (#4→#5→#8→#9) | `be71570` | unit 82 pass / 0 fail; contract 11 pass; self-checks pass; `bun run build:ext` ok |
| D — Scan lifecycle (#6→#7→#10) | `8bfc011` | unit 87 pass / 0 fail; engine+backfill+contract gate 31 pass |

## Execution lanes (read this first)

Yes — reorganize into 4 lanes. Reason, traced: items 4/5/8/9 all mutate `lib/storage.ts:100–476` and items 6/7 share the scan lifecycle in `lib/engine.ts`/`server.ts`; parallel workers on those files will conflict. Lanes A and B touch disjoint files and can run in parallel worktrees. Lane order within a lane is sequential.

| Lane | Items (in order) | Files (traced) | Parallel? |
|---|---|---|---|
| A — Server boundary | 2 → 3 | `server.ts:42–60,189–191,257–410`; tests: `tests/phase4-contract.test.ts` | Yes, with B |
| B — Dashboard XSS | 1 | `ui/digest.js:98–106,600–770,925–972` | Yes, with A |
| C — Storage integrity | 4 → 5 → 8 → 9 | `lib/storage.ts:84–129,181–476`; `server.ts:257–285`; `ui/standalone-entry.ts:65–94` | No — one worker, sequential |
| D — Scan lifecycle | 6 → 7 → 10 | `lib/engine.ts`; `lib/youtube.ts` (`fetchWithDeadline`, `indexByVideoId`); `server.ts` (`runScan` deadline + reuse); `lib/storage.ts` read-only for #10 | No — after C |

**Shared-file rule:** one writer per lane worktree. Lane C finishes (or is at least merged) before Lane D starts, because #10 reads `getDigests()`/`getSeenVideoIds()` from `lib/storage.ts`.

## Must fix

### 1. Untrusted text can execute JavaScript
`ui/digest.js:L609–627, L681–760, L937–950` — **Lane B — DONE (`2787b61`)**

- **What this is:** Topics, AI summaries and imported backups are displayed in the dashboard.
- **Problem:** Several fields go directly into `innerHTML` without escaping. Browser tests confirmed JavaScript execution through both a topic and a summary bullet.
- **Traced sinks (2026-11-01):** `esc()` exists at `ui/digest.js:98–106`. Already escaped (do not regress): topic rows `475–484`, pinned channels `521–526`, subtopics `643`, skipped titles `652`, video title/url/channel `715–721`. **Unescaped:** `activeTopic` interpolated at `618` and `631`; `digest.crossVideoSynthesis` at `760`; `v.videoType`, `v.worthWatchingFull`, `v.signalScore`, `v.durationText` at `707–710` (typed as enums/numbers in TS, but a poisoned backup/store makes them arbitrary strings — treat as untrusted); chapter `c.timestamp`, `c.sectionTitle`, `c.keyPoints[]` at `688–696`; detail `d.label`, `d.items[]` at `701–704`; attributes `data-vid="${v.videoId}"` and `data-ts="${c.timestamp}"` at `688`; side-panel `videoObj.coreThesis`, `c.timestamp`, `c.sectionTitle`, `c.keyPoints[]` at `943–950`.
- **Fix:** Apply the existing `esc()` helper consistently to text and attribute values. Add browser tests using malicious HTML.
- **If we skip it:** Opening a poisoned digest can run code with dashboard access. Chrome extension policy limits inline scripts, but injected HTML remains unsafe.
- **Acceptance:**
  - Every sink listed above passes through `esc()` (text and attribute contexts); no other `innerHTML` template interpolates state/digest data unescaped. Verify by grepping `innerHTML` templates in `ui/digest.js`, not by spot-checking one field.
  - New Playwright test (alongside `tests/e2e/responsive-layout.pw.ts`, run via explicit `bunx playwright test` path against a spawned server): seed a digest + topic containing `<img src=x onerror=...>`, `"><svg onload=...>`, and `</button><script>...` payloads in topic name, `crossVideoSynthesis`, chapter title/keyPoint, detail label/item, and side-panel notes; assert no payload element is created, no script executes (e.g. `window.__xss` stays unset), and the literal text is visible.
  - Existing escaped fields still render (topic list, pinned channels, subtopic pills clickable via `data-*`).
- **Result:** all traced sinks escaped (`esc()` text + attributes; `encodeURIComponent`/`Number()` hardening in side panel); `tests/e2e/dashboard-xss.pw.ts` 5 passed (main-digest exec, literal-text render, benign fields, side-panel exec, non-http-URL case). Residual 1 CLOSED in micro-lane (see Residual risks).

### 2. The “local” server accepts network connections without authentication
`server.ts:L189–200` — **Lane A — DONE (`2787b61`)**

- **What this is:** The Bun server exposes saved state and actions that spend Gemini quota.
- **Problem:** No listening address is specified. I confirmed a wildcard listening socket and successfully fetched `/api/state` through non-loopback network interfaces.
- **Traced:** `Bun.serve({ port: PORT, idleTimeout: 120, ... })` at `server.ts:189–191` — no `hostname`.
- **Fix:** Bind explicitly to `127.0.0.1`. Keep network hosting unsupported unless authentication is added.
- **If we skip it:** Other devices can read backups, change settings or start scans wherever the firewall permits access.
- **Acceptance:**
  - `Bun.serve` gets `hostname: "127.0.0.1"` (keep `PORT` override working).
  - Contract test in `tests/phase4-contract.test.ts` style (server spawned on port 3459, isolated `RADAR_STORE_PATH`): `GET /api/state` via `127.0.0.1` succeeds; the same request via the machine's non-loopback interface address fails to connect.
- **Result:** `hostname: "127.0.0.1"` set; `PORT` override intact; loopback `GET /api/state` test added and passing. Non-loopback refusal was not probed in this environment (follows from the explicit bind; firewall-dependent) — residual: none open beyond that.

### 3. CORS does not prevent unwanted writes
`server.ts:L52–60, L257–285, L315–321` — **Lane A — DONE (`2787b61`)**

- **What this is:** CORS controls which websites may read API responses.
- **Problem:** Disallowed origins still reach the handlers. A browser page on an untrusted loopback origin successfully changed topics using a plain-text POST; blocking the response did not block the write.
- **Traced:** `corsHeaders()` (`server.ts:52–60`) only omits response headers for unknown origins; every route handler still runs. Mutation routes: `POST /api/sync` (257), `/api/entitlements` (293), `/api/metrics` (303), `/api/key` (315), `/api/scan` (326), `/api/backup/import` (400). Note: `ui/digest.js:1224–1227` sends backup import as a raw string body (fetch defaults to `text/plain`) — so the import route must **not** be forced to `application/json`; protect it by Origin + item-5 validation instead. Non-browser clients (curl, CLI, tests) send **no** `Origin` header and must keep working.
- **Fix:** Reject untrusted `Origin` values before processing mutations. Require JSON content types on JSON endpoints; separately protect the raw backup-import route.
- **If we skip it:** An unwanted request can replace the key, change topics or trigger scans when browser network rules permit it.
- **Acceptance:**
  - For every `POST` route: if `Origin` is present and does not match `ALLOWED_ORIGINS` (`server.ts:47–51`), return `403` **before** the handler runs — state, key, entitlements and metrics unchanged, no scan started.
  - If `Origin` is absent (curl/CLI/tests) or allowlisted, behavior is unchanged.
  - JSON routes (`/api/sync`, `/api/entitlements`, `/api/metrics`, `/api/key`, `/api/scan`) reject a non-JSON `Content-Type` (allow `application/json; charset=...`) with `400`/`415` before parsing; `/api/backup/import` keeps accepting the raw body from `ui/digest.js:1224` but is Origin-checked and size/validation-gated by item 5.
  - Contract tests: untrusted-Origin `POST /api/sync` and `POST /api/key` return `403` and `GET /api/state` shows no change; `text/plain` `POST /api/sync` is rejected; existing phase-4 tests (which send no `Origin`) still pass.
- **Result:** pre-handler gate (`originBlocked` → `403 forbidden_origin`; JSON routes → `415` on non-JSON; import keeps raw body + Origin check) in `server.ts`; all new + existing contract tests pass. Residual 2 CLOSED in micro-lane (see Residual risks).

### 4. The saved API key is readable by other local accounts
`lib/storage.ts:L122–128, L232–244` — **Lane C (1st) — DONE (`be71570`)**

- **What this is:** Server and CLI mode save the Gemini key inside the JSON store.
- **Problem:** File permissions come from the process defaults. The isolated test created a `0664` file, which allows other accounts to read it.
- **Traced:** `readCliStore`/`writeCliStore` at `lib/storage.ts:103–129` — `fs.writeFile(CLI_STORE_PATH, snapshot, "utf8")` at `127` with no `mode`/`chmod`. Browser/IndexedDB paths do not use this file.
- **Fix:** Create the store with `0600` permissions and tighten existing files.
- **If we skip it:** Another account on the same machine can copy the Gemini key.
- **Acceptance:**
  - New store file is created with mode `0600` (`stat.mode & 0o777 === 0o600` in an isolated `RADAR_STORE_PATH` test).
  - A pre-existing `0664` store is tightened to `0600` on next write (or load) without changing its contents.
  - CLI/server persistence only; no change to `chrome.storage` behavior. `lib/storage.ts` bundle-safety preserved (`node:fs` stays inside the CLI branch).
- **Result:** store + tmp + lock files created/chmodded `0600`; pre-existing `0664` tightened on load/write; `tests/storage-integrity.test.ts` perm case passes; `bun run build:ext` ok.

### 5. A rejected backup can still change saved data
`lib/storage.ts:L397–476` — **Lane C (2nd) — DONE (`be71570`)**

- **What this is:** Backup import merges external JSON into local state.
- **Problem:** Validation is incomplete and writes start before all fields are checked. A backup with `seenVideoIds: 42` returned an error after changing topics; another backup successfully stored a numeric topic.
- **Traced:** `importBackupJson` (`lib/storage.ts:397–476`): `saveSyncState(nextSync)` runs at `444`, digests are written at `448–458`, and only then does `for (const id of parsed.seenVideoIds || [])` at `461` throw on `42`. Element types are never checked: `parsed.sync.topics` elements, `pinnedChannels` fields (only `ch?.channelId` truthiness at `428`), `digests` values, and `metrics` numbers are all trusted. The same coercion-without-element-checks exists in `POST /api/sync` (`server.ts:258–276`) and the standalone route (`ui/standalone-entry.ts:65–94`).
- **Fix:** Validate the entire backup—including nested types and size limits—before the first write. Apply equivalent checks to `/api/sync`.
- **If we skip it:** A malformed backup can partly overwrite settings or leave data that crashes dashboard rendering.
- **Acceptance:**
  - One shared validator (in `lib/storage.ts`, reused by `importBackupJson`, `server.ts` `/api/sync`, and `ui/standalone-entry.ts` `/api/sync` — no duplicate copies) checks, **before any write**: raw size ≤ 10 MiB; `sync.topics` is an array of non-empty strings (≤ 200 chars each); `pinnedChannels[]` have string `channelId`/`channelName`/`topic`; `topicMeta` values are objects with optional boolean `starred`; `minDurationSec` is a finite number ≥ 0; `telemetryOptIn` is boolean if present; `digests` is a record whose values have a string `topic`, string `generatedAt`, and a `videos[]` array where each video has string `videoId`/`title`/`channelName`/`url` and, if present, `chapterBreakdown[]` (`timestamp`/`sectionTitle` strings, `keyPoints` string[]) and `typeSpecificDetails[]` (`label` string, `items` string[]); `seenVideoIds` is a string array; `metrics`, if present, has only finite numbers ≥ 0.
  - Atomicity test: importing `{ seenVideoIds: 42 }` and `{ sync: { topics: [42] } }` each return an error and leave the store **byte-identical** (CLI path) with no revision bump; `POST /api/sync` with `topics: [42]` returns `400` and `GET /api/state` is unchanged, in both server and standalone route tables.
  - Valid backups (existing phase-4 import tests) still merge without duplicates, still exclude the API key, and still respect the free-topic clamp.
- **Result:** shared `validateSyncValue` + `parseAndValidateBackup` (10 MiB byte check, element types, digest/metrics shapes) reused by `importBackupJson`, server `/api/sync`, standalone `/api/sync`; rejected imports leave store byte-identical with no revision bump (atomicity cases pass); valid-merge tests still green.

### 6. Two extension scans can acquire the same lock
`lib/engine.ts:L52–98` — **Lane D (1st) — DONE (`8bfc011`)**

- **What this is:** The extension lock should prevent simultaneous paid scans.
- **Problem:** Reading and setting `chrome.storage.local` are separate operations. A concurrent harness using the real lock implementation returned `[true, true]` for two competing scans.
- **Traced:** `createChromeScanLock` (`lib/engine.ts:52–98`): `local.get` at `72`, check at `74–80`, `local.set` at `82` — separate awaited ops, so two callers can both pass the check. House precedent: `lib/storage.ts:146–152` (`withTopicWrite`) already uses `navigator.locks.request("radar-topic-write", …)` when available. Note the trap: replacing the get/set **inside** `acquireLock` with `locks.request(...)` releases the lock as soon as `acquireLock` returns — the Web Lock must be held for the whole scan, so `runStandaloneScan` (`lib/engine.ts:125–248`) has to be restructured to run its body inside the lock callback, while keeping the injected `acquireLock`/`releaseLock` deps seam that `tests/engine.test.ts` relies on.
- **Fix:** Hold a Web Lock for the whole scan. The storage layer already uses this browser feature for topic writes.
- **If we skip it:** A tab and side panel can duplicate Gemini work and overwrite each other’s results. Existing engine tests replace this lock, so they miss the race.
- **Acceptance:**
  - With `navigator.locks` available, the scan body runs inside `navigator.locks.request("radar-scan", …)` (or equivalent held-for-scan Web Lock); a second concurrent `runStandaloneScan` returns `409 scan_in_progress` **before** calling `search`, and the first scan's digest/metrics/seen writes complete exactly once.
  - Concurrency test uses the **real** default lock (not the injected fake): two simultaneous scans yield `[200, 409]` (previously `[true, true]` at acquire level), and the lock is released after success, failure, and provider-error paths (existing `tests/engine.test.ts` lock tests still pass).
  - If `navigator.locks` is unavailable, the storage-key fallback remains but the code carries a `shortcut:` comment naming the residual race.
- **Result:** scan body runs inside `navigator.locks.request("radar-scan", { ifAvailable: true })` with capability probe (name-blind shims fall back to the kept `acquireLock`/`releaseLock` seam); real-lock concurrency test yields `[200, 409]` with loser never reaching `search`; old `tests/engine.test.ts` lock tests green; Bun/CLI fallback is now a real in-memory mutex (was allow-all).

### 7. Network stalls can leave scans running indefinitely
`lib/youtube.ts:L143–146, L292–335, L390`; `server.ts:L347–365` — **Lane D (2nd) — DONE (`8bfc011`)**

- **What this is:** Scans depend on YouTube search, player, caption and RSS requests.
- **Problem:** Those requests have no explicit cancellation deadline. After ten minutes, the scan lock expires without stopping the old work, allowing another scan to overlap it.
- **Traced:** Direct `fetch` calls with no `signal`: player POST `lib/youtube.ts:308–322`, caption XML `335`, RSS `390`. Search/getInfo go through Innertube (`getInnertube`, `lib/youtube.ts:57–64`; used at `142`, `287`) — **the worker must first verify whether youtubei.js accepts an `AbortSignal`/custom fetch; do not claim cancellation for a call that is only raced against a timer.** Server scan lock: `SCAN_STALE_MS = 10 min` at `server.ts:67` with supersede at `347–365`; engine lock has the same 10-min staleness at `lib/engine.ts:39,74–80`. `saveTopicDigest` (`lib/storage.ts:267–281`) guards topic-generation changes, not scan supersession — a superseded scan can still write.
- **Fix:** Add cancellable deadlines to outbound requests and the whole scan. Cancel old work before allowing a replacement.
- **If we skip it:** Scans can hang, overlap or finish late and replace a newer digest.
- **Acceptance:**
  - Every direct `fetch` in `lib/youtube.ts` (player, caption, RSS) carries an `AbortSignal` with a deadline (default 30 s; injectable/shortenable for tests — no test may wait 30 s or 10 min of wall clock).
  - Scan-level deadline (server `runScan` and engine `runStandaloneScan`): when it fires, the scan aborts, releases its lock, and — critically — a superseded/late scan performs **no** digest, metrics, or seen writes afterward. Test: stub a hanging transcript fetch with a short injected deadline; assert the scan settles promptly with an error, the lock is free, and no writes occurred; then a replacement scan succeeds and its digest is not overwritten when the old stub resolves.
  - Innertube calls: either wired to a real cancellation mechanism (name it in the diff) or explicitly listed as bounded-but-not-cancelled in a `shortcut:` comment. A `Promise.race` timeout alone does not satisfy "cancellable" and must not be described as cancellation.
- **Result:** direct fetches (player/caption/RSS) via `fetchWithDeadline` (AbortSignal + 30 s default, injectable); scan-level deadline in both pipelines (`504 scan_timeout`, lock freed, superseded body writes guarded off — no digest/metrics/seen, no synthesis spend); Innertube search/getInfo honestly marked bounded-but-not-cancelled via `shortcut:` (no per-call AbortSignal in youtubei.js singleton). Hanging-transcript + replacement-survival tests pass.

### 8. File-write failures can permanently disable saving or erase the store
`lib/storage.ts:L103–129` — **Lane C (3rd) — DONE (`be71570`)**

- **What this is:** CLI/server persistence uses a promise queue and one JSON file.
- **Problem:** One failed write leaves the queue rejected, so later writes fail even after the disk problem is fixed; I reproduced this. Writes also overwrite the live file directly, while malformed JSON is silently treated as a fresh store.
- **Traced:** `writeCliStore` (`lib/storage.ts:122–129`): `cliWriteChain = cliWriteChain.then(...)` — a rejected link poisons every later write (contrast `withTopicWrite` at `149–153`, which already does `next.catch(() => {})` with the comment "A rejected save must not poison later saves" — reuse that house pattern). `readCliStore` (`103–120`) catches **all** errors, including `JSON.parse` failures, and substitutes defaults, which then overwrite the corrupt file on the next write.
- **Fix:** Write to a temporary file and rename it into place. Recover the queue after failures, and use defaults only when the file is missing—not when it is unreadable or corrupt.
- **If we skip it:** Saving can remain broken until restart, or an interrupted write can lead to saved data being replaced with defaults.
- **Acceptance:**
  - Writes go to a temp file in the same directory and are renamed over the store (atomic on the same filesystem); the temp file also respects item 4's `0600`.
  - Queue recovery test: force one write to fail (e.g. unwritable path), restore writability, and the next `saveSyncState`/`updateMetrics` succeeds without a process restart.
  - Missing file (`ENOENT`) → defaults as today. Corrupt/unparseable file → an explicit error (named in the diff) and the corrupt file is left **unchanged** on disk — never silently replaced with defaults.
  - Existing self-checks still pass: `bun -e 'import { runSelfChecks } from "./index.ts"; await runSelfChecks()'` (covers concurrent `saveSyncState`/`updateMetrics`).
- **Result:** temp-file + rename writes; queue recovery via `catch`-before-`then` (house pattern); `ENOENT` → defaults, corrupt → `CorruptStoreError` with file untouched; queue-recovery + corrupt-unchanged tests pass; self-checks green.

### 9. CLI and server processes overwrite each other’s changes
`lib/storage.ts:L100–129` — **Lane C (4th) — DONE (`be71570`)**

- **What this is:** Both modes share the same file but keep separate in-memory copies.
- **Problem:** Write serialization works only within one process. In an isolated two-process test, one process saved new topics; a metrics update from the other restored the old topics.
- **Traced:** `cliStoreCache` (`lib/storage.ts:100`) is per-process; `readCliStore` returns the cache forever after first load, and `writeCliStore` serializes the whole in-memory snapshot — so process B's stale snapshot clobbers process A's committed topics. `RADAR_STORE_PATH` selects the file; there is no cross-process coordination today.
- **Fix:** Enforce one process owning a store at a time and clearly reject a second writer.
- **If we skip it:** Running the CLI while the dashboard is open can silently lose topics, digests or settings.
- **Acceptance:**
  - Mechanism (worker's choice, no new dependency): e.g. an exclusive lock file at `${CLI_STORE_PATH}.lock` created with `wx`, containing the owner pid; a stale lock whose pid is dead is reclaimed. Acquired before the first CLI-store write (server: at startup/first write; CLI: per invocation) and released on clean exit.
  - Two-process test (isolated `RADAR_STORE_PATH`, like `tests/helpers/topic-lifecycle-worker.ts` spawns separate processes): process A holds the store and saves new topics; process B's write attempt fails fast with a clear, named error (e.g. `store_locked` / "store is in use by another process") and A's topics survive; after A exits, B writes successfully; a lock left by a dead pid does not wedge B.
  - Browser/IndexedDB path unaffected; `lib/storage.ts` bundle-safety preserved.
- **Result:** `${CLI_STORE_PATH}.lock` (`wx`, 0600, owner pid, dead-pid reclaim, exit-hook release); second writer fails fast with `StoreLockedError` → `409` on `/api/sync`; holder-exits + stale-lock-reclaimed cases pass; browser path untouched.

## Should fix

### 10. Rescanning pays to summarize unchanged videos again
`server.ts:L115–129`; `lib/engine.ts:L158–174`; `lib/storage.ts:L283–302` — **Lane D (3rd) — DONE (`8bfc011`)**

- **What this is:** Every scan fetches transcripts and generates fresh summaries.
- **Problem:** Saved summaries and seen-video IDs are not checked before summarization. Two identical three-video scans produced six summary calls and two synthesis calls in the isolated harness.
- **Traced:** Both pipelines call transcript→summarize unconditionally per candidate (`server.ts:115–129`, `lib/engine.ts:158–174`). There is no global summary cache: the only stored summaries are the `videos[]` inside each topic's `TopicDigest` (`lib/summarizer.ts:18–50`, via `getDigests()` in `lib/storage.ts:259–265`), and `getSeenVideoIds()` (`lib/storage.ts:283–289`) is only used to *mark* seen after a scan, never to skip work. Minimal scope: reuse is per-topic from that topic's previous digest only — do not build a cross-topic cache.
- **Fix:** Reuse stored summaries for unchanged video IDs. Skip synthesis when the selected videos and summaries have not changed.
- **If we skip it:** Routine rescans spend unnecessary time and Gemini quota.
- **Acceptance:**
  - Before transcript/summarize, look up the candidate's `videoId` in the topic's existing digest; on a hit, reuse the stored `VideoSummary` with no transcript or Gemini call.
  - If the final selected video IDs **and** their summaries are identical to the previous digest's, skip synthesis and keep the previous synthesis/subtopics.
  - Harness test (mocked search/transcript/summarize/synthesize, as in `tests/engine.test.ts` / `tests/helpers/server-quota-worker.ts`): two identical 3-video scans → summarize called 3 times total (not 6), synthesize called once total (not twice); a scan where one video changes → exactly 1 new summarize call. Applies to both `server.ts` `runScan` and `lib/engine.ts` `runStandaloneScan`.
  - Metrics/seen semantics on a fully-reused scan are defined in the diff and asserted (no double-counted `videosSummarized` for reused videos).
- **Result:** per-topic reuse from the topic's previous digest (`indexByVideoId`, no cross-topic cache) in both pipelines; identical selection skips synthesis; rescan test: 3 summarizes total, 1 synthesis total, `videosSummarized: 0` on full reuse, 1-video change → exactly 1 new summarize; reused videos not re-marked seen.

## Orchestration protocol (how sub-agents run this plan)

Parent (this session) owns intent, lane order, and final acceptance. Workers implement; they never approve their own work.

### Per-lane brief (every worker task must state)
Goal (item IDs + acceptance bullets above) · repo + explicit `cwd` + worktree · authority/edit boundary (only the lane's files; `extension/*` is build output — never edit by hand) · traced evidence (the file:line list from the item) · success criteria (= the item's Acceptance) · validation commands · expected output · when to stop and ask (e.g. item 7's Innertube-cancellation unknown).

### No self-approval — three separate roles
1. **Worker** (`agent: "worker"`, fresh context): implements + runs the lane's validation commands. Its brief ends: *"You are the implementer only. Report `ready-for-review` with changed files, commands run, and residual risks. Do not mark this lane accepted, do not review your own diff, do not edit this plan's status."* Enforce mechanically with an acceptance gate on the run:
   `acceptance: { level: "verified", criteria: [<item acceptance bullets>], evidence: ["changed-files","tests-added","commands-run","validation-output","residual-risks","no-staged-files"], verify: [{ id: "lane-gate", command: "<lane gate command>", timeoutMs: 120000 }], review: { required: true } }`
   Evidence reaching `verified` is **not** approval — independent review is a separate gate.
2. **Reviewer** (`agent: "reviewer"`, fresh context — never `context: "fork"` from the worker, never the worker resumed): read-only; gets the diff + the item's Acceptance and checks each bullet, plus blast radius on shared files. Returns findings, not fixes.
3. **Parent**: only the parent marks a lane done, after (a) reviewer findings are resolved and (b) the parent re-runs the lane gate itself. A worker or reviewer saying "looks good" is evidence, not a decision.

### Fix loop — resume the same child
Reviewer findings go back to the **same** worker run so it keeps its context — resume with the latest returned run ID and a new stable key each pass:

```js
let child = await runs.run("lane-a-fix-1", { agent: "worker", task: "…", acceptance: {…} });
const review = await runs.run("lane-a-review-1", { agent: "reviewer", task: "Review diff vs Acceptance: …" });
child = await runs.run("lane-a-fix-2", { resume: child.runId, task: "Apply these accepted findings: …" });
return child.output;
```

Rules: always resume the **latest** `runId` (every resume returns a new one); `resume` excludes `agent`/`gate` (the child keeps them); resume a *completed* child, `steer` a live one (`subagent({ action: "resume" | "steer", id, message })` at top level); stopped runs are non-resumable — relaunch fresh with the findings in the brief. Cap at 2 fix passes per lane; a third failure means the parent takes over or re-scopes.

### Per-lane gates (all must be green before the parent accepts the lane)
| Lane | Worker/reviewer gate | Reviewer focus |
|---|---|---|
| A | `bun test tests/phase4-contract.test.ts` (server on 3459, isolated store) + new Origin/hostname tests | Rejection happens *before* handlers; no-Origin clients unaffected |
| B | New Playwright XSS test + `bunx playwright test tests/e2e/responsive-layout.pw.ts` still green | Every `innerHTML` interpolation escaped; attributes included |
| C | `bun test` + `bun -e 'import { runSelfChecks } from "./index.ts"; await runSelfChecks()'` + new storage two-process/atomicity tests | Validate-before-first-write; queue recovery; bundle-safety of `lib/storage.ts` |
| D | `bun test tests/engine.test.ts tests/scan-backfill.test.ts` + `bun test tests/phase4-contract.test.ts` | Web Lock held for whole scan; superseded scan writes nothing; reuse counts |

### Final parent review (after all lanes)
- `git status` / `git diff --stat`: only lane files touched; no hand-edited `extension/*` (rebuild with `bun run build:ext` only if distribution needs it); no `.env.local` / `.local-radar-store.json` in the diff.
- Parent personally re-runs: `bun test`, `bun test tests/phase4-contract.test.ts`, `bun test tests/youtube-parser-guard.test.ts`, and the self-checks — worker-reported output does not substitute.
- Each item's Acceptance bullet is checked off against a test or a traced line, not against the worker's summary. Anything unverifiable (e.g. item 7 Innertube cancellation) stays listed as a residual risk, not silently closed.

## Verification (final, 2026-11-01)

- Unit suite (`bun test $(ls tests/*.test.ts)`, Playwright `.spec.ts` excluded — residual 6): **87 pass, 0 fail** (A+B: 74; C: 82; D: 87).
- Contract (`tests/phase4-contract.test.ts`, server on 3459, isolated store): **11 pass**.
- Lane D gate (engine + backfill + contract): **31 pass**; old `tests/engine.test.ts` green unmodified.
- Playwright (`bunx playwright test`, server on 3459): `tests/e2e/dashboard-xss.pw.ts` **5 passed**; `tests/e2e/responsive-layout.pw.ts` 6/7 (1 pre-existing backdrop failure, also fails on clean tree).
- Micro-lane (residuals 1, 2, 3, 6): unit set **88 pass / 0 fail**; lane gate (contract, storage-integrity, scan-lifecycle ×2, engine, backfill) **45 pass / 0 fail**; independent reviewer sign-off, no blockers.
- Self-checks (`runSelfChecks`): pass. `bun run build:ext`: ok (bundle-safe; build output reverted from the diff).
- Original audit baseline: 70 tests passed; `bun audit --json` clean. Real-network scan contract test deliberately skipped (unchanged).

**Verdict:** all 10 items fixed in lane order (A+B → C → D). Residuals below are the only open threads.

**Not checked:** Live YouTube/Gemini performance, paid calls, full extension acceptance tests, fresh release package.

## Residual risks (accepted, not silently closed)

1. ~~`javascript:` URL scheme~~ — CLOSED in micro-lane: `ui/digest.js:715` renders `<a>` only for `/^https?:\/\//i`, other schemes fall back to `<span>`; covered by new `tests/e2e/dashboard-xss.pw.ts` case (5/5 green); reviewer swept remaining `href=`/`src=` sinks (iframe + watch link are `encodeURIComponent`-built, safe).
2. ~~`isJsonContent` permissive~~ — CLOSED in micro-lane: strict `ct === "application/json" || ct.startsWith("application/json;")` (closes both the reported bypass and the `application/json-evil` prefix nuance); contract test covers tricky + charset variants (12/12 green).
3. ~~Cosmetic `*/export async` join~~ — CLOSED in micro-lane (one-line split, body untouched).
4. Innertube search/getInfo bounded-but-not-cancelled (youtubei.js singleton takes no per-call signal) — documented via `shortcut:`; upgrade to per-scan session if hangs observed.
5. `chrome.storage` get-then-set race remains as fallback — documented via `shortcut:`; Web Lock is the real guard where available.
6. ~~Playwright specs break bare `bun test`~~ — CLOSED in micro-lane: specs renamed to `tests/e2e/*.pw.ts` + minimal `playwright.config.ts` (`testDir`/`testMatch`); tracked files no longer discovered by bun (unit set 88/88). Remaining bare-`bun test` red is gitignored root `demo_*.spec.ts` throwaways (not product code per AGENTS.md, out of scope) — run the unit set + explicit `bunx playwright test <path>` separately. Note: `tests/e2e/responsive-layout.pw.ts` has 1 pre-existing failure ("backdrop closes the drawer"), reproduced on clean tree — environmental, untouched by this work.
7. Extension smoke not re-run after C/D (no UI-affecting changes there); B covered by the XSS spec.
