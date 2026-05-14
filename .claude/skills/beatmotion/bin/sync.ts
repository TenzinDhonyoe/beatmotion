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

type Beat = {
  time: number;
  frame: number;
  strength: number;
  // Optional musical-structure fields. Populated by Phase 2+ analyzer; ignored
  // gracefully when absent (matcher treats undefined → 0/false → no bonus).
  kind?: "kick" | "snare" | "hat" | "other";
  barPos?: 1 | 2 | 3 | 4;
  phrasePos?: number;
  downbeat?: boolean;
  synthetic?: boolean;
  manualOverride?: boolean;
};
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
  weakMatch: boolean;
  deltaSec: number;
};

// Anything farther than this from the original frame is a weak alignment —
// we still surface it but flag it so the caller can warn the user instead
// of presenting a misleading "aligned to beat" rationale.
export const WEAK_MATCH_THRESHOLD_SEC = 0.5;

/**
 * Pure-distance nearest-beat lookup. Preserved for back-compat with the public
 * API + existing tests. Internal matching uses `bestBeatForFrame` instead.
 */
export function nearestBeatIndex(targetFrame: number, beats: Beat[]): number {
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

export type MatchOpts = {
  downbeatBonus?: number;
  barOneBonus?: number;
  phraseBonus?: number;
  kickBoost?: number;
  manualOverrideBonus?: number;
  distancePenalty?: number;
};

export type MatchResult = {
  idx: number;
  deltaFrames: number;
  score: number;
  reasonTags: string[];
};

const DEFAULT_MATCH_OPTS: Required<MatchOpts> = {
  downbeatBonus: 1.5,
  barOneBonus: 0.5,
  phraseBonus: 0.8,
  kickBoost: 0.3,
  manualOverrideBonus: 2.0,
  distancePenalty: 0.1,
};

/**
 * Musically-aware beat picker. Scores each beat by:
 *
 *   (strength + 0.1)
 *   × (1 + downbeatBonus·isDownbeat + barOneBonus·(barPos===1)
 *        + phraseBonus·(phrasePos===0) + kickBoost·(kind==="kick")
 *        + manualOverrideBonus·isManualOverride)
 *   / (1 + distancePenalty × |targetFrame - b.frame|)
 *
 * The `+0.1` baseline keeps synthetic grid beats (strength 0, from Phase 3
 * tempo-locking) competitive. Bonuses default to 0 when the corresponding
 * field is absent — so the matcher degrades to a strength-weighted nearest
 * picker on legacy sidecars and gets progressively smarter as Phase 2/3
 * analyzer output lands.
 *
 * Picks the highest-scoring beat in the array. Returns idx, signed delta,
 * score, and a short list of reasonTags (e.g. ["downbeat", "kick"]) the
 * caller can splice into a rationale.
 */
export function bestBeatForFrame(
  targetFrame: number,
  beats: Beat[],
  opts: MatchOpts = {}
): MatchResult {
  if (beats.length === 0) return { idx: -1, deltaFrames: 0, score: 0, reasonTags: [] };
  const o = { ...DEFAULT_MATCH_OPTS, ...opts };

  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    const delta = Math.abs(b.frame - targetFrame);
    let bonusMul = 1;
    if (b.downbeat) bonusMul += o.downbeatBonus;
    if (b.barPos === 1) bonusMul += o.barOneBonus;
    if (b.phrasePos === 0) bonusMul += o.phraseBonus;
    if (b.kind === "kick") bonusMul += o.kickBoost;
    if (b.manualOverride) bonusMul += o.manualOverrideBonus;
    const score = ((b.strength ?? 0) + 0.1) * bonusMul / (1 + o.distancePenalty * delta);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  const chosen = beats[bestIdx];
  const reasonTags: string[] = [];
  if (chosen.downbeat) reasonTags.push("downbeat");
  if (chosen.barPos === 1) reasonTags.push("bar 1");
  if (chosen.phrasePos === 0) reasonTags.push("phrase start");
  if (chosen.kind && chosen.kind !== "other") reasonTags.push(chosen.kind);
  if (chosen.manualOverride) reasonTags.push("manual override");

  return {
    idx: bestIdx,
    deltaFrames: chosen.frame - targetFrame,
    score: bestScore,
    reasonTags,
  };
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

export function findInterpolate(source: string, beats: BeatsFile): Animation[] {
  // Match the full interpolate(...) call up to its closing paren so the
  // `original` string carries enough context to be unique when the file has
  // multiple animations sharing the same input range. The tail uses [\s\S]
  // with a non-greedy quantifier so multi-line argument lists still match.
  const re = /interpolate\s*\(\s*frame\s*,\s*\[\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\]([\s\S]*?)\)/g;
  const out: Animation[] = [];
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = re.exec(source)) !== null) {
    const startFrame = Number(m[1]);
    const endFrame = Number(m[2]);
    const tail = m[3];
    // Frame 0 is "video start" — never retarget it. Only the end frame is
    // a candidate for beat alignment.
    if (endFrame === 0) continue;
    const match = bestBeatForFrame(endFrame, beats.beats);
    if (match.idx < 0) continue;
    const targetIdx = match.idx;
    const targetBeat = beats.beats[targetIdx];
    if (targetBeat.frame === endFrame) continue;
    const deltaSec = Math.abs(targetBeat.frame - endFrame) / beats.fps;
    const weakMatch = deltaSec > WEAK_MATCH_THRESHOLD_SEC;
    const { line, column } = lineCol(source, m.index);
    const original = m[0];
    const proposed = `interpolate(frame, [${startFrame}, beats[${targetIdx}].frame]${tail})`;
    const tagSuffix = match.reasonTags.length ? ` [${match.reasonTags.join(", ")}]` : "";
    const rationale = weakMatch
      ? `WEAK MATCH (${deltaSec.toFixed(2)}s off): end frame ${endFrame} → beat ${targetIdx} at frame ${targetBeat.frame} (${targetBeat.time.toFixed(3)}s)${tagSuffix}. Consider keeping as-is or running override to add a beat near ${(endFrame / beats.fps).toFixed(2)}s.`
      : `Aligns end frame ${endFrame} to beat ${targetIdx} (frame ${targetBeat.frame}, ${targetBeat.time.toFixed(3)}s, ${deltaSec.toFixed(3)}s delta)${tagSuffix}.`;
    out.push({
      id: `interp-${idx++}`,
      kind: "interpolate",
      line,
      column,
      original,
      proposed,
      rationale,
      weakMatch,
      deltaSec,
    });
  }
  return out;
}

export function findSpring(source: string, beats: BeatsFile): Animation[] {
  // Match: spring({ ..., delayInFrames: <number>, ... }). The body uses
  // [\s\S]*? so multi-line config objects still match. The non-greedy form
  // stops at the first `}` after `delayInFrames`, which is the right boundary
  // unless the body itself contains a nested object literal — for now that
  // edge case falls through and the caller can hand-edit.
  const re = /spring\s*\(\s*\{[\s\S]*?delayInFrames\s*:\s*(\d+(?:\.\d+)?)[\s\S]*?\}/g;
  const out: Animation[] = [];
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = re.exec(source)) !== null) {
    const delay = Number(m[1]);
    // delayInFrames: 0 means "no delay" — don't retarget it to a non-zero beat.
    if (delay === 0) continue;
    const match = bestBeatForFrame(delay, beats.beats);
    if (match.idx < 0) continue;
    const targetIdx = match.idx;
    const targetBeat = beats.beats[targetIdx];
    if (targetBeat.frame === delay) continue;
    const deltaSec = Math.abs(targetBeat.frame - delay) / beats.fps;
    const weakMatch = deltaSec > WEAK_MATCH_THRESHOLD_SEC;
    const { line, column } = lineCol(source, m.index);
    const original = m[0];
    const proposed = original.replace(
      /delayInFrames\s*:\s*\d+(?:\.\d+)?/,
      `delayInFrames: beats[${targetIdx}].frame`
    );
    const tagSuffix = match.reasonTags.length ? ` [${match.reasonTags.join(", ")}]` : "";
    const rationale = weakMatch
      ? `WEAK MATCH (${deltaSec.toFixed(2)}s off): spring delay ${delay} → beat ${targetIdx} at frame ${targetBeat.frame}${tagSuffix}. Consider keeping as-is.`
      : `Aligns spring delay frame ${delay} to beat ${targetIdx} (frame ${targetBeat.frame}, ${targetBeat.time.toFixed(3)}s, ${deltaSec.toFixed(3)}s delta)${tagSuffix}.`;
    out.push({
      id: `spring-${idx++}`,
      kind: "spring",
      line,
      column,
      original,
      proposed,
      rationale,
      weakMatch,
      deltaSec,
    });
  }
  return out;
}

export function findSequence(source: string, beats: BeatsFile): Animation[] {
  // Match: <Sequence ... from={<number>} ...> — including attributes split
  // across lines. [\s\S]*? lets the attribute list span newlines, while the
  // closing `>` (not `/>`) anchors the match to opening tags.
  const re = /<Sequence\b([\s\S]*?)from=\{(\d+(?:\.\d+)?)\}([\s\S]*?)>/g;
  const out: Animation[] = [];
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = re.exec(source)) !== null) {
    const from = Number(m[2]);
    // <Sequence from={0}> means "start of video" — never retarget it.
    if (from === 0) continue;
    // Prefer aligning to a drop if one is near; otherwise musically-scored beat.
    let proposedExpr = "";
    let rationaleBody = "";
    let targetFrame = 0;
    let tagSuffix = "";
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
      targetFrame = drop.frame;
      rationaleBody = `Sequence start ${from} → ${drop.kind} at frame ${drop.frame} (${drop.time.toFixed(2)}s)`;
    } else {
      const match = bestBeatForFrame(from, beats.beats);
      if (match.idx < 0) continue;
      const targetIdx = match.idx;
      const beat = beats.beats[targetIdx];
      if (beat.frame === from) continue;
      proposedExpr = `beats[${targetIdx}].frame`;
      targetFrame = beat.frame;
      rationaleBody = `Sequence start ${from} → beat ${targetIdx} at frame ${beat.frame} (${beat.time.toFixed(3)}s)`;
      if (match.reasonTags.length) tagSuffix = ` [${match.reasonTags.join(", ")}]`;
    }
    const deltaSec = Math.abs(targetFrame - from) / beats.fps;
    const weakMatch = deltaSec > WEAK_MATCH_THRESHOLD_SEC;
    const { line, column } = lineCol(source, m.index);
    const original = m[0];
    const proposed = original.replace(/from=\{\d+(?:\.\d+)?\}/, `from={${proposedExpr}}`);
    const rationale = weakMatch
      ? `WEAK MATCH (${deltaSec.toFixed(2)}s off): ${rationaleBody}${tagSuffix}. Consider keeping as-is.`
      : `Aligns ${rationaleBody}, ${deltaSec.toFixed(3)}s delta${tagSuffix}.`;
    out.push({
      id: `seq-${idx++}`,
      kind: "Sequence",
      line,
      column,
      original,
      proposed,
      rationale,
      weakMatch,
      deltaSec,
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
      strongMatches: animations.filter((a) => !a.weakMatch).length,
      weakMatches: animations.filter((a) => a.weakMatch).length,
      byKind: animations.reduce<Record<string, number>>((acc, a) => {
        acc[a.kind] = (acc[a.kind] ?? 0) + 1;
        return acc;
      }, {}),
    },
    animations,
  };

  console.log(JSON.stringify(out, null, 2));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
