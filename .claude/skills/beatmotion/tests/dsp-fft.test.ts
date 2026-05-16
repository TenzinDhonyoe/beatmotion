import { describe, expect, test } from "bun:test";
import {
  binToHz,
  fft,
  hannWindow,
  hzToBin,
  ifft,
  powerSpectrum,
  spectrogramAtFps,
} from "../bin/fft.ts";

describe("Hann window", () => {
  test("starts and ends at 0", () => {
    const w = hannWindow(64);
    expect(w[0]).toBeCloseTo(0, 5);
    expect(w[63]).toBeCloseTo(0, 5);
  });
  test("peaks near 1 at the center", () => {
    const w = hannWindow(64);
    expect(w[31]).toBeGreaterThan(0.99);
    expect(w[32]).toBeGreaterThan(0.99);
  });
  test("cached: same instance returned for same length", () => {
    const a = hannWindow(128);
    const b = hannWindow(128);
    expect(a).toBe(b);
  });
});

describe("fft / ifft round-trip", () => {
  test("recovers original signal within float epsilon", () => {
    const n = 64;
    const original = new Float32Array(n);
    for (let i = 0; i < n; i++) original[i] = Math.sin((2 * Math.PI * 3 * i) / n) + 0.3;
    const real = new Float32Array(original);
    const imag = new Float32Array(n);
    fft(real, imag);
    ifft(real, imag);
    for (let i = 0; i < n; i++) {
      expect(real[i]).toBeCloseTo(original[i], 4);
    }
  });

  test("throws on non-power-of-two length", () => {
    expect(() => fft(new Float32Array(7), new Float32Array(7))).toThrow();
  });
});

describe("fft on known signals", () => {
  test("DC signal puts all energy in bin 0", () => {
    const n = 64;
    const real = new Float32Array(n).fill(1);
    const imag = new Float32Array(n);
    fft(real, imag);
    const mag0 = Math.sqrt(real[0] ** 2 + imag[0] ** 2);
    let restSum = 0;
    for (let i = 1; i < n; i++) restSum += Math.sqrt(real[i] ** 2 + imag[i] ** 2);
    expect(mag0).toBeCloseTo(n, 3);
    expect(restSum).toBeLessThan(1e-3);
  });

  test("single sine at bin k peaks at bin k (and N-k)", () => {
    const n = 64;
    const k = 5;
    const real = new Float32Array(n);
    for (let i = 0; i < n; i++) real[i] = Math.cos((2 * Math.PI * k * i) / n);
    const imag = new Float32Array(n);
    fft(real, imag);
    const mags = new Float32Array(n);
    for (let i = 0; i < n; i++) mags[i] = Math.sqrt(real[i] ** 2 + imag[i] ** 2);
    // Strongest bin should be k (or N-k by symmetry); both should be far above noise.
    expect(mags[k]).toBeGreaterThan(n * 0.4);
    expect(mags[n - k]).toBeGreaterThan(n * 0.4);
    // Any other bin should be near zero.
    for (let i = 0; i < n; i++) {
      if (i !== k && i !== n - k) expect(mags[i]).toBeLessThan(1e-3);
    }
  });

  test("Parseval: time-domain energy equals frequency-domain energy / N", () => {
    const n = 64;
    const real = new Float32Array(n);
    for (let i = 0; i < n; i++) real[i] = Math.sin((2 * Math.PI * 7 * i) / n) + 0.5;
    const imag = new Float32Array(n);
    let timeEnergy = 0;
    for (let i = 0; i < n; i++) timeEnergy += real[i] ** 2;
    fft(real, imag);
    let freqEnergy = 0;
    for (let i = 0; i < n; i++) freqEnergy += real[i] ** 2 + imag[i] ** 2;
    expect(freqEnergy / n).toBeCloseTo(timeEnergy, 3);
  });
});

describe("powerSpectrum + binToHz / hzToBin", () => {
  test("1000 Hz tone at 44.1 kHz with 2048-pt FFT peaks at the right bin", () => {
    const sampleRate = 44100;
    const fftSize = 2048;
    const targetHz = 1000;
    const frame = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) frame[i] = Math.cos((2 * Math.PI * targetHz * i) / sampleRate);
    const spec = powerSpectrum(frame);
    expect(spec.length).toBe(fftSize / 2 + 1);
    const expectedBin = hzToBin(targetHz, sampleRate, fftSize);
    // Find peak bin.
    let peakBin = 0;
    let peakVal = 0;
    for (let i = 0; i < spec.length; i++) {
      if (spec[i] > peakVal) {
        peakVal = spec[i];
        peakBin = i;
      }
    }
    // Hann windowing smears the peak across a few neighbour bins — allow ±2.
    expect(Math.abs(peakBin - expectedBin)).toBeLessThanOrEqual(2);
  });

  test("binToHz / hzToBin are inverses on bin centers", () => {
    const sampleRate = 48000;
    const fftSize = 1024;
    for (let bin = 0; bin < 100; bin++) {
      const hz = binToHz(bin, sampleRate, fftSize);
      const roundTripBin = hzToBin(hz, sampleRate, fftSize);
      expect(roundTripBin).toBe(bin);
    }
  });
});

describe("spectrogramAtFps", () => {
  test("returns one spectrum per video frame", () => {
    const sampleRate = 44100;
    const fps = 30;
    const durationSec = 2;
    const mono = new Float32Array(sampleRate * durationSec);
    for (let i = 0; i < mono.length; i++) mono[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate);
    const spec = spectrogramAtFps(mono, sampleRate, fps, 1024);
    // ~60 video frames over 2 seconds.
    expect(spec.length).toBeGreaterThanOrEqual(59);
    expect(spec.length).toBeLessThanOrEqual(61);
    // Each frame has fftSize/2 + 1 = 513 bins.
    expect(spec[0].length).toBe(513);
  });

  test("420 Hz tone shows the same peak bin in every frame", () => {
    const sampleRate = 44100;
    const fps = 30;
    const fftSize = 2048;
    const durationSec = 1;
    const targetHz = 420;
    const mono = new Float32Array(sampleRate * durationSec);
    for (let i = 0; i < mono.length; i++) mono[i] = Math.sin((2 * Math.PI * targetHz * i) / sampleRate);
    const spec = spectrogramAtFps(mono, sampleRate, fps, fftSize);
    const expectedBin = hzToBin(targetHz, sampleRate, fftSize);
    // Sample 3 mid-song frames; the steady tone should have the same peak in each.
    for (const f of [5, 15, 25]) {
      let peakBin = 0;
      let peakVal = 0;
      for (let i = 0; i < spec[f].length; i++) {
        if (spec[f][i] > peakVal) {
          peakVal = spec[f][i];
          peakBin = i;
        }
      }
      expect(Math.abs(peakBin - expectedBin)).toBeLessThanOrEqual(2);
    }
  });
});
