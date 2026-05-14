import { describe, expect, test } from "bun:test";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FIXTURES, runBin, withTmpDir } from "./helpers.ts";

describe("scaffold phrase-aware output", () => {
  test("uses phrase boundaries when sidecar is grid-locked", async () => {
    await withTmpDir(async (dir) => {
      // Build a tiny grid-locked sidecar by hand. The scaffold template
      // branches on `helpers.gridLocked && helpers.phrases.length > 0` — we
      // can verify both branches without needing a real audio analysis pass.
      const sidecar = {
        audio: "test.wav",
        duration: 8,
        sampleRate: 44100,
        fps: 30,
        bpm: 120,
        bpmConfidence: 0.9,
        bpmCurve: [],
        gridLocked: true,
        gridPhaseFrames: 0,
        phrases: [
          { startBeat: 0, endBeat: 7, startFrame: 0, endFrame: 120 },
          { startBeat: 8, endBeat: 15, startFrame: 120, endFrame: 240 },
        ],
        beats: [
          { time: 0, frame: 0, strength: 0.9, kind: "kick", barPos: 1, phrasePos: 0, downbeat: true },
          { time: 0.5, frame: 15, strength: 0.6, kind: "snare", barPos: 2, phrasePos: 1 },
          { time: 1.0, frame: 30, strength: 0.8, kind: "kick", barPos: 3, phrasePos: 2 },
          { time: 1.5, frame: 45, strength: 0.6, kind: "snare", barPos: 4, phrasePos: 3 },
        ],
        drops: [],
        sections: [{ start: 0, end: 8, kind: "main" }],
        overrides: [],
        analyzer: { version: "0.4.0-banded-structured" },
        generatedAt: new Date().toISOString(),
      };
      const beatsPath = join(dir, "song.beats.json");
      await writeFile(beatsPath, JSON.stringify(sidecar));

      const result = await runBin(
        "scaffold.ts",
        ["song.beats.json", "--tsx", "src/Composition.tsx", "--comp", "T"],
        { cwd: dir }
      );
      expect(result.exitCode).toBe(0);

      const tsx = await readFile(join(dir, "src/Composition.tsx"), "utf8");
      // Both branches of SEQUENCE_BOUNDARIES are present, but the runtime
      // condition `helpers.gridLocked && helpers.phrases.length > 0` should
      // select the phrase branch — and the scaffold's template emits both
      // code paths so the comp works whether the sidecar is grid-locked or
      // not. We can at least confirm the phrase code path is present.
      expect(tsx).toContain("SEQUENCE_BOUNDARIES");
      expect(tsx).toContain("helpers.gridLocked");
      expect(tsx).toContain("helpers.phrases.map");
      // Falls back to sections too — preserves legacy behavior.
      expect(tsx).toContain("helpers.sections.map");
    });
  });

  test("falls back to sections when sidecar is not grid-locked", async () => {
    await withTmpDir(async (dir) => {
      // Re-use the silence-3s fixture which has no grid lock.
      await copyFile(join(FIXTURES, "silence-3s.beats.json"), join(dir, "song.beats.json"));
      const result = await runBin(
        "scaffold.ts",
        ["song.beats.json", "--tsx", "src/Composition.tsx", "--comp", "T"],
        { cwd: dir }
      );
      expect(result.exitCode).toBe(0);
      const tsx = await readFile(join(dir, "src/Composition.tsx"), "utf8");
      // The template always emits both branches; runtime picks. We just
      // confirm the section fallback code is in the output.
      expect(tsx).toContain("helpers.sections.map");
    });
  });

  test("transitions library exports new kind-aware helpers", async () => {
    await withTmpDir(async (dir) => {
      await copyFile(
        join(FIXTURES, "click-140bpm-48k.beats.json"),
        join(dir, "song.beats.json")
      );
      const result = await runBin(
        "scaffold.ts",
        ["song.beats.json", "--tsx", "src/Composition.tsx", "--comp", "T"],
        { cwd: dir }
      );
      expect(result.exitCode).toBe(0);
      const transitions = await readFile(join(dir, "src/transitions.ts"), "utf8");
      expect(transitions).toContain("kickPunch");
      expect(transitions).toContain("snareFlash");
      expect(transitions).toContain("hatNudge");
      expect(transitions).toContain("dropClimax");
      expect(transitions).toContain("pickTransitionPlan");
      // Legacy pickTransition still exported for older comps.
      expect(transitions).toContain("export function pickTransition");
    });
  });
});
