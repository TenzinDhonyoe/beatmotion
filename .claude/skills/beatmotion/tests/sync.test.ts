import { describe, expect, test } from "bun:test";
import {
  findInterpolate,
  findSequence,
  findSpring,
  nearestBeatIndex,
  WEAK_MATCH_THRESHOLD_SEC,
} from "../bin/sync.ts";

const beats = {
  audio: "test.wav",
  duration: 10,
  fps: 30,
  bpm: 120,
  beats: [
    { time: 0.0, frame: 0, strength: 0.8 },
    { time: 0.5, frame: 15, strength: 0.6 },
    { time: 1.0, frame: 30, strength: 0.9 },
    { time: 1.5, frame: 45, strength: 0.5 },
    { time: 2.0, frame: 60, strength: 0.95 },
  ],
  drops: [{ time: 2.0, frame: 60, kind: "main_drop" }],
};

describe("nearestBeatIndex", () => {
  test("exact match returns that beat", () => {
    expect(nearestBeatIndex(30, beats.beats)).toBe(2);
  });
  test("picks closer of two neighbors", () => {
    expect(nearestBeatIndex(20, beats.beats)).toBe(1); // 15 is closer than 30
    expect(nearestBeatIndex(25, beats.beats)).toBe(2); // 30 is closer than 15
  });
  test("returns -1 on empty beats array", () => {
    expect(nearestBeatIndex(10, [])).toBe(-1);
  });
});

describe("findInterpolate", () => {
  test("matches single-line interpolate with frame literal", () => {
    const src = `const o = interpolate(frame, [0, 22], [0, 1]);`;
    const out = findInterpolate(src, beats);
    expect(out.length).toBe(1);
    expect(out[0].kind).toBe("interpolate");
    // End frame 22 → nearest is beat 1 (frame 15) at deltaSec 7/30 ≈ 0.233.
    expect(out[0].proposed).toContain("beats[");
    expect(out[0].weakMatch).toBe(false);
  });

  test("matches multi-line interpolate with nested config", () => {
    const src = `const y = interpolate(
      frame,
      [0, 88],
      [40, 0],
      { extrapolateRight: "clamp" }
    );`;
    const out = findInterpolate(src, beats);
    expect(out.length).toBe(1);
    // 88 is beyond all beats; nearest is beat 4 (frame 60).
    expect(out[0].proposed).toContain("beats[4].frame");
  });

  test("skips already-symbolic interpolate", () => {
    const src = `const o = interpolate(frame, [0, beats[2].frame], [0, 1]);`;
    const out = findInterpolate(src, beats);
    expect(out.length).toBe(0);
  });

  test("flags weak match when delta > 0.5s", () => {
    // Pick a frame far from any beat: frame 100, nearest is beat 4 (frame 60)
    // → delta = 40/30 ≈ 1.33s > 0.5s threshold.
    const src = `const o = interpolate(frame, [0, 100], [0, 1]);`;
    const out = findInterpolate(src, beats);
    expect(out.length).toBe(1);
    expect(out[0].weakMatch).toBe(true);
    expect(out[0].deltaSec).toBeGreaterThan(WEAK_MATCH_THRESHOLD_SEC);
  });
});

describe("findSpring", () => {
  test("matches spring with delayInFrames", () => {
    const src = `const s = spring({ frame, fps, delayInFrames: 22, config: { damping: 12 } });`;
    const out = findSpring(src, beats);
    expect(out.length).toBe(1);
    expect(out[0].kind).toBe("spring");
    expect(out[0].proposed).toContain("delayInFrames: beats[");
  });

  test("matches multi-line spring across newlines", () => {
    // 44 is not a beat (beats are at 0, 15, 30, 45, 60) → forces a retarget.
    const src = `const s = spring({
      frame,
      fps,
      delayInFrames: 44,
      config: { damping: 200 }
    });`;
    const out = findSpring(src, beats);
    expect(out.length).toBe(1);
    expect(out[0].proposed).toContain("delayInFrames: beats[3].frame");
  });

  test("skips spring when already on a beat", () => {
    const src = `const s = spring({ frame, fps, delayInFrames: 30, config: { damping: 12 } });`;
    const out = findSpring(src, beats);
    expect(out.length).toBe(0); // 30 is exactly beat 2's frame
  });

  test("skips delayInFrames: 0 (start-of-comp)", () => {
    const src = `const s = spring({ frame, fps, delayInFrames: 0 });`;
    const out = findSpring(src, beats);
    expect(out.length).toBe(0);
  });
});

describe("findSequence", () => {
  test("matches <Sequence from={N}>", () => {
    const src = `<Sequence from={20} durationInFrames={60}>`;
    const out = findSequence(src, beats);
    expect(out.length).toBe(1);
    expect(out[0].kind).toBe("Sequence");
    expect(out[0].proposed).toContain("from={");
  });

  test("matches <Sequence with attrs split across lines", () => {
    const src = `<Sequence
      from={45}
      durationInFrames={60}
    >`;
    const out = findSequence(src, beats);
    expect(out.length).toBe(1);
    // 45 is exactly beat 3, so this skips via already-aligned guard.
    // Test multi-line parsing via a different value:
    const src2 = `<Sequence
      from={47}
      durationInFrames={60}
    >`;
    const out2 = findSequence(src2, beats);
    expect(out2.length).toBe(1);
    expect(out2[0].proposed).toContain("from={");
  });

  test("skips <Sequence from={0}> (start of video)", () => {
    const src = `<Sequence from={0} durationInFrames={60}>`;
    const out = findSequence(src, beats);
    expect(out.length).toBe(0);
  });
});
