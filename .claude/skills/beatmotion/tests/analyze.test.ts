import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FIXTURES, runBin, withTmpDir } from "./helpers.ts";

type Fixture = { wav: string; expectedBpm: number };
const FIXTURES_BPM: Fixture[] = [
  { wav: "click-90bpm-44k.wav", expectedBpm: 90 },
  { wav: "click-100bpm-22k.wav", expectedBpm: 100 },
  { wav: "click-140bpm-48k.wav", expectedBpm: 140 },
  { wav: "click-165bpm-44k.wav", expectedBpm: 165 },
];

describe("analyze BPM detection", () => {
  for (const { wav, expectedBpm } of FIXTURES_BPM) {
    test(`${wav} → BPM within ±2 of ${expectedBpm}`, async () => {
      await withTmpDir(async (dir) => {
        const outPath = join(dir, "out.beats.json");
        const result = await runBin("analyze.ts", [
          join(FIXTURES, wav),
          "--out",
          outPath,
        ]);
        expect(result.exitCode).toBe(0);
        const beats = JSON.parse(await readFile(outPath, "utf8"));
        expect(Math.abs(beats.bpm - expectedBpm)).toBeLessThanOrEqual(2);
        expect(Array.isArray(beats.beats)).toBe(true);
        expect(beats.beats.length).toBeGreaterThan(0);
      });
    });
  }
});

describe("analyze error paths", () => {
  test("MP3 decode failure produces actionable error message", async () => {
    await withTmpDir(async (dir) => {
      // A tiny corrupted .mp3 — guaranteed to fail decode without dragging
      // a real-world MP3 fixture into the repo.
      const fake = join(dir, "broken.mp3");
      await writeFile(fake, "not really an mp3");
      const result = await runBin("analyze.ts", [fake]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("MP3 decode failed");
      expect(result.stderr).toContain("afconvert");
      expect(result.stderr).toContain("ffmpeg");
    });
  });
});
