# Handoff — Phase 3 (Browser Extension Side Panel & Engine Wiring)

Paste this file as the first message to another code agent (Codex/Claude/any harness).
It is self-contained: state, evidence, open work, decisions, and commands.

---

## 0. Snapshot

| Item | Value |
|---|---|
| Repo | `/home/home/projects/yt-topic-radar` |
| Branch / HEAD | current working tree, HEAD = `646ded4 Updated plan` |
| Phase 3 code | **implemented, uncommitted** (working tree) |
| Phase 3 in `PLAN.md` §7 | marked ✅ Done with checked DoD |
| Runtime | Bun (`bun run ui` = server on `:3456`), Chromium MV3 extension |
| Architecture | **Extension is a thin shell over the local Bun server.** No engine bundling. The extension does not work unless `bun run ui` is running. |

Uncommitted / untracked files that are part of this work:

```
M  PLAN.md
M  server.ts
M  package.json
M  extension/background.js
M  extension/manifest.json
M  extension/digest.html
M  ui/digest.html
?? ui/digest.js        (802 lines, extracted from inline <script>)
?? ui/digest.css       (411 lines, replaces Tailwind CDN)
?? extension/digest.js (copy, do not hand-edit)
?? extension/digest.css(copy, do not hand-edit)
?? yt-topic-radar-extension.zip (rebuilt)
```

`extension/digest.{html,js,css}` are **generated**. Never edit them directly; run `bun run build:ext` (which copies all three from `ui/`).

Also in the tree (unrelated, pre-existing): `demo_*.spec.ts`, `demo-videos*/`, `test-results/`, four `.mp4` demo files. Not part of the product build.

---

## 1. What Phase 3 was supposed to do (from `PLAN.md` §7)

Deliver the Phase 2 dashboard as an installable MV3 extension (Chrome side panel + full-tab) that drives the `lib/` engine via the local Bun server, under MV3's security model.

Implemented changes, by file:

| File | Change |
|---|---|
| `ui/digest.html` | Removed Tailwind CDN + inline `<style>`/`<script>`; now `<link href="./digest.css">` + `<script type="module" src="./digest.js">`. Added `#topicsSidebar`, `#sidebarBackdrop`, `#btnToggleSidebar`, `referrerpolicy` on the player iframe. |
| `ui/digest.js` | Extracted dashboard logic; `API_BASE` fetch rewrite; drawer toggle + auto-close below 640px; `${API_BASE}` backup export; `#sidePanelYtWatchLink` deep link; optional seek of an open YouTube tab via `chrome.tabs.query/update`. |
| `ui/digest.css` | Hand-written local utility stylesheet (no Tailwind build step). Breakpoints at 640px (sidebar drawer) and 900px (full-pane player). |
| `server.ts` | `OPTIONS` → 204 + `Access-Control-Allow-*` on every response; static routes `/digest.js`, `/digest.css`; `json()` helper. |
| `extension/manifest.json` | `host_permissions += "http://localhost:3456/*"`; `permissions += "tabs"`. |
| `extension/background.js` | `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` on load/install/startup; tab fallback only if the API is missing. |
| `package.json` | `build:ext` copies `digest.html`, `digest.js`, `digest.css`. |

---

## 2. Verification already run (all passing)

Run these before trusting the handoff. They were executed against a live server and a real Chromium MV3 build.

### 2a. Static + API contract (`bun`, port 3459)

```bash
cd /home/home/projects/yt-topic-radar
PORT=3459 bun run server.ts &
# expect: OPTIONS /api/sync -> 204 + ACAO *, GET /api/state 200 + CORS,
# GET /digest.js 200 text/javascript, GET /digest.css 200 text/css,
# GET /api/backup/export 200 with version:1 JSON
```

Assertions that passed: `sidePanel` + `tabs` permissions, localhost host permission, `setPanelBehavior` present, **zero remote scripts, zero inline `<script>`, zero inline `<style>`** in `extension/digest.html`.

### 2b. Responsive layout (Playwright, real browser) — 15/15 passed

Viewport `1280x800` and `360x800` against `http://localhost:3459`:

- 1280: sidebar static at `x=0,w=320`; mobile toggle hidden; 6 topics; **no console errors**.
- 360: sidebar off-canvas; `☰ Topics` opens drawer (`w≈306`); drawer auto-closes after picking a topic; digest cards render.
- 360: clicking `[MM:SS]` opens `#videoSidePanel` as full-width overlay (`w=360`); deep link `https://www.youtube.com/watch?v=…&t=0s` present; close button hides it.
- 1280: same click opens a `w=480` right column.
- No page/console errors in any scenario.

### 2c. Real MV3 extension (Playwright persistent context + `--load-extension`)

- Service worker loads: `chrome-extension://<id>/background.js`.
- `chrome.sidePanel.getPanelBehavior()` → `{"openPanelOnActionClick":true}`.
- `chrome-extension://<id>/digest.html` **executes under MV3 CSP**: CSS applied, 6 topics loaded from `http://localhost:3456/api/state`, API key detected, **0 console/page errors**, `remote scripts: []`, 1 stylesheet.
- Clicking `#btnExportBackup` inside the extension triggers a real download (`yt-topic-radar-backup-2026-10-27.json`), panel stays on `digest.html`, toast shown.

### 2d. Style coverage

Every class token in `ui/digest.html` + `ui/digest.js` exists in `ui/digest.css` (173 tokens). Three apparent misses are false positives: `dark` (marker only), `via-slate-900` / `to-slate-900` (baked into the hand-written `.bg-gradient-to-br` rule).

---

## 3. Open work — the review loop was interrupted

The instruction was **review → validate → fix → verify → re-review**. Steps 2a–2d cover verification; the independent review pass was cut short. Continue here.

### 3.1 Confirmed defect — CORS `*` exposes the local server to any website (security)

`server.ts` returns `Access-Control-Allow-Origin: *` on `/api/state`, `/api/sync`, `/api/key`, `/api/scan`, `/api/backup/*`. Any web page the user visits can read their topics/digests/metrics and can POST `/api/scan` to burn their Gemini quota.

- **Why it is unnecessary:** `host_permissions` already contains `http://localhost:3456/*`, and MV3 lets extension pages bypass CORS for permitted hosts.
- **Fix:** drop the CORS headers and the `OPTIONS` handler, or restrict ACAO to `chrome-extension://<id>`.
- **Required evidence:** the extension check in §2c must still pass **without** `Access-Control-Allow-Origin`; if it does, remove the headers. Re-run §2c before accepting.

### 3.2 Unverified DoD — toolbar icon actually opens the side panel

`getPanelBehavior()` reports the right config, but a headless run cannot click a real toolbar button. Verify manually: `bun run ui`, `chrome://extensions` → Load unpacked → `extension/` → click the icon on a YouTube tab, confirm the panel opens docked and does not also open a tab.

### 3.3 Behaviour to confirm — `seekOpenYouTubeTab` reloads the tab

`ui/digest.js` uses `chrome.tabs.update(tabId, { url: "...&t=30s" })`. That **navigates** the user's tab, not seeks in place. Acceptable for MVP, but if "seek" is the requirement, use a content script or `postMessage` to the player. Decide, then update `PLAN.md` §7 DoD wording if reload is accepted.

### 3.4 Player fallback in the extension

`youtube.com/embed/...` inside `chrome-extension://` can be blocked by owners (no usable Referer). `#sidePanelYtWatchLink` is the fallback and is wired. Confirm on a real embed-restricted video.

### 3.5 Housekeeping

- Commit Phase 3 (currently uncommitted).
- `yt-topic-radar-extension.zip` is a build artifact; either commit intentionally or `.gitignore` it along with `demo-videos*/`, `test-results/`, `*.mp4`.
- Add a regression check: the Playwright viewport spec in §2b deserves to live in the repo (currently only a throwaway script) so `bun test`/CI can guard the 360px layout.

---

## 4. Decisions already made (do not re-litigate)

1. **Thin shell over local server.** No `lib/*` bundling into the extension in Phase 3, no WXT/React port. The extension requires `bun run ui`.
2. **No Tailwind build step.** `ui/digest.css` is hand-maintained. If you add a class in HTML/JS, add its rule to the CSS — there is no JIT compiler.
3. **No `chrome.storage` usage in the UI.** All state is `server.ts` → `.local-radar-store.json`.
4. **Phase 4 not started.** Do not flip `MONETIZATION_CONFIG` to `freemium` or add `isPro` as part of this work.

---

## 5. Commands

```bash
# dev
bun install
bun run ui                              # http://localhost:3456
bun run scan --help                     # CLI path must keep working

# build extension artifacts (always after editing ui/*)
bun run build:ext
(cd extension && zip -r ../yt-topic-radar-extension.zip .)

# typecheck
bunx tsc --noEmit

# load in Chrome
# chrome://extensions -> Developer mode -> Load unpacked -> extension/
```

Acceptance gate for any further change: `bunx tsc --noEmit` clean, §2a assertions pass, §2b 15/15, §2c extension check clean (0 console errors), and the `/api/state`, `/api/scan`, export/import flows unchanged.

---

## 6. Do not

- Do not edit `extension/digest.*` by hand — regenerate.
- Do not reintroduce a CDN script, inline `<script>`, or inline `<style>` into `ui/digest.html` (MV3 CSP blocks all three; this was the Phase 3 blocker).
- Do not add `"unsafe-inline"` or a custom `content_security_policy` to the manifest.
- Do not start Phase 4 (monetization/alarms/notifications) before §3.1 is resolved and Phase 3 is committed.
