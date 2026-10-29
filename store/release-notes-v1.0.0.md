# Release Notes — Topic Digest for YouTube v1.0.0 (Unlisted Beta)

This is the first unlisted beta of Topic Digest for YouTube, a standalone browser extension that
follows topics instead of channels.

## What it does

- **Runs on its own.** No server, no Bun, no separate app, and nothing else to install. The
  extension works entirely in your browser.
- **Bring your own Gemini key.** Paste a Gemini API key from Google AI Studio in Settings and the
  extension uses it to generate summaries. There is no developer key and no account.
- **Topic-first discovery.** Add a topic, and the extension searches YouTube for recent videos on
  that topic rather than making you subscribe to individual channels.
- **Anti-slop filtering.** Shorts and likely clickbait results are filtered out before summaries
  are generated.
- **Timestamped deep digests.** Each video gets a structured summary plus a cross-video synthesis,
  with clickable `[MM:SS]` timestamps so you can jump to the relevant part.
- **Read aloud.** Summaries can be read aloud using your browser's built-in speech synthesis.
- **Stays local.** Topics, pins, and preferences live in your browser and may sync through your own
  Chrome profile. Digests, counters, and seen-video IDs stay in local browser storage. You can
  export and import a JSON backup of your topics and digests.
- **Unlimited topics in v1.** This beta has no topic limit and no paywall.

## Not included in v1

- Pro features.
- RSS polling and alerts/notifications.
- Firefox, Safari, or an official Edge listing.

Brave is supported through the Chrome Web Store listing.

## Known limits

- **YouTube and Gemini availability.** Scans depend on YouTube's web API and Google's Gemini API.
  If either changes or is unavailable, a scan can fail or take longer. Updates may be needed to
  restore functionality.
- **Latency and quotas.** Summaries are generated through the Gemini API using your own key.
  Response times vary, model fallback can add delay, and your key's quotas or charges apply.
- **Your key is per-device.** The Gemini key is stored only on the device where you entered it. It
  is not synced through Chrome and is not included in backups, so you will need to re-enter it on
  another device.
- **Summaries can be wrong.** Summaries are generated automatically and may contain mistakes.
  Check the source video when accuracy matters.
- **Independent project.** Topic Digest for YouTube is unofficial and is not affiliated with,
  endorsed by, or sponsored by YouTube or Google LLC. YouTube is a trademark of Google LLC.

## Testing this beta

Follow the steps in `store/tester-instructions.md`. Please do not share your Gemini API key or your
exported backup file.
