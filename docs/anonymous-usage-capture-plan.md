# Anonymous usage capture (PostHog) — implementation plan

## Problem
The shipped standalone extension gives us no visibility into real usage: no
scan success/failure rates, no feature-use data, no activation signal. Chrome
Web Store (CWS) dashboard stats cover installs/weekly users only.

## Context (traced from source)
- Local counters exist (`UsageMetrics`, `lib/storage.ts:25-33`), are shown to
  the user (`ui/digest.js:393-435`), and never leave the device. In the
  standalone build, `/api/*` calls are intercepted in-page
  (`ui/digest.js:6-45`, `ui/standalone-entry.ts:190-193`).
- The opt-in flag `telemetryOptIn` (default `false`, `lib/storage.ts:20,63`)
  is stored, synced, and toggled (`ui/digest.js:1025-1032`) but **never read
  by any sender**. The toggle toast currently claims sharing that never
  happens (`store/privacy-policy.html:257-262` admits this).
- Scan success is the only scan outcome recorded (`lib/engine.ts:359-364`).
  Failed/superseded scans write no metrics, so no success rate is computable
  today — in PostHog or locally.
- Export already bumps a local counter (`backupsExported`,
  `lib/storage.ts:514-515`); import has no counter at all.
- `scripts/verify-package.ts:276-282` pins `host_permissions` to an exact
  expected set (`EXPECTED_HOSTS`), and `:310-335` bans `fetch(` in the prod
  background worker. Both constrain where sending code may live.

## Goal
Answer four questions across all installs: (1) do scans succeed, (2) which
features get used (timestamp jumps, read-aloud, backup export/import),
(3) where users drop off before their first successful scan, (4) which
extension versions are active. CWS remains the population denominator.

## Global constraints
- **Capture is on by default for every standalone install. There is no
  opt-in/opt-out toggle** (decided; this reverses the earlier opt-in
  design). The existing "Share anonymous usage stats" checkbox and its
  handler are removed from the code (Item 3). Disclosure is by prominent
  notice (Settings text + privacy policy + CWS form), not by consent gate.
  **Risk, recorded not resolved:** Chrome's Disclosure Requirements call
  for prominent in-product disclosure plus the user's affirmative informed
  consent *before* collecting user data, and a persistent installation ID
  counts as user data. Default-on capture with no opt-out may draw a CWS
  review rejection or a policy warning; the research recommendation was
  opt-in. Proceeding requires accepting this risk or reinstating an
  opt-off control before submission.
- Plain `fetch` to the PostHog Capture API. No SDK, no new dependency, no
  remotely hosted code (MV3). Sending only from the digest page, only in the
  standalone build (`STANDALONE_ROUTE !== null`, `ui/digest.js:7-10`); dev/
  server mode sends nothing.
- No changes to `lib/engine.ts`, `server.ts`, `lib/summarizer.ts`,
  `lib/youtube.ts`, or the `UsageMetrics` storage schema.
- Never captured: Gemini API key (not even hashed), topics, search queries,
  pinned channels, video/channel titles/IDs/URLs, clicked timestamps,
  transcripts, digests, page URLs, backup contents, raw error messages,
  account identity. Every search and every topic stays on the user's machine.
- Fire-and-forget v1: `shortcut: events are lost if the page closes or the
  network drops mid-send; add a persisted queue only if scan-completion
  counts prove unreliable.`
- **Batching: decided — per-event, immediate, no queue (v1).** Each event is
  one POST at the moment it happens. PostHog's `/batch/` endpoint exists and
  SDKs batch by default, but at ~6-9 events/session batching saves nothing
  (PostHog counts events, not requests) and costs a queue, client-side
  timestamps, and a purge-on-opt-out correctness rule. Never batch in the
  service worker (MV3 kills it after ~30s idle; the verifier bans
  background `fetch(` anyway). Reserved hook if click volume surprises us:
  aggregate `timestamp_clicked`/`tts_played` locally and flush one event
  with a `count` property on the next lifecycle event or page hide.
- **Capture consent variant (pending G1):** variant A (no toggle — all existing DoDs stand) vs variant B (opt-out kept — `captureUsage` gates on `telemetryOptIn`, checkbox stays, G6 assertion flips to 'toggle present and wired', Item 10 manual run gains an opt-out case). Item 3 builds variant B unless G1 signs variant A.

## Public disclosure wording (user-facing)
> We collect anonymous usage data to understand whether Topic Digest is
> working and which features are useful — for example, how many scans
> complete or fail, how many videos are summarised, and whether features
> such as timestamp jumps, read-aloud, and backup export/import are used.
> We do not collect your Gemini API key. Your topics, searches, pinned
> channels, and digests stay on your machine and are never sent to us; we
> only count that a feature was used, never what it was used on.
> We also count which browser family is used (Chrome or Firefox, never the
> full user-agent or browsing history) to tell the two extension builds apart.

The privacy policy additionally names PostHog as the receiving processor,
states that a random installation identifier is used to count distinct
installs, that capture happens by default when the extension is used, and
how long events are retained. There is no in-product opt-out (see the risk
note in Global constraints).

## Event schema

Common envelope (allowlisted — nothing else may be sent):

```json
{
  "api_key": "<PostHog public project token>",
  "event": "<event name>",
  "distinct_id": "<random UUID from chrome.storage.local>",
  "properties": {
    "$process_person_profile": false,
    "$geoip_disable": true,
    "ext_version": "1.0.0",
    "build": "standalone",
    "schema_version": 1,
    "browser": "chrome"
  }
}
```

| Event | Trigger point | Extra properties |
|---|---|---|
| `dashboard_opened` | First successful `loadState()` per page load only | `has_api_key: bool`, `topics_count_bucket`, `digests_count_bucket` (`"0"\|"1"\|"2-5"\|"6+"`) |
| `api_key_saved` | After successful key save | — |
| `scan_started` | Scan handler, before `POST /api/scan` | `max_videos: int` |
| `scan_completed` | Scan handler, `/api/scan` ok | `duration_bucket`, `videos_summarized: int`, `requested_count: int`, `skipped_count: int`, `slop_filtered: int`, `seconds_saved_delta: int` |
| `scan_failed` | Scan handler, `/api/scan` error (incl. early-return branches) | `duration_bucket`, `error_class` (table below) |
| `timestamp_clicked` / `tts_played` | Inside existing `recordMetricEvent` | — |
| `backup_exported` / `backup_export_failed` | Export handler success / failure | — / `error_class: "unknown"` |
| `backup_imported` / `backup_import_failed` | Import handler success / failure | `topics_count_bucket`, `digests_count_bucket` (merged totals, bucketed) / `error_class: "invalid_backup"\|"backup_too_large"\|"unknown"` |

Every event above also carries `browser` (`chrome` | `firefox` | `other`) as a common allowlisted property.

`error_class` mapping (raw error strings are never sent):

| `/api/scan` `error` | `error_class` |
|---|---|
| `quota_exhausted`, `rate_limited` | `quota_or_rate_limit` |
| `invalid_api_key`, `gemini_api_not_enabled` | `api_key_problem` |
| `provider_unavailable` | `provider_unavailable` |
| `scan_timeout` | `timeout` |
| `scan_in_progress` | `scan_in_progress` |
| `topic_changed` | `topic_changed` |
| anything else, thrown/network error | `unknown` |

`duration_bucket` values (decided — closes G5(c)/G8):

| `duration_ms` | `duration_bucket` |
|---|---|
| 0–5s | `0-5s` |
| 5–15s | `5-15s` |
| 15–30s | `15-30s` |
| 30–60s | `30-60s` |
| 60s+ | `60s+` |
| missing/unmeasurable | `unknown` |

Lower-bound inclusive. Measured interval is wall-clock via `Date.now` diff in the scan handler.

Derived product metrics: reporting installs (distinct IDs), activation
(first `scan_completed` per ID; `has_api_key` on `dashboard_opened`), scan
success rate, per-scan output/filtering sums, feature-use adoption,
import success rate, failure mix, version adoption.

---

## Dependencies (required for this flow to succeed)

If any row is missing, the flow fails in the stated way — silently in
several cases, which is why the spike (D2) gates all sending code.

| # | Dependency | Type | Needed by | If missing |
|---|---|---|---|---|
| D1 | PostHog project exists; region (US/EU), endpoint host, public project token, event retention chosen | External decision | Items 1, 3, 8, 10 | Nothing to send to; host permission and policy text cannot be written |
| D2 | **Spike verified:** one hand-sent payload in the exact planned envelope (incl. `distinct_id` placement) from a `chrome-extension://` origin appears in PostHog Live Events | External verification | Items 3-6 (all sending) | PostHog returns 200 even for dropped events — wrong payload shape means *all* events vanish undetected |
| D3 | Default-on decision accepted with its CWS consent risk (see Global constraints); disclosure copy approved as the substitute for a consent gate | Product/legal decision | Shipping at all | Store review may reject or flag the submission for collecting without affirmative consent |
| D4 | Extension updated to the capturing version and dashboard opened (runtime) | Runtime | Every event | Users on older builds send nothing — version adoption understates the installed base during rollout |
| D5 | Item 2 helpers (allowlist payload builder, buckets, error-class maps) | Code | Items 3-6 | Hooks have no safe payload to send; the privacy guarantee is unenforceable |
| D6 | Item 3 sender + `radarAnonId` in `chrome.storage.local`; `crypto.randomUUID()` and `chrome.runtime.getManifest()` available on the extension page | Code + platform | Items 4-6 | No identity, no version, no transport |
| D7 | `state` loaded successfully before hooks read it (`hasApiKey`, metrics snapshots come from loaded state) | Code (existing) | Items 3-5 | Deltas diff against zeroes; `dashboard_opened` properties are wrong |
| D8 | Existing response shapes hold: `/api/scan` returns structured `error` codes (`lib/provider-errors.ts`) and cumulative `metrics`; import returns merged counts; `recordMetricEvent` remains the single funnel for timestamp/TTS | Code (existing) | Items 5, 6 | Error classes and per-scan deltas cannot be derived in the UI |
| D9 | Manifest host permission **and** `EXPECTED_HOSTS` in `scripts/verify-package.ts` updated together; extension rebuilt with `bun run build:ext` | Release | Any sending in the shipped package | Verifier fails the package, or the shipped manifest lacks the host and fetches are blocked |
| D10 | Store copy + CWS disclosure updated in the same release (Item 10) | Release/legal | Shipping at all | Shipped behaviour contradicts the published "collects nothing" policy |
| D11 | PostHog reachable from the user's network at send time | Runtime | Every event | Event lost (accepted, fire-and-forget); counts under-report slightly |

**Ordering:** D1 -> Item 0 spike (D2) -> Item 3 (D6) ->
Items 4-6 hooks. Item 2 (D5) is complete (`ui/telemetry-utils.js`, `tests/telemetry-utils.test.ts`, 114-test suite green) and no longer gated. Item 7 is retired (no work). Item 8 (D9) and Item 9 can proceed in parallel with the
hooks. Item 10 is last and gates submission, not development.

## Open items (council review, 2026-11-02 — 2 passes, oracle + reviewer)

Verdict recorded: **do not start Items 3-6** until blocking items G1-G3
are resolved. Item 2 is complete (`ui/telemetry-utils.js`, `tests/telemetry-utils.test.ts`, 114-test suite green). Spec items G4-G8 must be written into the affected items
before coding to avoid rework. Owner items G9-G10 need a recorded choice
before submission. Council run IDs: Pass 1 oracle
`f9492bb7-f1e8-4d4a-8029-47d2079015f8` (fork), reviewer
`14267a27-a39e-46e7-95d0-67da410ab3c7`; Pass 2 oracle `273c69a0`,
reviewer `c50996cf` (neither changed recommendation; disputed details
settled as noted).

| # | Open item | Severity | Status | Affects |
|---|---|---|---|---|
| G1 | D3 default-on risk accepted but unsigned: Decisions checklist still all unchecked; Items 3-10 build on an unrecorded owner decision | Blocking | Open — owner must sign or reinstate opt-off/opt-in before Item 3. See 'Capture consent variant (pending G1)' in Global constraints. | Item 1, Item 3, Decisions |
| G2 | Item 0 spike DoD must assert received event has no auto-added `$ip`/geo fields; note it proves PostHog did not attach them, not that transport never saw source IP — policy must not overclaim | Blocking | Open — strengthen Item 0 DoD (done) and run spike | Item 0, Item 10, disclosure wording |
| G3 | Disclosure-timing contradiction: Settings text is hidden until the gear is clicked, but `dashboard_opened` fires on first `loadState()` — collection precedes the notice. Accepted fix: dashboard-visible first-capture-version notice rendered before the first `captureUsage` call, gated by a `chrome.storage.local` shown-flag (also covers upgraders) | Blocking | Open — add notice to Item 3/4 before coding | Items 3, 4, 10 |
| G4 | Success-rate formula undefined: headline must be `completed / (completed + failed)` **excluding** `scan_in_progress`/`topic_changed` (aborts, reported separately); orphaned `scan_started` events (page closed mid-scan) never enter the ratio — report `started - terminal` as an explicit abandonment count, and note terminal events under-represent long scans (censoring) | Spec | Open — write into Item 5 + metrics section | Item 5, schema |
| G5 | Error-derivation details missing: (a) classify `topic_changed` **before** the human-sentence throw at `ui/digest.js:1224` (Item 5 must mandate pre-throw classification or one `scanOutcome` variable emitted once); (b) superseded-by-decision: default-flip (empty->unknown, size signals->backup_too_large, everything else->invalid_backup) — do not reintroduce keyword lists; (c) closed — ranges recorded in the Event schema `duration_bucket` table (lower-bound inclusive, wall-clock via `Date.now` diff in the scan handler); (d) document `videos_summarized` = cumulative-metrics delta (fresh count, diverges from digest length on fully-reused scans) | Spec | Partially closed — (b) superseded-by-decision, (c) closed; (a) and (d) open — write into Items 5, 6, 9 | Items 2, 5, 6, 9 |
| G6 | Items 3-6 DoDs are manual-only and no test touches `telemetryToggle`/digest UI: minimum guard is one source-slice Bun test (existing `tests/topic-lifecycle.test.ts:73-95` pattern) driving the scan handler through success/quota-failure/`topic_changed` with stubbed `captureUsage`, plus static assertions (standalone gate, checkbox assertion per consent variant — absence under A, present-and-wired under B — `dashboard_opened` in `!initialLoadDone`, single `recordMetricEvent` call site) | Spec | Open — extend Item 9 before coding | Item 9 |
| G7 | Item 10 scope incomplete: must explicitly include `store/listing.md`, CWS data-category selection (persistent UUID = user data), and PostHog host justification in `store/permissions.md` | Spec | Open — extend Item 10 | Item 10 |
| G8 | `duration_bucket` value table missing from the Event schema (property named, ranges absent) — folded into G5(c), tracked separately so Item 9(a) is not unimplementable | Spec | Closed — table recorded in the Event schema (`0-5s`/`5-15s`/`15-30s`/`30-60s`/`60s+`/`unknown`, lower-bound inclusive, wall-clock via `Date.now` diff in the scan handler) | Schema, Items 2, 9 |
| G9 | Deletion-request path for an invisible `distinct_id` undefined: either expose the ID in Settings/diagnostics for support-led PostHog deletion, or state events are non-retrievable and expire by retention — policy must not imply an exercisable right that does not exist | Owner | Open — decide in Item 1/10 | Items 1, 10, Decisions |
| G10 | Rollout impacts unverified: (a) existing users auto-update into capture with no new action and never see updated store copy — the G3 version-keyed notice is the mitigation; (b) whether a new `host_permission` disables the extension pending re-approval must be verified externally and sequenced before Item 8 ships; (c) "anonymous" vs "pseudonymous" wording for a persistent UUID must be chosen | Owner | Open — decide before Item 8/submission | Items 8, 10, Decisions, wording |

## Implementation items

### Item 0 — PostHog spike (dependency D2)
- **Scope:** No repo code. One manual send against the real project.
- **Problem:** PostHog can return 200 while dropping malformed events; the
  plan's envelope (incl. where `distinct_id` sits) is assumed, not proven.
- **Goal:** Confirm the exact envelope plus `chrome-extension://` CORS
  against the project created in Item 1.
- **Constraint:** Uses the real public project token and region host — the
  same values Items 3 and 8 will embed.
- **DoD:** The test event is visible in PostHog Live Events with the
  intended properties **and the received event's full property set
  contains no auto-added `$ip`/geo fields** (open item G2 — without
  this, the "anonymous" wording in Section "Public disclosure wording"
  is wrong). The verified envelope is recorded verbatim in this file.
  Items 3-6 do not start before this passes.
  `checkpoint: council P2 (C2, reviewed by oracle).`

### Item 1 — Decisions and PostHog project setup
- **Scope:** No code. PostHog project config + this file.
- **Problem:** Region determines the host permission and policy text;
  retention must be statable in the privacy policy.
- **Context:** PostHog project token is publishable by design; no secret can
  ship in the package.
- **Goal:** Project created, region (US/EU) chosen, event retention set,
  public wording above approved.
- **Constraint:** Decide before Item 8 (manifest) — the endpoint host is
  written in two places that must agree. Includes recording the
  default-on risk acceptance (D3).
- **DoD:** Region, endpoint host, retention period, and approved wording
  recorded under "Decisions" at the bottom of this file.
  Open items to close here: G1 (sign D3), G9 (deletion-request path),
  G10 (wording anonymous vs pseudonymous, existing-user rollout).

### Item 2 — Pure telemetry helpers (`ui/telemetry-utils.js`)
- **Scope:** New file `ui/telemetry-utils.js`; `package.json` dev-build copy
  list; new test file (Item 9). No changes to existing logic.
- **Problem:** Bucketing, error-class mapping, and payload construction must
  be testable without a browser, and must guarantee non-allowlisted data
  cannot leak into a payload.
- **Context:** Mirrors the existing precedent — `ui/tts-scan-utils.js` holds
  pure helpers imported by `ui/digest.js` and unit-tested directly
  (`tests/tts-scan-utils.test.ts`). The prod bundle inlines imports; the dev
  build copies files by name, so the new file must join the `build:ext:dev`
  copy list in `package.json` or the dev extension breaks.
- **Goal:** Export `countBucket(n)`, `durationBucket(ms)`,
  `scanErrorClass(errorCode)`, `importErrorClass(messageOrCode)`,
  `browserBucket(ua, hasBrave, uaBrands)` (same order as `getBrowserName`), and
  `buildCapturePayload({ apiKey, event, distinctId, version, props })`
  which emits only the envelope keys plus an explicit per-event property
  allowlist, dropping everything else. `browser` (`"chrome"|"firefox"|"other"`;
  Chromium family collapses to `"chrome"`) is a common allowlisted property
  on every event.
- **Constraint:** Pure functions only — no `chrome.*`, no `fetch`, no state.
  Property allowlist lives here, not at call sites.
- **DoD:** Helpers exported; dev copy list updated; unit tests in Item 9 pass.
  Open items to close here: G5 (define `durationBucket` ranges, edge
  inclusivity, measured interval; prefix/substring rules for
  `importErrorClass`; document `videos_summarized` = metrics-delta fresh
  count) — Item 9(a) is otherwise unimplementable.

### Item 3 — Capture sender and identity; remove the opt-in checkbox
- **Scope:** One helper in `ui/digest.js` near `recordMetricEvent`
  (`ui/digest.js:299-312`); **remove** the checkbox markup in
  `ui/digest.html:51-54`, its change handler (`ui/digest.js:1025-1032`),
  and the checkbox state sync in `renderMetricsUI` (`ui/digest.js:406`).
  Replace the checkbox with static disclosure text (the public wording).
  The `telemetryOptIn` field itself is left dormant in the sync schema
  (validated, round-tripped, ignored) — removing it from `SyncState`,
  both `/api/sync` handlers, and backup validation is a separate cleanup
  that would break existing fixtures for no user benefit.
- **Problem:** Events must be standalone-only, carry a stable per-install
  ID, and fail silently — telemetry must never break a user action. The
  checkbox must go without breaking Settings rendering.
- **Context:** `ui/digest.js` already overrides `window.fetch` (`:17-45`);
  a non-`/api/` URL passes through to the native fetch untouched, so the
  PostHog POST works without touching the interception layer.
  `chrome.storage.local` already has precedent in this file (`:96, 1059`).
- **Goal:** `captureUsage(event, props)`: no-op unless
  `STANDALONE_ROUTE !== null` (standalone build only — no consent gate);
  loads/mints `radarAnonId` (`crypto.randomUUID()`) on first send in
  `chrome.storage.local`; builds the payload via Item 2; fire-and-forget
  POST wrapped in try/catch. `ext_version` from
  `chrome.runtime.getManifest().version`.
- **Constraint:** ID never enters `chrome.storage.sync`, backups, or
  `lib/storage.ts`. Sender must never throw into callers. Background worker
  untouched (package verifier bans `fetch(` there).
- **DoD:** In dev mode, zero network calls to PostHog; in the standalone
  build, one well-formed POST per event with no toggle present in the
  Settings UI; removing the checkbox/handler leaves Settings rendering
  and all existing UI tests green; `radarAnonId` persists across page
  loads in `chrome.storage.local`.
  Open items to close here: G3 (dashboard-visible first-capture-version
  notice before the first `captureUsage` call, `chrome.storage.local`
  shown-flag — Settings text alone is not prominent and the first event
  currently fires before it is seen).

### Item 4 — Dashboard-open and API-key events
- **Scope:** `loadState()` first-load block and `btnSaveKey` handler in
  `ui/digest.js`.
- **Problem:** Activation needs a session start and a "key configured"
  signal, but `loadState()` re-runs after nearly every action (save, scan,
  import), so a naive hook massively overcounts opens.
- **Context:** `loadState` already tracks first load via `initialLoadDone`
  (`ui/digest.js:314-340`); the key-save handler confirms success before
  toasting (`:1099-1128`).
- **Goal:** Emit `dashboard_opened` exactly once per page load, inside the
  `!initialLoadDone` success path, with bucketed counts from the just-loaded
  state. Emit `api_key_saved` after a successful key save only.
- **Constraint:** The event carries `has_api_key` as a boolean — never the
  key, its length, or its prefix (the UI's `maskedKey` must not be reused).
- **DoD:** Reloading state via save/scan/import in one session produces no
  second `dashboard_opened`; a fresh page load produces exactly one; saving
  a key produces exactly one `api_key_saved`.
  Open items to close here: G3 (no `dashboard_opened` until the G3
  first-run notice has been shown once — covers upgraders too).

### Item 5 — Scan lifecycle events (the missing failure metrics)
- **Scope:** Scan button handler only (`ui/digest.js:1176-1262`). No engine,
  storage, or server changes.
- **Problem:** Today only successful scans are counted anywhere
  (`lib/engine.ts:359-364`); failures are invisible, so scan success rate —
  the single most decision-relevant metric — is unknowable.
- **Context:** The handler already receives everything needed: the
  structured `error` code on failure (provider codes defined in
  `lib/provider-errors.ts:31-38`) and, on success, the digest plus the
  **cumulative** metrics object. Per-scan values are therefore deltas:
  snapshot `state.metrics` before the fetch and diff against the returned
  `data.metrics` (fresh `videosSummarized`, `slopVideosFiltered`,
  `secondsSaved`) before `loadState()` overwrites state. The handler has
  early `return`s for quota/auth/provider branches inside its `try` — each
  must emit `scan_failed` (or set a pending failure emitted once), and the
  `catch` maps thrown/network errors to `unknown`.
- **Goal:** `scan_started` before the fetch (after the offline guard),
  `scan_completed` with delta properties on success, `scan_failed` with
  mapped `error_class` on every failure path.
- **Constraint:** The `topic` variable in scope must never enter a payload —
  Item 2's allowlist is the enforcement, not caller discipline. Telemetry
  failure must not alter toasts, state reload, or the `finally` cleanup.
- **DoD:** One successful scan → exactly one started + one completed with
  deltas matching the returned metrics; one quota failure and one invalid-key
  failure → started + failed with `quota_or_rate_limit` /
  `api_key_problem`; no event contains the topic string.
  Open items to close here: G4 (headline success =
  `completed / (completed + failed)` excluding `scan_in_progress` +
  `topic_changed` as separate abort classes; report `started - terminal`
  as abandonment; note terminal censoring of long scans); G5(a) (retain
  `data.error` at `ui/digest.js:1224` and classify before the
  human-sentence throw — or one `scanOutcome` variable emitted once);
  G5(d) (`videos_summarized` delta semantics on fully-reused scans).

### Item 6 — Feature-use events (timestamp, TTS, backup import/export)
- **Scope:** `recordMetricEvent` (`ui/digest.js:299-312`) and the backup
  handlers (`:1266-1312`).
- **Problem:** Whether users use timestamp jumps, read-aloud, and especially
  backup import/export is currently unknowable; import has no counter of any
  kind.
- **Context:** All four timestamp/TTS call sites already funnel through
  `recordMetricEvent("timestampClick" | "ttsPlay")` (`:825, 834, 843, 991`),
  so one added line there covers every call site. Export/import handlers
  already distinguish success from failure and import already returns merged
  `topicsCount`/`digestsCount`.
- **Goal:** Map the two existing metric events to `timestamp_clicked` /
  `tts_played` inside `recordMetricEvent` (after the local metric succeeds);
  emit `backup_exported`/`backup_export_failed` and
  `backup_imported`/`backup_import_failed` in the backup handlers, with
  bucketed merged counts on import success.
- **Constraint:** No `UsageMetrics` schema change — import gets no local
  counter; the PostHog events alone answer feature use. Backup file name,
  size, and contents never enter a payload.
- **DoD:** Clicking a timestamp and playing TTS each emit one event;
  a successful export and a successful import each emit one event; a
  deliberately corrupted import file emits `backup_import_failed` with
  `invalid_backup` and imports nothing (existing behaviour unchanged).
  Open items to close here: G5(b) (`importErrorClass` substring rules
  for `lib/storage.ts:626-636` message shapes).

### Item 7 — Backup import and the dormant flag (retired)
- **Status:** Retired by the default-on decision. This item previously
  guarded against a backup silently enabling telemetry on import.
- **Why it is moot:** Capture no longer reads `telemetryOptIn` at all
  (Item 3), so the value a backup carries (`lib/storage.ts:699`) cannot
  change capture behaviour on any device. No code change in
  `lib/storage.ts`; the field stays dormant in the schema.
- **DoD:** Grep confirms no capture path reads `telemetryOptIn`; existing
  backup-merge tests pass unchanged.

### Item 8 — Manifest, package verifier, and build
- **Scope:** `scripts/manifest.prod.json` (one `host_permissions` entry),
  `scripts/verify-package.ts` (`EXPECTED_HOSTS`, `:16-22, 276-282`),
  `package.json` (dev copy list, from Item 2).
- **Problem:** Adding the PostHog host to the manifest alone fails package
  verification — the verifier pins the exact host set. Both must change
  together or the release pipeline goes red.
- **Context:** `permissions` (non-host) are unchanged, so
  `EXPECTED_PERMISSIONS` stays. The DNR ruleset is YouTube-only and
  unrelated. Prod background remains fetch-free, satisfying the verifier's
  background checks.
- **Goal:** Manifest and verifier agree on the new host set
  (`youtube.com`, `generativelanguage.googleapis.com`, PostHog region host
  from Item 1); dev build copies `telemetry-utils.js`.
- **Constraint:** No new `permissions`, no alarms/notifications, no localhost
  hosts — verifier assertions on those must keep passing untouched.
- **DoD:** `bun run build:ext` succeeds; `bun run verify:package` passes;
  built `extension/manifest.json` shows exactly the three hosts; dev build
  (`bun run build:ext:dev`) loads without a missing-module error.
  Open items to close here: G10(b) (verify externally whether the new
  host permission disables auto-updated installs pending re-approval;
  sequence rollout before shipping).

### Item 9 — Lightweight tests
- **Scope:** One new test file, `tests/telemetry-utils.test.ts`; no changes
  to existing suites.
- **Problem:** The privacy guarantee ("only counts/buckets/enums can be
  sent") needs a cheap, permanent guard — not a browser harness.
- **Context:** Repo precedent is direct unit tests of pure UI helpers
  (`tests/tts-scan-utils.test.ts`, `bun test`, no network). Existing
  engine/scan-lifecycle/storage suites already prove the untouched layers
  keep behaving; they need no telemetry cases.
- **Goal:** Cover exactly: (a) `countBucket`/`durationBucket`/`browserBucket` boundaries;
  (b) every row of the `error_class` mapping tables, incl. unknown fallback;
  (c) `buildCapturePayload` drops non-allowlisted properties — feed it
  `topic`, `apiKey`, `videoId`, `url` and assert none survive and the
  envelope fields are exact. (The sender's standalone-only gate and the
  checkbox removal are covered by the Item 10 manual run plus existing UI
  tests staying green, not by new harness code.)
- **Constraint:** No PostHog network, no Chrome APIs, no Playwright. Tests
  must run in the normal `bun test` pass in milliseconds.
- **DoD:** `bun test tests/telemetry-utils.test.ts` green; full `bun test`
  still green (contract, storage-integrity, engine, scan-lifecycle prove no
  regression in untouched layers).
  Open items to close here: G6 (extend Item 9 with one source-slice test
  driving the scan handler through success / quota-failure /
  `topic_changed` with stubbed `captureUsage` asserting exact sequences
  and no topic in props, plus static assertions: standalone gate string,
  `telemetryToggle` absence, `dashboard_opened` inside `!initialLoadDone`,
  single `recordMetricEvent` call site).

### Item 10 — Store copy, disclosure, and rollout validation
- **Scope:** `ui/digest.html` (static disclosure text replacing the
  checkbox, from Item 3), `store/privacy-policy.html`, `store/data-disclosure.md`,
  `store/permissions.md`, `store/submission-checklist.md`, **plus
  `store/listing.md` (G7)**, CWS dashboard privacy fields **incl. the
  data-category selection for the persistent UUID (G7)**.
- **Problem:** The store listing's core promise is currently "developer
  collects nothing" — shipping capture without rewriting those claims in
  the same change is a policy violation and a trust risk.
- **Context:** Affected claims are enumerated at
  `store/privacy-policy.html:158, 247-262` and
  `store/data-disclosure.md:15-23, 101-110`; the checklist pins "collects:
  No" (`store/submission-checklist.md:73`).
- **Goal:** All copy switched to the approved public wording; privacy policy
  names PostHog, the random installation identifier, default-on capture,
  and retention. No copy may promise an opt-out that does not exist.
- **Constraint:** Copy lands in the **same** release as the code — never
  disclose-then-collect or collect-then-disclose across versions.
- **DoD:** No "collects nothing / no analytics" claim remains in `store/`;
  manual test-profile run — open dashboard (no toggle interaction), save
  key, run one good scan, one failing scan, click a timestamp, play TTS,
  export, import, corrupt-import — shows exactly the expected PostHog Live
  Events with allowlisted properties only, with zero user opt-in action;
  rebuilt extension passes the standalone smoke test.

## Impact summary
- **Touched:** `ui/digest.js`, `ui/digest.html`, new `ui/telemetry-utils.js`,
  `scripts/manifest.prod.json`,
  `scripts/verify-package.ts` (expected hosts), `package.json` (dev copy
  list), `store/*` copy, one new test file.
- **Untouched:** scan engine, server, summarizer, YouTube layer, storage
  metrics schema, background workers, DNR rules, local `/api/metrics` flow.
- **User-visible change:** the Settings checkbox is replaced by disclosure
  text, and every standalone user generates outbound PostHog requests by
  default. Dev/server users see zero behavioural change.

## Known limits (accepted)
- No opt-in bias — capture covers all standalone installs on the new
  version, so PostHog counts approach population totals (CWS remains the
  cross-check). The cost is the consent/store-review risk recorded in
  Global constraints, plus probable negative-review sensitivity from
  privacy-conscious BYOK users who chose this tool partly for its
  "collects nothing" promise.
- Reinstall/storage-clear mints a new ID; two browsers count twice.
  Uninstalls remain a CWS-only signal.
- Fire-and-forget undercounts slightly (see shortcut in Global constraints).

## Decisions (to record at implementation)
- [x] PostHog region + endpoint host: EU — `https://eu.i.posthog.com` (Item 3/8 default; override via `POSTHOG_HOST` at build time)
- [x] Event retention period: 90 days
- [x] Default-on risk accepted (D3): no — variant B (opt-in toggle kept, checkbox default OFF; see consent-variant note)
- [ ] Public wording approved as written above: yes / no
