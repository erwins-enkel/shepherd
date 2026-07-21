#!/usr/bin/env bash
# Regenerate the Shepherd explainer video from committed source.
# Build-time only — see README.md for the pinned toolchain and #2613 posture.
#
# Prereqs:
#   - Docker running
#   - system espeak-ng installed (Kokoro's phonemizer backend)
#   - a Python venv with `kokoro-onnx soundfile`, pointed at by HYPERFRAMES_PYTHON
#
# Usage: ./regen.sh [OUT_DIR]   (default: ./out)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$HERE/out}"
HF="npx --yes hyperframes@0.7.65"
mkdir -p "$OUT"

# Hardening (never install/update the skills; telemetry off) — see #2613.
export DO_NOT_TRACK=1 HYPERFRAMES_NO_TELEMETRY=1 \
       HYPERFRAMES_NO_UPDATE_CHECK=1 HYPERFRAMES_SKIP_SKILLS=1
: "${HYPERFRAMES_PYTHON:?point HYPERFRAMES_PYTHON at a venv python with kokoro-onnx + soundfile}"
: "${PHONEMIZER_ESPEAK_LIBRARY:=/usr/lib/libespeak-ng.so.1}"; export PHONEMIZER_ESPEAK_LIBRARY

# The HyperFrames project scaffold (hyperframes.json, node_modules, …) is intentionally
# NOT committed. Scaffold a throwaway project out-of-tree and copy the committed source in.
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
( cd "$WORK" && $HF init proj --example blank --non-interactive --skip-transcribe >/dev/null )
PROJ="$WORK/proj"
cp "$HERE/index.html" "$PROJ/index.html"
mkdir -p "$PROJ/assets"; cp -r "$HERE/assets/." "$PROJ/assets/"

# 1. Narration wavs from the committed script (voice: am_michael).
while IFS=$'\t' read -r id text; do
  [ -n "$id" ] || continue
  case "$id" in \#*) continue ;; esac  # skip comment lines
  $HF tts "$text" -v am_michael -o "$PROJ/assets/$id.wav" </dev/null
done < "$HERE/assets/narration.tsv"

# 2. Deterministic render (CRF 32 keeps the flat vector cut well under 3 MB).
( cd "$PROJ" && $HF render --docker --resolution 1080p --crf 32 -o "$OUT/shepherd-explainer.mp4" )

# 3. Poster (thesis end-state).
ffmpeg -y -ss 58 -i "$OUT/shepherd-explainer.mp4" -frames:v 1 -vf scale=1280:720 \
  "$OUT/shepherd-explainer-poster.png"

echo "Done → $OUT (re-check the .en.srt offsets if narration timings changed)"
