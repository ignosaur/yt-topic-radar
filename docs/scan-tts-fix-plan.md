# Implementation Plan — Scan-status bleed, TTS on Brave, server single-flight

> Active implementation plan for the three manually-reported issues.
> Product decisions were locked with the reporter before planning (toast-not-disable
> for TTS, cached content for idle topics, global 409 for concurrent scans).
> Repo conventions live in `AGENTS.md`; product context in `PLAN.md`.

## 0. Guiding practices (why this plan looks the way it does)

- **Anthropic, "Building Effective Agents"** — *"finding the simplest solution
  possible, and only increasing complexity when needed"*; prefer predefined
  workflows over autonomous behavior for well-defined tasks; *"gain 'ground truth'
  from the environment at each step"*; *"extensive testing in sandboxed
  environments, along with the appropriate guardrails."*
  Applied here: each step is a small predefined change with a verification gate
  (ground truth) before proceeding; sandboxed tests use an isolated store
  (`RADAR_STORE_PATH` → temp dir); the server 409 lock is the guardrail.
- **Anthropic's three principles** (simplicity, transparency, well-crafted
  interfaces) — applied: sync UA-string browser detection instead of async
  `navigator.brave.isBrave()`; pure DOM-free utils module as the clean
  client/test interface; no new dependencies.
- **OpenAI Agents docs (platform.openai.com/docs/guides/agents)** — tool design
  and explicit state/cleanup ownership across runtimes.
  Applied here: explicit state ownership (`scanningTopic` client-side,
  `activeScan` server-side, both cleared in `finally`); every change verified in
  **both** shells (bun-served page and extension panel), since the extension
  rewrites `/api/*` to `http://localhost:3456` (`ui/digest.js:1-19`).
- **OpenAI, "A Practical Guide to Building Agents"** — define success criteria
  (evals) before building; start simple; add guardrails for high-stakes actions
  (here: Gemini quota burn from parallel scans).
  Applied here: §1 success criteria are the evals; §5 Definition of Done is the
  exit gate; the 409 guard exists to cap quota cost.

## 1. Success criteria (evals — must all hold before merge)

1. Scanning topic A then switching to topic B shows B's cached digest (or its
   "Not scanned yet" empty state) — never "Scanning YouTube for B".
2. Only the topic being scanned shows the scanning skeleton; a "●" dot marks
   its sidebar row.
3. A completed scan writes its digest under the topic that was scanned, even if
   the user switched topics mid-scan (fixes the `state.digests[activeTopic]`
   stale-write at `ui/digest.js:989`).
4. A second concurrent `POST /api/scan` (second tab, extension panel) gets
   `409 { error: "scan_in_progress", topic }`; the UI shows a friendly toast
   naming the in-flight topic; no stuck disabled button in any client.
5. Brave with no TTS voices: tapping Read Aloud shows
   `Read aloud not supported on Brave: no voices available`. Chrome (voices
   present, including first-click before `voiceschanged` fires): reads aloud,
   no false "not supported" toast.
6. Every change works identically from `bun run ui` (port 3456) and from the
   extension side panel with the server running.

## 2. Non-goals (simplicity guardrail)
- No TTS button disabling, voice picker, or server-side TTS fallback.
- No scan queueing (reject-only; queueing is the documented follow-up if users complain).
- No per-topic parallel scans (global single-flight, protects Gemini quota).
- No new dependencies, no CORS changes, no storage-schema changes.

## 2a. Constraints (hard limits — any violation needs reporter sign-off)

- **Architecture:** extension stays a thin shell over `http://localhost:3456`
  (`AGENTS.md`). No background-script scan engine, no new origins, no widening
  the CORS allowlist (`server.ts:36-40`).
- **Scope:** three reported issues only. No scan queueing, no per-topic parallelism,
  no TTS fallback engine, no storage migration.
- **Compatibility:** no change to `/api/*` response shapes except the additive
  `409 { error: "scan_in_progress", topic }`; existing clients ignore unknown fields.
- **Secrets/state:** never commit `.env.local` or `.local-radar-store.json`; tests use
  isolated `RADAR_STORE_PATH` temp stores.
- **Tooling:** Bun-only (`bun run`, `bun test`); no npm/node/python additions.
- **Extension build:** never hand-edit `extension/` — all UI changes flow through
  `bun run build:ext`; the `extension/` diff must equal the `ui/` changes.

## 3. Work breakdown (in order — each step ships only after its gate)

### Step 0 — Shared utils infra (unblocks testability)

- **Create `ui/tts-scan-utils.js`** — pure, DOM-free ES module: `getBrowserName(ua)`,
  `shouldShowScanning(scanningTopic, activeTopic)`, `ttsSupportStatus(hasApi, voicesCount)`
  (`"ok" | "no-api" | "no-voices"`). Signature note: `getBrowserName(ua, hasBraveGlobal)`
  — Brave's desktop UA deliberately omits a "Brave" token (it looks like Chrome),
  so Brave detection needs the sync `Boolean(navigator.brave)` signal passed in;
  sync-only, still no async `isBrave()` call. Imported by `digest.js`; imported directly by `bun test`.
- **`server.ts`** — add one static route for `/tts-scan-utils.js` (copy of the
  `/digest.js` block). The server serves only three hardcoded paths today
  (`server.ts:68-85`); without this the bun tab 404s on the import.
- **`package.json`** — extend `build:ext` to copy `ui/tts-scan-utils.js` to
  `extension/` (else the extension panel gets a dangling `./tts-scan-utils.js`
  import under `chrome-extension://`).
- **Gate:** bun tab + extension panel load with zero 404s (Network tab);
  `bun test` imports the utils module.

### Step 1 — Per-topic scan state (`ui/digest.js` → `bun run build:ext`)

- `let isScanning` → `let scanningTopic = ""` (`ui/digest.js:50`).
- Scan handler (`:968-1011`): capture `const topic = activeTopic` at click; guard
  `if (!activeTopic || scanningTopic) return`; use captured `topic` in fetch body,
  completion toast, and `state.digests[topic]`; clear `scanningTopic` in `finally`.
- `renderMainDigest()` (`:559`): skeleton only when
  `shouldShowScanning(scanningTopic, activeTopic)`; other topics render cache/empty.
- `renderSidebar()`: "●" marker on the row matching `scanningTopic`. Note:
  the scan handler currently calls only `renderMainDigest()` at start, so it
  must also call `renderSidebar()` (or `renderAll()`) or the dot won't appear
  until the next unrelated re-render.
- Map `scan_in_progress` (Step 2) to friendly toast here. (Sequencing: this
  sub-item lands with Step 2, not Step 1's gate.)
- **Gate:** manual — scan A, switch to B (B shows cache), switch back (A shows
  skeleton), completion toast + digest land on A. Unit tests for
  `shouldShowScanning` green.

### Step 2 — Server single-flight (`server.ts`) + client 409 mapping

- Module-level `let activeScan: string | null`; in `POST /api/scan`, after
  topic/key validation, do a **synchronous check-and-set** (`if (activeScan)
  return 409; activeScan = topic;` — no `await` between check and set, which
  is what makes it atomic under Bun's single thread; note `req.json()` /
  `getApiKey()` awaits happen before this point, so "before the first await"
  in earlier drafts was wrong). Wrap the rest of the handler in `try/finally`
  that clears the lock **only if this request acquired it** — a 409'd or
  validation-rejected request must never clear another request's lock, and
  every early return (search 502, empty-summaries 502, success 200) must release it.
- Client: friendly `"${topic}" is already scanning — please wait` toast; `finally`
  still resets + `renderAll()` (no stuck button).
- **Gate:** tolerant contract test (see §4) + manual two-tab check. Reload
  mid-scan self-heals (fresh client, lock clears when scan settles, interim retry
  gets named 409).

### Step 3 — TTS hardening (`ui/digest.js` → `bun run build:ext`)

- **Pre-step diagnostic (5 min, ground truth before coding):** in real Brave,
  record `navigator.userAgent`, `Boolean(navigator.brave)`,
  `speechSynthesis.getVoices().length`, and whether an utterance fires
  `onstart`/`onerror`. The "no voices" root cause is currently an assumption —
  if Brave returns voices but never starts, the fix below won't cover it and
  the plan reopens before Step 3 code is written.
- Warm up voices at load (`getVoices()` + `voiceschanged` listener that keeps
  updating the cache until non-empty).
- `speakText`: keep API check (toast names browser on absence); if voice cache
  empty, wait ≤800ms once for `voiceschanged` before declaring unsupported
  (prevents Chrome first-click false negative — found in pressure test); add
  `utter.onerror` → error toast naming browser. `speakText` becomes `async`;
  callers are fire-and-forget, which is fine, but a second click during the
  wait must not queue a duplicate utterance (cancel-first semantics preserved).
- `getBrowserName(ua, hasBraveGlobal)`: Brave checked via `hasBraveGlobal`
  (`Boolean(navigator.brave)`, sync) — **not** via UA string, since Brave's UA
  has no Brave token. UA fallback covers Chrome/Edge/Firefox/Safari, unknown
  → `"this browser"`.
- **Gate:** Brave-no-voices → named toast, no crash; Chrome incl. cold first
  click → audio, no false toast; unit tests for `getBrowserName`/`ttsSupportStatus`.

## 4. Test plan (lightweight — no new harness)

| Test | Where | Notes |
|---|---|---|
| `shouldShowScanning`, `getBrowserName`, `ttsSupportStatus` unit tests | `bun test` (imports `ui/tts-scan-utils.js`) | Same/different/empty topic; Brave/Chrome/Edge UAs; ok/no-api/no-voices |
| 409 concurrency contract test | extend `tests/phase4-contract.test.ts` pattern (spawn server :3459, isolated `RADAR_STORE_PATH`) | Fire req1 (no await) + req2 after ~150ms; assert 409 **or** document skip when req1 settles too fast offline — the lock is a synchronous check-and-set, correctness doesn't rest on timing. **Caveat:** if the automated test skips, DoD §5 stays unchecked until a human observes a real 409 in the manual two-tab gate. |
| Regression | `bun test tests/phase4-contract.test.ts`, `tests/youtube-parser-guard.test.ts` | Must stay green |
| Extension smoke | `node tests/extension-smoke.mjs` (server running) | Required by `AGENTS.md`. Script only *logs* (exit code is always success) — gate is output inspection: `page errors: []` and expected alarms, not exit status. |
| Manual matrix × 2 runtimes | bun tab + extension side panel | §1 criteria 1–6; confirm `extension/` diff equals `ui/` changes + new file |

## 5. Definition of Done (all must hold — no partial merge)

- [x] §1 success criteria 1–4 verified: real-Chrome UI test (hung `/api/scan`
      via route interception) showed skeleton on A, cached empty state on B, no
      bleed, zero page errors; genuine 409 observed by the contract test
      (`topic: "Topic 1"` asserted, not skipped).
- [ ] §1 criterion 5 (Brave audio / named toast) and 6 (human pass over both
      shells) — need the reporter's manual matrix; Brave binary wasn't available
      in this environment so the Step 3 pre-step diagnostic is still open.
- [x] `bun test tests/phase4-contract.test.ts` (7 pass) + parser guard (4 pass)
      + new utils tests (4 pass) green; extension smoke passes (see note below).
- [x] `extension/` contains only `build:ext` output (`diff` identical); `git status`
      shows no store/`.env` changes.
- [x] No new dependencies; no CORS allowlist change; no storage-schema change.
- [x] Pressure-test holes closed: Chrome cold-click TTS (HOLE 1 — headless-Chrome
      page check confirmed `voices:0` at load, validating the wait design),
      utils route + `build:ext` coverage (HOLE 2), 409 test ran non-skipped (HOLE 3).
- [ ] Known limitation recorded for users: one global in-flight scan; extras are
      rejected, not queued. (Docs/release-note step — do at merge.)
- [x] Brave diagnostic recorded: **not yet performed** (no Brave binary here) —
      Step 3 implementation is robust to all three hypotheses (no voices →
      named toast; voices-but-silent → `onerror` toast; speaks → works), but the
      reporter should still record UA/voices/`onstart` behavior on merge.
- [ ] Out of scope unless releasing: regenerate `yt-topic-radar-extension.zip`
      (gitignored; `AGENTS.md` requires re-zip only for distribution).

### Verification notes (environmental, pre-existing — not caused by this change)

- `bun test` (bare, whole repo) used to pick up Playwright `.spec.ts` files
  (`demo_*`, `tests/responsive-layout.spec.ts`) and fail on runner
  incompatibility (`test.describe()` under bun). Resolved 2026-11-01:
  demo throwaways deleted, tracked specs moved to `tests/e2e/*.pw.ts`
  (invisible to bun). Remaining bare-`bun test` red is only gitignored
  throwaways, if any. Preferred: `bun test $(ls tests/*.test.ts)` plus
  explicit `bunx playwright test tests/e2e/<name>.pw.ts`.
- `node tests/extension-smoke.mjs` (as documented in `AGENTS.md`) crashes under
  node (`import.meta.dir` is a Bun-ism). Ran green as `bun tests/extension-smoke.mjs`:
  `page errors: []`, deep link OK, Pro alarm OK. Recommend a follow-up fix to the
  script or the doc line — left untouched per scope constraint.
- Bare `/favicon.ico` 404s in console (no server route) — pre-existing, out of scope.

## 6. Risks & mitigations (from pressure test / dry-run)

| Risk | Mitigation |
|---|---|
| Chrome `getVoices()` empty on first call → false "not supported" | Voice warm-up + ≤800ms `voiceschanged` wait before declaring unsupported (Step 3) |
| New utils module 404s (hardcoded static routes; extension copy script) | `server.ts` route + `build:ext` update as Step 0 line items |
| 409 test flakes without network/key (scan fails fast, no race window) | Tolerant assertion + documented skip rationale; lock atomicity argued from code, not timing |
| Digest written to wrong topic after mid-scan switch (current `:989`) | Captured-`topic` variable; explicit line item in Step 1, covered by manual gate |
| Server crash mid-scan leaves clients showing skeleton | Client `finally` clears on fetch failure; reload resets; lock is in-memory (dies with server) |
| Parallel-scan quota burn before this ships | Unchanged from today; 409 closes it — no migration needed |

## 7. Files touched

- `ui/tts-scan-utils.js` (new) · `ui/digest.js` · `server.ts` · `package.json`
  (`build:ext` script) · `extension/` (generated output only) ·
  `tests/phase4-contract.test.ts` (additive 409 test) · `tests/tts-scan-utils.test.ts` (new).

## 8. Review log

**Pre-implementation review (against code at `159bcb3`):** plan approved with
amendments, now folded into the sections above — (1) Brave has no UA token, so
browser detection needs the sync `navigator.brave` signal, not `/brave/i`;
(2) lock placement reworded to synchronous check-and-set after validation
(earlier "before the first await" was inaccurate — `req.json()`/`getApiKey()`
await first), owner-only `finally` release covering all early returns;
(3) sidebar dot needs an explicit `renderSidebar()` call at scan start;
(4) 409 sub-item re-sequenced from Step 1 to Step 2; (5) extension-smoke gate
is output inspection, not exit code; (6) Brave root-cause diagnostic added as a
Step 3 pre-step since "no voices" was an unverified assumption; (7) DoD may not
be checked off on a skipped 409 test alone. Residual accepted risks: deleting
the scanning topic mid-scan leaves an orphan digest on the server (pre-existing
shape, not worsened); CLI scans (`bun run scan`) bypass the server lock by
design (separate process, out of scope).

**Post-implementation independent review (uncommitted diff):** three findings,
all addressed — (1) **fixed:** `utter.onerror` fired on every restart click
because `cancel()` emits an `"interrupted"`/`"canceled"` error event on the
previous utterance; handler now ignores those two codes (a regression this
diff would have introduced inside criterion 5); (2) **fixed:** `navigator.brave`
is deprecated/removed in newer Brave builds, so detection now also checks UA-CH
`navigator.userAgentData.brands` for a "Brave" brand (sync, no async `isBrave()`);
(3) **fixed:** a hung network hop (search/transcript fetches have no
`AbortSignal`) could hold the lock forever and answer 409 to all future scans —
`activeScan` now carries `{ topic, since }` and locks older than
`SCAN_STALE_MS` (10 min) are superseded instead of wedging. Small deviation
from the original Step 2 spec (plan said lock dies only with the server),
accepted as in-scope hardening of the 409 guard since the 409 itself introduced
the wedge risk. All suites re-run green after fixes (contract 7, parser guard 4,
utils 5), 409 test still non-skipped.
