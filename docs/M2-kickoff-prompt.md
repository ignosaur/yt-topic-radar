# M2 Kickoff — Multi-Agent Development Prompt (Store packaging)

Paste this as the first message to the orchestrator agent. It is self-contained.

---

## Mission

Implement **M2 — Store packaging** from `STANDALONE-EXTENSION-PLAN.md`. M1 is complete on all automated gates (standalone build works; prod bundle 2.12 MB; smoke 6/6; engine tests 7/7). M2 is packaging + disclosure only. **No new features.**

Read first: `STANDALONE-EXTENSION-PLAN.md` (M2 scope/constraints/DoD, Decisions 2/7/9), `AGENTS.md`, `scripts/manifest.prod.json`, `scripts/background.prod.js`, `scripts/dnr-rules.json`, `package.json`.

## Non-negotiables

- Do not change product behaviour, `ui/`, `lib/`, `lib/engine.ts`, or the scan pipeline.
- Zip must be built from the prod build only: no `localhost`, no `alarms`/`notifications`, no `.env*`, no `_metadata/`, no source maps, no dev worker/manifest.
- The DNR ruleset must ship (`rules.json`) — removing it breaks every scan.
- Version must match across `scripts/manifest.prod.json`, `scripts/manifest.dev.json`, and `package.json`; the zip filename carries the version.
- Owner-only items (hosting the privacy policy, support email, screenshots, store account) stay marked as blocked — do not invent URLs or contacts.

## Ownership matrix (do not edit outside your lane)

| Lane | Files (own) | Forbidden |
|---|---|---|
| A — Package tooling | `scripts/package-chrome.ts`, `package.json`, `scripts/manifest.prod.json`, `scripts/manifest.dev.json` | `ui/`, `lib/`, `tests/`, `store/` |
| B — Compliance content | `store/privacy-policy.html`, `store/listing.md`, `store/permissions.md`, `store/data-disclosure.md` | everything else |
| C — Artifact verifier | `scripts/verify-package.ts` | everything else |
| D — Orchestrator | `docs/M2-kickoff-prompt.md`, `STANDALONE-EXTENSION-PLAN.md`, `README.md`, final runs | A/B/C files |

## Lane A — package tooling

1. Bump version to **1.0.0** in `scripts/manifest.prod.json`, `scripts/manifest.dev.json`, and `package.json` (`version` already 1.0.0 in package.json — verify).
2. Add `scripts/package-chrome.ts` (Bun):
   - Preconditions: `extension/manifest.json` version === `package.json` version === `scripts/manifest.prod.json` version; fail loudly otherwise.
   - Clean `dist/`.
   - Deterministic zip: set every file mtime under `extension/` to a fixed epoch (`find extension -type f -exec touch -d @0 {} +` or `utimes`), then `cd extension && find . -type f ! -path './_metadata/*' | sort | zip -X -@ ../dist/yt-topic-radar-v<version>.zip`.
   - Refuse to package if any entry matches `.env`, `.map`, `_metadata`, `.DS_Store`, `node_modules`.
   - Print final path + sha256.
   - Run `bun scripts/verify-package.ts` as a post-step (Lane C owns that file; assume it exists at integration time).
3. `package.json` scripts:
   - `"package:chrome": "bun run build:ext && bun scripts/package-chrome.ts"`
   - `"verify:package": "bun scripts/verify-package.ts"`
   - keep all existing scripts.
4. Do not run the package script end-to-end before Lane C lands; JSON-validate your edits.

## Lane B — compliance content (draft, accurate to the manifest)

- `store/privacy-policy.html`: standalone, self-contained HTML page (inline CSS, no external assets). Sections: who we are (independent, unofficial), data the extension stores (topics/pins/preferences + optional Pro flag in `chrome.storage.sync`; Gemini key in `chrome.storage.local`; digests/metrics/seen IDs in IndexedDB), what leaves the device (requests to `youtube.com` for search/transcripts/RSS and to `generativelanguage.googleapis.com` with the user's own key), what is never collected (no developer server, no analytics, no accounts, key never synced or backed up), retention/uninstall, permissions rationale, contact placeholder `[OWNER: support email]`. State Chrome sync implication explicitly for topics/pins.
- `store/permissions.md`: one subsection per manifest permission — `storage`, `sidePanel`, `tabs`, `declarativeNetRequestWithHostAccess`, host `https://www.youtube.com/*`, host `https://generativelanguage.googleapis.com/*`. Explain the DNR rule precisely (sets Origin/Referer/Sec-Fetch-* for `youtube.com/youtubei/*` XHRs so YouTube accepts requests from the extension origin; scoped, static, no wildcard hosts) and why removing it breaks scans.
- `store/data-disclosure.md`: Chrome Web Store data-disclosure answers in plain Q/A form (single purpose, data collected by developer = none, data handled locally, third parties = YouTube/Google at user direction, no sale, no ads, no analytics, remote code = none, key handling).
- `store/listing.md`: short description (≤132 chars), detailed description (store-safe: no "guaranteed", no YouTube affiliation claim), category (Productivity), language, support contact placeholder, screenshot plan placeholder (owner to capture), and a "do not claim" checklist.
- Keep claims verifiable against the code. No invented metrics.

## Lane C — artifact verifier

`scripts/verify-package.ts` (Bun, no deps): given the newest `dist/yt-topic-radar-v*.zip` (or `process.argv[2]`), shell out to `unzip -l` / `unzip -p` and assert:
- filename version === `package.json` version;
- required entries exist: `manifest.json`, `background.js`, `digest.js`, `digest.html`, `digest.css`, `rules.json`, four icons;
- forbidden entries absent: `.env`, `.map`, `_metadata/`, `.DS_Store`, `node_modules`;
- manifest: permissions exactly `["storage","sidePanel","tabs","declarativeNetRequestWithHostAccess"]`; no permission string containing `alarm`/`notification`; host_permissions exactly the two prod hosts (no localhost);
- `background.js` contains none of: `fetch(`, `API_BASE`, `localhost`, `chrome.alarms`, `chrome.notifications`, `chrome.action.setBadgeText`;
- `digest.js` contains `localhost:3456` zero times;
- `rules.json` has exactly one rule, condition `urlFilter === "||youtube.com/youtubei/"`, includes an `Origin` set header;
- exit 0 with a `PASS` summary, exit 1 listing every failure.

## Lane D — orchestration

Promote the M2 DoD boxes only with evidence; leave owner-blocked boxes unchecked with a `blocked on: <item>` note. Update `README.md` packaging instructions to `bun run package:chrome`.

## Verification commands

```bash
bun run package:chrome
bun run verify:package
unzip -l dist/yt-topic-radar-v1.0.0.zip
sha256sum dist/yt-topic-radar-v1.0.0.zip
```

Second run of `package:chrome` must produce the same sha256. If the filesystem cannot guarantee it, report the measured difference rather than claiming reproducibility.

## Report format

Lanes completed, files touched, commands + output, sha256 + second-run comparison, M2 DoD checkbox status (verified / blocked-on-X), and anything unverifiable.
