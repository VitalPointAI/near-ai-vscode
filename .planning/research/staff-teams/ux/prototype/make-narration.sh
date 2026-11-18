#!/usr/bin/env bash
# Regenerates the war-room narration audio from the ORIENT and NARR lines in war-room.html:
# audio/orient-NN.wav (the screen tour) and audio/narr-NN.wav (one per moment of the demo).
# Needs piper-tts (pipx install piper-tts) and a Piper voice. The default voice used so far is
# en_US-joe-medium, trained on a CC0 dataset, so the audio is free to use in demos.
# Usage: ./make-narration.sh /path/to/en_US-joe-medium.onnx
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
model="${1:?give the path to a Piper .onnx voice}"
mkdir -p "$here/audio"
python3 - "$here/war-room.html" <<'PY' | while IFS=$'\t' read -r name text; do
import re, sys
src = open(sys.argv[1], encoding='utf-8').read()
for array, prefix in (('const ORIENT = [', 'orient'), ('const NARR = [', 'narr')):
    block = src[src.index(array):]
    block = block[:block.index('\n];')]
    for i, m in enumerate(re.finditer(r"text: '((?:[^'\\]|\\.)*)'", block), 1):
        print(f"{prefix}-{i:02d}\t{m.group(1).replace(chr(92) + chr(39), chr(39))}")
PY
  printf '%s' "$text" | piper -m "$model" --sentence-silence 0.3 --length-scale 1.05 -f "$here/audio/$name.wav" >/dev/null 2>&1
  echo "$name.wav"
done
