# beatmotion skill

This directory is a self-contained Claude Code skill. Drop it into any project's `.claude/skills/` (or your user-level `~/.claude/skills/`) and `/beatmotion` becomes available.

```
.claude/skills/beatmotion/
├── SKILL.md              # what Claude reads when the skill is invoked
├── package.json          # bun deps (audio-decode)
├── bin/
│   ├── analyze.ts        # audio -> beats.json
│   ├── sync.ts           # composition.tsx + beats.json -> proposed edits (stdout JSON)
│   ├── override.ts       # natural-language correction -> patched beats.json
│   └── dsp.ts            # the ~250-line DSP pipeline (ODF, autocorrelation BPM, tempogram)
├── templates/
│   └── useBeats.ts       # ergonomic helpers to copy into the user's Remotion project
├── scripts/
│   └── gen-test-wav.ts   # generate synthetic click tracks for testing
└── fixtures/             # test audio + composition fixtures
```

## Files Claude runs (you don't run these manually)

| Command | Purpose |
|---|---|
| `bun run bin/analyze.ts <audio>` | Detect beats, BPM, drops, sections; write `<basename>.beats.json` |
| `bun run bin/sync.ts <composition.tsx> <beats.json>` | Print JSON of proposed Remotion edits |
| `bun run bin/override.ts <beats.json> "<correction>"` | Patch beats.json with a natural-language correction |

The `/beatmotion` skill orchestrates these. Users invoke the skill, not the scripts directly.

## Bootstrap behavior

On the first `/beatmotion` use in a fresh checkout, the skill runs `bun install` inside this directory (one-time, ~1 second) and caches `node_modules` here. After that, every invocation is fast — Bun startup is sub-100 ms.

The skill discovers its own location via a shell walk-up from the current working directory looking for `.claude/skills/beatmotion/SKILL.md`, with a fallback to `~/.claude/skills/beatmotion/`.

## Signal processing summary

Native sample rate end-to-end. No FFT. Pipeline:

1. Decode audio with `audio-decode` (MP3/WAV/FLAC/Opus/AAC/...).
2. Mix to mono.
3. Onset detection function: log-energy derivative, half-wave rectified, sampled at 200 Hz (configurable).
4. BPM: normalized autocorrelation of the ODF, parabolic-interpolated peak, candidate range 60–200 BPM (configurable).
5. Dynamic BPM curve: sliding 6 s window, 1 s hop.
6. Peaks: local maxima above an adaptive `local_median + δ·(local_mean - local_median)` threshold.
7. Drops: RMS energy envelope at 0.5 s resolution, threshold-crossed; largest sustained jump = `main_drop`.

Verified BPM error < 0.4% across 22.05 / 44.1 / 48 kHz at tempos 90–165 BPM. Dynamic BPM curve correctly tracks a 100→140 BPM mid-track shift.

## Tuning

```bash
bun run bin/analyze.ts song.mp3 \
  --fps 30 \           # Remotion fps for the beats[].frame calculation
  --min-bpm 60 \       # constrain BPM search lower bound
  --max-bpm 200 \      # constrain BPM search upper bound
  --delta 0.7 \        # adaptive-threshold strictness (higher → fewer onsets)
  --odf-rate 200       # ODF frames/sec (higher → tighter timing, slower)
```

## Output schema

```json
{
  "audio": "song.mp3",
  "duration": 87.42,
  "sampleRate": 44100,
  "fps": 30,
  "bpm": 128.4,
  "bpmConfidence": 0.92,
  "bpmCurve":  [{ "time": 3.0, "bpm": 128.4, "confidence": 0.92 }, ...],
  "beats":     [{ "time": 0.469, "frame": 14, "strength": 0.87 }, ...],
  "drops":     [{ "time": 32.5, "frame": 975, "kind": "main_drop" }],
  "sections":  [{ "start": 0, "end": 16.2, "kind": "intro" }, ...],
  "overrides": [],
  "analyzer":  { "version": "0.2.0-native-dsp", "odfRate": 200, "minBpm": 60, "maxBpm": 200, "delta": 0.7 }
}
```

## Caveats

- Drop detection is heuristic. The skill always reads out `main_drop.time` so the user can override if it's wrong.
- The sync matcher only edits literal number arguments — already-symbolic expressions are skipped (re-running sync is idempotent).
- Some MP3 files fail CRC validation in `@audio/decode-mp3`. If decoding errors, convert to WAV or FLAC.
- The very first onset (at `t ≈ 0`) may be missed — the ODF derivative is undefined at the first frame.
