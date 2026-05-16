/**
 * Spectral feature extraction.
 *
 * Per-frame features computed from a power spectrum (magnitudes per bin).
 * All Hz-valued outputs use the convention that bin `i` of an FFT taken
 * at `sampleRate` over `fftSize` samples corresponds to `i * sampleRate / fftSize` Hz.
 *
 * These features are the de-facto MIR (music information retrieval) basics
 * that drive perceptual brightness, timbral change rate, tonal-vs-noise
 * balance, and high-frequency content estimation:
 *
 *   centroid  — weighted-average frequency. Brightness proxy.
 *   spread    — variance around centroid. Bandwidth proxy.
 *   rolloff   — frequency below which `fraction` of energy lives.
 *   flux      — half-wave rectified L2 distance to the previous frame.
 *   flatness  — geomean / arithmean of magnitudes. Tonal-vs-noisy (0..1).
 */

import { binToHz } from "./fft.ts";

/**
 * Spectral centroid in Hz. Weighted average of bin frequencies, weighted
 * by magnitude. Returns 0 if the frame has no energy.
 */
export function spectralCentroid(
  magnitudes: Float32Array,
  sampleRate: number,
  fftSize: number
): number {
  let weightedSum = 0;
  let totalSum = 0;
  for (let i = 0; i < magnitudes.length; i++) {
    const m = magnitudes[i];
    weightedSum += binToHz(i, sampleRate, fftSize) * m;
    totalSum += m;
  }
  return totalSum > 1e-12 ? weightedSum / totalSum : 0;
}

/**
 * Spectral spread in Hz — the standard deviation of bin frequencies
 * weighted by magnitude, around the supplied centroid. Larger spread =
 * wider-band frame (orchestral chord), smaller = narrowband (sine tone).
 */
export function spectralSpread(
  magnitudes: Float32Array,
  centroid: number,
  sampleRate: number,
  fftSize: number
): number {
  let varSum = 0;
  let totalSum = 0;
  for (let i = 0; i < magnitudes.length; i++) {
    const m = magnitudes[i];
    const hz = binToHz(i, sampleRate, fftSize);
    const d = hz - centroid;
    varSum += d * d * m;
    totalSum += m;
  }
  return totalSum > 1e-12 ? Math.sqrt(varSum / totalSum) : 0;
}

/**
 * Spectral rolloff in Hz — the frequency below which `fraction` (default
 * 0.85) of the total magnitude is concentrated. High rolloff means the
 * track has lots of high-frequency content; low rolloff means it's
 * low-pass dominant.
 */
export function spectralRolloff(
  magnitudes: Float32Array,
  sampleRate: number,
  fftSize: number,
  fraction: number = 0.85
): number {
  let total = 0;
  for (let i = 0; i < magnitudes.length; i++) total += magnitudes[i];
  if (total < 1e-12) return 0;
  const target = total * fraction;
  let acc = 0;
  for (let i = 0; i < magnitudes.length; i++) {
    acc += magnitudes[i];
    if (acc >= target) return binToHz(i, sampleRate, fftSize);
  }
  return binToHz(magnitudes.length - 1, sampleRate, fftSize);
}

/**
 * Spectral flux — half-wave rectified L2 distance between consecutive
 * frames. Captures how fast the timbre is changing. Steady tones have
 * near-zero flux; rapid spectral changes (drum fills, riser builds) produce
 * large values. Returns 0 if either frame is null/empty or shape-mismatched.
 */
export function spectralFlux(
  curr: Float32Array,
  prev: Float32Array | null
): number {
  if (!prev || prev.length !== curr.length) return 0;
  let sumSq = 0;
  for (let i = 0; i < curr.length; i++) {
    const d = curr[i] - prev[i];
    // half-wave rectify — only count rising spectral components.
    if (d > 0) sumSq += d * d;
  }
  return Math.sqrt(sumSq);
}

/**
 * Spectral flatness on [0, 1]. Ratio of geometric mean to arithmetic mean
 * of magnitudes:
 *
 *   flatness = geomean(m) / arithmean(m)
 *
 * Computed in log space to avoid underflow on long FFTs. 1.0 is "pure
 * white noise"; near-0 is "pure tonal" (single sine). Useful for telling
 * whether the music's current spectral character is tonal (melody/harmony
 * dominant) or noisy (percussion, hat splash, riser).
 */
export function spectralFlatness(magnitudes: Float32Array): number {
  const n = magnitudes.length;
  if (n === 0) return 0;
  let logSum = 0;
  let linSum = 0;
  let counted = 0;
  // Skip DC bin (i=0). Skip near-zero bins (log undefined).
  for (let i = 1; i < n; i++) {
    const m = magnitudes[i];
    if (m <= 1e-12) continue;
    logSum += Math.log(m);
    linSum += m;
    counted++;
  }
  if (counted < 1 || linSum < 1e-12) return 0;
  const geomean = Math.exp(logSum / counted);
  const arithmean = linSum / counted;
  return Math.max(0, Math.min(1, geomean / arithmean));
}

// ─────────────────────────────────────────────────────────────────────────
// FPS-rate feature extraction. Given a spectrogram (one power spectrum per
// video frame), compute all features as parallel arrays of length
// `spectrogram.length`. Designed to feed directly into the analyzer's
// sidecar emission step.
// ─────────────────────────────────────────────────────────────────────────

export type FpsSpectralFeatures = {
  fps: number;
  centroid: number[];    // Hz
  spread: number[];      // Hz
  rolloff: number[];     // Hz
  flux: number[];        // ≥ 0, raw L2
  flatness: number[];    // 0..1
};

export function computeFpsSpectralFeatures(
  spectrogram: Float32Array[],
  sampleRate: number,
  fftSize: number,
  fps: number
): FpsSpectralFeatures {
  const n = spectrogram.length;
  const centroid: number[] = new Array(n);
  const spread: number[] = new Array(n);
  const rolloff: number[] = new Array(n);
  const flux: number[] = new Array(n);
  const flatness: number[] = new Array(n);
  for (let f = 0; f < n; f++) {
    const cur = spectrogram[f];
    centroid[f] = spectralCentroid(cur, sampleRate, fftSize);
    spread[f] = spectralSpread(cur, centroid[f], sampleRate, fftSize);
    rolloff[f] = spectralRolloff(cur, sampleRate, fftSize, 0.85);
    flux[f] = spectralFlux(cur, f > 0 ? spectrogram[f - 1] : null);
    flatness[f] = spectralFlatness(cur);
  }
  return { fps, centroid, spread, rolloff, flux, flatness };
}

/**
 * Round all values in a number[] to `decimals` places. Used before JSON
 * emission to compress sidecar size — a 28-second song at 30fps has 840
 * frames × 5 features = 4200 floats just for spectral. Rounding to 4
 * decimals cuts JSON size ~3x with no perceptual loss.
 */
export function roundCurve(values: number[], decimals: number = 4): number[] {
  const factor = Math.pow(10, decimals);
  return values.map((v) => Math.round(v * factor) / factor);
}
