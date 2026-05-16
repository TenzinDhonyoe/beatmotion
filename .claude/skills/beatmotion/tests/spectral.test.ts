import { describe, expect, test } from "bun:test";
import { powerSpectrum } from "../bin/fft.ts";
import {
  computeFpsSpectralFeatures,
  spectralCentroid,
  spectralFlatness,
  spectralFlux,
  spectralRolloff,
  spectralSpread,
} from "../bin/spectral.ts";

const SR = 44100;
const FFT_SIZE = 2048;

function toneFrame(hz: number): Float32Array {
  const f = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) f[i] = Math.cos((2 * Math.PI * hz * i) / SR);
  return f;
}

function noiseFrame(seed: number = 1): Float32Array {
  // Cheap LCG-based pseudo-random fill.
  let s = seed;
  const f = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    s = (s * 16807) % 2147483647;
    f[i] = (s / 2147483647) * 2 - 1;
  }
  return f;
}

describe("spectralCentroid", () => {
  test("low-frequency tone has low centroid", () => {
    const spec = powerSpectrum(toneFrame(100));
    const c = spectralCentroid(spec, SR, FFT_SIZE);
    expect(c).toBeGreaterThan(50);
    expect(c).toBeLessThan(400);
  });

  test("high-frequency tone has high centroid", () => {
    const spec = powerSpectrum(toneFrame(8000));
    const c = spectralCentroid(spec, SR, FFT_SIZE);
    expect(c).toBeGreaterThan(7000);
    expect(c).toBeLessThan(9000);
  });

  test("returns 0 on silence", () => {
    const spec = powerSpectrum(new Float32Array(FFT_SIZE));
    const c = spectralCentroid(spec, SR, FFT_SIZE);
    expect(c).toBe(0);
  });
});

describe("spectralSpread", () => {
  test("pure tone has small spread", () => {
    const spec = powerSpectrum(toneFrame(1000));
    const c = spectralCentroid(spec, SR, FFT_SIZE);
    const s = spectralSpread(spec, c, SR, FFT_SIZE);
    // A near-pure sine spread by Hann windowing — should be a few hundred Hz
    // at most.
    expect(s).toBeLessThan(700);
  });

  test("broadband noise has large spread", () => {
    const spec = powerSpectrum(noiseFrame(42));
    const c = spectralCentroid(spec, SR, FFT_SIZE);
    const s = spectralSpread(spec, c, SR, FFT_SIZE);
    expect(s).toBeGreaterThan(2000);
  });
});

describe("spectralRolloff", () => {
  test("low tone rolls off at low frequency", () => {
    const spec = powerSpectrum(toneFrame(200));
    const r = spectralRolloff(spec, SR, FFT_SIZE, 0.85);
    expect(r).toBeLessThan(1000);
  });

  test("high tone rolls off at high frequency", () => {
    const spec = powerSpectrum(toneFrame(6000));
    const r = spectralRolloff(spec, SR, FFT_SIZE, 0.85);
    expect(r).toBeGreaterThan(5000);
  });
});

describe("spectralFlux", () => {
  test("identical frames produce zero flux", () => {
    const a = powerSpectrum(toneFrame(440));
    const b = powerSpectrum(toneFrame(440));
    expect(spectralFlux(a, b)).toBe(0);
  });

  test("very different frames produce large flux", () => {
    const lo = powerSpectrum(toneFrame(120));
    const hi = powerSpectrum(toneFrame(6000));
    const f = spectralFlux(hi, lo);
    expect(f).toBeGreaterThan(0);
  });

  test("null prev returns 0", () => {
    const a = powerSpectrum(toneFrame(440));
    expect(spectralFlux(a, null)).toBe(0);
  });

  test("half-wave rectification: removing energy doesn't count", () => {
    const lo = powerSpectrum(toneFrame(120));
    const silence = powerSpectrum(new Float32Array(FFT_SIZE));
    // Going from sound → silence should yield zero (energy decreases, not increases).
    expect(spectralFlux(silence, lo)).toBe(0);
  });
});

describe("spectralFlatness", () => {
  test("pure tone has very low flatness (tonal)", () => {
    const spec = powerSpectrum(toneFrame(1000));
    const fl = spectralFlatness(spec);
    expect(fl).toBeLessThan(0.05);
  });

  test("white noise has higher flatness (noisy)", () => {
    const spec = powerSpectrum(noiseFrame(99));
    const fl = spectralFlatness(spec);
    expect(fl).toBeGreaterThan(0.15);
  });

  test("silence returns 0", () => {
    const spec = powerSpectrum(new Float32Array(FFT_SIZE));
    expect(spectralFlatness(spec)).toBe(0);
  });
});

describe("computeFpsSpectralFeatures", () => {
  test("returns parallel arrays of correct length", () => {
    // Build a 2-frame fake spectrogram.
    const spec = [powerSpectrum(toneFrame(440)), powerSpectrum(toneFrame(880))];
    const out = computeFpsSpectralFeatures(spec, SR, FFT_SIZE, 30);
    expect(out.fps).toBe(30);
    expect(out.centroid.length).toBe(2);
    expect(out.spread.length).toBe(2);
    expect(out.rolloff.length).toBe(2);
    expect(out.flux.length).toBe(2);
    expect(out.flatness.length).toBe(2);
    expect(out.centroid[0]).toBeGreaterThan(200);
    expect(out.centroid[1]).toBeGreaterThan(out.centroid[0]);
  });
});
