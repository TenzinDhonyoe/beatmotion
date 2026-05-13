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

export const DEFAULT_ODF_RATE = 200; // Hz — 5 ms hop, good for typical pop/EDM onsets.
export const DEFAULT_MIN_BPM = 60;
export const DEFAULT_MAX_BPM = 200;

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
      if (odf[i] > peaks[peaks.length - 1].strength) {
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
