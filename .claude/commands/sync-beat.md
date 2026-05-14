---
description: Sync Remotion animations to beats in an audio file. Auto-detects the audio file and composition state in the current project — no arguments needed.
---

Run the beatmotion skill end-to-end against the current project, auto-detecting the audio file and the composition state. Do not ask the user for filenames or flow choice unless the directory state is genuinely ambiguous (see rules below).

## Step 0 — verify the skill is installed

Check for the beatmotion skill in this order:
1. `./.claude/skills/beatmotion/SKILL.md` (project-level)
2. `~/.claude/skills/beatmotion/SKILL.md` (user-level)

If neither exists, tell the user the skill is not installed and point them to `https://github.com/TenzinDhonyoe/beatmotion#install`. Stop.

## Step 1 — locate the audio file

Search for audio files in this order, taking the first non-empty hit:
1. Project root (`./`)
2. `./public/`
3. `./assets/`
4. `./src/`

Extensions: `.mp3`, `.wav`, `.flac`, `.opus`, `.aac`, `.m4a`, `.ogg`.

Branch:
- **Exactly one match** → use it silently.
- **Multiple matches in the same tier** → list them with sizes and ask which one.
- **Zero matches anywhere** → tell the user to drop an audio file into the project (e.g. `./song.mp3`) and stop.

## Step 2 — detect composition state

Look for a Remotion composition in `src/**/*.tsx`:
- Files matching `Composition*.tsx`, OR
- Any `.tsx` containing `import { Composition }` from `'remotion'` / `"remotion"`.

For each candidate, classify it:
- **Symbolic** — already references `beats[N].frame`, `drops[N].frame`, or imports a `*.beats.json` sidecar. Nothing to sync.
- **Literal** — contains literal frame numbers inside `interpolate(...)`, `spring({ delayInFrames: N })`, or `<Sequence from={N}>`.
- **Skeleton** — exists but contains no `interpolate` / `spring` / `<Sequence from=>` calls (or the file is empty / a stub).

Branch:
- **No composition file at all, or only skeleton files** → **Scaffold flow**.
- **Exactly one Literal composition** → **Sync flow** against that file.
- **Multiple Literal compositions** → list them and ask which one to sync.
- **Only Symbolic compositions exist** → tell the user the composition is already symbolic; offer to re-analyze the audio (refresh the sidecar) or to scaffold a new composition alongside. Wait for their choice.

## Step 3 — run the chosen flow via the beatmotion skill

Follow the skill's own bootstrap-and-run instructions in `SKILL.md` (run its Step 0 bootstrap to resolve `$SKILL_DIR` and install deps, then invoke the right sub-flow). Do not run `bun` commands by hand outside the skill.

**Scaffold flow:**
1. Analyze the audio → writes a `<audio>.beats.json` sidecar.
2. Run `scaffold` to generate a starter `src/Composition.tsx` with beat-anchored `<Sequence>` blocks, drop emphasis, and a transitions library next to it.
3. If `src/Root.tsx` exists, try to auto-wire the `<Composition>` registration; otherwise print the snippet for the user to paste.

**Sync flow:**
1. Analyze the audio → writes a `<audio>.beats.json` sidecar.
2. Run `sync` against the target `.tsx`. Walk the user through each proposed edit one at a time: show the literal frame, the suggested beat-relative expression, the delta in seconds, the rationale, and a **weak-match** flag where the closest beat is >0.5s away.
3. Apply only approved edits. Add the `import beatsData from "./<audio>.beats.json"` line if not already present.

## Step 4 — tell the user what's next

After the flow completes, surface:
1. `npx remotion preview` to scrub.
2. `npx remotion render` when satisfied.
3. They can patch the analysis in natural language: *"the drop is at 0:42, not 0:48"*, *"remove the beat at 1:15"*. That re-runs the Override flow.

## Troubleshooting hooks

- If the skill's Step 0 exits with `NEEDS_BUN`, tell the user: install bun via `curl -fsSL https://bun.sh/install | bash`, then retry. Stop.
- If `audio-decode` fails on an MP3 with a `crc32` validation error, suggest converting to WAV (`afconvert -f WAVE -d LEI16 song.mp3 song.wav` on macOS, or `ffmpeg -i song.mp3 song.wav` cross-platform) and retry with the WAV. Note this is a known issue tracked in the roadmap.
