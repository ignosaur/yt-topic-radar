# Store Listing — Topic Digest for YouTube

Copy for the Chrome Web Store listing. Every statement below is verifiable against the
standalone production build; anything requiring the owner is marked with an `OWNER` placeholder.

---

## Name

Topic Digest for YouTube

## Short description (≤132 characters)

Follow topics, not channels: filtered video digests with clickable timestamps, summarized with your own Gemini API key.

_Length: 119 characters._

## Summary for Firefox AMO (≤250 characters)

Follow topics, not channels. Topic Digest scans YouTube, filters Shorts and clickbait, and builds summaries with clickable timestamps and a cross-video synthesis — using your Gemini API key. No account, no server; your data stays in your browser.

_Length: 246 characters._

## Detailed description

Follow topics, not channels.

Topic Digest for YouTube scans YouTube for recent videos on any topic you choose, filters out
Shorts and likely clickbait, reads the available timed transcripts, and turns them into a
structured digest: a verdict and chapter breakdown for each video, plus a cross-video
synthesis that ties them together. Every chapter carries a clickable timestamp that jumps the
player to that exact moment.

What you get:

- Topic scans on demand. Pick Top 2, 3, or 5 videos per scan, right from the side panel.
- Noise removed first. Shorts and likely clickbait are screened out before they cost you
  attention — the digest says how many were skipped and replaced.
- Per-video verdicts. Yes or Skim timestamps, a signal score, a core takeaway, and why it is
  (or isn't) worth your time.
- Chapters you can jump to. Every section has `[MM:SS]` timestamps that open the moment in
your existing YouTube tab, plus key points and field notes.
- The bigger picture. A cross-video synthesis of what the videos agree and disagree on, with
  AI-suggested sub-topics to track next.
- Your setup, your way. Star topics, pin channels, and listen back with Read Aloud.

Your data stays yours:

- No account and no developer server. The extension works without a separate app or local
  service.
- Bring your own Gemini API key. It lives only on your device in `chrome.storage.local` and is
  never synced, backed up, or sent anywhere except Google's Gemini API when you scan.
- Topics, pins, and preferences live in `chrome.storage.sync` (and may sync through your own
  Chrome profile). Digests and counters live in IndexedDB, and exports never include your key.
- Optional usage stats are off by default. Enable them in Settings to share counts and scan
  outcomes with PostHog (EU) — never your topics, keys, or video details.

Requirements and limits:

- You need a Gemini API key. Usage of the Gemini API is subject to Google's terms and any
  quotas or charges that apply to your key.
- Summaries are generated automatically and may contain mistakes. Review the source video when
  accuracy matters.
- YouTube access can change; if YouTube changes its web API, some features may stop working
  until the extension is updated.

This is an independent, unofficial project. It is not affiliated with, endorsed by, or
sponsored by YouTube or Google LLC. YouTube is a trademark of Google LLC.

## Category

Productivity

## Language

English

## Support contact

`joy.calcutta@gmail.com`

## Privacy policy URL

`https://ignosaur.github.io/yt-topic-radar/privacy-policy.html`

## Website / homepage

_(none for v1 — leave blank in dashboard)_

## Screenshots

`store/screenshots/` (5 × 1280×800 PNG, neutral demo content, already captured)

Suggested set (owner to capture, not yet created):

1. Side panel with a topic digest and several summarized videos.
2. A single summary showing chapters and clickable `[MM:SS]` timestamps.
3. Cross-video synthesis section.
4. Settings drawer showing the Gemini key field and the storage note.
5. Topic list with starred/pinned topics.

Requirements: 1280×800 or 640×400 PNG/JPEG, no misleading UI, no invented metrics or badges,
and no YouTube/Google branding that implies affiliation.

## Promotional images

`_(optional — skipped for v1)_`

---

## Claims we must not make

Check the listing and any screenshots against this list before submission.

- [ ] No guaranteed summaries or guaranteed results. Say "generates summaries", not "always
      produces accurate summaries".
- [ ] No affiliation, endorsement, partnership, or sponsorship by YouTube or Google. Always
      include the unofficial/not-affiliated disclaimer.
- [ ] No accuracy guarantees. Say summaries "may contain mistakes" and tell users to check the
      source.
- [ ] No performance numbers, speed claims, time-saved figures, video counts, or benchmark
      metrics. Do not reuse internal measurements (for example scan timings or bundle size).
- [ ] No claims about model names or model quality that could change. Do not promise a specific
      Gemini model.
- [ ] No claims of being "free" without qualification: the extension is free to install, but
      the user's Gemini API usage may be subject to Google's quotas or charges.
- [ ] No Pro/RSS/notification features in the listing. The standalone v1 release ships with Pro
      disabled, no topic cap, and no RSS polling, alarms, or notifications.
- [ ] No invented support channels, response times, user counts, ratings, or testimonials.
- [ ] No claim that data is "encrypted end-to-end" or that the developer cannot see data
      because of encryption. Say instead that the developer does not receive the data.
- [ ] No mention of payments, subscriptions, or a paid tier in the standalone v1 listing.

### Optional usage statistics

Optional usage statistics are off by default. Enable them in Settings to send feature-use counts, scan outcomes, bucketed counts and durations, browser family, extension version, and a random installation identifier to PostHog in the EU. We never send your Gemini key, topics, searches, pins, video details, transcripts, digests, backup contents, or raw errors. Events are retained for 3 months, with older events removed at monthly cleanup. Turn sharing off anytime in Settings.
