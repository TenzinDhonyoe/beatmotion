import { describe, expect, test } from "bun:test";
import {
  bandpass,
  rbjBandpass,
  applyBiquad,
} from "../bin/filters.ts";
import {
  DEFAULT_BANDS,
  computeBandedAudio,
  computeODF,
  classifyBeat,
} from "../bin/dsp.ts";

const SR = 44100;
const ODF_RATE = 200;

// Generate a 0.5-second tone at the given frequency. Used to verify that
// the bandpass attenuates out-of-band content and passes in-band content.
function tone(hz: number, durationSec: number): Float32Array {
  const n = Math.floor(SR * durationSec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / SR);
  return out;
}

function rms(samples: Float32Array, from: number = 0): number {
  let sum = 0;
  let count = 0;
  for (let i = from; i < samples.length; i++) {
    sum += samples[i] * samples[i];
    count++;
  }
  return Math.sqrt(sum / Math.max(1, count));
}

describe("biquad bandpass", () => {
  test("passes a center-frequency tone", () => {
    const sig = tone(1000, 0.5);
    const filtered = bandpass(sig, SR, 800, 1200);
    // Skip the first 1000 samples to let the filter settle (transient response).
    const r = rms(filtered, 1000);
    expect(r).toBeGreaterThan(0.3);
  });

  test("attenuates a far-out-of-band tone", () => {
    const sig = tone(8000, 0.5);
    const filtered = bandpass(sig, SR, 100, 300);
    const r = rms(filtered, 1000);
    // 8 kHz is way outside 100-300 Hz; should be near silent.
    expect(r).toBeLessThan(0.05);
  });

  test("4-pole cascade attenuates more than 2-pole", () => {
    const sig = tone(800, 0.5);
    const twoPole = bandpass(sig, SR, 100, 300, 2);
    const fourPole = bandpass(sig, SR, 100, 300, 4);
    expect(rms(fourPole, 1000)).toBeLessThan(rms(twoPole, 1000));
  });
});

describe("computeBandedAudio", () => {
  test("emits one filtered stream + ODF per band", () => {
    const sig = tone(80, 0.5); // sub_kick frequency
    const banded = computeBandedAudio(sig, SR, DEFAULT_BANDS, ODF_RATE);
    expect(banded.bands).toHaveLength(5);
    expect(banded.filtered).toHaveLength(5);
    expect(banded.bandedOdf).toHaveLength(5);
    expect(banded.filtered[0].length).toBe(sig.length);
  });

  test("sub_kick band carries 80 Hz energy more than hat_air band", () => {
    const sig = tone(80, 1.0);
    const banded = computeBandedAudio(sig, SR, DEFAULT_BANDS, ODF_RATE);
    const subRms = rms(banded.filtered[0], 2000);
    const hatRms = rms(banded.filtered[4], 2000);
    expect(subRms).toBeGreaterThan(hatRms);
  });
});

describe("classifyBeat", () => {
  // Tests assemble a synthetic per-band ODF directly to isolate the
  // classification logic from the filter-design subtleties (biquad gain is
  // small at the very low frequencies where the sub_kick band lives, which
  // can swamp the band-weight signal when testing with tone bursts).
  function bandedOdfWithEnergy(
    activeBand: number,
    frame: number,
    intensity: number = 1.0,
    length: number = 200
  ): Float32Array[] {
    const out: Float32Array[] = [];
    for (let b = 0; b < DEFAULT_BANDS.length; b++) {
      const arr = new Float32Array(length);
      if (b === activeBand) arr[frame] = intensity;
      out.push(arr);
    }
    return out;
  }

  test("energy in sub_kick band → kind 'kick'", () => {
    const bandedOdf = bandedOdfWithEnergy(0, 100);
    const cls = classifyBeat(100, bandedOdf, DEFAULT_BANDS, ODF_RATE);
    expect(cls.kind).toBe("kick");
  });

  test("energy in snare_body band → kind 'snare'", () => {
    const bandedOdf = bandedOdfWithEnergy(2, 100);
    const cls = classifyBeat(100, bandedOdf, DEFAULT_BANDS, ODF_RATE);
    expect(cls.kind).toBe("snare");
  });

  test("energy in hat_air band → kind 'hat'", () => {
    const bandedOdf = bandedOdfWithEnergy(4, 100);
    const cls = classifyBeat(100, bandedOdf, DEFAULT_BANDS, ODF_RATE);
    expect(cls.kind).toBe("hat");
  });

  test("bandEnergies sum to ~1 (L1-normalized)", () => {
    const bandedOdf = bandedOdfWithEnergy(2, 100, 0.7);
    const cls = classifyBeat(100, bandedOdf, DEFAULT_BANDS, ODF_RATE);
    const sum = cls.bandEnergies.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 2);
  });

  test("silence in all bands → kind 'other'", () => {
    const banded = computeBandedAudio(new Float32Array(SR), SR, DEFAULT_BANDS, ODF_RATE);
    const cls = classifyBeat(50, banded.bandedOdf, DEFAULT_BANDS, ODF_RATE);
    expect(cls.kind).toBe("other");
  });

  test("end-to-end: piping audio through computeBandedAudio works", () => {
    // Smoke test the full pipeline on a tone burst; just verify it returns
    // a non-zero classification result, without asserting specific kind.
    const n = Math.floor(SR * 1.0);
    const out = new Float32Array(n);
    const start = Math.floor(0.5 * SR);
    const len = Math.floor(SR * 0.3);
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / SR;
      out[start + i] = Math.sin(2 * Math.PI * 500 * t) * 0.8;
    }
    const banded = computeBandedAudio(out, SR, DEFAULT_BANDS, ODF_RATE);
    const cls = classifyBeat(Math.round(0.5 * ODF_RATE), banded.bandedOdf, DEFAULT_BANDS, ODF_RATE);
    expect(cls.bandEnergies.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });
});
