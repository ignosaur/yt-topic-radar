# Anonymous usage wiring verification — 2026-11-04

## Result

All 11 event types from `docs/anonymous-usage-capture-plan.md` are wired in the digest UI and received by PostHog EU project 334499, Topic Digest. Consent follows the latest recorded decision: **opt-in, OFF by default**. The sender is inactive in dev/server mode. No PostHog SDK or new dependency was added.

The shared payload builder allows only the common envelope and each event's declared properties. Scan deltas are calculated before authoritative state reload; error codes are classified before early returns or human-readable exceptions. Timestamp/TTS send only after successful local metric requests. Import validation failures are classified without transmitting messages; transport/file-read failures use `unknown`.

## Verification

- Full suite: `bun test` — **137 passed, 0 failed**, 642 assertions. The initial sandboxed run could not start the contract server; the full run passed with loopback access.
- Focused final run: `bun test tests/telemetry-wiring.test.ts tests/telemetry-utils.test.ts tests/topic-lifecycle.test.ts` — **48 passed, 0 failed**, 172 assertions.
- Browser integration: `bun tests/telemetry-browser.ts` after `bun run build:ext`. Runs an isolated Chromium profile with synthetic topics, a synthetic Gemini key, and a synthetic backup. Uses the rebuilt MV3 bundle, real local storage/state/key/backup routes, and live PostHog transport. Scan responses alone are stubbed at the UI API boundary, so no real Gemini/YouTube scan or provider spend is involved. Timestamp and synthesis read-aloud controls are exercised on an imported synthetic digest. No browser page errors occurred.
- UI run verified all 11 event types, exactly one dashboard open despite later state reloads, default OFF, enabling sharing, disclosure visibility, disabling sharing, and no further events after reload with sharing OFF.
- Source-slice tests execute actual UI handlers for success, quota/rate limiting, invalid/disabled API keys, provider outage, timeout, concurrent-scan abort, changed-topic abort, unknown and network failures; confirm one start plus one terminal event and cleanup. Sender tests cover concurrent ID creation, storage persistence within a page, consent/dev/missing-token gates, and network failures without interrupting callers.
- Live stored-event inspection: **23 synthetic records across all 11 event types**. Every expected property exists; the property-key sets exactly match the schema. No `$ip`, GeoIP, raw errors, topic/video/key/backup content, or other unexpected properties. Every event is `propertyless` (no person profile). This verifies stored-event properties, not that network transport never sees a source IP.
- Build configuration was checked to target the connected project's public token without printing any Gemini key.
- Chrome packaging: `bun run package:chrome`, **37 verifier checks passed**. Firefox packaging: `bun run build:ext:firefox && bun scripts/package-chrome.ts firefox`, **40 verifier checks passed**. Dev build completed; production was rebuilt afterward.
- Ripwire quality delta: **0 gating regressions** in the shared working tree. It reports minor/new-symbol findings, including generated bundle complexity and intentional best-effort telemetry error suppression; it is not a zero-debt claim. `captureUsage` contract check: unchanged, 0 incompatible callers. `git diff --check` passed.

## Evidence

- [Browser requests and checks](evidence/2026-11-04-telemetry/browser-events.json)
- [Stored PostHog records](evidence/2026-11-04-telemetry/posthog-received.json)
- [Exact property-key validation](evidence/2026-11-04-telemetry/validation.json)
- [Extension screenshot](evidence/2026-11-04-telemetry/extension-settings.png)

Synthetic installation ID: `d041af1b-9fe8-4bf8-86d1-c756aa301904`. Exclude it from real usage reporting. A separate `radar_telemetry_spike` event with distinct ID `radar-verification-2026-11-04` verified the initial extension-origin request envelope before hooks were implemented. Test data remains in PostHog under the configured 3-month retention window; it was not deleted.

## Delivery and limits

- Reload the unpacked extension (or install the rebuilt ZIP), open Settings, and enable **Share anonymous usage stats** to send your own usage events. Older builds do not gain these hooks automatically.
- This work wires and verifies capture. It does not replace PostHog's generic starter dashboard with product-specific charts.
- Events are immediate, best effort, with no persisted queue. Closing the page or network failure can lose events. Installation identity is shared within one page; simultaneous first-ever opens of different extension pages can still race. Reinstall/storage clear creates a new identity.
- Firefox was packaged and verified statically; no Firefox runtime test was performed.
- No changes were published to extension stores or hosted privacy-policy pages. Repository store copy now reflects opt-in PostHog collection, pseudonymous installation identity, and the actual **3-month** retention setting (monthly cleanup). Updating the hosted policy/store form and confirming host-permission behavior on upgrades remain release tasks.
- Feedback-link and transcript-download changes were present or arrived concurrently in the shared checkout. They were preserved, not claimed as telemetry work; generated bundles include the current source tree. No commit, push, or store submission was performed by this task.
