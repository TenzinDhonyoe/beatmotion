---
description: Sync Remotion animations to beats in an audio file. Auto-detects the audio file and composition state, runs the full analyze → scaffold (or analyze → sync) pipeline without stopping for confirmations.
---

Run the beatmotion pipeline end-to-end against the current project. **Do not stop to ask "should I continue?" between steps.** Only ask the user when the directory state is genuinely ambiguous (multiple audio files, multiple Literal compositions) or when proposing sync edits one at a time.

## Step 0 — bootstrap the skill (silent unless something fails)

Resolve the skill directory:
1. If `./.claude/skills/beatmotion/SKILL.md` exists → `SKILL_DIR="$PWD/.claude/skills/beatmotion"`.
2. Else if `$HOME/.claude/skills/beatmotion/SKILL.md` exists → `SKILL_DIR="$HOME/.claude/skills/beatmotion"`.
3. Else: tell the user the skill is not installed and point them to `https://github.com/TenzinDhonyoe/beatmotion#install`. Stop.

If `bun --version` fails: tell the user to install bun (`curl -fsSL https://bun.sh/install | bash`). Stop.

If `$SKILL_DIR/node_modules` is missing: run `(cd "$SKILL_DIR" && bun install)` silently. Don't ask first.

## Step 1 — locate the audio file (auto)

Search for audio files in this order; take the first non-empty tier:
1. Project root (`./`)
2. `./public/`
3. `./assets/`
4. `./src/`

Extensions: `.mp3`, `.wav`, `.flac`, `.opus`, `.aac`, `.m4a`, `.ogg`.

Decision:
- **Exactly one match** → use it. No question.
- **Multiple matches in the same tier** → list them with sizes and ask which one.
- **Zero matches anywhere** → tell the user to drop an audio file into the project and stop.

## Step 2 — classify composition state (auto)

Look for a Remotion composition: any `src/**/*.tsx` matching `Composition*.tsx` OR containing `import { Composition }` from `'remotion'` / `"remotion"`.

For each candidate, classify:
- **Symbolic** — already references `beats[N].frame`, `drops[N].frame`, or imports a `*.beats.json` sidecar.
- **Literal** — contains literal frame numbers inside `interpolate(...)`, `spring({ delayInFrames: N })`, or `<Sequence from={N}>`.
- **Skeleton** — exists but contains no `interpolate` / `spring` / `<Sequence from=>` calls (or the file is empty / a stub).

Branch (no question unless explicitly listed):
- **No composition file at all, OR only Skeleton files** → **Scaffold flow**.
- **Exactly one Literal composition** → **Sync flow** against that file.
- **Multiple Literal compositions** → ask which one to sync.
- **Only Symbolic compositions exist** → tell the user the composition is already symbolic and offer to re-analyze (refresh the sidecar) or scaffold a new one. Wait for choice.

## Step 3 — run the full pipeline (no intermediate confirmation)

### Determine the Remotion FPS

Grep the project for `<Composition fps={N}>`. If found, use that N. If not found, default to **30** without asking.

### Scaffold flow (auto-detected audio, no existing comp)

Run BOTH commands in sequence without stopping:

```bash
# 1. Analyze (writes <audio-stem>.beats.json next to the audio file)
bun run "$SKILL_DIR/bin/analyze.ts" "<absolute audio path>" --fps <fps>

# 2. Scaffold straight into src/Composition.tsx
bun run "$SKILL_DIR/bin/scaffold.ts" "<audio-stem>.beats.json" \
    --tsx src/Composition.tsx \
    --comp BeatComp
```

If `src/Composition.tsx` already exists: overwrite with `--force` if it's a previous scaffold output (contains `__BEATS_IMPORT__` substitution markers like `import beatsData` plus `dropClimax`), otherwise ask before clobbering user work.

**MP3 decode failures are handled automatically by analyze.ts** — it auto-converts to a temp WAV using `afconvert` (macOS) or `ffmpeg` (cross-platform) and continues. You don't need to intervene unless analyze.ts itself exits non-zero, in which case relay the printed instructions.

After both commands succeed, summarize in 4-6 lines what the sidecar reported (BPM + confidence, gridLocked, phrase count, drop times, sections), then print the registration snippet from scaffold's stderr verbatim. Do not ask "do you want to run sync next?" — the scaffold output is symbolic already.

### Sync flow (existing Literal composition)

Run analyze first, then sync. After sync runs, **walk through the proposed edits one at a time** — this is the only point in the pipeline where per-step user input is genuinely needed.

```bash
# 1. Analyze
bun run "$SKILL_DIR/bin/analyze.ts" "<absolute audio path>" --fps <fps>

# 2. Sync — emits JSON on stdout with proposed edits
bun run "$SKILL_DIR/bin/sync.ts" "<target .tsx>" "<audio-stem>.beats.json"
```

Parse the JSON output. If `summary.total === 0`: tell the user nothing was retargeted and offer to switch to Scaffold flow. Otherwise, walk through `animations[]` in source order:

For each animation, show:
- File path + line:column
- `original` → `proposed`
- The `rationale` verbatim
- For `weakMatch: true` entries, lean toward recommending "Skip"

Options per edit: **Apply** / **Skip** / **Stop reviewing**.

Apply approved edits with the Edit tool using the exact `original` string. If Edit returns "old_string not unique", expand context from the line/column reference until unique. Never use `replace_all: true`.

After all edits applied: check `hasBeatsImport` from sync output. If `false`, insert
```ts
import beatsData from "<beatsImport from sync output>";
const { beats, drops, sections } = beatsData;
```
after the last existing `import` line.

## Step 4 — final summary (one block, no follow-up question)

After the flow completes, tell the user in 3-5 lines:
- What the pipeline did (analyzed → scaffolded / synced N edits)
- Where the output is (file path)
- The next concrete command they should run: `npx remotion preview` then `npx remotion render`
- If `gridLocked: false`, mention briefly that the song has variable/uncertain tempo — the matcher still ran but without bar/phrase bonuses

Do not ask "anything else?" or "want to try another flow?" — the user can invoke `/sync-beat` again or send a natural-language override (*"the drop is at 0:42"*) if they want to iterate.

## Override flow (natural-language correction, not part of normal /sync-beat)

If the user, AFTER running /sync-beat, says something like *"the drop is actually at 0:42"* or *"remove that beat near 1:15"*, translate the phrase into one of the supported override forms and run:

```bash
bun run "$SKILL_DIR/bin/override.ts" "<beats.json>" "<translated correction>"
```

Then re-run sync if a `.tsx` is present.

## Failure modes you might hit

- **MP3 auto-fallback failed (no afconvert / ffmpeg)** — analyze.ts will exit 1 with conversion instructions. Relay them and stop.
- **bun install failed** — relay the error and stop. The skill needs its deps to run.
- **Audio file is genuinely silent or unanalyzable** — analyze.ts will emit 0 beats, gridLocked: false. Tell the user, don't try to scaffold from it.
