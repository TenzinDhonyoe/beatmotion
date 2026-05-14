#!/usr/bin/env bun
/**
 * beatmotion analyze — detect beats, BPM, drops, and sections in an audio file.
 *
 * Signal processing runs at the file's native sample rate. BPM is detected via
 * autocorrelation of an onset envelope so it works for any tempo (60–200 BPM
 * out of the box) and any sample rate the decoder produces.
 *
 * Usage: bun run bin/beatmotion-analyze.ts <audio> [--fps 30] [--min-bpm 60] [--max-bpm 200] [--delta 0.7] [--out path]
 *
 * Writes <audio-basename>.beats.json next to the audio file (or to --out).
 */
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import decode from "audio-decode";
import {
  DEFAULT_ODF_RATE,
  DEFAULT_BANDS,
  backtrackToAttack,
  buildTempoGrid,
  classifyBeat,
  computeBandedAudio,
  computeODF,
  detectBpm,
  findPeaks,
  inferBarPhrase,
  mixToMono,
  snapToGrid,
  tempogram,
  type BeatKind,
  type GridSnappedPeak,
} from "./dsp.ts";

type Args = {
  audio: string;
  fps: number;
  minBpm: number;
  maxBpm: number;
  delta: number;
  odfRate: number;
  out: string | null;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    audio: "",
    fps: 30,
    minBpm: 60,
    maxBpm: 200,
    delta: 0.7,
    odfRate: DEFAULT_ODF_RATE,
    out: null,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--fps") args.fps = Number(rest[++i]);
    else if (a === "--min-bpm") args.minBpm = Number(rest[++i]);
    else if (a === "--max-bpm") args.maxBpm = Number(rest[++i]);
    else if (a === "--delta") args.delta = Number(rest[++i]);
    else if (a === "--odf-rate") args.odfRate = Number(rest[++i]);
    else if (a === "--out") args.out = rest[++i];
    else if (a === "-h" || a === "--help") {
      console.log(
        "Usage: beatmotion-analyze <audio> [--fps 30] [--min-bpm 60] [--max-bpm 200] [--delta 0.7] [--odf-rate 200] [--out beats.json]"
      );
      process.exit(0);
    } else if (!args.audio) args.audio = a;
  }
  if (!args.audio) {
    console.error("error: audio file required");
    process.exit(1);
  }
  if (!Number.isFinite(args.fps) || args.fps <= 0) {
    console.error("error: --fps must be a positive number");
    process.exit(1);
  }
  if (args.minBpm <= 0 || args.maxBpm <= args.minBpm) {
    console.error("error: --min-bpm must be > 0 and < --max-bpm");
    process.exit(1);
  }
  return args;
}

type Beat = {
  time: number;
  frame: number;
  strength: number;
  kind?: BeatKind;
  bandEnergies?: number[];
  attackBacktrackMs?: number;
  barPos?: 1 | 2 | 3 | 4;
  phrasePos?: number;
  downbeat?: boolean;
  synthetic?: boolean;
};
type Drop = { time: number; frame: number; kind: string };
type Section = { start: number; end: number; kind: string };

// Top-level confidence gate for tempo-locking. Below this, we keep raw peaks
// instead of building a grid — protects rubato / free-time music from getting
// force-quantized to a bogus grid.
const GRID_CONFIDENCE_FLOOR = 0.4;

function computeEnergyEnvelope(
  samples: Float32Array,
  sampleRate: number,
  windowSec: number
): { times: number[]; energy: number[] } {
  const windowSize = Math.max(1, Math.floor(sampleRate * windowSec));
  const numWindows = Math.floor(samples.length / windowSize);
  const times: number[] = [];
  const energy: number[] = [];
  for (let w = 0; w < numWindows; w++) {
    let sum = 0;
    const start = w * windowSize;
    for (let i = 0; i < windowSize; i++) {
      const s = samples[start + i];
      sum += s * s;
    }
    times.push((start + windowSize / 2) / sampleRate);
    energy.push(Math.sqrt(sum / windowSize));
  }
  return { times, energy };
}

/**
 * Compute coarse per-band RMS at the same resolution as `computeEnergyEnvelope`.
 * Used by `detectDropsAndSections` for spectral drop scoring (sub-bass surge,
 * high-band brightness dip).
 */
function computeBandedRms(
  filtered: Float32Array[],
  sampleRate: number,
  windowSec: number
): number[][] {
  return filtered.map((band) => {
    const env = computeEnergyEnvelope(band, sampleRate, windowSec);
    return env.energy;
  });
}

function smooth(values: number[], radius: number): number[] {
  const out = new Array(values.length).fill(0);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
      sum += values[j];
      count++;
    }
    out[i] = sum / count;
  }
  return out;
}

type DropDetail = {
  jumpMag: number;
  subSurge: number;
  brightDip: number;
  score: number;
};

function detectDropsAndSections(
  times: number[],
  energy: number[],
  fps: number,
  bandedRms?: number[][] // optional — when provided, enables spectral scoring
): { drops: (Drop & Partial<DropDetail>)[]; sections: Section[] } {
  if (energy.length === 0) return { drops: [], sections: [] };

  const smoothed = smooth(energy, 3);
  const maxEnergy = Math.max(...smoothed);
  const minEnergy = Math.min(...smoothed);
  const range = maxEnergy - minEnergy || 1;
  const normalized = smoothed.map((e) => (e - minEnergy) / range);

  // Spectral character series. subRatio: how much of the energy is sub-bass
  // (a real drop is preceded by a low-frequency surge). brightness: how much
  // is in the air band (a build-up's white-noise riser raises this; the drop
  // moment itself sees brightness DROP as the riser cuts and kick takes over).
  // bandedRms layout matches DEFAULT_BANDS in dsp.ts: [sub_kick, low_body,
  // snare_body, snare_brt, hat_air].
  let subRatio: number[] = [];
  let brightness: number[] = [];
  if (bandedRms && bandedRms.length === 5) {
    const n = Math.min(times.length, bandedRms[0].length);
    for (let i = 0; i < n; i++) {
      const total = bandedRms.reduce((a, b) => a + (b[i] ?? 0), 0) || 1;
      subRatio.push((bandedRms[0][i] ?? 0) / total);
      brightness.push((bandedRms[4][i] ?? 0) / total);
    }
  }

  const highThreshold = 0.65;
  const dropCandidates: Array<{ i: number; detail: DropDetail }> = [];
  let inHigh = normalized[0] >= highThreshold;
  for (let i = 1; i < normalized.length; i++) {
    const wasLow = !inHigh;
    const nowHigh = normalized[i] >= highThreshold;
    if (wasLow && nowHigh) {
      const lookahead = normalized.slice(i, Math.min(i + 4, normalized.length));
      const avg = lookahead.reduce((a, b) => a + b, 0) / lookahead.length;
      if (avg >= highThreshold * 0.9) {
        const jumpMag = normalized[i] - (i > 0 ? normalized[i - 1] : 0);
        let subSurge = 0;
        let brightDip = 0;
        if (subRatio.length > 0 && i < subRatio.length) {
          const subPrior =
            (subRatio.slice(Math.max(0, i - 4), i).reduce((a, b) => a + b, 0) /
              Math.max(1, Math.min(i, 4))) || 0;
          subSurge = subRatio[i] - subPrior;
          const brightLeading =
            (brightness
              .slice(Math.max(0, i - 2), i + 1)
              .reduce((a, b) => a + b, 0) / 3) || 0;
          const brightTrailing =
            (brightness
              .slice(i + 1, Math.min(brightness.length, i + 4))
              .reduce((a, b) => a + b, 0) /
              Math.max(1, Math.min(brightness.length - i - 1, 3))) || 0;
          brightDip = brightLeading - brightTrailing;
        }
        const score = 0.5 * jumpMag + 0.3 * subSurge + 0.2 * brightDip;
        // Keep all candidates that clear the energy threshold + 6 s gap.
        const last = dropCandidates.at(-1);
        if (!last || times[i] - times[last.i] >= 6) {
          dropCandidates.push({ i, detail: { jumpMag, subSurge, brightDip, score } });
        } else if (score > last.detail.score) {
          // Replace the earlier weaker candidate within the 6 s window with
          // this stronger one — same logic the energy-only path used.
          dropCandidates[dropCandidates.length - 1] = {
            i,
            detail: { jumpMag, subSurge, brightDip, score },
          };
        }
      }
    }
    inHigh = nowHigh;
  }

  // Top-scoring candidate = main_drop. Others = secondary.
  let mainPos = -1;
  let mainScore = -Infinity;
  for (let p = 0; p < dropCandidates.length; p++) {
    if (dropCandidates[p].detail.score > mainScore) {
      mainScore = dropCandidates[p].detail.score;
      mainPos = p;
    }
  }

  const drops: (Drop & Partial<DropDetail>)[] = dropCandidates.map((c, p) => ({
    time: times[c.i],
    frame: Math.round(times[c.i] * fps),
    kind: p === mainPos ? "main_drop" : "secondary_drop",
    jumpMag: Math.round(c.detail.jumpMag * 1000) / 1000,
    subSurge: Math.round(c.detail.subSurge * 1000) / 1000,
    brightDip: Math.round(c.detail.brightDip * 1000) / 1000,
    score: Math.round(c.detail.score * 1000) / 1000,
  }));

  const sections: Section[] = [];
  let sectionStart = 0;
  let currentKind = normalized[0] >= highThreshold ? "main" : "intro";
  for (let i = 1; i < normalized.length; i++) {
    const wasHigh = normalized[i - 1] >= highThreshold;
    const nowHigh = normalized[i] >= highThreshold;
    if (wasHigh !== nowHigh) {
      sections.push({ start: times[sectionStart], end: times[i], kind: currentKind });
      sectionStart = i;
      currentKind = nowHigh ? "main" : "break";
    }
  }
  const lastKind = currentKind === "main" ? "main" : sections.length > 0 ? "outro" : "intro";
  sections.push({ start: times[sectionStart], end: times[times.length - 1], kind: lastKind });
  if (sections.length > 0) sections[0].start = 0;

  return { drops, sections };
}

async function main() {
  const args = parseArgs(process.argv);
  const audioPath = resolve(args.audio);

  console.error(`reading ${audioPath}`);
  const buf = await readFile(audioPath);

  console.error("decoding...");
  let decoded;
  try {
    decoded = await decode(new Uint8Array(buf));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const ext = audioPath.slice(audioPath.lastIndexOf(".")).toLowerCase();
    if (ext === ".mp3") {
      console.error(
        `\nerror: MP3 decode failed (${msg.split("\n")[0]}).\n` +
          `Some real-world MP3s trip the bundled decoder. Convert to WAV and retry:\n` +
          `  macOS:        afconvert -f WAVE -d LEI16 "${audioPath}" "${audioPath.replace(/\.mp3$/i, ".wav")}"\n` +
          `  cross-platform: ffmpeg -i "${audioPath}" "${audioPath.replace(/\.mp3$/i, ".wav")}"\n` +
          `Then: bun run bin/analyze.ts "${audioPath.replace(/\.mp3$/i, ".wav")}"`
      );
    } else {
      console.error(`error: audio decode failed for ${audioPath}: ${msg}`);
    }
    process.exit(1);
  }
  const { channelData, sampleRate } = decoded;
  const duration = channelData[0].length / sampleRate;
  console.error(
    `decoded: ${duration.toFixed(2)}s @ ${sampleRate}Hz, ${channelData.length} channel(s)`
  );

  const mono = mixToMono(channelData);

  console.error(`computing onset envelope (ODF rate ${args.odfRate} Hz, native ${sampleRate} Hz)...`);
  const odf = computeODF(mono, sampleRate, args.odfRate);

  console.error("detecting BPM via autocorrelation...");
  const { bpm: globalBpm, confidence } = detectBpm(odf, args.odfRate, {
    minBpm: args.minBpm,
    maxBpm: args.maxBpm,
  });
  console.error(
    `BPM ${globalBpm.toFixed(2)} (confidence ${(confidence * 100).toFixed(0)}%)`
  );

  console.error("building dynamic BPM curve (tempogram)...");
  const bpmCurve = tempogram(odf, args.odfRate, {
    minBpm: args.minBpm,
    maxBpm: args.maxBpm,
    windowSec: 6,
    hopSec: 1,
  });

  // BPM fallback: when the global AC is weak (variable-tempo tracks smear
  // the autocorrelation across multiple lags), trust the highest-confidence
  // local window from the tempogram instead. A track with a clear intro
  // groove that drifts mid-song will have a global AC peak near 0 but a
  // local AC peak in the intro near 0.7+. Using the local one gives the
  // grid something musical to lock to instead of guessing at the lag floor.
  let effectiveBpm = globalBpm;
  let effectiveConfidence = confidence;
  if (confidence < 0.4 && bpmCurve.length >= 3) {
    let bestLocal = bpmCurve[0];
    for (const pt of bpmCurve) {
      if (pt.confidence > bestLocal.confidence) bestLocal = pt;
    }
    if (bestLocal.confidence > confidence * 2 && bestLocal.confidence >= 0.5) {
      console.error(
        `global BPM ${globalBpm.toFixed(1)} weak (${(confidence * 100).toFixed(0)}%) — switching to tempogram best: ${bestLocal.bpm.toFixed(1)} BPM @ ${(bestLocal.confidence * 100).toFixed(0)}%`
      );
      effectiveBpm = bestLocal.bpm;
      effectiveConfidence = bestLocal.confidence;
    }
  }

  console.error("picking onsets...");
  // Min interval = a little tighter than max BPM so we can catch 8th notes if
  // they're stronger than expected — the BPM number itself is not derived
  // from peak count, so the peak picker just needs to be permissive enough
  // to surface useful animation anchor points.
  const minInterval = 60 / Math.max(args.maxBpm, 240);
  const peaks = findPeaks(odf, args.odfRate, {
    minIntervalSec: minInterval,
    delta: args.delta,
  });
  console.error(`found ${peaks.length} onsets`);

  // Multi-band drum classification + per-beat attack backtrack.
  //
  // Each detected peak is classified (kick / snare / hat / other) by which
  // spectral band dominates within ±5 ms. The peak time is then shifted
  // earlier to the true perceptual attack on the dominant band — for real
  // music, energy rises 5–30 ms after the attack starts, so the ODF peak
  // is systematically late. On synthetic clicks the energy is instantaneous
  // and backtrack returns the same sample, so this is a no-op for the
  // existing test fixtures.
  console.error(`band-filtering (${DEFAULT_BANDS.length} bands)...`);
  const banded = computeBandedAudio(mono, sampleRate, DEFAULT_BANDS, args.odfRate);
  console.error("classifying beats + aligning attacks...");

  const maxStrength = peaks.reduce((m, p) => Math.max(m, p.strength), 0) || 1;
  let prevAttackSample = -1;
  const minGapSamples = Math.round(0.02 * sampleRate); // 20 ms guard
  const beats: Beat[] = peaks.map((p) => {
    const cls = classifyBeat(p.frame, banded.bandedOdf, DEFAULT_BANDS, args.odfRate);
    // Dominant band by raw L1-normalized energy.
    let domIdx = 0;
    let domEnergy = -1;
    for (let b = 0; b < cls.bandEnergies.length; b++) {
      if (cls.bandEnergies[b] > domEnergy) {
        domEnergy = cls.bandEnergies[b];
        domIdx = b;
      }
    }
    const peakSample = Math.round(p.time * sampleRate);
    const attackFloor = prevAttackSample >= 0 ? prevAttackSample + minGapSamples : 0;
    const attackSample = backtrackToAttack(banded.filtered[domIdx], sampleRate, peakSample, {
      searchFloor: attackFloor,
    });
    prevAttackSample = attackSample;
    const attackTime = attackSample / sampleRate;
    const shiftMs = Math.round((p.time - attackTime) * 1000);
    return {
      time: Math.round(attackTime * 1000) / 1000,
      frame: Math.round(attackTime * args.fps),
      strength: Math.round((p.strength / maxStrength) * 1000) / 1000,
      kind: cls.kind,
      bandEnergies: cls.bandEnergies.map((e) => Math.round(e * 1000) / 1000),
      ...(shiftMs > 0 ? { attackBacktrackMs: shiftMs } : {}),
    };
  });

  // ─── Phase 3: tempo-locked grid + bar/phrase inference ───
  //
  // If the global BPM estimate is confident enough, build a perfectly
  // regular grid at that tempo phase-locked to the ODF. Then snap each
  // detected peak into a grid slot and synthesize "rest" beats where no
  // onset landed — downstream code sees a complete musical grid instead
  // of a sparse list of detected events. Autocorrelation of the grid's
  // strength series then identifies bar position (1..4) and phrase start.
  //
  // Below the confidence floor we skip the grid entirely and keep raw
  // peaks. Rubato / free-time / classical music gets the old behaviour;
  // pop / EDM / hip-hop with steady tempo gets the structured grid.
  let gridLocked = false;
  let gridPhaseFrames = 0;
  let phrases: Array<{ startBeat: number; endBeat: number; startFrame: number; endFrame: number }> = [];

  if (effectiveConfidence >= GRID_CONFIDENCE_FLOOR && effectiveBpm > 0) {
    console.error(`tempo-locking grid at ${effectiveBpm.toFixed(2)} BPM...`);
    const grid = buildTempoGrid(odf, effectiveBpm, args.odfRate);
    if (grid.positions.length >= 4) {
      const snapped: GridSnappedPeak[] = snapToGrid(
        peaks,
        grid.positions,
        odf,
        args.odfRate,
        80
      );
      console.error(
        `grid: ${grid.positions.length} slots, ${snapped.filter((s) => !s.synthetic).length} real, ${snapped.filter((s) => s.synthetic).length} synthetic`
      );

      // Build the grid-locked beat list. Real snapped peaks inherit their
      // original classification + backtrack from the Phase 2 beats array
      // (matched by originalFrame). Synthetic beats are classified at their
      // grid position so they still carry a `kind` field for downstream
      // routing (a "rest" with sub-band energy still gets `kind: "kick"`).
      const gridBeats: Beat[] = snapped.map((sp) => {
        const timeSec = sp.frame / args.odfRate;
        const frame = Math.round(timeSec * args.fps);
        if (sp.synthetic) {
          const cls = classifyBeat(sp.frame, banded.bandedOdf, DEFAULT_BANDS, args.odfRate);
          const localStrength = Math.round((sp.strength / maxStrength) * 1000) / 1000;
          return {
            time: Math.round(timeSec * 1000) / 1000,
            frame,
            strength: localStrength,
            kind: cls.kind,
            bandEnergies: cls.bandEnergies.map((e) => Math.round(e * 1000) / 1000),
            synthetic: true,
          };
        }
        const origIdx = peaks.findIndex((p) => p.frame === sp.originalFrame);
        if (origIdx >= 0) {
          return {
            ...beats[origIdx],
            time: Math.round(timeSec * 1000) / 1000,
            frame,
            synthetic: false,
          };
        }
        return {
          time: Math.round(timeSec * 1000) / 1000,
          frame,
          strength: Math.round((sp.strength / maxStrength) * 1000) / 1000,
          synthetic: false,
        };
      });

      // Bar/phrase inference on the locked grid.
      const strengths = gridBeats.map((b) => b.strength);
      const kinds = gridBeats.map((b) => b.kind);
      const structure = inferBarPhrase(strengths, kinds);
      console.error(
        `structure: barPhase=${structure.barPhase}, phraseLen=${structure.phraseLen}, phrasePhase=${structure.phrasePhase}, confidence=${(structure.confidence * 100).toFixed(0)}%`
      );

      for (let i = 0; i < gridBeats.length; i++) {
        const b = gridBeats[i];
        const barIdx = ((i - structure.barPhase) % 4 + 4) % 4;
        const phraseIdx = ((i - structure.phrasePhase) % structure.phraseLen + structure.phraseLen) % structure.phraseLen;
        b.barPos = (barIdx + 1) as 1 | 2 | 3 | 4;
        b.phrasePos = phraseIdx;
        b.downbeat = b.barPos === 1 && phraseIdx === 0;
      }

      // Build phrase range list. If the song starts mid-phrase (the first
      // detected downbeat is at beat >0), include a "pickup" phrase from
      // frame 0 to the first phrase boundary so the scaffolded composition
      // covers the full song. Without this, the intro / anacrusis renders
      // as a black frame.
      let lastStartIdx = -1;
      for (let i = 0; i < gridBeats.length; i++) {
        if (gridBeats[i].phrasePos === 0) {
          if (lastStartIdx < 0 && i > 0) {
            // Pickup phrase: 0 → first downbeat. Tagged as a partial.
            phrases.push({
              startBeat: 0,
              endBeat: i - 1,
              startFrame: 0,
              endFrame: gridBeats[i].frame,
            });
          } else if (lastStartIdx >= 0) {
            phrases.push({
              startBeat: lastStartIdx,
              endBeat: i - 1,
              startFrame: gridBeats[lastStartIdx].frame,
              endFrame: gridBeats[i].frame,
            });
          }
          lastStartIdx = i;
        }
      }
      // Tail phrase: from the last phrase-start to end of song.
      if (lastStartIdx >= 0) {
        phrases.push({
          startBeat: lastStartIdx,
          endBeat: gridBeats.length - 1,
          startFrame: gridBeats[lastStartIdx].frame,
          endFrame: Math.round(duration * args.fps),
        });
      } else if (gridBeats.length > 0) {
        // No phrase boundaries detected (short song). Treat the whole
        // thing as one phrase.
        phrases.push({
          startBeat: 0,
          endBeat: gridBeats.length - 1,
          startFrame: 0,
          endFrame: Math.round(duration * args.fps),
        });
      }

      // Replace the beats array with the grid-locked one.
      beats.length = 0;
      beats.push(...gridBeats);

      gridLocked = true;
      gridPhaseFrames = grid.phaseFrames;
    }
  }

  // Legacy t=0 prepend — only when the grid isn't locked. With a locked grid,
  // the first grid slot already covers t=0 (synthetic beat if no real onset
  // there), so the prepend is redundant and would double-count.
  if (!gridLocked && effectiveBpm > 0 && beats.length > 0) {
    const beatInterval = 60 / effectiveBpm;
    const firstBeatTime = beats[0].time;
    if (firstBeatTime > beatInterval * 0.6 && firstBeatTime < beatInterval * 1.4) {
      beats.unshift({
        time: 0,
        frame: 0,
        strength: beats[0].strength,
        kind: beats[0].kind,
        bandEnergies: beats[0].bandEnergies,
      });
    }
  }

  console.error("computing drops + sections from spectral envelope...");
  const { times, energy } = computeEnergyEnvelope(mono, sampleRate, 0.5);
  const bandedRms = computeBandedRms(banded.filtered, sampleRate, 0.5);
  const { drops, sections } = detectDropsAndSections(times, energy, args.fps, bandedRms);
  console.error(`found ${drops.length} drops, ${sections.length} sections`);

  const out = {
    audio: basename(audioPath),
    duration,
    sampleRate,
    fps: args.fps,
    bpm: Math.round(effectiveBpm * 10) / 10,
    bpmConfidence: Math.round(effectiveConfidence * 100) / 100,
    bpmGlobal: Math.round(globalBpm * 10) / 10,
    bpmGlobalConfidence: Math.round(confidence * 100) / 100,
    bpmCurve,
    gridLocked,
    gridPhaseFrames: Math.round(gridPhaseFrames * 1000) / 1000,
    phrases,
    beats,
    drops,
    sections,
    overrides: [] as Array<{ kind: string; time: number; note?: string; action?: string }>,
    analyzer: {
      version: "0.4.0-banded-structured",
      odfRate: args.odfRate,
      minBpm: args.minBpm,
      maxBpm: args.maxBpm,
      delta: args.delta,
      bandFreqs: DEFAULT_BANDS.map((b) => [b.lo, b.hi]),
      gridToleranceMs: 80,
      gridConfidenceFloor: GRID_CONFIDENCE_FLOOR,
    },
    generatedAt: new Date().toISOString(),
  };

  const outPath =
    args.out ??
    join(dirname(audioPath), basename(audioPath).replace(/\.[^.]+$/, "") + ".beats.json");
  await writeFile(outPath, JSON.stringify(out, null, 2));
  console.error(`wrote ${outPath}`);
  console.log(outPath);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
