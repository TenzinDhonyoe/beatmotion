---
name: beatmotion
description: Sync Remotion animations to music beat drops. Use whenever the user wants to align video animations to musical moments - phrases like "sync this to the beat", "match the drop", "the music doesn't line up with the animation", or when they mention an audio file alongside a Remotion composition. Detects beats, BPM (any tempo), drops, and sections from any audio file at its native sample rate, then proposes per-animation edits to Remotion source code.
---

# beatmotion

A Claude Code skill that syncs Remotion animations to music. The user describes what they want in natural language; you handle everything else — locating files, running the signal-processing pipeline, proposing edits, applying them.

## What this skill does

1. **Detects beats** in any audio file (MP3, WAV, FLAC, Opus, AAC, etc.) at its native sample rate. BPM is computed via autocorrelation of an onset envelope and works for any tempo in the 60–200 BPM range out of the box.
2. **Proposes edits** to a Remotion `.tsx` composition: every `interpolate(frame, [a,b], ...)`, `spring({ delayInFrames: N })`, and `<Sequence from={N}>` gets a beat-aligned suggestion with a rationale.
3. **Applies corrections** via natural language ("drop at 0:42", "remove beat at 1:15") to patch the analyzed sidecar.

## How you (Claude) drive this skill

The user will not type `bun ...` commands. You do that. When the user invokes `/beatmotion` or asks anything in the skill's scope, follow the flow below.

### Step 0 — bootstrap (run once per skill install)

The skill ships with `package.json` declaring its deps. On first use in a fresh checkout, run:

```bash
SKILL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)
# Fallback: scan from cwd upward for the skill directory.
if [ -z "$SKILL_DIR" ] || [ ! -f "$SKILL_DIR/package.json" ]; then
  d=$(pwd)
  while [ "$d" != "/" ]; do
    if [ -f "$d/.claude/skills/beatmotion/SKILL.md" ]; then
      SKILL_DIR="$d/.claude/skills/beatmotion"; break
    fi
    d=$(dirname "$d")
  done
fi
if [ -z "$SKILL_DIR" ] || [ ! -f "$SKILL_DIR/SKILL.md" ]; then
  # Last resort: user-level install.
  if [ -d "$HOME/.claude/skills/beatmotion" ]; then SKILL_DIR="$HOME/.claude/skills/beatmotion"; fi
fi
if [ -z "$SKILL_DIR" ]; then
  echo "ERROR: cannot find the beatmotion skill directory" >&2
  exit 1
fi

# Check bun.
if ! command -v bun >/dev/null 2>&1; then
  echo "NEEDS_BUN: bun is required. Install with: curl -fsSL https://bun.sh/install | bash" >&2
  exit 2
fi

# Install deps if missing.
if [ ! -d "$SKILL_DIR/node_modules" ]; then
  ( cd "$SKILL_DIR" && bun install >/dev/null 2>&1 ) || { echo "bun install failed in $SKILL_DIR" >&2; exit 3; }
fi
echo "$SKILL_DIR"
```

Capture the printed `$SKILL_DIR` and reuse it for every subsequent command in this session.

If the script exits with code 2 (no bun), tell the user: **"This skill needs bun. Install it with `curl -fsSL https://bun.sh/install | bash`, then try again."** Then stop.

If the script exits with code 3 (install failed), show the error and tell the user the dep install failed. Stop.

### Step 1 — figure out what the user wants

Listen for the three sub-flows:

| User says... | Run |
|---|---|
| "analyze this song", "detect beats in song.mp3", "what's the bpm" | **Analyze flow** |
| "sync the animations", "align this to the beats", "now apply it" | **Sync flow** |
| "the drop is actually at...", "the beat at X is wrong" | **Override flow** |

If the user invokes `/beatmotion` with no clear sub-flow, ask them what they want.

If the user gives an audio file AND a `.tsx` composition in one go, do **Analyze → Sync** back-to-back without asking.

## Analyze flow

**Goal:** turn an audio file into `<audio>.beats.json`.

1. Verify the audio path exists. If not, ask the user for the correct path. Do not guess.
2. Determine the Remotion FPS:
   - Grep the user's project for `<Composition` and read the `fps={N}` attribute.
   - If multiple compositions have different fps values, ask which one to target.
   - If you can't find any, default to 30 and tell the user that's what you used.
3. Run:
   ```bash
   bun run "$SKILL_DIR/bin/analyze.ts" "<absolute audio path>" --fps <fps>
   ```
4. Read the resulting `<audio>.beats.json`. Report to the user:
   - BPM and confidence (e.g., "128.4 BPM, 92% confidence")
   - Beat count
   - Drop count + time of the `main_drop` (in mm:ss)
   - Section count
   - If the `bpmCurve` shows any 1-second window deviating by more than 5 BPM from the global value, flag the tempo change explicitly.
5. Ask: "Run /beatmotion sync now to wire this into your Remotion source?"

## Sync flow

**Goal:** propose beat-aligned edits to a Remotion `.tsx` file and apply the approved ones.

1. Resolve the target `.tsx` file:
   - If only one `*.tsx` in the project contains a Remotion `<Composition>` or imports from `remotion`, use it.
   - Otherwise ask which file.
2. Resolve the `beats.json`. Default to the most recent `*.beats.json` near the audio file. If none found, suggest running `/beatmotion analyze` first.
3. Run:
   ```bash
   bun run "$SKILL_DIR/bin/sync.ts" "<composition.tsx>" "<beats.json>"
   ```
4. Parse the JSON output (stdout). It includes a `summary` and an `animations` array.
5. If `summary.total === 0`, tell the user: "No animations to sync — all `interpolate`/`spring`/`Sequence` calls in this file already use symbolic frame expressions, or there are none." Stop.
6. Briefly summarize: "Found N candidates (X interpolate, Y spring, Z Sequence). Walk through them?"
7. For each animation in source order (one at a time), use AskUserQuestion with:
   - Re-ground: file path, line:column, animation kind
   - Show the `rationale` verbatim
   - Show `original` → `proposed`
   - Options:
     - **A) Apply this edit** (recommended if the time delta is < 0.2s from the original beat)
     - **B) Skip — keep as-is**
     - **C) Stop reviewing** (apply nothing further)
8. For approved edits, use the Edit tool with `old_string = original` and `new_string = proposed`. The original strings are designed to be unique within the file.
9. Once any edit is applied, ensure the file has access to the beats data:
   - Check the `hasBeatsImport` field in the sync output.
   - If `false`, insert after the last existing `import` line:
     ```ts
     import beatsData from "<beatsImport>";
     const { beats, drops, sections } = beatsData;
     ```
   - Use the `beatsImport` path from the sync output verbatim.
10. After all approved edits are applied, tell the user: "Applied N of M edits. Re-render with `npx remotion render` (or your normal Remotion render command) to see the synced video."

## Override flow

**Goal:** patch `beats.json` based on a natural-language correction.

1. Locate the active `beats.json`. If unclear, ask.
2. Translate the user's phrase into one of the supported forms. Examples:
   - "the drop is at 42 seconds" → `"drop at 0:42"`
   - "the main drop should be at one minute fifteen" → `"drop at 1:15"`
   - "remove that beat near the 30 second mark" → `"remove beat at 0:30"`
   - "there's a secondary drop at one twelve" → `"secondary drop at 1:12"`
3. Run:
   ```bash
   bun run "$SKILL_DIR/bin/override.ts" "<beats.json>" "<translated correction>"
   ```
4. Exit code 0 = applied. Stderr line and the JSON on stdout describe what changed.
5. Exit code 1 = couldn't parse. Tell the user what phrases are supported (see `--help`) and ask for a corrected phrasing.
6. After a successful override, ask: "Re-run /beatmotion sync to propagate this into the Remotion source?"

## Import strategy (for sync edits)

The sync CLI emits proposed strings using bare `beats[N].frame` and `drops[N].frame` symbols. When applying, you have two options:

- **Preferred:** insert a single import + destructure at the top of the file (see Sync flow step 9). The proposed strings then work as-is.
- **Alternative:** rewrite each proposed string to qualify symbols, e.g. `beats[2].frame` → `beatsData.beats[2].frame`.

Always pick the preferred form unless the user has an existing import with conflicting names. If `beats` or `drops` is already an identifier in the file, fall back to qualified access using `beatsData.beats[N]`.

## Useful templates

The skill ships `templates/useBeats.ts` — a zero-dep helper that provides `frameOf`, `nearestBeat`, `isOnDrop`, `sectionAt`, etc. If the user wants richer access patterns than indexed arrays, offer to copy it into their project:

```bash
cp "$SKILL_DIR/templates/useBeats.ts" <user-project>/src/useBeats.ts
```

Then they can write:
```ts
import beatsData from "./song.beats.json";
import { createBeatHelpers } from "./useBeats";
const beats = createBeatHelpers(beatsData);
const opacity = interpolate(frame, [0, beats.frameOf(2)], [0, 1]);
```

## Quality bar

- Verified across sample rates (22.05 / 44.1 / 48 kHz) and tempos (90 / 100 / 120 / 140 / 165 BPM) — BPM error < 0.4% on clean tracks.
- Dynamic BPM curve correctly tracks tempo changes (verified with a 100 → 140 BPM shift fixture).
- Drop detection is heuristic. Always read out the detected main_drop time so the user can override if it's off.
- The sync matcher only edits literal number arguments. Already-symbolic frame expressions are skipped, which makes re-running `sync` idempotent.

## When NOT to use this skill

- The user wants **real-time** audio-reactive animation (volume bars, FFT visualizations). For that, use Remotion's built-in `useAudioData()` and `visualizeAudio()` — beatmotion is for semantic timestamps (beats, drops), not amplitude.
- Tracks with extreme tempo flexibility (rubato, free time). The BPM detector assumes a roughly constant tempo per autocorrelation window.

## Examples of end-to-end flows

### "Make my launch video sync to song.mp3"

```
You: 1. Bootstrap (one-time bun install if needed)
     2. Grep the project for <Composition fps={...} → 30
     3. bun run $SKILL_DIR/bin/analyze.ts /abs/path/song.mp3 --fps 30
     4. Report: "128 BPM, main drop at 0:32, 47 beats, 3 sections"
     5. AskUser: "Run sync now?" → Yes
     6. Find the only *.tsx with <Composition> → src/Composition.tsx
     7. bun run $SKILL_DIR/bin/sync.ts src/Composition.tsx song.beats.json
     8. Walk through 5 proposed edits one by one with AskUserQuestion
     9. Apply approved edits + insert `import beatsData from "./song.beats.json"`
     10. Report: "Applied 4 of 5. Render with `npx remotion render`."
```

### "The drop is actually at 28 seconds, not 32"

```
You: 1. Locate the active *.beats.json
     2. Translate: "drop at 0:28"
     3. bun run $SKILL_DIR/bin/override.ts song.beats.json "drop at 0:28"
     4. Report: "Main drop moved to 0:28 (frame 840). Re-run sync to update the .tsx?"
```
