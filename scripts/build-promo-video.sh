#!/usr/bin/env bash
# Promo video assembly: caption the 3 raw Playwright WebMs, add open/close
# cards, stitch into one H.264 MP4 for the (unlisted) YouTube upload behind
# the Chrome Web Store listing. AMO takes no video — screenshots only.
#
# Usage: bash scripts/build-promo-video.sh
# Input : test-results/store-video.pw.ts-clip-*/video.webm (from store-video.pw.ts)
# Output: dist/promo-final.mp4 (1280x720, H.264 + silent AAC for max compat)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IN="$ROOT/test-results"
OUT="$ROOT/dist/promo-final.mp4"
FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

C1="$IN/store-video.pw.ts-clip-1-—-one-digest-noise-filtered/video.webm"
C2="$IN/store-video.pw.ts-clip-2-—-click-a-timestamp-player-jumps/video.webm"
C3="$IN/store-video.pw.ts-clip-3-—-the-key-never-leaves-this-device/video.webm"
for f in "$C1" "$C2" "$C3"; do
  [ -f "$f" ] || { echo "missing $f — run the store-video spec first"; exit 1; }
done

# caption(text, color, start, end) -> one drawtext filter with bottom pill box.
cap() {
  printf "drawtext=fontfile=%s:text='%s':fontcolor=%s:fontsize=30:x=(w-text_w)/2:y=h-110:box=1:boxcolor=0x0F172ACC:boxborderw=18:enable='between(t,%s,%s)'" \
    "$FONT" "$1" "$2" "$3" "$4"
}
AMBER=0xFBBF24
WHITE=0xFFFFFF

VCOMMON="scale=1280:720:flags=lanczos,setsar=1,format=yuv420p"

# --- clip 1: 12s ---
ffmpeg -y -v error -i "$C1" -vf \
  "$VCOMMON,$(cap 'Too many videos. Too little time.' $AMBER 0 2.5),$(cap 'Clickbait filtered out.' $AMBER 2.5 5.5),$(cap 'One topic. One digest.' $WHITE 5.5 8.5),$(cap 'Skips counted in the open.' $WHITE 8.5 12)" \
  -t 12 -c:v libx264 -preset medium -crf 20 -an "$TMP/c1.mp4"

# --- clip 2: 9.6s native ---
ffmpeg -y -v error -i "$C2" -vf \
  "$VCOMMON,$(cap 'Skip to the good part.' $AMBER 0 2.5),$(cap 'Every timestamp jumps.' $WHITE 2.5 4.5),$(cap 'Click. Watch that moment.' $WHITE 4.5 7),$(cap 'Verdict on every video.' $WHITE 7 9.6)" \
  -t 9.6 -c:v libx264 -preset medium -crf 20 -an "$TMP/c2.mp4"

# --- clip 3: 10s ---
ffmpeg -y -v error -i "$C3" -vf \
  "$VCOMMON,$(cap 'Your data stays yours.' $AMBER 0 2.5),$(cap 'No account. No server.' $WHITE 2.5 6),$(cap 'One key. Pasted once.' $WHITE 6 10)" \
  -t 10 -c:v libx264 -preset medium -crf 20 -an "$TMP/c3.mp4"

# --- cards (dark slate, centered) ---
card() { # card(duration, main, sub, out)
  if [ -n "$3" ]; then
    SUB=",drawtext=fontfile=$FONT:text='$3':fontcolor=0x94A3B8:fontsize=26:x=(w-text_w)/2:y=(h-text_h)/2+60"
  else SUB=""; fi
  ffmpeg -y -v error -f lavfi -i "color=c=0x0F172A:s=1280x720:d=$1:r=30" -vf \
    "drawtext=fontfile=$FONT:text='$2':fontcolor=white:fontsize=56:x=(w-text_w)/2:y=(h-text_h)/2-30$SUB,format=yuv420p" \
    -c:v libx264 -preset medium -crf 20 -an "$4"
}
card 2 'Follow topics, not channels.' '' "$TMP/open.mp4"
card 3 'Stop scrolling. Start knowing.' 'Free to install. Needs your Gemini key.' "$TMP/close.mp4"

# --- stitch + silent audio track (widest YouTube compat) ---
printf "file '%s'\nfile '%s'\nfile '%s'\nfile '%s'\nfile '%s'\n" \
  "$TMP/open.mp4" "$TMP/c1.mp4" "$TMP/c2.mp4" "$TMP/c3.mp4" "$TMP/close.mp4" > "$TMP/list.txt"
ffmpeg -y -v error -f concat -safe 0 -i "$TMP/list.txt" \
  -f lavfi -i "anullsrc=r=44100:cl=stereo:d=37" -shortest \
  -c:v libx264 -preset medium -crf 20 -c:a aac -b:a 96k "$OUT"
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
