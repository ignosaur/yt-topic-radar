# Performance and security audit

## What this repo does:
Scans YouTube topics and uses Gemini to produce timestamped summaries. It runs as a local Bun dashboard/CLI or a standalone Chrome extension.

**Assumed load:** one person, sometimes using a tab and side panel together, with occasional CLI use. Not a public server.

## Must fix

### 1. Untrusted text can execute JavaScript
`ui/digest.js:L609–627, L681–760, L937–950`

- **What this is:** Topics, AI summaries and imported backups are displayed in the dashboard.
- **Problem:** Several fields go directly into `innerHTML` without escaping. Browser tests confirmed JavaScript execution through both a topic and a summary bullet.
- **Fix:** Apply the existing `esc()` helper consistently to text and attribute values. Add browser tests using malicious HTML.
- **If we skip it:** Opening a poisoned digest can run code with dashboard access. Chrome extension policy limits inline scripts, but injected HTML remains unsafe.

### 2. The “local” server accepts network connections without authentication
`server.ts:L189–200`

- **What this is:** The Bun server exposes saved state and actions that spend Gemini quota.
- **Problem:** No listening address is specified. I confirmed a wildcard listening socket and successfully fetched `/api/state` through non-loopback network interfaces.
- **Fix:** Bind explicitly to `127.0.0.1`. Keep network hosting unsupported unless authentication is added.
- **If we skip it:** Other devices can read backups, change settings or start scans wherever the firewall permits access.

### 3. CORS does not prevent unwanted writes
`server.ts:L52–60, L257–285, L315–321`

- **What this is:** CORS controls which websites may read API responses.
- **Problem:** Disallowed origins still reach the handlers. A browser page on an untrusted loopback origin successfully changed topics using a plain-text POST; blocking the response did not block the write.
- **Fix:** Reject untrusted `Origin` values before processing mutations. Require JSON content types on JSON endpoints; separately protect the raw backup-import route.
- **If we skip it:** An unwanted request can replace the key, change topics or trigger scans when browser network rules permit it.

### 4. The saved API key is readable by other local accounts
`lib/storage.ts:L122–128, L232–244`

- **What this is:** Server and CLI mode save the Gemini key inside the JSON store.
- **Problem:** File permissions come from the process defaults. The isolated test created a `0664` file, which allows other accounts to read it.
- **Fix:** Create the store with `0600` permissions and tighten existing files.
- **If we skip it:** Another account on the same machine can copy the Gemini key.

### 5. A rejected backup can still change saved data
`lib/storage.ts:L397–476`

- **What this is:** Backup import merges external JSON into local state.
- **Problem:** Validation is incomplete and writes start before all fields are checked. A backup with `seenVideoIds: 42` returned an error after changing topics; another backup successfully stored a numeric topic.
- **Fix:** Validate the entire backup—including nested types and size limits—before the first write. Apply equivalent checks to `/api/sync`.
- **If we skip it:** A malformed backup can partly overwrite settings or leave data that crashes dashboard rendering.

### 6. Two extension scans can acquire the same lock
`lib/engine.ts:L52–98`

- **What this is:** The extension lock should prevent simultaneous paid scans.
- **Problem:** Reading and setting `chrome.storage.local` are separate operations. A concurrent harness using the real lock implementation returned `[true, true]` for two competing scans.
- **Fix:** Hold a Web Lock for the whole scan. The storage layer already uses this browser feature for topic writes.
- **If we skip it:** A tab and side panel can duplicate Gemini work and overwrite each other’s results. Existing engine tests replace this lock, so they miss the race.

### 7. Network stalls can leave scans running indefinitely
`lib/youtube.ts:L143–146, L292–335, L390`; `server.ts:L347–365`

- **What this is:** Scans depend on YouTube search, player, caption and RSS requests.
- **Problem:** Those requests have no explicit cancellation deadline. After ten minutes, the scan lock expires without stopping the old work, allowing another scan to overlap it.
- **Fix:** Add cancellable deadlines to outbound requests and the whole scan. Cancel old work before allowing a replacement.
- **If we skip it:** Scans can hang, overlap or finish late and replace a newer digest.

### 8. File-write failures can permanently disable saving or erase the store
`lib/storage.ts:L103–129`

- **What this is:** CLI/server persistence uses a promise queue and one JSON file.
- **Problem:** One failed write leaves the queue rejected, so later writes fail even after the disk problem is fixed; I reproduced this. Writes also overwrite the live file directly, while malformed JSON is silently treated as a fresh store.
- **Fix:** Write to a temporary file and rename it into place. Recover the queue after failures, and use defaults only when the file is missing—not when it is unreadable or corrupt.
- **If we skip it:** Saving can remain broken until restart, or an interrupted write can lead to saved data being replaced with defaults.

### 9. CLI and server processes overwrite each other’s changes
`lib/storage.ts:L100–129`

- **What this is:** Both modes share the same file but keep separate in-memory copies.
- **Problem:** Write serialization works only within one process. In an isolated two-process test, one process saved new topics; a metrics update from the other restored the old topics.
- **Fix:** Enforce one process owning a store at a time and clearly reject a second writer.
- **If we skip it:** Running the CLI while the dashboard is open can silently lose topics, digests or settings.

## Should fix

### 10. Rescanning pays to summarize unchanged videos again
`server.ts:L115–129`; `lib/engine.ts:L158–174`; `lib/storage.ts:L283–302`

- **What this is:** Every scan fetches transcripts and generates fresh summaries.
- **Problem:** Saved summaries and seen-video IDs are not checked before summarization. Two identical three-video scans produced six summary calls and two synthesis calls in the isolated harness.
- **Fix:** Reuse stored summaries for unchanged video IDs. Skip synthesis when the selected videos and summaries have not changed.
- **If we skip it:** Routine rescans spend unnecessary time and Gemini quota.

## Verification

- **70 tests passed**, plus isolated self-checks.
- Browser checks confirmed HTML execution and cross-origin writes.
- Storage, lock and network-listening checks used temporary stores.
- `bun audit --json` reported no known dependency vulnerabilities.
- No repository files changed during the audit; this report was saved afterward at the user's request.

**Verdict:** Fix dashboard HTML injection and server access boundaries first, then scan locking and persistence.

**Not checked:** Live YouTube/Gemini performance, paid calls, full extension acceptance tests or a fresh release package. The real-network scan contract test was deliberately skipped.
