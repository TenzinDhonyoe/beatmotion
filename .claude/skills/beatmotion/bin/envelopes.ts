/**
 * FPS-rate envelope + intensity / tension / density curves.
 *
 * Discrete events (beats, drops, phrases) handle visual punctuation, but
 * the bulk of "feels alive" motion in pro motion graphics is driven by
 * CONTINUOUS audio properties — total energy, where the energy lives
 * spectrally, how fast the timbre is changing. This module turns those
 * properties into per-video-frame curves the templates can index with
 * `array[currentFrame]`.
 *
 * Re-uses the per-band filtered audio that `computeBandedAudio` already
 * produces during Phase 2 multi-band analysis — no new filtering passes.
 */

import type { BandedAudio } from "./dsp.ts";

/**
 * Sample one per-band RMS value at every video-frame timestamp. For each
 * frame, compute RMS over a `windowMs` window centered on that frame's
 * sample position. 20 ms is short enough to track beat-rate energy changes
 * without smearing percussion, long enough to be stable.
 */
export function bandEnvelopesAtFps(
  banded: BandedAudio,
  sampleRate: number,
  fps: number,
  totalFrames: number,
  windowMs: number = 20
): number[][] {
  const windowSamples = Math.max(1, Math.floor((windowMs / 1000) * sampleRate));
  const halfWin = windowSamples >> 1;
  const out: number[][] = banded.filtered.map(() => new Array(totalFrames));
  for (let f = 0; f < totalFrames; f++) {
    const centerSample = Math.round((f / fps) * sampleRate);
    const a = Math.max(0, centerSample - halfWin);
    const b = Math.min(banded.filtered[0].length, centerSample + halfWin);
    for (let bandIdx = 0; bandIdx < banded.filtered.length; bandIdx++) {
      let sum = 0;
      const sig = banded.filtered[bandIdx];
      for (let i = a; i < b; i++) sum += sig[i] * sig[i];
      const n = Math.max(1, b - a);
      out[bandIdx][f] = Math.sqrt(sum / n);
    }
  }
  return out;
}

/**
 * Total RMS envelope: sum the 5 per-band envelopes into one curve.
 * Useful as a quick "loudness" proxy when callers don't need per-band detail.
 */
export function totalEnvelope(bandEnvelopes: number[][]): number[] {
  const n = bandEnvelopes[0]?.length ?? 0;
  const out: number[] = new Array(n).fill(0);
  for (const band of bandEnvelopes) {
    for (let i = 0; i < n; i++) out[i] += band[i];
  }
  return out;
}

/**
 * Normalize an array to [0, 1] using its 95th-percentile peak as the
 * reference (robust to single outlier spikes that would otherwise crush
 * the rest of the curve to near-zero). Values above the 95th percentile
 * clamp to 1.0.
 */
export function normalizeRobust(values: number[]): number[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
  const denom = Math.max(p95, 1e-9);
  return values.map((v) => Math.max(0, Math.min(1, v / denom)));
}

/**
 * Moving-average smoothing with a per-frame window. Used to take the
 * jagged frame-by-frame envelope and produce something a designer would
 * call "intensity" — a smoothed, breathable curve that responds to
 * energy trends rather than individual transients.
 */
export function smoothCurve(values: number[], radius: number = 3): number[] {
  const n = values.length;
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - radius);
    const b = Math.min(n, i + radius + 1);
    let sum = 0;
    for (let j = a; j < b; j++) sum += values[j];
    out[i] = sum / (b - a);
  }
  return out;
}

/**
 * Energy curve: normalized total RMS, smoothed lightly. Per-frame "is the
 * track loud right now."
 */
export function energyCurve(bandEnvelopes: number[][]): number[] {
  return normalizeRobust(smoothCurve(totalEnvelope(bandEnvelopes), 1));
}

/**
 * Intensity curve: the energy curve with longer smoothing — "is the track
 * in a loud section." Use for things you don't want twitching frame-to-frame
 * (background glow, atmospheric drift speed).
 */
export function intensityCurve(bandEnvelopes: number[][]): number[] {
  return normalizeRobust(smoothCurve(totalEnvelope(bandEnvelopes), 8));
}

/**
 * Tension curve: derived from spectral flux + centroid derivative.
 * Captures "how much is the music changing right now" — high during
 * builds, risers, transitions; low during steady-state grooves. Drives
 * pre-drop anticipation effects, chromatic aberration, edge vignette.
 *
 * `flux` and `centroid` are FPS-aligned arrays from spectral.ts.
 */
export function tensionCurve(flux: number[], centroid: number[]): number[] {
  const n = Math.min(flux.length, centroid.length);
  if (n === 0) return [];
  // Centroid derivative: |centroid[t] - centroid[t-1]|.
  const cdiff: number[] = new Array(n);
  for (let i = 1; i < n; i++) cdiff[i] = Math.abs(centroid[i] - centroid[i - 1]);
  cdiff[0] = 0;
  const fluxNorm = normalizeRobust(flux);
  const cdiffNorm = normalizeRobust(cdiff);
  const combined: number[] = new Array(n);
  for (let i = 0; i < n; i++) combined[i] = 0.6 * fluxNorm[i] + 0.4 * cdiffNorm[i];
  return smoothCurve(combined, 3);
}

/**
 * Onset density curve: count detected beats falling inside a sliding window
 * around each video frame. Captures "how busy is the rhythm right now."
 * Sparse passages (intros, breakdowns) read low; dense (chorus, drop) reads
 * high. Drives shimmer particle count, atmospheric thickness, etc.
 */
export function densityCurve(
  beatFrames: number[],
  totalFrames: number,
  fps: number,
  windowSec: number = 2
): number[] {
  const out: number[] = new Array(totalFrames).fill(0);
  const halfWin = Math.round((windowSec / 2) * fps);
  // Two-pointer sweep.
  let lo = 0;
  let hi = 0;
  for (let f = 0; f < totalFrames; f++) {
    const winLo = f - halfWin;
    const winHi = f + halfWin;
    while (lo < beatFrames.length && beatFrames[lo] < winLo) lo++;
    while (hi < beatFrames.length && beatFrames[hi] <= winHi) hi++;
    out[f] = hi - lo;
  }
  // Normalize: most music tops out around 4 onsets/sec.
  const maxCount = windowSec * 5; // 5 onsets/sec = "dense"
  return out.map((c) => Math.max(0, Math.min(1, c / maxCount)));
}

/**
 * All-in-one envelope bundle, ready for the analyzer to emit.
 */
export type EnvelopeBundle = {
  fps: number;
  total: number[];        // raw normalized total RMS
  subBass: number[];      // sub_kick band, normalized
  lowBody: number[];      // low_body band, normalized
  midBody: number[];      // snare_body band, normalized
  midBright: number[];    // snare_brt band, normalized
  hiAir: number[];        // hat_air band, normalized
};

export function computeEnvelopeBundle(
  bandEnvelopes: number[][],
  fps: number
): EnvelopeBundle {
  // Band index → name mapping matches DEFAULT_BANDS in dsp.ts:
  // [0] sub_kick, [1] low_body, [2] snare_body, [3] snare_brt, [4] hat_air.
  const total = normalizeRobust(totalEnvelope(bandEnvelopes));
  return {
    fps,
    total,
    subBass: normalizeRobust(bandEnvelopes[0] ?? []),
    lowBody: normalizeRobust(bandEnvelopes[1] ?? []),
    midBody: normalizeRobust(bandEnvelopes[2] ?? []),
    midBright: normalizeRobust(bandEnvelopes[3] ?? []),
    hiAir: normalizeRobust(bandEnvelopes[4] ?? []),
  };
}

export type IntensityBundle = {
  fps: number;
  energy: number[];     // smooth-1, normalized total
  intensity: number[];  // smooth-8, normalized total — for slow drivers
  tension: number[];    // flux + centroid derivative
  density: number[];    // onset density (beats per window)
};

export function computeIntensityBundle(
  bandEnvelopes: number[][],
  flux: number[],
  centroid: number[],
  beatFrames: number[],
  totalFrames: number,
  fps: number
): IntensityBundle {
  return {
    fps,
    energy: energyCurve(bandEnvelopes),
    intensity: intensityCurve(bandEnvelopes),
    tension: tensionCurve(flux, centroid),
    density: densityCurve(beatFrames, totalFrames, fps, 2),
  };
}
