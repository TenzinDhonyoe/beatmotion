# beatmotion

A Claude Code skill that syncs [Remotion](https://remotion.dev) animations to music. Two paths depending on where you are:

- **Scaffold** — you have an mp3 and no composition yet. The skill detects beats / drops / sections, then writes a starter `Composition.tsx` with beat-synced cuts, drop emphasis, and a small transition library wired up. Optionally binds image media you point it at.
- **Sync** — you have an mp3 and an existing composition with literal frame numbers. The skill detects beats and walks you through retargeting each `interpolate` / `spring` / `<Sequence>` to the nearest beat, flagging weak matches so it never silently misaligns.

You never type a `bun` command — Claude runs everything.

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

> "I have `song.mp3` and want a beat-synced video — start me off."

Claude will analyze the audio, then scaffold a starter `src/Composition.tsx` with section-aware `<Sequence>` blocks, drop emphasis, and a transition library next to it. Drop `song.mp3` into `public/`, register the composition in your `Root.tsx`, and `npx remotion render`.

Or if you already have a composition:

> "Sync the animations in `src/Composition.tsx` to `song.mp3`."

Claude will analyze the audio, then walk you through every `interpolate` / `spring` / `<Sequence>` it can align to a beat, with a delta, rationale, and weak-match flag where appropriate. Approved edits are applied with a generated `import beatsData from "./song.beats.json"` line.

You can mix and match:

> "Detect the beats in `song.mp3`."
> "Scaffold a comp from those beats and the images in `./assets`."
> "The drop is actually at 0:42, not 0:48."
> "Now refine the cuts."

The skill recognizes natural language for analyze / scaffold / sync / override flows.

## What it does

- **Detects beats** at any sample rate (22.05 / 44.1 / 48 kHz tested) and any tempo (60–200 BPM default range). Onset detection via log-energy derivative, BPM via autocorrelation of the onset envelope, dynamic BPM curve via sliding-window autocorrelation (tracks tempo changes). Prepends an implicit beat at t=0 for tracks that start on a downbeat (since the log-energy derivative can't fire on frame 0).
- **Detects drops** via energy-envelope analysis. Main drop = largest sustained energy jump after a low-energy passage.
- **Scaffolds Remotion source** — `bin/scaffold.ts` writes a starter `Composition.tsx` from a `beats.json` sidecar. Sections become `<Sequence>` blocks, beats become transition anchor points (cut / fade / slide, chosen by beat strength), and each drop gets a scale-bounce emphasis. Copies a beat-helpers module and a transitions library next to your output so the scaffolded comp is editable straight away.
- **Edits existing Remotion source** to replace literal frame numbers with `beats[N].frame` / `drops[N].frame` expressions. Multi-line `interpolate`/`spring`/`<Sequence>` calls are supported. Already-symbolic expressions are skipped (idempotent). Weak matches (>0.5s from any beat) are flagged so the user can decline.
- **Patches mistakes** via natural-language overrides: "drop at 0:42", "remove beat at 1:15".

## Full docs

See [`.claude/skills/beatmotion/SKILL.md`](.claude/skills/beatmotion/SKILL.md) for the skill instructions Claude follows, and [`.claude/skills/beatmotion/bin/dsp.ts`](.claude/skills/beatmotion/bin/dsp.ts) for the ~250-line signal-processing pipeline (no external DSP deps, no FFT, runs at the file's native sample rate).

## License

MIT.
