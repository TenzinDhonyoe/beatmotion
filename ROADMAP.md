# Roadmap

What's planned next, in rough priority order. Open an issue if you'd find one of these useful — that's how things move up the list.

- **Validate `beats.json` input.** The scaffold currently trusts the sidecar; a malformed file produces a confusing error instead of a clean rejection.
- **Auto-wire `<Composition>` into `Root.tsx`.** Today the scaffold prints a paste-this snippet for the user's root file. Detect-and-inject would close the last manual step in the "drop mp3 → render" flow.
- **`--watch` mode for `analyze`.** Re-run on mp3 change so the sidecar stays fresh while you iterate on cuts.
- **Video clip support in `scaffold --media`.** Today `--media` accepts images; `.mp4` / `.mov` would emit `<Video>` tags with section-aligned start offsets.
- **Windows path handling pass.** `node:path` is cross-platform but only Unix-tested; cross-drive scaffolding on Windows likely needs work.

Longer-tail items (AST-based sync matcher, drop preview HTML generator, etc.) live in the repo's deferred-work notes and surface here once they're close to landing.
