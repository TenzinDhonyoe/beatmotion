# TODOS

Deferred work captured during the 2026-05-13 CEO review and the follow-up eng review. Items here have context attached so they're pickup-ready in a future session. Organized by component, then priority (P0 → P3).

## bin/scaffold.ts

### P1 — Runtime validation of beats.json input

**What:** Validate the shape of the beats.json sidecar before substitution. Currently `JSON.parse` is cast directly with `as { audio, duration, fps }` — a malformed file produces a confusing TypeError or generates a broken `.tsx`.

**Why:** Real users will edit beats.json by hand (or pass one from a stale analyzer version). The current path is "explode mysteriously"; the better path is "refuse with a one-line explanation of what's missing."

**Context:** Both the eng review (finding 1A) and the adversarial review (finding 7) flagged this. Implementation: small validator function — check `audio` is a string, `duration > 0`, `fps > 0`, `Array.isArray(beats)`, `Array.isArray(sections)`. ~20 lines. No new deps.

**Effort:** S (human: ~30 min / CC: ~10 min). **Priority:** P1.

### P2 — Auto-wire `Composition` registration into Root.tsx

**What:** Detect `src/Root.tsx` (or `src/index.tsx`). If present and contains `<Composition`, inject the new `<Composition>` registration. If absent, scaffold a minimal Root.tsx alongside the comp. Keep `--no-root` to opt out.

**Why:** The scaffold's "next steps" currently includes a manual paste step. Closing that step makes the "drop mp3 → get video" promise truly automatic.

**Context:** Flagged by eng review (finding 1B). Risk: existing Root.tsx files may have unusual structure; the detection has to be conservative. Default to opt-out if detection is uncertain.

**Effort:** S (human: ~2h / CC: ~15 min). **Priority:** P2.

### P2 — Scaffold performance: memoize per-section beat/drop filters

**What:** Memoize `beatsInSection` / `dropsInSection` per section index (via `useMemo`) and binary-search `activeBeatIdx` on the sorted array.

**Why:** Current generated code re-filters and linear-scans every frame for every section. For a 30-second comp with 200 beats and 4 sections at 30fps, that's ~720k filter ops + 720k scans per render. Preview will feel sluggish on real videos.

**Context:** Flagged by eng review (finding 4A). The change is in the template — `templates/Composition.scaffold.tsx.tmpl` — not the scaffold script.

**Effort:** S (human: ~1h / CC: ~10 min). **Priority:** P2.

## bin/sync.ts

### P3 — Full AST-based sync matcher (replace regex)

**What:** Replace the regex matchers in `bin/sync.ts` with a real TypeScript parser. Multi-line regex handles common cases but breaks on nested object literals containing `delayInFrames` literal text, or deeply-nested JSX with conditional children.

**Why:** The current matcher works on simple-to-moderately-complex compositions. Don't do this until a real user hits a bug it can't handle.

**Context:** Look at `Bun.Transpiler` or oxc when the time comes. AST gives correct nested-brace handling, JSX expressions, conditional rendering.

**Effort:** L (human: ~1 week / CC: ~1.5h). **Priority:** P3.

## bin/analyze.ts

### P3 — Watch mode for re-analyzing on mp3 change

**What:** Add `--watch` flag that re-runs analysis whenever the audio file changes on disk.

**Why:** Users iterating on mp3 cuts (trimming intros, swapping mixes) currently re-run analyze by hand. With watch mode the sidecar stays fresh.

**Context:** Bun has `fs.watch` natively. Wire it around the existing main flow. Debounce ~200ms, print one-line "re-analyzed at HH:MM:SS" to stderr.

**Effort:** S (human: ~1h / CC: ~10 min). **Priority:** P3.

## Testing

### P1 — Bootstrap test suite (sync + override + scaffold)

**What:** Add unit tests covering: sync matchers against synthetic source strings (multi-line, frame=0, weak match, nested config) — ~12 tests; `override.ts` `parseTime`/`parseCorrection` — ~8 tests; `scaffold.ts` end-to-end against the click-140 fixture asserting key generated tokens exist — ~4 tests. Use Bun's native `bun:test` runner (no install cost). Add `bun test` to `package.json` scripts.

**Why:** Currently zero tests in the repo. Regressions in the regex matchers would ship invisibly. The eng review surfaced this as the highest-leverage gap — shipping new code with no CI gate is the biggest debt accumulator.

**Context:** Eng review finding 3A. Both reviewers flagged it. Recommended approach in the eng review walkthrough.

**Effort:** S (human: ~4h / CC: ~25 min). **Priority:** P1.

### P2 — Edge-case fixtures for scaffold

**What:** Add `fixtures/silence-3s.beats.json` (zero beats, single section) and `fixtures/single-beat.beats.json` (one beat at t=1, one section) plus assertions that scaffold produces a valid `.tsx` against each.

**Why:** All current fixtures are clean ~16s click tracks. Real users will feed in 0.5-second voice memos or audio with no detectable beats. The activeBeatIdx logic and pickTransition aren't tested at these boundaries.

**Context:** Eng review finding 3B. Bundle with the test suite from the P1 testing item above.

**Effort:** S (human: ~30 min / CC: ~10 min). **Priority:** P2.

## Distribution

### P2 — Drop preview HTML generator

**What:** New CLI that takes a `beats.json` and writes a self-contained `song.preview.html` with an SVG waveform, beat ticks color-coded by strength, drop labels.

**Why:** Today's override flow is the only correction path, but the user has to know where the mistakes are. Visual preview surfaces them at a glance.

**Context:** CEO review deferred this (proposal 6). audio-decode is already a dep. ~150 LOC inline CSS + SVG. Self-contained so the user can email it to collaborators.

**Effort:** M (human: ~4h / CC: ~20 min). **Priority:** P2.

### P3 — Video clip support in scaffold `--media`

**What:** Extend `--media` to handle `.mp4`/`.mov` files alongside images. Emit `<Video>` tags with section-aligned start offsets.

**Why:** Many users will have video clips, not stills.

**Context:** CEO review deferred this. `<Video>` has more knobs than `<Img>` (start/end time, mute, playback rate). Default carefully.

**Effort:** M (human: ~4h / CC: ~25 min). **Priority:** P3.

## Cross-platform

### P3 — Windows path-handling pass

**What:** Verify path computations in `scaffold.ts` work across drives on Windows. `node:path` is cross-platform but only Unix-tested today.

**Why:** A user on Windows scaffolding from `C:\projects\foo` against beats.json on `D:\assets\` gets an absolute path string in an `import` statement — broken comp.

**Context:** Adversarial review finding 9. Not a security issue, just broken output on Windows.

**Effort:** S. **Priority:** P3.

## Completed

(none yet — this branch ships the v0.3.0 features, those move here once merged)


## P2 — Watch mode for `bin/analyze.ts`

**What:** Add `--watch` flag that re-runs analysis whenever the audio file changes on disk.

**Why:** Users iterating on mp3 cuts (trimming intros, swapping mixes) currently have to re-run analyze by hand each time. With watch mode, `song.beats.json` stays fresh and any open Remotion preview picks it up immediately.

**Pros:** Cuts the iteration loop. Especially useful when paired with a Remotion preview server (`npx remotion preview`) since the comp reactively reflects the latest beats.

**Cons:** Adds a process-lifetime concern (watcher needs to be killed cleanly). Marginal — most users won't iterate fast enough to need this.

**Context:** Bun has `fs.watch` natively. Wire it around the existing main flow in `bin/analyze.ts`: on change, debounce ~200ms, then re-invoke the analyze pipeline and overwrite the sidecar. Print a one-line "re-analyzed at HH:MM:SS" to stderr.

**Effort:** S (human: ~1h / CC: ~10 min). **Priority:** P2. **Depends on:** nothing.

## P2 — Drop preview HTML generator (`bin/preview.ts`)

**What:** New CLI that takes a `beats.json` and writes a self-contained `song.preview.html`. The HTML renders an SVG waveform of the audio (sampled from the beats sidecar's section/energy data, or re-decoded from the audio), tick marks at each beat color-coded by strength, and labels at each drop. The user opens it in a browser and eyeballs whether the analyzer was right.

**Why:** Today the override flow is the only way to correct mistakes, but you have to know where the mistakes are. A visual preview surfaces them at a glance.

**Pros:** Real DX win. Replaces the "play the song and count seconds" workflow most users do today.

**Cons:** Needs to decode audio (audio-decode is already a dep) and emit SVG markup — meaningful but not large. Doesn't change correctness, just discoverability.

**Context:** Sample the mono waveform down to ~2000 points (one per ~5ms at typical durations) for the SVG path. Overlay vertical lines from the beats array. The HTML can be ~150 LOC including inline CSS. Self-contained so the user can email it to a collaborator.

**Effort:** M (human: ~4h / CC: ~20 min). **Priority:** P2. **Depends on:** nothing.

## P3 — Full AST-based sync matcher (replace regex)

**What:** Replace the regex matchers in `bin/sync.ts` with a real TypeScript parser (Bun's `Bun.Transpiler` or a hand-rolled tokenizer). Handle JSX expressions, conditional rendering, nested object literals inside `spring({ ... })`, and comments cleanly.

**Why:** The current multi-line regex hardening (Proposal 7) raises the ceiling, but it can still fail on edge cases like `spring({ config: { damping, stiffness: x ? 1 : 2 } })` where the nested ternary or extra braces confuse `[\s\S]*?`. A real parser is bulletproof.

**Pros:** Production-grade. Long tail of edge cases handled.

**Cons:** Larger surface area to maintain. Probably overkill until real users hit a real edge case the regex can't handle.

**Context:** The current matcher works on simple-to-moderately-complex compositions. Don't do this until a user reports a real bug. When you do, look at swc, oxc, or Bun's built-in TS parser — pick whichever is smallest to embed without adding heavy deps.

**Effort:** L (human: ~1 week / CC: ~1.5h). **Priority:** P3. **Depends on:** real user feedback.

## P3 — Video clip support in scaffold

**What:** Extend `bin/scaffold.ts` `--media` to handle `.mp4` / `.mov` files alongside images. Emit `<Video>` tags instead of `<Img>` with start offsets aligned to section boundaries.

**Why:** Many users will have video clips, not stills. The current --media flag silently filters those out.

**Pros:** Completes the "drop in your stuff" promise for video sources.

**Cons:** `<Video>` has more knobs than `<Img>` (start time, end time, mute, playback rate). Defaulting these well takes design care.

**Effort:** M (human: ~4h / CC: ~25 min). **Priority:** P3.
