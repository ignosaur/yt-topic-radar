# Tester Instructions — Topic Digest for YouTube (Unlisted Beta)

Thank you for testing the unlisted beta of **Topic Digest for YouTube**. This is a short, unaided
run: follow the steps below in order and report what happened. You should not need any other
documentation. Expect about 10 minutes.

This is an unlisted beta, not a public launch. Please do not post the install link or screenshots
publicly.

---

## Before you start

- [ ] Use **Chrome or Brave on desktop**. Other browsers are not supported in this beta.
- [ ] Have a **Gemini API key** ready from Google AI Studio. The extension uses your own key; there
      is no developer key and no account.
- [ ] Set aside about **10 minutes**.
- [ ] Optionally install on a clean browser profile so other extensions do not interfere.

## 1. Install and open

1. Open the unlisted Chrome Web Store install link provided to you: `[OWNER: tester install link]`
2. Click **Add to Chrome** (or **Add to Brave**) and confirm the permissions prompt.
3. Pin the extension to the toolbar (puzzle-piece icon, then pin **Topic Digest for YouTube**).
4. Click the toolbar icon to open the **side panel**.

Expected: the dashboard opens in the side panel with starter topic packs and an empty topic list.

## 2. Save your Gemini API key

1. Click the **Settings** gear in the top-right of the panel.
2. Paste your key into **Gemini API Key (BYOK)**.
3. Click **Save**.
4. Confirm the key status shows as configured.

Privacy: the key is stored only in this browser profile (`chrome.storage.local`). It is not synced
through Chrome and is never included in an exported backup. Do not share your key with anyone,
including in a bug report.

## 3. Add a topic and scan

1. Type a topic into **+ Add any topic** and click **Add**. A topic with available captions is
   easiest for this test.
2. Select the topic in the list.
3. Leave the scan count at **Top 3 Videos**.
4. Click **Scan Topic Now** and keep the panel open while it runs. Closing the panel or tab cancels
   the scan.

Expected: the panel shows progress, then a digest with a cross-video synthesis and one card per
video. A scan can take a while because it depends on YouTube and Gemini.

## 4. Open a timestamp

1. In any video card, click a **`[MM:SS]`** timestamp.
2. Confirm the video player opens and starts at approximately that time.

## 5. Try Read Aloud (optional)

1. Click **Read Aloud** on a summary and confirm audio playback starts.
2. Stop playback when finished.

## 6. Export and Import a backup

1. Click **Export .json** and save the file somewhere you can find it.
2. Note the file name and that the export completed.
3. Click **Import .json**, select the file you just saved, and confirm the import succeeds and your
   topic and digest are still present.
4. Do not send the backup file to anyone. It contains your topics and digests (but not your API
   key).

## 7. Restart and confirm persistence

1. Fully quit and reopen the browser.
2. Open the side panel again.
3. Confirm your **Gemini API key is still configured** and your **topic and digest are still
   listed**.

## What is out of scope for v1

Please do not report these as product bugs for this beta:

- Pro features, RSS polling, or alerts (not included in v1).
- Firefox, Safari, or an official Edge listing.
- Bugs in YouTube's own interface or playback unrelated to the extension.
- Gemini quota, billing, or API-key problems on your Google account.

## How to report back

Send a short report with:

- Operating system and version:
- Chrome or Brave version:
- The step number that failed (or "all passed"):
- Exact error message or toast text, copied as shown:
- Console errors, if any (open DevTools with **F12**, then the **Console** tab, and copy the errors):
- Was the scan on a topic with captions? (yes / no / not sure)
- Anything else that looked wrong:

If a step fails, stop there and send the report rather than retrying many times, so we can see the
first failure.

---

## Quick privacy reminder

- Never share your **Gemini API key**.
- Never share your **exported backup file**.
- The key stays on your device, is not synced, and is not part of backups.
- Topics and preferences may sync through your own Chrome profile if Chrome sync is enabled.
- Digests and counters are stored locally in this browser.
