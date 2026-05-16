/**
 * Rule-based genre / rhythm classification.
 *
 * Aggregates per-frame features into song-level statistics, then runs a
 * decision tree to label the track. The labels are coarse on purpose —
 * the downstream visual layer needs a STYLE TARGET, not a Spotify-grade
 * sub-genre tag. "edm vs hiphop vs ballad" is enough to pick a palette
 * and a motion vocabulary.
 *
 * Orthogonal axes (bpmClass, subBassClass, brightClass, grooveClass,
 * intensityProfile) capture variance the genre tag alone can't — e.g.
 * "general / slow / heavy / warm / sparse / sustain" describes a
 * down-tempo lo-fi track that doesn't fit any genre cleanly but still
 * has a clear visual treatment (warm palette, restrained motion, slow
 * camera).
 */

export type GenreLabel =
  | "edm"
  | "house"
  | "trap"
  | "hiphop"
  | "drum_and_bass"
  | "pop"
  | "rock"
  | "ballad"
  | "lofi"
  | "general";

export type BpmClass = "slow" | "mid" | "fast" | "dnb";
export type SubBassClass = "thin" | "balanced" | "heavy";
export type BrightClass = "dark" | "warm" | "neutral" | "bright";
export type GrooveClass = "sparse" | "moderate" | "dense" | "relentless";
export type IntensityProfile = "build" | "sustain" | "decline" | "varied";

export type Classification = {
  genre: GenreLabel;
  bpmClass: BpmClass;
  subBassClass: SubBassClass;
  brightClass: BrightClass;
  grooveClass: GrooveClass;
  intensityProfile: IntensityProfile;
  /** Confidence 0..1 — how clearly the classifier landed on `genre`. */
  confidence: number;
};

/**
 * Aggregated features computed from per-frame curves over the whole song.
 * These are the inputs to `classify()`.
 */
export type ClassifierFeatures = {
  bpm: number;
  bpmConfidence: number;
  bpmStability: number;          // 1 / (number of tempo segments) — higher = steadier
  subBassRatioMean: number;      // 0..1 — sub_kick / total RMS, averaged
  brightnessNorm: number;        // spectral centroid mean / (sampleRate * 0.5)
  brightnessVar: number;         // variance of centroid over song, normalized
  fluxMean: number;              // normalized flux mean
  flatnessMean: number;          // mean spectral flatness
  onsetRate: number;             // beats per second over song
  energyMean: number;            // total energy mean (0..1)
  energySlope: number;           // (last-quarter energy mean) - (first-quarter energy mean)
};

/** Compute per-axis classes from features (no genre yet). */
function classifyAxes(f: ClassifierFeatures): {
  bpmClass: BpmClass;
  subBassClass: SubBassClass;
  brightClass: BrightClass;
  grooveClass: GrooveClass;
  intensityProfile: IntensityProfile;
} {
  const bpmClass: BpmClass =
    f.bpm < 90 ? "slow" : f.bpm < 130 ? "mid" : f.bpm < 170 ? "fast" : "dnb";

  const subBassClass: SubBassClass =
    f.subBassRatioMean < 0.18 ? "thin" : f.subBassRatioMean < 0.32 ? "balanced" : "heavy";

  // brightnessNorm is centroid / Nyquist. 0.04 = ~880Hz at 44.1k, 0.10 = ~2.2kHz,
  // 0.18 = ~4kHz. Real music sits between 0.02 and 0.25.
  const brightClass: BrightClass =
    f.brightnessNorm < 0.05 ? "dark"
    : f.brightnessNorm < 0.10 ? "warm"
    : f.brightnessNorm < 0.18 ? "neutral"
    : "bright";

  const grooveClass: GrooveClass =
    f.onsetRate < 2 ? "sparse"
    : f.onsetRate < 4 ? "moderate"
    : f.onsetRate < 6 ? "dense"
    : "relentless";

  const intensityProfile: IntensityProfile =
    Math.abs(f.energySlope) < 0.08 ? "sustain"
    : f.energySlope > 0.08 ? "build"
    : f.energySlope < -0.08 ? "decline"
    : "varied";

  return { bpmClass, subBassClass, brightClass, grooveClass, intensityProfile };
}

/**
 * Pick a genre label from features. Cascade of rule conditions: the most
 * specific match wins; default is "general" so we never block downstream
 * (the palette and motion fall back to a neutral "title/promo" treatment).
 */
function pickGenre(f: ClassifierFeatures): { genre: GenreLabel; confidence: number } {
  // Drum & bass: very fast tempo + dense onsets.
  if (f.bpm >= 160 && f.onsetRate >= 5) {
    return { genre: "drum_and_bass", confidence: 0.8 };
  }
  // House / EDM: 120-135 BPM, heavy sub-bass, dense regular onsets.
  if (
    f.bpm >= 118 &&
    f.bpm <= 138 &&
    f.subBassRatioMean >= 0.25 &&
    f.onsetRate >= 3.5
  ) {
    if (f.flatnessMean > 0.2) return { genre: "edm", confidence: 0.75 };
    return { genre: "house", confidence: 0.7 };
  }
  // Trap: 130-160 BPM (half-time feel of 65-80), heavy sub-bass, often
  // sparse main beats with dense hi-hat rolls. We catch the half-time
  // version (65-80 BPM detected) with heavy sub — leaves 80+ to hip-hop.
  // The deciding factor is brightness: trap tracks have bright hat rolls
  // visible in the high band, so brightnessVar tends to be elevated.
  if (
    ((f.bpm >= 130 && f.bpm <= 160) || (f.bpm >= 65 && f.bpm < 80)) &&
    f.subBassRatioMean >= 0.32 &&
    f.brightnessNorm < 0.10
  ) {
    return { genre: "trap", confidence: 0.65 };
  }
  // Hip-hop: 70-100 BPM, heavy/balanced sub-bass, warm-to-neutral brightness,
  // moderate groove.
  if (
    f.bpm >= 70 &&
    f.bpm <= 105 &&
    f.subBassRatioMean >= 0.22 &&
    f.brightnessNorm < 0.12 &&
    f.onsetRate >= 1.5
  ) {
    return { genre: "hiphop", confidence: 0.65 };
  }
  // Pop: 90-130 BPM, balanced spectrum, moderate density.
  if (
    f.bpm >= 90 &&
    f.bpm <= 130 &&
    f.subBassRatioMean >= 0.15 &&
    f.subBassRatioMean < 0.32 &&
    f.brightnessNorm >= 0.08 &&
    f.brightnessNorm < 0.18 &&
    f.onsetRate >= 2.5
  ) {
    return { genre: "pop", confidence: 0.6 };
  }
  // Rock: 100-160 BPM, neutral/bright spectrum (guitars + cymbals), moderate
  // sub-bass, dense onsets, high flux (lots of timbral change).
  if (
    f.bpm >= 100 &&
    f.bpm <= 165 &&
    f.brightnessNorm >= 0.12 &&
    f.fluxMean >= 0.4 &&
    f.onsetRate >= 3
  ) {
    return { genre: "rock", confidence: 0.55 };
  }
  // Ballad: slow, sparse, warm/dark, low flux.
  if (
    f.bpm < 100 &&
    f.onsetRate < 2.5 &&
    f.brightnessNorm < 0.12 &&
    f.fluxMean < 0.4
  ) {
    return { genre: "ballad", confidence: 0.55 };
  }
  // Lofi: slow, warm, dark, low energy, low flatness (tonal, not noisy).
  if (
    f.bpm < 100 &&
    f.brightnessNorm < 0.08 &&
    f.energyMean < 0.45 &&
    f.flatnessMean < 0.15
  ) {
    return { genre: "lofi", confidence: 0.55 };
  }
  // Fallback.
  return { genre: "general", confidence: 0.4 };
}

export function classify(f: ClassifierFeatures): Classification {
  const axes = classifyAxes(f);
  const { genre, confidence } = pickGenre(f);
  // Reduce confidence when BPM detection itself was weak.
  const adjustedConfidence = confidence * Math.min(1, Math.max(0.5, f.bpmConfidence * 1.5));
  return {
    genre,
    ...axes,
    confidence: Math.round(adjustedConfidence * 100) / 100,
  };
}

/**
 * Compute aggregated features from FPS-rate curves. Convenience for
 * analyze.ts so it doesn't have to compute means inline.
 */
export function aggregateFeatures(opts: {
  bpm: number;
  bpmConfidence: number;
  numTempoSegments: number;
  durationSec: number;
  beatFrames: number[];
  fps: number;
  sampleRate: number;
  subBassEnvelope: number[];
  totalEnvelope: number[];
  centroidHz: number[];
  fluxRaw: number[];
  flatness: number[];
  energy: number[];
}): ClassifierFeatures {
  const safeMean = (arr: number[]): number => {
    if (arr.length === 0) return 0;
    let sum = 0;
    for (const v of arr) sum += v;
    return sum / arr.length;
  };
  const safeVar = (arr: number[], mean: number): number => {
    if (arr.length === 0) return 0;
    let sum = 0;
    for (const v of arr) sum += (v - mean) * (v - mean);
    return sum / arr.length;
  };

  // Sub-bass ratio: subBass / total, per-frame, then mean.
  const subRatios: number[] = [];
  for (let i = 0; i < opts.subBassEnvelope.length; i++) {
    const total = opts.totalEnvelope[i] ?? 0;
    if (total > 1e-6) subRatios.push(opts.subBassEnvelope[i] / total);
  }
  const subBassRatioMean = safeMean(subRatios);

  const nyquist = opts.sampleRate * 0.5;
  const centroidMean = safeMean(opts.centroidHz);
  const brightnessNorm = nyquist > 0 ? centroidMean / nyquist : 0;
  const brightnessVar = safeVar(
    opts.centroidHz.map((c) => c / Math.max(1, nyquist)),
    brightnessNorm
  );

  const flatnessMean = safeMean(opts.flatness);

  // Normalize flux against its own max so different songs are comparable.
  const fluxMax = Math.max(1e-9, ...opts.fluxRaw);
  const fluxMean = safeMean(opts.fluxRaw.map((f) => f / fluxMax));

  const onsetRate = opts.durationSec > 0 ? opts.beatFrames.length / opts.durationSec : 0;
  const energyMean = safeMean(opts.energy);

  // Energy slope: last quarter mean - first quarter mean.
  const q = Math.max(1, Math.floor(opts.energy.length / 4));
  const firstQ = safeMean(opts.energy.slice(0, q));
  const lastQ = safeMean(opts.energy.slice(opts.energy.length - q));
  const energySlope = lastQ - firstQ;

  const bpmStability = 1 / Math.max(1, opts.numTempoSegments);

  return {
    bpm: opts.bpm,
    bpmConfidence: opts.bpmConfidence,
    bpmStability,
    subBassRatioMean,
    brightnessNorm,
    brightnessVar,
    fluxMean,
    flatnessMean,
    onsetRate,
    energyMean,
    energySlope,
  };
}
