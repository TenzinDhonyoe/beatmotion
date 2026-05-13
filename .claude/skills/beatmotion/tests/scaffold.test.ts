import { describe, expect, test } from "bun:test";
import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { FIXTURES, runBin, withTmpDir } from "./helpers.ts";

async function scaffoldInto(beatsFile: string, dir: string) {
  await copyFile(join(FIXTURES, beatsFile), join(dir, "song.beats.json"));
  return runBin(
    "scaffold.ts",
    ["song.beats.json", "--tsx", "src/Composition.tsx", "--comp", "TestComp"],
    { cwd: dir }
  );
}

describe("scaffold against click-140bpm fixture", () => {
  test("produces a Composition.tsx with expected tokens", async () => {
    await withTmpDir(async (dir) => {
      const result = await scaffoldInto("click-140bpm-48k.beats.json", dir);
      expect(result.exitCode).toBe(0);

      const tsx = await readFile(join(dir, "src/Composition.tsx"), "utf8");
      expect(tsx).toContain("export const TestComp");
      expect(tsx).toContain("import beatsData");
      expect(tsx).toContain("<AbsoluteFill");
      expect(tsx).toContain("<Audio src=");
      expect(tsx).toContain("<Sequence");
    });
  });

  test("copies useBeats.ts and transitions.ts alongside", async () => {
    await withTmpDir(async (dir) => {
      const result = await scaffoldInto("click-140bpm-48k.beats.json", dir);
      expect(result.exitCode).toBe(0);
      const useBeats = await readFile(join(dir, "src/useBeats.ts"), "utf8");
      const transitions = await readFile(join(dir, "src/transitions.ts"), "utf8");
      expect(useBeats).toContain("createBeatHelpers");
      expect(transitions).toContain("pickTransition");
    });
  });
});

describe("scaffold edge cases", () => {
  test("0-beat input (silence-3s) produces a valid composition", async () => {
    await withTmpDir(async (dir) => {
      const result = await scaffoldInto("silence-3s.beats.json", dir);
      expect(result.exitCode).toBe(0);
      const tsx = await readFile(join(dir, "src/Composition.tsx"), "utf8");
      expect(tsx).toContain("export const TestComp");
      // Should still wire sections (1 of them) even with no beats.
      expect(tsx).toContain("helpers.sections.map");
    });
  });

  test("1-beat input (single-beat) produces a valid composition", async () => {
    await withTmpDir(async (dir) => {
      const result = await scaffoldInto("single-beat.beats.json", dir);
      expect(result.exitCode).toBe(0);
      const tsx = await readFile(join(dir, "src/Composition.tsx"), "utf8");
      expect(tsx).toContain("export const TestComp");
    });
  });
});
