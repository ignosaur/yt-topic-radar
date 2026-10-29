# Chrome Web Store Data Disclosure — Topic Digest for YouTube

Plain Q/A answers for the Chrome Web Store data-disclosure form. Answers describe the
standalone production build (`scripts/manifest.prod.json` + `extension/`, Pro disabled).

---

## 1. What is the single purpose of the extension?

Topic Digest for YouTube lets a user follow topics rather than channels: it searches YouTube
for recent videos on a topic, filters out low-value/clickbait results, reads the videos'
transcripts, and produces timestamped summaries and a cross-video synthesis using a Gemini API
key the user supplies. All processing runs in the browser; there is no developer server.

## 2. Does the developer collect user data?

**No.** The developer does not receive, store, or have access to any user data. There is no
developer-operated backend, no analytics or telemetry endpoint, no crash-reporting service, and
no account system. The extension sends requests directly from the user's browser to YouTube and
to Google's Gemini API.

Do not select any "collected" data category on the form. The data below is handled locally in
the browser and/or sent to third parties at the user's direction; it does not reach the
developer.

## 3. What data does the extension handle locally?

| Data | Storage location | Notes |
|---|---|---|
| Topics, pinned channels, preferences (minimum duration, starred metadata, anonymous-usage-stats toggle) | `chrome.storage.sync` | May sync through the user's own Chrome profile. |
| Optional Pro status flag | `chrome.storage.sync` | Not used in the current standalone release (Pro disabled). |
| Gemini API key | `chrome.storage.local` | Device-local; never synced, never included in backups. |
| Digests, usage counters, seen-video IDs | IndexedDB | Used to display results, keep local counters, and avoid re-processing. |

The extension also has a user-initiated Export/Import feature that writes/reads a JSON file.
Exports contain topics, pins, preferences, digests, counters, and seen IDs. **Exports never
contain the Gemini API key.**

## 4. Is data transferred to third parties?

Only at the user's direction, directly from the user's browser:

- **YouTube (`https://www.youtube.com`)** — search requests, video/transcript data needed for a
  scan, and (in builds that include the optional RSS feature; not the standalone v1 release)
  public channel feeds.
- **Google Gemini API (`https://generativelanguage.googleapis.com`)** — the content the user
  chooses to summarize, authenticated with the user's own API key.

The developer is not a party to these requests and receives no copy. No other third parties are
contacted.

## 5. Is data sold, used for advertising, or used for credit/lending decisions?

**No.** No sale of data, no advertising, no ad targeting, no creditworthiness or lending
decisions. No data brokers.

## 6. Does the extension use remote code?

**No.** The extension ships its full JavaScript bundle in the package. It does not load or
execute remote scripts, does not use `eval` to fetch code, and does not download code at
runtime. Network requests are limited to data calls to YouTube and the Gemini API.

## 7. Does the extension require authentication or accounts?

**No developer account or sign-in.** The only credential is the user's own Gemini API key,
which the user pastes into Settings. It is stored in `chrome.storage.local`, is used only to
call `generativelanguage.googleapis.com`, and is never synced, backed up, or sent to the
developer. There is no OAuth, no Chrome identity permission, and no user profile.

## 8. What is the retention and deletion policy?

Data remains on the user's device until the user deletes it or uninstalls the extension.
Uninstalling removes local data (`chrome.storage.local` and IndexedDB). The Chrome sync copy of
topics, pins, and preferences, if the user has sync enabled, is governed by the user's Google
account and can be removed through Chrome sync settings or Google account data controls. Because
the developer holds no data, there is nothing for the developer to retain or delete.

## 9. Permissions used

`storage`, `sidePanel`, `tabs`, `declarativeNetRequestWithHostAccess` plus hosts
`https://www.youtube.com/*` and `https://generativelanguage.googleapis.com/*`. See
`store/permissions.md` for the per-permission justification text.

The `declarativeNetRequestWithHostAccess` permission exists for one static, narrowly scoped
rule: it sets `Origin`/`Referer`/`Sec-Fetch-*` to `https://www.youtube.com` for
`||youtube.com/youtubei/` XMLHttpRequests so YouTube's own web API accepts requests from the
extension origin. It is required for scans and does not apply to any other site or request type.

## 10. Contact

Privacy and support contact: `[OWNER: support email]`

Privacy policy URL: `[OWNER: privacy policy URL]`

---

## Form-filling quick reference

| Store form question | Answer |
|---|---|
| Collects user data? | No |
| Data categories collected | None |
| Sold to third parties? | No |
| Used for advertising? | No |
| Used for credit/lending? | No |
| Remote code? | No |
| Authentication / accounts? | No (user-supplied Gemini key only) |
| Third-party requests | YouTube and Google Gemini API, user-directed |
| Data retention | Local until user deletes or uninstalls |
