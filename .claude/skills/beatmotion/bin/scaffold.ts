#!/usr/bin/env bun
/**
 * beatmotion scaffold — generate a starter Remotion Composition.tsx from a
 * beats.json sidecar. Closes the gap for users who have an mp3 but no
 * composition yet: instead of "no animations to sync," they get a render-ready
 * starter comp with beat-synced cuts, drop emphasis, and a transition library
 * already wired up.
 *
 * Usage:
 *   bun run bin/scaffold.ts <beats.json> [--tsx <out>] [--audio <path>] [--media <dir>] [--comp <name>] [--force]
 *
 * What it writes (next to <out>):
 *   - Composition.tsx (or whatever --tsx points at)
 *   - useBeats.ts (copied from templates/, if missing at the destination)
 *   - transitions.ts (copied from templates/, if missing at the destination)
 *
 * Outputs the destination path on stdout. Logs to stderr.
 */
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";

// Refuses to write to a path that resolves outside the current working
// directory. The scaffold is a developer tool — it should never write to
// /etc/, the user's home dotfiles, or anywhere else they didn't ask for.
function assertInsideCwd(absPath: string, what: string): void {
  const cwd = process.cwd();
  const parent = dirname(absPath);
  if (parent !== cwd && !parent.startsWith(cwd + sep)) {
    console.error(`error: ${what} must be inside the current working directory (${cwd}); got ${absPath}`);
    process.exit(1);
  }
}

// Refuses to overwrite or copy onto a symlink. This blocks a symlink TOCTOU
// where existsSync() sees a regular file but writeFile/copyFile follows a
// pre-planted symlink to write outside the scaffolded directory.
function assertNotSymlink(path: string, what: string): void {
  if (!existsSync(path)) return;
  if (lstatSync(path).isSymbolicLink()) {
    console.error(`error: ${what} at ${path} is a symlink — refusing to overwrite. Remove or resolve it first.`);
    process.exit(1);
  }
}

type Args = {
  beatsJson: string;
  tsxOut: string | null;
  audio: string | null;
  mediaDir: string | null;
  compName: string;
  force: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    beatsJson: "",
    tsxOut: null,
    audio: null,
    mediaDir: null,
    compName: "BeatComp",
    force: false,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--tsx") args.tsxOut = rest[++i];
    else if (a === "--audio") args.audio = rest[++i];
    else if (a === "--media") args.mediaDir = rest[++i];
    else if (a === "--comp") args.compName = rest[++i];
    else if (a === "--force") args.force = true;
    else if (a === "-h" || a === "--help") {
      console.log(
        "Usage: beatmotion-scaffold <beats.json> [--tsx <out>] [--audio <path>] [--media <dir>] [--comp <name>] [--force]"
      );
      process.exit(0);
    } else if (!args.beatsJson) args.beatsJson = a;
  }
  if (!args.beatsJson) {
    console.error("error: beats.json path required");
    process.exit(1);
  }
  return args;
}

function defaultTsxOut(): string {
  return existsSync("src") ? "src/Composition.tsx" : "Composition.tsx";
}

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);

function listImages(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => IMAGE_EXTS.has(extname(name).toLowerCase()))
    .map((name) => resolve(dir, name))
    .sort();
}

function jsIdent(name: string, fallback: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^[0-9]/, "_$&");
  return cleaned || fallback;
}

async function main() {
  const args = parseArgs(process.argv);
  const beatsPath = resolve(args.beatsJson);
  if (!existsSync(beatsPath)) {
    console.error(`error: beats.json not found at ${beatsPath}`);
    process.exit(1);
  }

  const beats = JSON.parse(await readFile(beatsPath, "utf-8")) as {
    audio: string;
    duration: number;
    fps: number;
  };

  const tsxOut = resolve(args.tsxOut ?? defaultTsxOut());
  assertInsideCwd(tsxOut, "--tsx output path");
  if (existsSync(tsxOut) && !args.force) {
    console.error(
      `error: ${tsxOut} already exists. Pass --force to overwrite, or --tsx <other-path>.`
    );
    process.exit(1);
  }
  assertNotSymlink(tsxOut, "output .tsx");
  const outDir = dirname(tsxOut);
  await mkdir(outDir, { recursive: true });

  // Resolve audio filename for the staticFile() call. Default to whatever's in
  // beats.audio; user can override with --audio.
  const audioBasename = basename(args.audio ?? beats.audio);

  // Compute relative path from output .tsx to the beats.json sidecar. Paths
  // already starting with `..` don't need the `./` prefix.
  const rel = relative(outDir, beatsPath) || basename(beatsPath);
  const beatsImport = rel.startsWith(".") ? rel : "./" + rel;

  // Collect media (images only for v1 — Video would need different handling).
  const mediaFiles = args.mediaDir ? listImages(resolve(args.mediaDir)) : [];
  const hasMedia = mediaFiles.length > 0;
  console.error(
    hasMedia
      ? `found ${mediaFiles.length} image(s) in ${args.mediaDir}`
      : args.mediaDir
      ? `no images found in ${args.mediaDir} — falling back to text labels`
      : "no --media dir — using text labels"
  );

  // Locate the skill's template files (next to this script).
  const skillDir = dirname(import.meta.dir);
  const templatePath = resolve(skillDir, "templates/Composition.scaffold.tsx.tmpl");
  const useBeatsSrc = resolve(skillDir, "templates/useBeats.ts");
  const transitionsSrc = resolve(skillDir, "templates/transitions.ts");

  let template = await readFile(templatePath, "utf-8");

  // Build the import block and render block based on media presence.
  let mediaImportExtra = "";
  let mediaFilesImport = "";
  let mediaRenderBlock = "";

  if (hasMedia) {
    mediaImportExtra = "\n  Img,";
    const lines = mediaFiles.map((abs, i) => {
      const raw = relative(outDir, abs);
      const rel = raw.startsWith(".") ? raw : "./" + raw;
      const ident = jsIdent(`media_${i}_${basename(abs, extname(abs))}`, `media_${i}`);
      return `import ${ident} from ${JSON.stringify(rel)};`;
    });
    const idents = mediaFiles.map((abs, i) =>
      jsIdent(`media_${i}_${basename(abs, extname(abs))}`, `media_${i}`)
    );
    mediaFilesImport = lines.join("\n") + `\nconst mediaFiles = [${idents.join(", ")}];`;
    // Nested AbsoluteFills: outer = slide (translate), inner = drop
    // (scale + filter). Keeps transforms from colliding under spread.
    mediaRenderBlock = `return (
    <AbsoluteFill style={{ ...slideStyle }}>
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          overflow: "visible",
          ...dropStyle,
        }}
      >
        <div style={{ ...fadeStyle, overflow: "visible" }}>
          <Img
            src={mediaFiles[Math.max(0, activeBeatIdx) % mediaFiles.length]}
            style={{ maxWidth: "85%", maxHeight: "85%", objectFit: "contain" }}
          />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );`;
  } else {
    mediaImportExtra = "";
    mediaFilesImport = "";
    mediaRenderBlock = `return (
    <AbsoluteFill style={{ ...slideStyle }}>
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          overflow: "visible",
          ...dropStyle,
        }}
      >
        <div
          style={{
            fontSize: 96,
            fontWeight: 700,
            letterSpacing: -3,
            ...fadeStyle,
          }}
        >
          {section.kind.toUpperCase()}
        </div>
        <div
          style={{
            marginTop: 24,
            fontSize: 28,
            opacity: 0.6,
          }}
        >
          beat {Math.max(0, activeBeatIdx) + 1} / {beatsInSection.length}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );`;
  }

  // Substitute placeholders in a single pass. Doing chained .replace() calls
  // would let a substitution value containing a placeholder-shaped string
  // (e.g., a beats.json named __AUDIO_SRC__.json) be re-matched by a later
  // replacement, smuggling content into the wrong slot. One pass keyed by
  // identity avoids that entire class of bug.
  const subs: Record<string, string> = {
    "__BEATS_IMPORT__": beatsImport,
    "__AUDIO_SRC__": `/${audioBasename}`,
    "__COMP_NAME__": args.compName,
    "__MEDIA_IMPORT_EXTRA__": mediaImportExtra,
    "__MEDIA_FILES_IMPORT__": mediaFilesImport,
    "__MEDIA_RENDER_BLOCK__": mediaRenderBlock,
  };
  template = template.replace(/__[A-Z_]+__/g, (m) => (m in subs ? subs[m] : m));

  // Tidy: collapse any 3+ consecutive blank lines (from empty placeholders)
  // down to a single blank line. Format-agnostic — survives template edits.
  template = template.replace(/\n{3,}/g, "\n\n");

  await writeFile(tsxOut, template);
  console.error(`wrote ${tsxOut}`);

  // Copy useBeats.ts and transitions.ts next to the output if missing.
  // Symlink check on each destination so a pre-planted symlink can't redirect
  // the copy to a path outside the scaffolded directory.
  const useBeatsDest = resolve(outDir, "useBeats.ts");
  const transitionsDest = resolve(outDir, "transitions.ts");
  assertNotSymlink(useBeatsDest, "useBeats.ts destination");
  assertNotSymlink(transitionsDest, "transitions.ts destination");
  if (!existsSync(useBeatsDest)) {
    await copyFile(useBeatsSrc, useBeatsDest);
    console.error(`copied useBeats.ts → ${useBeatsDest}`);
  } else {
    console.error(`useBeats.ts already exists at ${useBeatsDest} — leaving as is`);
  }
  if (!existsSync(transitionsDest)) {
    await copyFile(transitionsSrc, transitionsDest);
    console.error(`copied transitions.ts → ${transitionsDest}`);
  } else {
    console.error(`transitions.ts already exists at ${transitionsDest} — leaving as is`);
  }

  // Helpful pointers.
  console.error("");
  console.error(`Next steps:`);
  console.error(`  1. Place "${audioBasename}" in your Remotion project's public/ folder.`);
  if (hasMedia) {
    console.error(`  2. Media images are imported relative to ${outDir}.`);
  } else {
    console.error(`  2. (Optional) Re-run with --media <dir> to bind real images.`);
  }
  console.error(`  3. Register the composition in your root file (e.g., src/Root.tsx):`);
  console.error(`        <Composition id="${args.compName}" component={${args.compName}}`);
  console.error(`          durationInFrames={${Math.ceil(beats.duration * beats.fps)}}`);
  console.error(`          fps={${beats.fps}} width={1920} height={1080} />`);
  console.error(`  4. Render: npx remotion render ${args.compName}`);

  console.log(tsxOut);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
