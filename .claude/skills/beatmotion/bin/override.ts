#!/usr/bin/env bun
/**
 * beatmotion override — patch beats.json with a user correction.
 *
 * Usage:
 *   bun run bin/beatmotion-override.ts <beats.json> "<correction>"
 *
 * Supported corrections (v1, all case-insensitive):
 *   - "drop at 0:42"            → add a main_drop at 42 seconds
 *   - "drop at 42"              → add a main_drop at 42 seconds
 *   - "drop at 42.5"            → add a main_drop at 42.5 seconds
 *   - "secondary drop at 1:15"  → add a secondary_drop
 *   - "remove drop at 0:42"     → remove the nearest drop within 1s tolerance
 *   - "beat at 0:32.5"          → add a beat
 *   - "remove beat at 0:32.5"   → remove nearest beat within 0.25s tolerance
 *
 * Edits beats.json in place. Original drops/beats stay; overrides are
 * tracked in the `overrides` array so they can be re-applied if /analyze
 * is rerun (the analyzer should later merge them — out of scope for v1).
 *
 * Exit codes:
 *   0 — applied
 *   1 — could not parse the correction string
 *   2 — file I/O error
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type Beat = { time: number; frame: number; strength: number };
type Drop = { time: number; frame: number; kind: string };
type Override = { kind: string; time: number; note?: string; action: "add" | "remove" };

type BeatsFile = {
  audio: string;
  duration: number;
  fps: number;
  bpm: number;
  beats: Beat[];
  drops: Drop[];
  sections: Array<{ start: number; end: number; kind: string }>;
  overrides: Override[];
  generatedAt?: string;
};

function parseTime(s: string): number | null {
  // "0:42", "0:42.5", "42", "42.5"
  const m = s.trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const min = m[1] ? Number(m[1]) : 0;
  const sec = Number(m[2]);
  return min * 60 + sec;
}

type ParsedCorrection =
  | { action: "add"; kind: "main_drop" | "secondary_drop" | "beat"; time: number }
  | { action: "remove"; kind: "drop" | "beat"; time: number };

function parseCorrection(input: string): ParsedCorrection | null {
  const s = input.trim().toLowerCase();

  let m = s.match(/^remove\s+drop\s+at\s+(\S+)$/);
  if (m) {
    const t = parseTime(m[1]);
    return t === null ? null : { action: "remove", kind: "drop", time: t };
  }

  m = s.match(/^remove\s+beat\s+at\s+(\S+)$/);
  if (m) {
    const t = parseTime(m[1]);
    return t === null ? null : { action: "remove", kind: "beat", time: t };
  }

  m = s.match(/^(?:main\s+)?drop\s+at\s+(\S+)$/);
  if (m) {
    const t = parseTime(m[1]);
    return t === null ? null : { action: "add", kind: "main_drop", time: t };
  }

  m = s.match(/^secondary\s+drop\s+at\s+(\S+)$/);
  if (m) {
    const t = parseTime(m[1]);
    return t === null ? null : { action: "add", kind: "secondary_drop", time: t };
  }

  m = s.match(/^beat\s+at\s+(\S+)$/);
  if (m) {
    const t = parseTime(m[1]);
    return t === null ? null : { action: "add", kind: "beat", time: t };
  }

  return null;
}

function applyCorrection(beats: BeatsFile, c: ParsedCorrection): string {
  const fps = beats.fps;
  const frame = Math.round(c.time * fps);

  if (c.action === "add" && (c.kind === "main_drop" || c.kind === "secondary_drop")) {
    // Replace existing main_drop if user adds a new main_drop.
    if (c.kind === "main_drop") {
      beats.drops = beats.drops.map((d) =>
        d.kind === "main_drop" ? { ...d, kind: "secondary_drop" } : d
      );
    }
    beats.drops.push({ time: c.time, frame, kind: c.kind });
    beats.drops.sort((a, b) => a.time - b.time);
    beats.overrides.push({
      kind: c.kind,
      time: c.time,
      action: "add",
      note: "user-added",
    });
    return `added ${c.kind} at ${c.time}s (frame ${frame})`;
  }

  if (c.action === "add" && c.kind === "beat") {
    beats.beats.push({ time: c.time, frame, strength: 1 });
    beats.beats.sort((a, b) => a.time - b.time);
    beats.overrides.push({
      kind: "beat",
      time: c.time,
      action: "add",
      note: "user-added",
    });
    return `added beat at ${c.time}s (frame ${frame})`;
  }

  if (c.action === "remove" && c.kind === "drop") {
    const TOLERANCE = 1.0;
    const idx = beats.drops.reduce<{ i: number; d: number } | null>((acc, dr, i) => {
      const d = Math.abs(dr.time - c.time);
      if (d > TOLERANCE) return acc;
      if (!acc || d < acc.d) return { i, d };
      return acc;
    }, null);
    if (!idx) return `no drop within ${TOLERANCE}s of ${c.time}s — nothing removed`;
    const removed = beats.drops.splice(idx.i, 1)[0];
    beats.overrides.push({
      kind: removed.kind,
      time: removed.time,
      action: "remove",
      note: "user-removed",
    });
    return `removed ${removed.kind} at ${removed.time}s (frame ${removed.frame})`;
  }

  if (c.action === "remove" && c.kind === "beat") {
    const TOLERANCE = 0.25;
    const idx = beats.beats.reduce<{ i: number; d: number } | null>((acc, b, i) => {
      const d = Math.abs(b.time - c.time);
      if (d > TOLERANCE) return acc;
      if (!acc || d < acc.d) return { i, d };
      return acc;
    }, null);
    if (!idx) return `no beat within ${TOLERANCE}s of ${c.time}s — nothing removed`;
    const removed = beats.beats.splice(idx.i, 1)[0];
    beats.overrides.push({
      kind: "beat",
      time: removed.time,
      action: "remove",
      note: "user-removed",
    });
    return `removed beat at ${removed.time}s (frame ${removed.frame})`;
  }

  return "noop";
}

async function main() {
  const [, , beatsPathArg, correctionArg] = process.argv;
  if (!beatsPathArg || !correctionArg) {
    console.error('Usage: beatmotion-override <beats.json> "<correction>"');
    console.error('Examples: "drop at 0:42", "remove drop at 0:42", "beat at 1:15.5"');
    process.exit(1);
  }
  const beatsPath = resolve(beatsPathArg);

  const correction = parseCorrection(correctionArg);
  if (!correction) {
    console.error(`could not parse correction: "${correctionArg}"`);
    console.error('try: "drop at 0:42", "secondary drop at 1:15", "remove beat at 0:32.5"');
    process.exit(1);
  }

  let beats: BeatsFile;
  try {
    beats = JSON.parse(await readFile(beatsPath, "utf-8")) as BeatsFile;
  } catch (err) {
    console.error(`could not read ${beatsPath}: ${(err as Error).message}`);
    process.exit(2);
  }
  beats.overrides ??= [];

  const result = applyCorrection(beats, correction);
  await writeFile(beatsPath, JSON.stringify(beats, null, 2));
  console.error(result);
  console.log(JSON.stringify({ ok: true, result, file: beatsPath }));
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
