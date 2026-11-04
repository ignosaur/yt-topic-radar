# Permission Justifications — Topic Digest for YouTube

Paste-ready text for the Chrome Web Store "Permission justification" fields. Each section
matches one entry in `scripts/manifest.prod.json`. Do not add permissions beyond these.

Manifest source of truth:

```json
"permissions": ["storage", "sidePanel", "tabs", "declarativeNetRequestWithHostAccess"],
"host_permissions": [
  "https://www.youtube.com/*",
  "https://generativelanguage.googleapis.com/*"
]
```

---

## `storage`

> The extension saves the user's own configuration and results in the browser: topics, pinned
> channels, preferences, the optional Pro status flag (not used in the current standalone
> release), the user's Gemini API key, generated digests, local usage counters, and seen-video
> IDs. Topics and preferences use `chrome.storage.sync`; the Gemini API key uses
> `chrome.storage.local` only; digests, counters, and seen IDs use IndexedDB. Nothing is sent to
> a developer server. Without this permission the extension could not remember a user's topics
> or keep their API key between sessions.

## `sidePanel`

> The extension's entire interface is a dashboard shown in Chrome's side panel. This permission
> lets the toolbar action open that panel, where the user adds topics, starts scans, and reads
> digests. No other browser surface is needed.

## `tabs`

> When a user clicks a `[MM:SS]` timestamp in a digest, the extension looks for an already-open
> YouTube watch tab and navigates it to the requested time. The `tabs` permission is used only
> for that lookup and update; the extension does not read page contents, inject scripts, or
> track browsing. Without it, timestamp clicks could not continue in the user's existing tab.

## `declarativeNetRequestWithHostAccess`

> YouTube's web API rejects requests whose origin is a browser extension. To make scans work,
> the extension ships exactly one static rule that sets the `Origin`, `Referer`, and
> `Sec-Fetch-*` request headers to `https://www.youtube.com` for requests to
> `||youtube.com/youtubei/` with resource type `xmlhttprequest`. The rule is narrowly scoped to
> YouTube's Innertube endpoint, uses no wildcard hosts, and does not modify headers for any other
> site or request type. It is a static ruleset: no dynamic rules, no request blocking, no
> redirects, and no feedback permission. Without this rule every scan fails with a 403 from
> YouTube. The rule is required by the product and must ship in the package (`rules.json`).

## Host permission — `https://www.youtube.com/*`

> Required to search YouTube for the topics the user enters and to read the public video and
> transcript data used to produce a digest. Requests are made directly from the user's browser
> for actions the user starts. The extension does not run on or modify YouTube pages, and it
> does not track browsing outside these requests.

## Host permission — `https://generativelanguage.googleapis.com/*`

> Required to call Google's Gemini API with the API key the user supplies, so the extension can
> turn the selected video transcripts into summaries and a cross-video synthesis. The developer
> does not operate a proxy or receive the requests. Without this host permission the extension
> cannot generate any summaries, which is its core function.

---

## Reviewer notes (not for the form)

- The production manifest contains no `alarms`, no `notifications`, no localhost host, and no
  `declarativeNetRequestFeedback`.
- The DNR rule is static and lives in `rules.json`; removing it makes every scan return 403
  from YouTube.
- Do not describe the DNR rule as "spoofing" or "bypassing" in the store form. State what it
  does: it presents the request as same-origin so YouTube's own web API accepts extension
  requests, narrowly scoped to `/youtubei/` XHRs.

## Host permission — `https://eu.i.posthog.com/*`

> Sends only optional, explicitly enabled usage events to PostHog EU. Includes counts, buckets, outcome enums, browser family, version, and a random installation ID; never topics, video details, digests, or Gemini keys. No session replay or autocapture SDK is used.
