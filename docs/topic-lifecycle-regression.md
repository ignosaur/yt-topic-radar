# Topic deletion and re-addition regression

## Code path and fix

- Dashboard remove/add handlers call `saveSync` in `ui/digest.js`.
- Server `POST /api/sync` and standalone `handleApi` both call `saveSyncState` in `lib/storage.ts`.
- Shared storage now removes a deleted topic's digest, metadata, and associated pins. Other topics and global settings/history remain intact.
- Each save returns a new revision. Dashboard saves include the revision they observed; stale saves return HTTP 409 `stale_state`, and the dashboard reloads for retry.
- Each newly added topic receives a generation identifier. Scan completion commits only if the identifier captured at scan start still matches. Deletion followed by re-addition cannot accept an earlier scan.
- Sync changes and conditional digest commits share a write lock. Extension pages use Web Locks; server requests use a promise queue.
- Failed dashboard saves restore the last known sync state. Confirmed deletes clear cached content. Successful scan responses reload authoritative state rather than inserting a potentially obsolete response.

## Existing coverage reused

`engine.test.ts` already covers scan success, skipped/all-failed videos, lock rejection/release, count limits, and seen-write failure. `scan-backfill.test.ts` covers replacement attempts. Parser and TTS/scan utility tests remain unchanged.

`phase4-contract.test.ts` already covers free/Pro limits, entitlement validation, grandfathered saves, and backup restrictions. Its real-network concurrent-scan test is explicitly excluded below. Lifecycle scan races use deferred promises and fixture summaries instead.

## New coverage

`tests/topic-lifecycle.test.ts` runs 19 tests:

- For each of server and standalone: cleanup and re-addition, stale-tab rejection, simultaneous conflicting saves, ordinary updates, scan finishing after deletion, scan finishing after delete/re-add (including a fresh successful scan), and unrelated-topic removal during a scan.
- Dashboard callbacks: network save failure, HTTP save failure, confirmed-delete cache cleanup, and a late scan response after re-addition.

API tests execute the actual route handlers without sockets. A subprocess per scenario isolates module mocks and storage caches. Standalone uses cloned in-memory Chrome storage/IndexedDB adapters and a serialized Web Locks substitute. Dashboard tests execute the actual function/callback source with UI/network boundaries replaced; they are not full browser interaction tests.

A standalone storage failure test also rejects the Chrome sync write, checks that topics and digests both survive, and verifies that a retry can commit the deletion.

Search, transcripts, summaries, and synthesis are fixtures. External fetch is blocked and its call count must remain zero. The tests use temporary stores and never read the user's key or local store.

## Red → green evidence

On the original HEAD source, the final 18 regression tests produce **5 passes, 13 failures**. With the fix they produce **18 passes, 0 failures**. Original source was tested in a temporary archive, without reverting the working tree.

Validation commands:

```sh
bun test tests/topic-lifecycle.test.ts tests/engine.test.ts tests/scan-backfill.test.ts tests/tts-scan-utils.test.ts tests/youtube-parser-guard.test.ts
# 40 pass, 0 fail
bun test tests/phase4-contract.test.ts --test-name-pattern '^(?!concurrent scans)'
# 6 pass, 1 filtered out, 0 fail
bun run build:ext
# success; generated extension/digest.js updated
```

Storage/scoring/chunking self-checks also passed with `RADAR_STORE_PATH` pointing at a temporary store and external fetch blocked. `git diff --check` passed.

Ripwire found the new test worker and suite in the affected-test graph. The added optional storage parameters are intentional; no incompatible callers were reported. Its quality check still flags recent churn in the existing server handler and size growth in the generated standalone route handler; no suppressions were added.

Compatibility: direct internal saves and older API clients without a revision remain accepted. Conflict protection applies to clients that send the observed revision, including the updated dashboard. Legacy topics without generation metadata use a stable fallback until re-added. Explicit backup import retains its existing merge behavior.

## Review finding verification

The reported partial-write issue was reproduced before the review fix: the new standalone sync-failure test failed because the topic remained subscribed but its digest disappeared. The fix restores the previous IndexedDB digests if the subsequent sync commit fails, before releasing the topic write lock. If restoring also fails, both errors are surfaced together.

After the fix, all 19 lifecycle tests pass (40 with the existing offline suites), the six selected contract tests pass, self-checks pass, and the production extension build succeeds. No Gemini, AI, or YouTube calls were used.

Live browser interaction and real generation were not performed for this change.
