#!/usr/bin/env bun
/**
 * Generate a synthetic WAV click track for testing the analyzer.
 *
 * Produces a stereo PCM 16-bit WAV at a configurable sample rate, BPM, and
 * duration. The second half of the track plays louder than the first to
 * simulate a "drop" for drop-detection testing.
 *
 * Optional --bpm-shift switches to a second BPM partway through, to test the
 * dynamic BPM curve.
 *
 * Usage:
 *   bun run scripts/gen-test-wav.ts [out.wav] [--bpm 120] [--rate 44100] [--duration 16] [--drop-at 8] [--bpm-shift 140@8]
 */
import { resolve } from "node:path";

type Opts = {
  out: string;
  bpm: number;
  rate: number;
  duration: number;
  dropAt: number;
  bpmShift: { bpm: number; at: number } | null;
};

function parseOpts(argv: string[]): Opts {
  const opts: Opts = {
    out: "fixtures/test-click.wav",
    bpm: 120,
    rate: 44100,
    duration: 16,
    dropAt: 8,
    bpmShift: null,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--bpm") opts.bpm = Number(rest[++i]);
    else if (a === "--rate") opts.rate = Number(rest[++i]);
    else if (a === "--duration") opts.duration = Number(rest[++i]);
    else if (a === "--drop-at") opts.dropAt = Number(rest[++i]);
    else if (a === "--bpm-shift") {
      const m = rest[++i].match(/^(\d+(?:\.\d+)?)@(\d+(?:\.\d+)?)$/);
      if (m) opts.bpmShift = { bpm: Number(m[1]), at: Number(m[2]) };
    } else if (!a.startsWith("--")) opts.out = a;
  }
  return opts;
}

const opts = parseOpts(process.argv);
const { bpm, rate, duration, dropAt, bpmShift, out } = opts;

const CLICK_HZ = 880;
const CLICK_LEN_SEC = 0.05;
const totalSamples = Math.floor(rate * duration);
const clickLenSamples = Math.floor(rate * CLICK_LEN_SEC);

const left = new Float32Array(totalSamples);
const right = new Float32Array(totalSamples);

let beatTime = 0;
let currentBpm = bpm;
while (beatTime < duration) {
  if (bpmShift && beatTime >= bpmShift.at) currentBpm = bpmShift.bpm;
  const start = Math.floor(beatTime * rate);
  if (start >= totalSamples) break;
  const dropped = beatTime >= dropAt;
  const amplitude = dropped ? 0.9 : 0.25;
  for (let i = 0; i < clickLenSamples && start + i < totalSamples; i++) {
    const t = i / rate;
    const env = Math.exp(-i / (clickLenSamples * 0.4));
    const s = Math.sin(2 * Math.PI * CLICK_HZ * t) * env * amplitude;
    left[start + i] += s;
    right[start + i] += s;
  }
  beatTime += 60 / currentBpm;
}

function writeWavStereoPcm16(left: Float32Array, right: Float32Array, sampleRate: number): Buffer {
  const n = left.length;
  const dataLen = n * 4;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    buf.writeInt16LE(Math.round(l * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(r * 32767), 44 + i * 4 + 2);
  }
  return buf;
}

const wav = writeWavStereoPcm16(left, right, rate);
const outPath = resolve(out);
await Bun.write(outPath, wav);
console.error(
  `wrote ${outPath} — ${(wav.length / 1024).toFixed(1)} KB, ${duration}s @ ${rate}Hz, ${bpm} BPM${
    bpmShift ? ` (shifts to ${bpmShift.bpm} BPM at ${bpmShift.at}s)` : ""
  }, drop at ${dropAt}s`
);
