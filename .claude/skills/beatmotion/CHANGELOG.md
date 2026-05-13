# Changelog

All notable changes to the beatmotion skill are documented here.

## [0.3.0] - 2026-05-13

### Added

- **Scaffold flow.** New `bin/scaffold.ts` generates a starter `Composition.tsx` from a beats sidecar, so users with just an mp3 (and no existing Remotion comp) get a render-ready starting point. Section-anchored `<Sequence>` blocks, drop-emphasis effects, beat-strength-aware transition selection.
- **Transition library.** New `templates/transitions.ts` with pure helpers: `beatCut`, `beatFade`, `dropPunch`, `sectionSlide`, `pickTransition`. Composable style objects, no React-component wrappers, importable from any Remotion comp.
- **`--media` flag.** Scaffold can bind a folder of images (`.jpg`, `.png`, `.webp`, etc.) — they cycle per beat inside the generated `<Sequence>` blocks. Without it, the comp falls back to text labels showing the section name.
- **Implicit beat 0 for downbeat-start tracks.** The log-energy ODF can't fire on frame 0, so tracks starting on a downbeat lost their first beat. The analyzer now prepends a `{time: 0, frame: 0}` beat when the first detected beat lands within 0.6×–1.4× of the BPM interval.

### Changed

- **Sync matchers now handle multi-line code.** Replaced `[^}]` and `[^>]` patterns with `[\s\S]*?` non-greedy in `findInterpolate`, `findSpring`, and `findSequence`. Multi-line `interpolate(\n  frame,\n  [0, 30],\n  ...\n)`, multi-line `spring({...})` with nested config, and `<Sequence>` with attributes split across lines now match correctly.
- **Sync now flags weak matches.** Animations more than 0.5s away from any beat are marked `weakMatch: true` with a `WEAK MATCH (Xs off)` rationale, so the skill can recommend "skip" instead of silently misaligning.
- **Frame 0 preserved.** `<Sequence from={0}>`, `interpolate(frame, [0, X], ...)` start frames, and `spring({ delayInFrames: 0 })` are no longer retargeted — frame 0 is semantically "video start," not a beat candidate.
- **Sync output schema.** `summary` now includes `strongMatches` and `weakMatches` counts. Each animation entry includes `weakMatch: boolean` and `deltaSec: number`.
- **README.** Honestly describes both flows (scaffold + sync) instead of overselling a single retarget path.
- **SKILL.md.** Adds Scaffold flow section, the "no animations" branch now offers scaffold instead of dead-ending, and Edit-not-unique fallback documented for cases where two identical `interpolate` calls collide.

### Fixed

- **Stale fixtures.** All six fixture `.beats.json` files regenerated against the new analyzer (beat 0 prepend). BPM detection unchanged across 90 / 100 / 140 / 165 BPM and 22.05 / 44.1 / 48 kHz fixtures (still <0.4% error).

## [0.2.0] - prior

Initial release: analyze (BPM, beats, drops, sections, dynamic BPM curve via autocorrelation), sync (regex-based retarget of `interpolate`/`spring`/`<Sequence>`), override (natural-language corrections to beats.json), `useBeats.ts` helpers.
