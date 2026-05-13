# beatmotion

A Claude Code skill that syncs [Remotion](https://remotion.dev) animations to music beat drops.

You ask Claude to sync your launch video to a song. The skill detects beats, drops, and BPM from the audio (any tempo, any sample rate), then walks you through code edits one at a time. You never type a `bun` command — Claude runs everything.

## Install

This repo **is** the skill. To use it in any Remotion project:

```bash
# Option A — per-project (recommended; works only in that project)
cp -r /path/to/this/repo/.claude/skills/beatmotion <your-project>/.claude/skills/beatmotion

# Option B — user-level (works in every Claude Code session)
cp -r /path/to/this/repo/.claude/skills/beatmotion ~/.claude/skills/beatmotion
```

The skill auto-installs its own deps the first time it runs. The only prerequisite is [Bun](https://bun.sh):

```bash
curl -fsSL https://bun.sh/install | bash
```

## Use

Open Claude Code in your Remotion project. Then just say what you want:

> "Sync the animations in `src/Composition.tsx` to `song.mp3`."

Claude will:

1. Bootstrap the skill (one-time `bun install` if needed).
2. Detect the FPS from your `<Composition>` JSX.
3. Run beat detection — report BPM, drop location, and onset count.
4. Walk you through every `interpolate` / `spring` / `<Sequence>` it can align to a beat, with diffs and rationale.
5. Apply approved edits and add an `import beatsData from "./song.beats.json"` line.

Or be more specific:

> "Detect the beats in `song.mp3`."
> "The drop is actually at 0:42, not 0:48."
> "Now sync the animations."

The skill recognizes natural language for analyze / sync / override flows.

## What it does

- **Detects beats** at any sample rate (22.05 / 44.1 / 48 kHz tested) and any tempo (60–200 BPM default range). Onset detection via log-energy derivative, BPM via autocorrelation of the onset envelope, dynamic BPM curve via sliding-window autocorrelation (tracks tempo changes).
- **Detects drops** via energy-envelope analysis. Main drop = largest sustained energy jump after a low-energy passage.
- **Edits Remotion source** to replace literal frame numbers with `beats[N].frame` / `drops[N].frame` expressions. Skips already-symbolic expressions (idempotent).
- **Patches mistakes** via natural-language overrides: "drop at 0:42", "remove beat at 1:15".

## Full docs

See [`.claude/skills/beatmotion/SKILL.md`](.claude/skills/beatmotion/SKILL.md) for the skill instructions Claude follows, and [`.claude/skills/beatmotion/bin/dsp.ts`](.claude/skills/beatmotion/bin/dsp.ts) for the ~250-line signal-processing pipeline (no external DSP deps, no FFT, runs at the file's native sample rate).

## License

MIT.
