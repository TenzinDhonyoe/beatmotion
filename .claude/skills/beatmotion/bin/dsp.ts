/**
 * Signal-processing primitives for beatmotion.
 *
 * Everything here is sample-rate agnostic. You hand in a mono Float32Array
 * and the file's native sample rate; the module produces:
 *   - an onset detection function (ODF) sampled at ODF_RATE Hz
 *   - onset peaks (timestamps in seconds + relative strengths)
 *   - a single best BPM via autocorrelation of the ODF
 *   - a dynamic BPM curve (tempogram) for tracks with tempo changes
 *
 * No FFT — onset detection uses log-energy derivative + half-wave rectification.
 * That's the simplest ODF that still catches percussion sharply and runs in O(N).
 *
 * BPM via biased normalized autocorrelation over the candidate-tempo range.
 * Lag-to-BPM: bpm = 60 * odfRate / lag.
 */

import { bandpass } from "./filters.ts";

export const DEFAULT_ODF_RATE = 200; // Hz — 5 ms hop, good for typical pop/EDM onsets.
export const DEFAULT_MIN_BPM = 60;
export const DEFAULT_MAX_BPM = 200;

// Drum-kit-tuned frequency bands. The weights say "if this band carries
// most of the onset energy, the percussion kind is probably X." A kick
// drum lives in 20–250 Hz, snare body in 200–800 with brightness up to
// 4 kHz, hat / cymbal / shaker in the air band above 5 kHz. A clap is
// close enough to a snare in spectrum that it gets the same weights.
//
// The sub_kick band is cascaded (4-pole) because a 2-pole biquad at 60 Hz
// has too gentle a rolloff to keep bass-guitar fundamentals out of the
// kick band; the 4-pole gives ~24 dB/oct which makes the band actually
// kick-selective on busy mixes.
export type BandSpec = {
  name: string;
  lo: number;
  hi: number;
  poles?: number;
  weights: { kick: number; snare: number; hat: number };
};

export const DEFAULT_BANDS: BandSpec[] = [
  { name: "sub_kick",   lo: 20,   hi: 120,   poles: 4, weights: { kick: 1.0, snare: 0.0, hat: 0.0 } },
  { name: "low_body",   lo: 120,  hi: 250,             weights: { kick: 0.5, snare: 0.3, hat: 0.0 } },
  { name: "snare_body", lo: 200,  hi: 800,             weights: { kick: 0.1, snare: 1.0, hat: 0.1 } },
  { name: "snare_brt",  lo: 1500, hi: 4000,            weights: { kick: 0.0, snare: 0.8, hat: 0.4 } },
  { name: "hat_air",    lo: 5000, hi: 12000,           weights: { kick: 0.0, snare: 0.2, hat: 1.0 } },
];

export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  const inv = 1 / channels.length;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const ch of channels) s += ch[i];
    out[i] = s * inv;
  }
  return out;
}

/**
 * Onset detection function — log-energy difference, half-wave rectified.
 *
 * For a hop of `sampleRate / odfRate` samples:
 *   1. Compute log(1 + sum(s^2)) over each non-overlapping frame.
 *   2. Take the positive part of the first difference: max(0, E[t] - E[t-1]).
 *
 * The result is an ODF sampled at `odfRate` Hz — peaks correspond to onsets.
 */
export function computeODF(
  mono: Float32Array,
  sampleRate: number,
  odfRate: number = DEFAULT_ODF_RATE
): Float32Array {
  const hop = Math.max(1, Math.floor(sampleRate / odfRate));
  const numFrames = Math.floor(mono.length / hop);
  if (numFrames < 2) return new Float32Array(0);

  const logEnergy = new Float32Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    let sum = 0;
    const start = f * hop;
    const end = Math.min(start + hop, mono.length);
    for (let i = start; i < end; i++) sum += mono[i] * mono[i];
    logEnergy[f] = Math.log(1 + sum);
  }

  const odf = new Float32Array(numFrames);
  for (let f = 1; f < numFrames; f++) {
    const d = logEnergy[f] - logEnergy[f - 1];
    odf[f] = d > 0 ? d : 0;
  }
  return odf;
}

export type Peak = { frame: number; time: number; strength: number };

/**
 * Adaptive peak picker.
 *
 * A frame is a peak if:
 *   - it's a local maximum (strictly greater than both neighbors), AND
 *   - it exceeds a sliding threshold: local_median + delta * local_mean, AND
 *   - it's at least `minIntervalSec` away from the previous accepted peak
 *     (with replacement: stronger peak wins).
 *
 * Default minimum interval matches `60 / maxBpm` so peaks can't violate
 * the upper BPM bound.
 */
export function findPeaks(
  odf: Float32Array,
  odfRate: number,
  opts: { minIntervalSec?: number; delta?: number; windowSec?: number } = {}
): Peak[] {
  const { minIntervalSec = 60 / DEFAULT_MAX_BPM, delta = 0.7, windowSec = 0.6 } = opts;
  if (odf.length < 3) return [];

  const windowFrames = Math.max(8, Math.floor(odfRate * windowSec));
  const minIntervalFrames = Math.max(1, Math.floor(odfRate * minIntervalSec));
  const peaks: Peak[] = [];

  const half = Math.floor(windowFrames / 2);
  const buf = new Float64Array(windowFrames);

  for (let i = 1; i < odf.length - 1; i++) {
    if (odf[i] <= odf[i - 1] || odf[i] <= odf[i + 1]) continue;

    const start = Math.max(0, i - half);
    const end = Math.min(odf.length, i + half);
    let mean = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      buf[count++] = odf[j];
      mean += odf[j];
    }
    mean /= count;
    const slice = buf.subarray(0, count);
    slice.sort();
    const median = slice[Math.floor(count / 2)];

    const threshold = median + delta * Math.max(mean - median, 0) + 1e-6;
    if (odf[i] < threshold) continue;

    if (peaks.length > 0 && i - peaks[peaks.length - 1].frame < minIntervalFrames) {
      // When two candidate peaks fall within the minimum interval, prefer
      // the earlier one unless the later one is meaningfully stronger.
      // A cymbal hit's energy can peak ~10–20 ms after the kick that triggered
      // it; a naive "strongest wins" replacement overwrites the kick with the
      // cymbal, shifting downstream beat times to the wrong event. The 1.5×
      // ratio keeps the earlier peak unless we're confident the later one is
      // a different, louder onset and not just secondary smearing.
      if (odf[i] > peaks[peaks.length - 1].strength * 1.5) {
        peaks[peaks.length - 1] = { frame: i, time: i / odfRate, strength: odf[i] };
      }
      continue;
    }

    peaks.push({ frame: i, time: i / odfRate, strength: odf[i] });
  }

  return peaks;
}

/**
 * Normalized biased autocorrelation, computed up to `maxLag`.
 * O(N * maxLag). For ODF lengths around 60 s * 200 Hz = 12 000 and
 * maxLag around 200, that's 2.4 M multiplies — fast.
 */
export function autocorrelate(signal: Float32Array, maxLag: number): Float32Array {
  const n = signal.length;
  const out = new Float32Array(maxLag + 1);
  let energy = 0;
  for (let i = 0; i < n; i++) energy += signal[i] * signal[i];
  if (energy <= 0) return out;
  for (let lag = 0; lag <= maxLag; lag++) {
    let sum = 0;
    const stop = n - lag;
    for (let i = 0; i < stop; i++) sum += signal[i] * signal[i + lag];
    out[lag] = sum / energy;
  }
  return out;
}

/**
 * Single best BPM from the ODF via autocorrelation.
 *
 * Considers candidate BPMs in [minBpm, maxBpm], plus their half/double for
 * tempo-octave correction: pop/EDM at 60 BPM often autocorrelates strongest
 * at lag-to-120; the strongest peak in the candidate range wins.
 */
export function detectBpm(
  odf: Float32Array,
  odfRate: number,
  opts: { minBpm?: number; maxBpm?: number } = {}
): { bpm: number; confidence: number } {
  const { minBpm = DEFAULT_MIN_BPM, maxBpm = DEFAULT_MAX_BPM } = opts;
  if (odf.length < odfRate) return { bpm: 0, confidence: 0 };

  const minLag = Math.max(1, Math.floor((60 / maxBpm) * odfRate));
  const maxLag = Math.min(odf.length - 1, Math.ceil((60 / minBpm) * odfRate));
  if (maxLag <= minLag) return { bpm: 0, confidence: 0 };

  const ac = autocorrelate(odf, maxLag);

  let bestLag = minLag;
  let bestVal = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (ac[lag] > bestVal) {
      bestVal = ac[lag];
      bestLag = lag;
    }
  }

  // Tempo-octave correction. On backbeat patterns (kick on 1+3, snare on 2+4)
  // the autocorrelation at lag = "1 kick period" can dominate the lag at
  // "1 beat period" because kicks are louder than snares. The result: the
  // analyzer reports half the actual BPM, the grid lands every other beat,
  // and every animation is twice as wide as the music. Mitigate by checking
  // if the autocorrelation at lag/2 (= 2× BPM) is meaningfully strong —
  // if so, prefer the doubled BPM. The 0.55 threshold is tuned to flip on
  // pop / hip-hop / EDM backbeats but leave true sub-100 BPM tracks alone
  // (their lag/2 peaks tend to be weak because the music doesn't have a
  // half-bar accent pattern).
  const halfLag = Math.round(bestLag / 2);
  if (halfLag >= minLag && halfLag < bestLag && ac[halfLag] >= bestVal * 0.55) {
    bestLag = halfLag;
    bestVal = ac[halfLag];
  }

  // Parabolic interpolation around the best lag for sub-frame BPM resolution.
  let lagRefined = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const y0 = ac[bestLag - 1];
    const y1 = ac[bestLag];
    const y2 = ac[bestLag + 1];
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-9) {
      lagRefined = bestLag + (0.5 * (y0 - y2)) / denom;
    }
  }

  const bpm = lagRefined > 0 ? (60 * odfRate) / lagRefined : 0;

  // Confidence: how much the winning autocorrelation peak exceeds the median
  // of the candidate-range autocorrelation values. Higher = clearer tempo.
  const candidate: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) candidate.push(ac[lag]);
  candidate.sort();
  const median = candidate[Math.floor(candidate.length / 2)];
  const confidence = bestVal > 0 ? Math.min(1, (bestVal - median) / Math.max(bestVal, 1e-9)) : 0;

  return { bpm, confidence };
}

/**
 * Dynamic BPM curve — runs `detectBpm` on a sliding window of the ODF.
 * Returns one (time, bpm, confidence) point per `hopSec` step.
 *
 * If the song has stable tempo throughout, every point reports the same BPM.
 * If the song has a tempo change, the curve tracks it.
 */
export function tempogram(
  odf: Float32Array,
  odfRate: number,
  opts: { windowSec?: number; hopSec?: number; minBpm?: number; maxBpm?: number } = {}
): Array<{ time: number; bpm: number; confidence: number }> {
  const { windowSec = 6, hopSec = 1, minBpm = DEFAULT_MIN_BPM, maxBpm = DEFAULT_MAX_BPM } = opts;
  const windowFrames = Math.floor(odfRate * windowSec);
  const hopFrames = Math.max(1, Math.floor(odfRate * hopSec));
  const out: Array<{ time: number; bpm: number; confidence: number }> = [];
  if (odf.length < windowFrames) {
    const { bpm, confidence } = detectBpm(odf, odfRate, { minBpm, maxBpm });
    if (bpm > 0) out.push({ time: odf.length / odfRate / 2, bpm, confidence });
    return out;
  }
  for (let start = 0; start + windowFrames <= odf.length; start += hopFrames) {
    const window = odf.subarray(start, start + windowFrames);
    const { bpm, confidence } = detectBpm(window, odfRate, { minBpm, maxBpm });
    if (bpm > 0) {
      out.push({
        time: (start + windowFrames / 2) / odfRate,
        bpm: Math.round(bpm * 10) / 10,
        confidence: Math.round(confidence * 100) / 100,
      });
    }
  }
  return out;
}

/**
 * Compute a band-filtered version of the input audio for every band in `bands`,
 * plus a per-band onset detection function. Used by `classifyBeat` to tell
 * kick / snare / hat apart and by `backtrackToAttack` to align beats to the
 * perceptual transient on the relevant band.
 *
 * Memory cost: bands.length × samples.length × 4 bytes (Float32). For a 4-min
 * song at 48 kHz × 5 bands that's about 230 MB of intermediates — fine on a
 * developer laptop, would be uncomfortable on memory-constrained CI. Callers
 * with tight budgets can pass a subset of bands.
 */
export type BandedAudio = {
  bands: BandSpec[];
  filtered: Float32Array[];
  bandedOdf: Float32Array[];
};

export function computeBandedAudio(
  mono: Float32Array,
  sampleRate: number,
  bands: BandSpec[] = DEFAULT_BANDS,
  odfRate: number = DEFAULT_ODF_RATE
): BandedAudio {
  const filtered: Float32Array[] = [];
  const bandedOdf: Float32Array[] = [];
  for (const band of bands) {
    const f = bandpass(mono, sampleRate, band.lo, band.hi, band.poles ?? 2);
    filtered.push(f);
    bandedOdf.push(computeODF(f, sampleRate, odfRate));
  }
  return { bands, filtered, bandedOdf };
}

export type BeatKind = "kick" | "snare" | "hat" | "other";

export type BeatClassification = {
  kind: BeatKind;
  bandEnergies: number[]; // L1-normalized over the band set
  scores: { kick: number; snare: number; hat: number };
};

/**
 * Classify a single detected onset by which spectral band dominates within
 * a ±5 ms window around the peak. Returns a kind plus the full L1-normalized
 * band-energy vector so downstream code can do something fancier than
 * one-of-four bucketing if it wants to.
 *
 * The 0.5 score threshold for committing to a non-"other" kind matters:
 * tight enough that a kick+snare simultaneous hit lands as the louder one
 * (instead of being declared "other"), loose enough that a muddy mid-band
 * pulse stays in "other" rather than getting force-labeled.
 */
export function classifyBeat(
  peakOdfFrame: number,
  bandedOdf: Float32Array[],
  bands: BandSpec[] = DEFAULT_BANDS,
  odfRate: number = DEFAULT_ODF_RATE,
  windowMs: number = 5
): BeatClassification {
  const windowFrames = Math.max(1, Math.round((windowMs / 1000) * odfRate));
  const contribs: number[] = new Array(bands.length).fill(0);
  for (let b = 0; b < bands.length; b++) {
    const odf = bandedOdf[b];
    const start = Math.max(0, peakOdfFrame - windowFrames);
    const end = Math.min(odf.length, peakOdfFrame + windowFrames + 1);
    let peak = 0;
    for (let i = start; i < end; i++) {
      if (odf[i] > peak) peak = odf[i];
    }
    contribs[b] = peak;
  }

  const total = contribs.reduce((a, b) => a + b, 0);
  if (total < 1e-9) {
    return {
      kind: "other",
      bandEnergies: bands.map(() => 0),
      scores: { kick: 0, snare: 0, hat: 0 },
    };
  }
  const bandEnergies = contribs.map((c) => c / total);

  let kick = 0;
  let snare = 0;
  let hat = 0;
  for (let b = 0; b < bands.length; b++) {
    kick += bandEnergies[b] * bands[b].weights.kick;
    snare += bandEnergies[b] * bands[b].weights.snare;
    hat += bandEnergies[b] * bands[b].weights.hat;
  }

  let kind: BeatKind = "other";
  const max = Math.max(kick, snare, hat);
  if (max > 0.5) {
    if (max === kick) kind = "kick";
    else if (max === snare) kind = "snare";
    else kind = "hat";
  }
  return { kind, bandEnergies, scores: { kick, snare, hat } };
}

/**
 * Walk back from a detected peak on a band-filtered audio stream to find the
 * actual perceptual attack. The log-energy ODF peaks where the energy slope
 * is steepest — that's some way INTO the attack, not its start, because RMS
 * smooths out the instantaneous onset. Real perceptual onsets are at the
 * earliest point where the band's energy crosses up through some fraction
 * of the peak RMS — for percussion, 30% of peak captures the leading edge
 * cleanly without picking up earlier room noise.
 *
 * For synthetic click-track fixtures, the click IS the energy — RMS goes
 * from 0 to peak in a single frame, so backtrack returns the original peak
 * sample unchanged. The shift kicks in on real music where attacks have
 * finite rise time (5-30 ms).
 *
 * Returns the sample index of the attack. Constrain searchStart with
 * `prevPeakSample + minGapSamples` from the caller side to avoid backtracking
 * into a previous event's decay tail.
 */
export function backtrackToAttack(
  filteredBand: Float32Array,
  sampleRate: number,
  peakSample: number,
  opts: {
    maxBackMs?: number;
    rmsWindowMs?: number;
    thresholdRatio?: number;
    searchFloor?: number;
  } = {}
): number {
  const { maxBackMs = 30, rmsWindowMs = 2, thresholdRatio = 0.3, searchFloor = 0 } = opts;
  const maxBackSamples = Math.max(1, Math.round((maxBackMs / 1000) * sampleRate));
  const rmsHalf = Math.max(1, Math.round((rmsWindowMs / 1000) * sampleRate * 0.5));

  function rmsAt(idx: number): number {
    const a = Math.max(0, idx - rmsHalf);
    const b = Math.min(filteredBand.length, idx + rmsHalf + 1);
    let sum = 0;
    for (let i = a; i < b; i++) sum += filteredBand[i] * filteredBand[i];
    const n = Math.max(1, b - a);
    return Math.sqrt(sum / n);
  }

  const peakRms = rmsAt(peakSample);
  if (peakRms < 1e-9) return peakSample;
  const threshold = peakRms * thresholdRatio;
  const searchStart = Math.max(searchFloor, peakSample - maxBackSamples);

  for (let i = peakSample; i >= searchStart; i--) {
    if (rmsAt(i) < threshold) {
      // First sample WHERE energy crosses up through threshold = i+1.
      return Math.min(filteredBand.length - 1, i + 1);
    }
  }
  return peakSample;
}

// ─────────────────────────────────────────────────────────────────────────
// Tempo-locked beat grid + bar/phrase inference.
//
// This is the structural piece — given a global BPM and an ODF, we find the
// best phase such that beats laid out at perfectly regular `60/bpm` intervals
// land on ODF maxima. Once the grid phase is locked, raw detected peaks get
// snapped into grid slots, and slots with no nearby real peak get a
// synthetic beat (strength = local ODF) so downstream code sees a complete
// musical grid instead of a sparse list of detected onsets.
//
// The autocorrelation in `inferBarPhrase` runs over the resulting strength
// series at lags 4, 8, 16, 32 — picking the phase that puts the strongest
// beats on barPos 1 (and the start of phrases). This is the data Phase 1's
// `bestBeatForFrame` matcher has been ready to consume all along.
// ─────────────────────────────────────────────────────────────────────────

export type GridResult = {
  /** ODF-frame positions of each grid slot (rounded). */
  positions: number[];
  /** Phase offset in ODF frames (start of grid). */
  phaseFrames: number;
  /** Score of the winning phase (sum of local-max ODF at grid positions). */
  score: number;
};

/**
 * Build a perfectly regular beat grid at the given BPM, phase-locked to the
 * ODF. Tries `steps` candidate phases in `[0, beatPeriodFrames)` and picks
 * the one that maximizes the sum of local-max ODF in a ±2-frame window at
 * each grid position. Returns the positions plus the chosen phase.
 *
 * For tracks where the autocorrelation BPM estimate is solid, this gives
 * tight musical alignment. For free-time / rubato music, the phase fit will
 * still find SOME alignment but the score will be diffuse — caller should
 * gate on `bpmConfidence` before trusting the grid.
 */
export function buildTempoGrid(
  odf: Float32Array,
  bpm: number,
  odfRate: number,
  opts: { steps?: number; windowFrames?: number } = {}
): GridResult {
  const { steps = 50, windowFrames = 2 } = opts;
  if (bpm <= 0 || odf.length < 2) {
    return { positions: [], phaseFrames: 0, score: 0 };
  }

  const beatPeriodFrames = (60 / bpm) * odfRate;
  if (beatPeriodFrames < 1) {
    return { positions: [], phaseFrames: 0, score: 0 };
  }

  let bestScore = -Infinity;
  let bestPhase = 0;
  for (let s = 0; s < steps; s++) {
    const phase = (s / steps) * beatPeriodFrames;
    let score = 0;
    let k = 0;
    while (true) {
      const idx = Math.round(phase + k * beatPeriodFrames);
      if (idx >= odf.length) break;
      // local-max in ±windowFrames so we don't penalize being 1-2 frames off.
      const a = Math.max(0, idx - windowFrames);
      const b = Math.min(odf.length, idx + windowFrames + 1);
      let local = 0;
      for (let i = a; i < b; i++) {
        if (odf[i] > local) local = odf[i];
      }
      score += local;
      k++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }

  const positions: number[] = [];
  let k = 0;
  while (true) {
    const pos = Math.round(bestPhase + k * beatPeriodFrames);
    if (pos >= odf.length) break;
    positions.push(pos);
    k++;
  }
  return { positions, phaseFrames: bestPhase, score: bestScore };
}

/**
 * For each grid slot, find the strongest detected peak within `toleranceMs`
 * and snap it to the slot frame. Slots with no nearby peak get a synthetic
 * beat (strength = local-max ODF in a small window, `synthetic: true`).
 *
 * Returns peaks tagged `synthetic: false` for real detections (with their
 * strength preserved) and `synthetic: true` for slots filled from ODF.
 */
export type GridSnappedPeak = Peak & { synthetic: boolean; originalFrame?: number };

export function snapToGrid(
  peaks: Peak[],
  grid: number[],
  odf: Float32Array,
  odfRate: number,
  toleranceMs: number = 80
): GridSnappedPeak[] {
  const toleranceFrames = (toleranceMs / 1000) * odfRate;
  const result: GridSnappedPeak[] = [];
  // Track which peaks have been consumed so we don't double-assign.
  const used = new Set<number>();
  for (const g of grid) {
    let best = -1;
    let bestStrength = -Infinity;
    for (let p = 0; p < peaks.length; p++) {
      if (used.has(p)) continue;
      const dist = Math.abs(peaks[p].frame - g);
      if (dist > toleranceFrames) continue;
      if (peaks[p].strength > bestStrength) {
        bestStrength = peaks[p].strength;
        best = p;
      }
    }
    if (best >= 0) {
      used.add(best);
      result.push({
        ...peaks[best],
        frame: g,
        time: g / odfRate,
        synthetic: false,
        originalFrame: peaks[best].frame,
      });
    } else {
      // Synthesize a beat at this grid slot. Strength = local-max ODF nearby
      // so a "rest" slot with no audible onset still has a small non-zero
      // value the matcher can weight against real strong hits.
      const a = Math.max(0, g - 1);
      const b = Math.min(odf.length, g + 2);
      let local = 0;
      for (let i = a; i < b; i++) if (odf[i] > local) local = odf[i];
      result.push({
        frame: g,
        time: g / odfRate,
        strength: local,
        synthetic: true,
      });
    }
  }
  return result;
}

/**
 * Infer bar position (1..4) and phrase position (0..L-1) for a tempo-locked
 * beat list. Picks the best 4-beat phase by autocorrelating the strength
 * series at lag 4; if the choice is ambiguous (within 10% of the second-best),
 * tie-breaks by which phase aligns more kicks onto barPos 1.
 *
 * Phrase length: tries L=16 and L=32, picks whichever has the stronger
 * autocorrelation peak. This handles both pop (4-bar phrases) and EDM
 * (8-bar phrases) without configuration.
 *
 * Returns the bar phase, phrase length, and phrase phase. Callers apply
 * these by computing `(beatIndex - barPhase) mod 4` for barPos and
 * `(beatIndex - phrasePhase) mod phraseLen` for phrasePos.
 */
export type StructureInference = {
  barPhase: number;       // 0..3 — index offset that makes barPos == 1
  phraseLen: 16 | 32;
  phrasePhase: number;    // 0..phraseLen-1
  confidence: number;     // 0..1, autocorrelation peak strength
};

export function inferBarPhrase(
  strengths: number[],
  kinds: Array<string | undefined> = []
): StructureInference {
  if (strengths.length < 8) {
    return { barPhase: 0, phraseLen: 16, phrasePhase: 0, confidence: 0 };
  }

  // ─── bar phase (lag 4) ───────────────────────────────────────────────
  const barScores = [0, 0, 0, 0];
  for (let phase = 0; phase < 4; phase++) {
    for (let i = phase; i < strengths.length; i += 4) {
      barScores[phase] += strengths[i];
    }
  }
  let bestBarPhase = 0;
  let secondBest = 0;
  let bestBarScore = -Infinity;
  let secondBarScore = -Infinity;
  for (let phase = 0; phase < 4; phase++) {
    if (barScores[phase] > bestBarScore) {
      secondBarScore = bestBarScore;
      secondBest = bestBarPhase;
      bestBarScore = barScores[phase];
      bestBarPhase = phase;
    } else if (barScores[phase] > secondBarScore) {
      secondBarScore = barScores[phase];
      secondBest = phase;
    }
  }

  // Tie-break: if best and second-best are within 10%, prefer the phase
  // that aligns more `kick` beats onto barPos 1.
  if (secondBarScore > 0 && bestBarScore - secondBarScore < bestBarScore * 0.1 && kinds.length > 0) {
    const kickAt = (phase: number) => {
      let n = 0;
      for (let i = phase; i < kinds.length; i += 4) {
        if (kinds[i] === "kick") n++;
      }
      return n;
    };
    if (kickAt(secondBest) > kickAt(bestBarPhase)) bestBarPhase = secondBest;
  }

  // ─── phrase length + phase (lag 16 vs 32) ────────────────────────────
  //
  // Compare PER-SAMPLE averages rather than raw sums. Raw sums are biased
  // toward shorter lags (lag 16 has 2× the terms of lag 32 in any signal,
  // so its sum is naturally bigger). The per-sample average answers the
  // right question: "does every Nth slot carry above-average strength?"
  function evalPhrase(L: 16 | 32): { phase: number; score: number; avg: number } {
    let bestPhase = 0;
    let bestSum = -Infinity;
    let bestCount = 0;
    for (let phase = 0; phase < L; phase++) {
      let s = 0;
      let n = 0;
      for (let i = phase; i < strengths.length; i += L) {
        s += strengths[i];
        n++;
      }
      if (s > bestSum) {
        bestSum = s;
        bestPhase = phase;
        bestCount = n;
      }
    }
    return {
      phase: bestPhase,
      score: bestSum,
      avg: bestCount > 0 ? bestSum / bestCount : 0,
    };
  }
  const p16 = evalPhrase(16);
  const p32 = evalPhrase(32);
  const phraseLen: 16 | 32 = p32.avg > p16.avg * 1.1 ? 32 : 16;
  const phrasePhase = phraseLen === 32 ? p32.phase : p16.phase;

  // Confidence = how dominant the winning bar phase is over the others.
  const totalBar = barScores.reduce((a, b) => a + b, 0);
  const confidence = totalBar > 0 ? bestBarScore / totalBar - 0.25 : 0;

  return {
    barPhase: bestBarPhase,
    phraseLen,
    phrasePhase,
    confidence: Math.max(0, Math.min(1, confidence * 4)),
  };
}
