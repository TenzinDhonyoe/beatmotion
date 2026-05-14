# beatmotion

A Claude Code skill that syncs [Remotion](https://remotion.dev) animations to music. *(Remotion is a framework for building videos programmatically in React.)* Two paths depending on where you are:

- **Scaffold** — you have an mp3 and no composition yet. The skill detects beats / drops / sections, then writes a starter `Composition.tsx` with beat-synced cuts, drop emphasis, and a small transition library wired up. Optionally binds image media you point it at.
- **Sync** — you have an mp3 and an existing composition with literal frame numbers. The skill detects beats and walks you through retargeting each `interpolate` / `spring` / `<Sequence>` to the nearest beat, flagging weak matches so it never silently misaligns.

You never type a `bun` command — Claude runs everything.

## Demo

![beatmotion demo](docs/demo.gif)

*A 5-second clip: scaffolded `<Composition>` cutting on detected beats. Source: `fixtures/click-140bpm-48k.wav`.*

## Quick start

Requirements: [Bun](https://bun.sh), [Claude Code](https://claude.com/claude-code), Git. A Remotion project is optional — you can start with just an mp3.

Open Claude Code in your project (or any empty directory) and paste this. Claude does the rest.

> Set up beatmotion for me: shallow-clone `https://github.com/TenzinDhonyoe/beatmotion` into a temp directory (e.g. `git clone --depth 1 https://github.com/TenzinDhonyoe/beatmotion /tmp/beatmotion-install`), then copy two things from that clone into the current directory:
>   - `.claude/skills/beatmotion/` → `./.claude/skills/beatmotion/`
>   - `.claude/commands/sync-beat.md` → `./.claude/commands/sync-beat.md`
>
> If either destination already exists, ask me before overwriting. After install completes, confirm `bun --version` works, check that both `./.claude/skills/beatmotion/SKILL.md` and `./.claude/commands/sync-beat.md` exist, and show me the project tree. Then tell me to drop my audio file (mp3 / wav / flac) into the project and just type `/sync-beat` — it auto-detects everything. Do not run the skill yourself — wait for me.

Then:

1. Drop your audio file into the project (e.g. `./song.mp3`)
2. Type `/sync-beat` in Claude Code — it finds the audio, detects whether you already have a `<Composition>`, picks scaffold-vs-sync, and runs the whole flow
3. Approve the proposed edits one at a time — Claude walks you through each with a diff and a weak-match flag where appropriate
4. `npx remotion preview` to scrub, then `npx remotion render` when you're happy

That's the whole loop. No manual beat-counting, no eyeballing waveforms.

Prefer to do it yourself? Every step is spelled out below.

## Install

> **Prerequisite:** [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`

### Option A — one-liner (recommended)

From inside your Remotion project:

```bash
curl -fsSL https://raw.githubusercontent.com/TenzinDhonyoe/beatmotion/main/install.sh | bash
```

Add `--user` to install at `~/.claude/skills/` instead (available in every Claude Code session).

### Option B — manual

```bash
git clone https://github.com/TenzinDhonyoe/beatmotion.git
# project-level
mkdir -p <your-project>/.claude/{skills,commands}
cp -r beatmotion/.claude/skills/beatmotion        <your-project>/.claude/skills/beatmotion
cp    beatmotion/.claude/commands/sync-beat.md    <your-project>/.claude/commands/sync-beat.md
# or, for user-level (available in every Claude Code session):
mkdir -p ~/.claude/{skills,commands}
cp -r beatmotion/.claude/skills/beatmotion        ~/.claude/skills/beatmotion
cp    beatmotion/.claude/commands/sync-beat.md    ~/.claude/commands/sync-beat.md
```

The skill auto-installs its own deps the first time it runs.

## Use

Open Claude Code in your Remotion project, drop an audio file in, and type:

> `/sync-beat`

That's it. The slash command auto-detects your audio (`./`, `public/`, `assets/`, `src/`), detects whether you already have a `<Composition>` with literal frame numbers, picks scaffold-or-sync, and runs the whole flow. Approve the proposed edits one at a time.

Prefer natural language? It still works:

> "I have `song.mp3` and want a beat-synced video — start me off."

Claude will analyze the audio, then scaffold a starter `src/Composition.tsx` with section-aware `<Sequence>` blocks, drop emphasis, and a transition library next to it. Drop `song.mp3` into `public/`, register the composition in your `Root.tsx`, and `npx remotion render`.

Or against an existing composition:

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

## Troubleshooting

**`MP3 decode failed (crc32 validation)`** — some real-world MP3s trip the bundled `audio-decode` library. Convert to WAV and retry:

```bash
# macOS
afconvert -f WAVE -d LEI16 song.mp3 song.wav

# cross-platform
ffmpeg -i song.mp3 song.wav
```

Then point the skill at the WAV. The roadmap covers swapping the decoder so this works automatically.

## Full docs

See [`.claude/skills/beatmotion/SKILL.md`](.claude/skills/beatmotion/SKILL.md) for the skill instructions Claude follows, and [`.claude/skills/beatmotion/bin/dsp.ts`](.claude/skills/beatmotion/bin/dsp.ts) for the ~250-line signal-processing pipeline (no external DSP deps, no FFT, runs at the file's native sample rate).

## License

MIT.
