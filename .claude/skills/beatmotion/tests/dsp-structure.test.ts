import { describe, expect, test } from "bun:test";
import { inferBarPhrase } from "../bin/dsp.ts";

describe("inferBarPhrase", () => {
  test("kick on 1+3, snare on 2+4 pattern finds barPhase=0", () => {
    // 32 beats. Kicks have strength 0.9, snares 0.6, hats 0.2.
    // Pattern: K-S-K-S repeating every 4 beats (kick on barPos 1 and 3,
    // snare on 2 and 4). Expected: barPhase=0 so beat[0] = barPos 1 (kick).
    const strengths: number[] = [];
    const kinds: string[] = [];
    for (let i = 0; i < 32; i++) {
      const inBar = i % 4;
      if (inBar === 0 || inBar === 2) {
        strengths.push(0.9);
        kinds.push("kick");
      } else {
        strengths.push(0.6);
        kinds.push("snare");
      }
    }
    const inf = inferBarPhrase(strengths, kinds);
    expect(inf.barPhase).toBe(0);
  });

  test("offset pattern (snare on 1) finds barPhase=1", () => {
    // Shifted: snare on barPos 1 and 3, kick on 2 and 4.
    // Wait — for barPhase to be inferred correctly, the STRONGEST beats need
    // to land on the "barPhase" position. If snares are stronger than kicks
    // in the pattern, barPhase aligns to snares; if kicks dominate, to kicks.
    // Here we make kicks stronger but shifted by 1 beat.
    const strengths: number[] = [];
    const kinds: string[] = [];
    for (let i = 0; i < 32; i++) {
      const inBar = i % 4;
      if (inBar === 1 || inBar === 3) {
        strengths.push(0.9);
        kinds.push("kick");
      } else {
        strengths.push(0.6);
        kinds.push("snare");
      }
    }
    const inf = inferBarPhrase(strengths, kinds);
    // Kicks on positions 1 and 3 → barPhase=1 puts beat[1] on barPos 1.
    expect(inf.barPhase).toBe(1);
  });

  test("16-beat phrase length is preferred for short patterns", () => {
    const strengths: number[] = [];
    for (let i = 0; i < 32; i++) strengths.push(i % 16 === 0 ? 1.0 : 0.3);
    const inf = inferBarPhrase(strengths);
    expect(inf.phraseLen).toBe(16);
  });

  test("32-beat phrase length is preferred when the lag-32 peak dominates", () => {
    // Strong accent every 32 beats; weaker but present accents every 16.
    const strengths: number[] = [];
    for (let i = 0; i < 64; i++) {
      if (i % 32 === 0) strengths.push(1.5);
      else if (i % 16 === 0) strengths.push(0.5);
      else strengths.push(0.2);
    }
    const inf = inferBarPhrase(strengths);
    expect(inf.phraseLen).toBe(32);
  });

  test("very short input returns zeros gracefully", () => {
    const inf = inferBarPhrase([0.5, 0.5, 0.5]);
    expect(inf.barPhase).toBe(0);
    expect(inf.confidence).toBe(0);
  });
});
