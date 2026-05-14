# Changelog

All notable changes to the beatmotion skill are documented here.

## [0.3.0] - 2026-05-13 — initial public release

Two flows ship in this release: **analyze + sync** (existing) and **scaffold** (new).

### Analyze + Sync (the foundation)

- **Analyze.** BPM, beats, drops, sections, and a dynamic BPM curve via sliding-window autocorrelation. Native sample rate, no FFT, <0.4% BPM error across 22.05 / 44.1 / 48 kHz fixtures at 90–165 BPM.
- **Sync.** Regex-based retarget of literal frame numbers in `interpolate` / `spring` / `<Sequence>` to `beats[N].frame` / `drops[N].frame`. Idempotent — already-symbolic expressions are skipped.
- **Override.** Natural-language corrections to a `beats.json` sidecar — "drop at 0:42", "remove beat at 1:15".
- **`useBeats.ts` helpers.** Ergonomic accessors for the beats sidecar, dropped into the user's Remotion project.

### Scaffold (new in this release)

- **Scaffold flow.** New `bin/scaffold.ts` generates a starter `Composition.tsx` from a beats sidecar, so users with just an mp3 (and no existing Remotion comp) get a render-ready starting point. Section-anchored `<Sequence>` blocks, drop-emphasis effects, beat-strength-aware transition selection.
- **Transition library.** New `templates/transitions.ts` with pure helpers: `beatCut`, `beatFade`, `dropPunch`, `sectionSlide`, `pickTransition`. Composable style objects, no React-component wrappers, importable from any Remotion comp.
- **`--media` flag.** Scaffold can bind a folder of images (`.jpg`, `.png`, `.webp`, etc.) — they cycle per beat inside the generated `<Sequence>` blocks. Without it, the comp falls back to text labels showing the section name.

### Sync — robustness fixes landed before the public cut

- **Multi-line code matching.** Replaced `[^}]` and `[^>]` patterns with `[\s\S]*?` non-greedy in `findInterpolate`, `findSpring`, and `findSequence`. Multi-line `interpolate(\n  frame,\n  [0, 30],\n  ...\n)`, multi-line `spring({...})` with nested config, and `<Sequence>` with attributes split across lines now match correctly.
- **Weak-match gating.** Animations more than 0.5s away from any beat are marked `weakMatch: true` with a `WEAK MATCH (Xs off)` rationale, so the skill can recommend "skip" instead of silently misaligning.
- **Frame 0 preserved.** `<Sequence from={0}>`, `interpolate(frame, [0, X], ...)` start frames, and `spring({ delayInFrames: 0 })` are no longer retargeted — frame 0 is semantically "video start," not a beat candidate.
- **Output schema.** `summary` now includes `strongMatches` and `weakMatches` counts. Each animation entry includes `weakMatch: boolean` and `deltaSec: number`.

### Analyze — downbeat fix

- **Implicit beat 0 for downbeat-start tracks.** The log-energy ODF can't fire on frame 0, so tracks starting on a downbeat lost their first beat. The analyzer now prepends a `{time: 0, frame: 0}` beat when the first detected beat lands within 0.6×–1.4× of the BPM interval.

### Docs

- **README.** Describes both flows (scaffold + sync) honestly instead of overselling a single retarget path. Adds Remotion one-line explainer, Demo placeholder, and install one-liner.
- **SKILL.md.** Adds Scaffold flow section; the "no animations" branch now offers scaffold instead of dead-ending; Edit-not-unique fallback documented for cases where two identical `interpolate` calls collide.

> **Note on versioning.** The internal development branch went through a 0.2.0 iteration (analyze / sync / override / `useBeats.ts`) before the 0.3.0 cut that added scaffold and the sync robustness fixes. 0.3.0 is the first version with a public commit history.
