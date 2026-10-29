# External-Call Protection Audit — 2026-10-29

Scope: all outbound calls in `lib/youtube.ts`, `lib/summarizer.ts`, `server.ts`,
`ui/digest.js`, `extension/background.js`.
Legend: PROTECTED = timeout + retry + fallback; PARTIAL = some; NONE = none.

| Call | Status | Evidence |
|---|---|---|
| Gemini `generateWithFallback` | PROTECTED | 4-model chain, 35s timeout, 429/503 backoff ×1.5, sequential (`lib/summarizer.ts:116-152`) |
| `yt.search` | NONE | Bare await, no timeout/retry (`lib/youtube.ts:141`); only caller-side 502 |
| `yt.getInfo` / player POST / caption fetch | PARTIAL (fallback only) | Outer catch → empty blocks → Gemini native-URL path; hang = hang |
| RSS `fetch` | PARTIAL (HTTP-error→`[]` only) | No timeout; throw escapes, and `/api/rss` has no try/catch → raw 500 |
| `Bun.serve` | PARTIAL (`idleTimeout:120` only) | No per-route deadline; long scans hold one HTTP response for minutes |
| UI / extension `fetch` | PARTIAL (offline-guard only) | `isServerOffline` banner + toasts; no timeout/retry anywhere |
| Caching | NONE | `UniversalCache(false)`; no memoization of YouTube/Gemini/RSS responses |

## Top gaps by user impact

1. Hanging `/api/scan` locks the UI — no client abort + no server deadline + sequential N×35s Gemini calls.
2. `yt.search` hang = whole scan 502 — most frequent dependency, zero protection.
3. Caption/player failures silently inflate the Gemini bill (coarse fallback, no reason logged).
4. RSS hang/throw → 500; extension poll stalls, badge goes stale.
5. Optimistic `saveSync` phantom — failed save renders as saved until next reload.

## Agreed fix order (not yet implemented)

Search timeout + retry → RSS try/catch + timeout → scan deadline/abort →
`saveSync` revert-on-failure → fallback-reason logging.
