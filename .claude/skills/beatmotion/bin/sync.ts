#!/usr/bin/env bun
/**
 * beatmotion sync — find Remotion animations in a .tsx file and propose
 * beat-aligned replacements. Outputs JSON for the calling skill to consume.
 *
 * Usage: bun run bin/beatmotion-sync.ts <composition.tsx> <beats.json>
 *
 * Output (stdout, JSON):
 *   {
 *     source: ".../Composition.tsx",
 *     beatsImport: "./song.beats.json",   // relative path to suggest importing
 *     hasBeatsImport: false,
 *     animations: [
 *       {
 *         id: "anim-0",
 *         kind: "interpolate" | "spring" | "Sequence",
 *         line: 42,
 *         column: 13,
 *         original: "interpolate(frame, [0, 30], ...)",
 *         proposed: "interpolate(frame, [0, beats[2].frame], ...)",
 *         rationale: "Aligns end frame 30 to beat 2 (frame 30, 1.001s)."
 *       }
 *     ]
 *   }
 */
import { readFile } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";

type Beat = { time: number; frame: number; strength: number };
type Drop = { time: number; frame: number; kind: string };

type BeatsFile = {
  audio: string;
  duration: number;
  fps: number;
  bpm: number;
  beats: Beat[];
  drops: Drop[];
};

type Animation = {
  id: string;
  kind: "interpolate" | "spring" | "Sequence";
  line: number;
  column: number;
  original: string;
  proposed: string;
  rationale: string;
};

function nearestBeatIndex(targetFrame: number, beats: Beat[]): number {
  if (beats.length === 0) return -1;
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < beats.length; i++) {
    const d = Math.abs(beats[i].frame - targetFrame);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function lineCol(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset; i++) {
    if (source[i] === "\n") {
      line++;
      col = 1;
    } else col++;
  }
  return { line, column: col };
}

function findInterpolate(source: string, beats: BeatsFile): Animation[] {
  // Match: interpolate(frame, [<start>, <end>], ...)
  // start and end must be number literals for v1 — we don't touch already-symbolic ranges.
  const re = /interpolate\s*\(\s*frame\s*,\s*\[\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\]/g;
  const out: Animation[] = [];
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = re.exec(source)) !== null) {
    const startFrame = Number(m[1]);
    const endFrame = Number(m[2]);
    const targetIdx = nearestBeatIndex(endFrame, beats.beats);
    if (targetIdx < 0) continue;
    const targetBeat = beats.beats[targetIdx];
    if (targetBeat.frame === endFrame) continue;
    const { line, column } = lineCol(source, m.index);
    const original = m[0];
    const proposed = `interpolate(frame, [${startFrame}, beats[${targetIdx}].frame]`;
    out.push({
      id: `interp-${idx++}`,
      kind: "interpolate",
      line,
      column,
      original,
      proposed,
      rationale: `Aligns end frame ${endFrame} to beat ${targetIdx} (frame ${targetBeat.frame}, ${targetBeat.time.toFixed(3)}s).`,
    });
  }
  return out;
}

function findSpring(source: string, beats: BeatsFile): Animation[] {
  // Match: spring({ ..., frame: <something> ... }) where there's a `delayInFrames` or similar.
  // For v1, we only target literal `delayInFrames: <number>` inside a spring(...) call.
  const re = /spring\s*\(\s*\{[^}]*delayInFrames\s*:\s*(\d+(?:\.\d+)?)[^}]*\}/g;
  const out: Animation[] = [];
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = re.exec(source)) !== null) {
    const delay = Number(m[1]);
    const targetIdx = nearestBeatIndex(delay, beats.beats);
    if (targetIdx < 0) continue;
    const targetBeat = beats.beats[targetIdx];
    if (targetBeat.frame === delay) continue;
    const { line, column } = lineCol(source, m.index);
    const original = m[0];
    const proposed = original.replace(
      /delayInFrames\s*:\s*\d+(?:\.\d+)?/,
      `delayInFrames: beats[${targetIdx}].frame`
    );
    out.push({
      id: `spring-${idx++}`,
      kind: "spring",
      line,
      column,
      original,
      proposed,
      rationale: `Aligns spring delay frame ${delay} to beat ${targetIdx} (frame ${targetBeat.frame}, ${targetBeat.time.toFixed(3)}s).`,
    });
  }
  return out;
}

function findSequence(source: string, beats: BeatsFile): Animation[] {
  // Match: <Sequence ... from={<number>} ...>
  const re = /<Sequence\b([^>]*?)from=\{(\d+(?:\.\d+)?)\}([^>]*)>/g;
  const out: Animation[] = [];
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = re.exec(source)) !== null) {
    const from = Number(m[2]);
    // Prefer aligning to a drop if one is near; otherwise nearest beat.
    let proposedExpr = "";
    let rationale = "";
    const nearestDrop = beats.drops.reduce<{ idx: number; dist: number } | null>(
      (acc, d, i) => {
        const dist = Math.abs(d.frame - from);
        if (!acc || dist < acc.dist) return { idx: i, dist };
        return acc;
      },
      null
    );
    if (nearestDrop && nearestDrop.dist < 60) {
      const drop = beats.drops[nearestDrop.idx];
      proposedExpr = `drops[${nearestDrop.idx}].frame`;
      rationale = `Aligns Sequence start ${from} to ${drop.kind} at frame ${drop.frame} (${drop.time.toFixed(2)}s).`;
    } else {
      const targetIdx = nearestBeatIndex(from, beats.beats);
      if (targetIdx < 0) continue;
      const beat = beats.beats[targetIdx];
      if (beat.frame === from) continue;
      proposedExpr = `beats[${targetIdx}].frame`;
      rationale = `Aligns Sequence start ${from} to beat ${targetIdx} (frame ${beat.frame}, ${beat.time.toFixed(3)}s).`;
    }
    const { line, column } = lineCol(source, m.index);
    const original = m[0];
    const proposed = original.replace(/from=\{\d+(?:\.\d+)?\}/, `from={${proposedExpr}}`);
    out.push({
      id: `seq-${idx++}`,
      kind: "Sequence",
      line,
      column,
      original,
      proposed,
      rationale,
    });
  }
  return out;
}

function detectBeatsImport(source: string, beatsRelative: string): boolean {
  const stem = beatsRelative.replace(/^\.\//, "").replace(/\.json$/, "");
  const re = new RegExp(`import\\s+(\\w+)\\s+from\\s+["']\\./?${stem}\\.json["']`);
  return re.test(source);
}

async function main() {
  const [, , tsxPathArg, beatsPathArg] = process.argv;
  if (!tsxPathArg || !beatsPathArg) {
    console.error("Usage: beatmotion-sync <composition.tsx> <beats.json>");
    process.exit(1);
  }
  const tsxPath = resolve(tsxPathArg);
  const beatsPath = resolve(beatsPathArg);

  const [tsx, beatsRaw] = await Promise.all([
    readFile(tsxPath, "utf-8"),
    readFile(beatsPath, "utf-8"),
  ]);
  const beats = JSON.parse(beatsRaw) as BeatsFile;

  const animations = [
    ...findInterpolate(tsx, beats),
    ...findSpring(tsx, beats),
    ...findSequence(tsx, beats),
  ].sort((a, b) => a.line - b.line || a.column - b.column);

  const beatsImport = "./" + relative(dirname(tsxPath), beatsPath).replace(/\\/g, "/");
  const hasBeatsImport = detectBeatsImport(tsx, beatsImport);

  const out = {
    source: tsxPath,
    beatsFile: beatsPath,
    beatsImport,
    hasBeatsImport,
    summary: {
      total: animations.length,
      byKind: animations.reduce<Record<string, number>>((acc, a) => {
        acc[a.kind] = (acc[a.kind] ?? 0) + 1;
        return acc;
      }, {}),
    },
    animations,
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
