import { describe, expect, test } from "bun:test";
import {
  buildTempoGrid,
  snapToGrid,
  type Peak,
} from "../bin/dsp.ts";

const ODF_RATE = 200;

// Build a synthetic ODF with impulses at given times.
function odfWithImpulses(durationSec: number, beatTimes: number[]): Float32Array {
  const n = Math.floor(ODF_RATE * durationSec);
  const odf = new Float32Array(n);
  for (const t of beatTimes) {
    const idx = Math.round(t * ODF_RATE);
    if (idx >= 0 && idx < n) odf[idx] = 1.0;
  }
  return odf;
}

describe("buildTempoGrid", () => {
  test("locks phase to t=0 when impulses start at t=0", () => {
    // 120 BPM beats start at t=0, every 0.5s
    const beats = [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0];
    const odf = odfWithImpulses(5.0, beats);
    const grid = buildTempoGrid(odf, 120, ODF_RATE);
    // Phase should be near 0 (within ±1 frame at 200 Hz = ±5 ms).
    expect(Math.abs(grid.phaseFrames)).toBeLessThan(2);
    // Should have ~10 grid positions (5 seconds * 120 BPM / 60 + 1)
    expect(grid.positions.length).toBeGreaterThanOrEqual(9);
    expect(grid.positions.length).toBeLessThanOrEqual(11);
  });

  test("locks phase to mid-beat offset when impulses are offset", () => {
    // 120 BPM beats start at t=0.25, every 0.5s
    const beats = [0.25, 0.75, 1.25, 1.75, 2.25, 2.75];
    const odf = odfWithImpulses(3.5, beats);
    const grid = buildTempoGrid(odf, 120, ODF_RATE);
    // Phase should be near 0.25s = 50 ODF frames.
    expect(Math.abs(grid.phaseFrames - 50)).toBeLessThan(3);
  });

  test("returns empty grid when BPM is zero", () => {
    const odf = odfWithImpulses(2.0, [0.5, 1.0]);
    const grid = buildTempoGrid(odf, 0, ODF_RATE);
    expect(grid.positions).toHaveLength(0);
  });
});

describe("snapToGrid", () => {
  function peak(frame: number, strength: number): Peak {
    return { frame, time: frame / ODF_RATE, strength };
  }

  test("real peaks within tolerance snap to grid; missing slots become synthetic", () => {
    const odf = new Float32Array(2000);
    for (let i = 0; i < 2000; i++) odf[i] = 0.01; // some background ODF for synthetics
    const grid = [100, 200, 300, 400]; // 4 slots at ODF frames
    const peaks: Peak[] = [
      peak(102, 0.9), // close to slot 0
      // no peak near slot 1
      peak(305, 0.5), // close to slot 2
      // no peak near slot 3
    ];
    const snapped = snapToGrid(peaks, grid, odf, ODF_RATE, 80);
    expect(snapped).toHaveLength(4);
    expect(snapped[0].synthetic).toBe(false);
    expect(snapped[0].frame).toBe(100);
    expect(snapped[1].synthetic).toBe(true);
    expect(snapped[2].synthetic).toBe(false);
    expect(snapped[2].frame).toBe(300);
    expect(snapped[3].synthetic).toBe(true);
  });

  test("peaks outside tolerance are not consumed", () => {
    const odf = new Float32Array(1000);
    const grid = [100, 300];
    // Tolerance at 80 ms × 200 Hz = 16 frames. Peak at 50 is 50 frames from
    // slot 100, beyond tolerance.
    const peaks: Peak[] = [peak(50, 0.9), peak(305, 0.5)];
    const snapped = snapToGrid(peaks, grid, odf, ODF_RATE, 80);
    expect(snapped[0].synthetic).toBe(true); // slot 100 — no peak within range
    expect(snapped[1].synthetic).toBe(false); // slot 300 — peak at 305 (within 16-frame tolerance)
  });

  test("two peaks competing for one slot: stronger wins, weaker stays unassigned", () => {
    const odf = new Float32Array(500);
    const grid = [100, 300];
    const peaks: Peak[] = [peak(102, 0.4), peak(105, 0.9), peak(295, 0.3)];
    const snapped = snapToGrid(peaks, grid, odf, ODF_RATE, 80);
    // Slot 100 should adopt the strength=0.9 peak.
    expect(snapped[0].synthetic).toBe(false);
    expect(snapped[0].strength).toBe(0.9);
    expect(snapped[0].originalFrame).toBe(105);
  });
});
