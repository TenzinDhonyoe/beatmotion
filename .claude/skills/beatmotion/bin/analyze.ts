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
  computeODF,
  detectBpm,
  findPeaks,
  mixToMono,
  tempogram,
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

type Beat = { time: number; frame: number; strength: number };
type Drop = { time: number; frame: number; kind: string };
type Section = { start: number; end: number; kind: string };

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

function detectDropsAndSections(
  times: number[],
  energy: number[],
  fps: number
): { drops: Drop[]; sections: Section[] } {
  if (energy.length === 0) return { drops: [], sections: [] };

  const smoothed = smooth(energy, 3);
  const maxEnergy = Math.max(...smoothed);
  const minEnergy = Math.min(...smoothed);
  const range = maxEnergy - minEnergy || 1;
  const normalized = smoothed.map((e) => (e - minEnergy) / range);

  const highThreshold = 0.65;
  const dropIndices: number[] = [];
  let inHigh = normalized[0] >= highThreshold;
  for (let i = 1; i < normalized.length; i++) {
    const wasLow = !inHigh;
    const nowHigh = normalized[i] >= highThreshold;
    if (wasLow && nowHigh) {
      const lookahead = normalized.slice(i, Math.min(i + 4, normalized.length));
      const avg = lookahead.reduce((a, b) => a + b, 0) / lookahead.length;
      if (avg >= highThreshold * 0.9) {
        if (dropIndices.length === 0 || times[i] - times[dropIndices.at(-1)!] >= 6) {
          dropIndices.push(i);
        }
      }
    }
    inHigh = nowHigh;
  }

  let mainIdx = -1;
  let mainJump = -Infinity;
  for (const i of dropIndices) {
    const prev = i > 0 ? normalized[i - 1] : 0;
    const jump = normalized[i] - prev;
    if (jump > mainJump) {
      mainJump = jump;
      mainIdx = i;
    }
  }

  const drops: Drop[] = dropIndices.map((i) => ({
    time: times[i],
    frame: Math.round(times[i] * fps),
    kind: i === mainIdx ? "main_drop" : "secondary_drop",
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

  const maxStrength = peaks.reduce((m, p) => Math.max(m, p.strength), 0) || 1;
  const beats: Beat[] = peaks.map((p) => ({
    time: p.time,
    frame: Math.round(p.time * args.fps),
    strength: Math.round((p.strength / maxStrength) * 1000) / 1000,
  }));

  // The log-energy derivative ODF can't fire on the very first frame (there's
  // no prior frame to diff against). For tracks that start on a downbeat, this
  // means the analyzer reports its first beat one beat-interval late. Detect
  // that case and prepend an implicit beat at t=0 so `beats[0]` matches the
  // music's beat 0 instead of beat 1.
  if (globalBpm > 0 && beats.length > 0) {
    const beatInterval = 60 / globalBpm;
    const firstBeatTime = beats[0].time;
    if (firstBeatTime > beatInterval * 0.6 && firstBeatTime < beatInterval * 1.4) {
      beats.unshift({ time: 0, frame: 0, strength: beats[0].strength });
    }
  }

  console.error("computing drops + sections from energy envelope...");
  const { times, energy } = computeEnergyEnvelope(mono, sampleRate, 0.5);
  const { drops, sections } = detectDropsAndSections(times, energy, args.fps);
  console.error(`found ${drops.length} drops, ${sections.length} sections`);

  const out = {
    audio: basename(audioPath),
    duration,
    sampleRate,
    fps: args.fps,
    bpm: Math.round(globalBpm * 10) / 10,
    bpmConfidence: Math.round(confidence * 100) / 100,
    bpmCurve,
    beats,
    drops,
    sections,
    overrides: [] as Array<{ kind: string; time: number; note?: string; action?: string }>,
    analyzer: {
      version: "0.2.0-native-dsp",
      odfRate: args.odfRate,
      minBpm: args.minBpm,
      maxBpm: args.maxBpm,
      delta: args.delta,
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
