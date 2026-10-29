# Chrome Web Store Submission Checklist — Topic Digest for YouTube v1.0.0

Status: **not submitted; not approved.** This checklist prepares an **unlisted** release. The
public flip is a separate owner decision and is not covered here.

Every owner action below is a `- [ ]` checkbox so the preflight gate can count outstanding items.
Do not tick a box until the step is actually done.

---

## 0. Pre-submission gates (run locally first)

- [ ] Run `bun run package:chrome` to regenerate `dist/yt-topic-radar-v1.0.0.zip`.
- [ ] Run `bun run verify:package` and confirm it reports `PASS 34 checks`.
- [ ] Run `bun run preflight:m3` and confirm it reports `GO` with `blockers=0`. It is expected to
      report `NO-GO` until all owner placeholders and unchecked items are resolved.
- [ ] Confirm the upload artifact is exactly `dist/yt-topic-radar-v1.0.0.zip` (version `1.0.0`).

## 1. Developer account

- [ ] Sign in to the Chrome Web Store developer dashboard with `[OWNER: account holder]`.
- [ ] Complete developer registration and pay any one-time registration fee if this account is not
      already registered.
- [ ] Confirm the account can publish extensions and that any required identity/contact
      verification is complete.

## 2. Listing values (enter exactly)

| Field | Value |
|---|---|
| Upload artifact | `dist/yt-topic-radar-v1.0.0.zip` |
| Name | Topic Digest for YouTube |
| Version | 1.0.0 |
| Category | Productivity |
| Language | English |
| Visibility | Unlisted |
| Support contact | `[OWNER: support email]` |
| Homepage | `[OWNER: homepage URL, or leave blank]` |
| Privacy policy URL | `[OWNER: hosted privacy policy URL]` |
| Screenshots | `[OWNER: screenshots in store/screenshots/]` |

- [ ] Create a new item in the developer dashboard.
- [ ] Upload `dist/yt-topic-radar-v1.0.0.zip`.
- [ ] Enter the name **Topic Digest for YouTube**.
- [ ] Confirm the version shown is **1.0.0**.
- [ ] Set the category to **Productivity**.
- [ ] Set the language to **English**.
- [ ] Set visibility to **Unlisted**.
- [ ] Enter the support contact `[OWNER: support email]`.
- [ ] Enter the homepage `[OWNER: homepage URL, or leave blank]`.
- [ ] Enter the hosted privacy policy URL `[OWNER: hosted privacy policy URL]` (host
      `store/privacy-policy.html`; the page still contains owner placeholders for the effective
      date and support email).
- [ ] Add screenshots from `store/screenshots/` in the required sizes (`[OWNER: screenshots]`).

## 3. Paste-ready listing and disclosure text

Use these files as the source of truth; do not rewrite claims on the fly.

| Store field | Paste from |
|---|---|
| Short description (≤132 characters) | `store/listing.md` → "Short description" |
| Detailed description | `store/listing.md` → "Detailed description" |
| Category / language | `store/listing.md` → "Category" and "Language" |
| Permission justifications | `store/permissions.md` → one section per permission |
| Data-disclosure answers | `store/data-disclosure.md` → "Form-filling quick reference" |
| Privacy policy | `store/privacy-policy.html` at `[OWNER: hosted privacy policy URL]` |

- [ ] Paste the short description from `store/listing.md`.
- [ ] Paste the detailed description from `store/listing.md`.
- [ ] Paste each permission justification from `store/permissions.md` into its matching field.
- [ ] Complete the data-disclosure form using `store/data-disclosure.md`.
- [ ] Confirm the disclosure selects **no collected data categories** (the developer receives no
      data).
- [ ] Confirm the listing includes the unofficial/not-affiliated statement and the Gemini-key and
      accuracy limits from `store/listing.md`.

## 4. Distribution and testers

- [ ] Confirm the item remains **Unlisted** (not public).
- [ ] Add the tester distribution list: `[OWNER: tester email addresses]`.
- [ ] Share the install link `[OWNER: tester install link]` only with the testers.
- [ ] Send `store/tester-instructions.md` to each tester once the listing is installable.

## 5. Submit for review

- [ ] Re-check every claim against the "Claims we must not make" list in `store/listing.md`.
- [ ] Submit the item for review.
- [ ] Record the submission date and any review questions here (do not record an approval date
      until approval is actually received).

Submission does **not** mean approval. Do not tell testers the listing is approved until it is
installable.

## 6. Post-approval verification

- [ ] Confirm the listing is approved and installable from `[OWNER: tester install link]`.
- [ ] Install from the unlisted link on a clean Chrome profile and complete the tester script.
- [ ] Confirm Brave installs from the same listing and completes the same checklist.
- [ ] Run `bun run verify:package` against the shipped package.
- [ ] Run `bun run preflight:m3` and confirm `GO`.
- [ ] Record the listing ID and approval date in `STANDALONE-EXTENSION-PLAN.md` (M3 evidence), not
      in this checked-in checklist.
- [ ] Start the soak period and log defects with severity and resolution.

---

## Pre-verified artifacts

These are already proven for the current `1.0.0` artifact; they do not need to be redone before
submission, but re-run them if the build changes.

| Artifact | Proof | Status |
|---|---|---|
| Reproducible zip | `bun run package:chrome` twice produced the same sha256 | `9f5fd1f3e8a83dc628d2989531a4812f0d9cc2a16ea97b39438b6876d2809136` |
| Package audit | `bun run verify:package` | PASS, 34 checks |
| Extracted-zip smoke | `node tests/standalone-smoke.mjs` against the extracted zip | 6/6 |
| Zip contents | 12 entries, including `manifest.json`, `digest.js`, `rules.json`, slim `background.js` | Confirmed |
| Version consistency | `package.json`, `scripts/manifest.prod.json`, and zip `manifest.json` | `1.0.0` |
| Prod permissions | No localhost, no `alarms`, no `notifications` | Confirmed by verifier |
