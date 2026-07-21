# Shepherd explainer — reproducible source

Build-time source for `docs/media/shepherd-explainer.mp4` (+ `.en.srt`, `-poster.png`).
The video is a narrated re-cut of the on-site pipeline animation
(`site/src/components/PipelineAnimation.astro`, #1878): same node coordinates, gate
positions, semantic palette, motion and per-beat copy — the 17s loop stretched to a
single 38s play (~44s total with the closing thesis), the beat-8 "needs you" payload
held at the end.

This is a **build-time asset generator**. Nothing here is a runtime dependency; the repo
carries only the rendered artifacts. The HyperFrames project scaffold
(`hyperframes.json`, `.media/`, `renders/`, `node_modules/`) is deliberately **not**
committed — regenerate it out-of-tree with the commands below.

## What's here

- `index.html` — the composition (self-contained: inline SVG + CSS + `<audio>` tracks).
- `assets/narration.tsv` — the narration script (id ⇥ text), input to Kokoro TTS.
- `regen.sh` — regenerates the narration wavs and re-renders the mp4.

The narration `.wav` files are **not** committed — they are regenerable from
`narration.tsv` via `hyperframes tts` (see `regen.sh`).

## Pinned toolchain (all load-bearing — see #1872 §5.2 / #2613)

| Piece           | Pin                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HyperFrames CLI | **`hyperframes@0.7.65`** exactly (`npx hyperframes@0.7.65 …`)                                                                                                             |
| Render mode     | `--docker` (deterministic; local mode is documented non-reproducible)                                                                                                     |
| Render image    | `hyperframes-renderer:0.7.65`, built locally by the pinned CLI (id `sha256:2cb5cc80c6ee…`). No external registry tag — the npm pin is the root of trust for the image.    |
| TTS model       | Kokoro `kokoro-v1.0.onnx` sha256 `7d5df8ec…a6c5`; `voices-v1.0.bin` sha256 `bca610b8…bf7d`                                                                                |
| Phonemizer      | system `espeak-ng 1.52.0` + `PHONEMIZER_ESPEAK_LIBRARY=/usr/lib/libespeak-ng.so.1` (the pip-bundled `espeakng_loader` lib is broken and ignores every data-path override) |
| Voice           | `am_michael`                                                                                                                                                              |

## Security posture (#2613 — open at authoring time)

HyperFrames' Claude Code skills open with a directive to run
`npx hyperframes skills update` "silently, don't ask" on every invocation. This project
is generated with the skills **never installed**:

```sh
export DO_NOT_TRACK=1 HYPERFRAMES_NO_TELEMETRY=1 \
       HYPERFRAMES_NO_UPDATE_CHECK=1 HYPERFRAMES_SKIP_SKILLS=1
```

`HYPERFRAMES_SKIP_SKILLS=1` stops `init` from touching the agent skills dir; blueprints
are pulled with `add`, never via the global `skills` install. **Never** run
`hyperframes skills update` or `hyperframes upgrade`. Telemetry is off (`DO_NOT_TRACK`).

## Regenerate

Prereqs: Docker running, `espeak-ng` installed system-wide, a Python venv with
`kokoro-onnx soundfile` pointed at by `HYPERFRAMES_PYTHON`. Then:

```sh
./regen.sh /path/to/out   # writes shepherd-explainer.mp4 + poster (.en.srt is hand-authored)
```

The `.en.srt` is hand-authored from the exact narration offsets in `index.html`
(more accurate than Whisper for known copy); update it if the timings change.
