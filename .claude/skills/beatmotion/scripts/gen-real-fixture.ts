#!/usr/bin/env bun
/**
 * Synthesize a mock real-music fixture for end-to-end test coverage of the
 * analyzer. Click tracks alone don't exercise the multi-band classifier or
 * the spectral drop scorer — this script lays out a 24-bar 128 BPM "song"
 * with kick / snare / hat synthesized from filtered noise + decaying sines,
 * giving each drum class real spectral content the analyzer can pick apart.
 *
 * Structure (4/4 at 128 BPM):
 *
 *   bars  1- 4  intro     kick on 1+3,           hat on 1.5+2.5+3.5+4.5
 *   bars  5- 8  build     kick on 1+3, snare 2+4, hat 8ths, +white-noise riser
 *   bars  9-20  drop      kick on 1+3, snare 2+4, hat 8ths (full chorus, loud)
 *   bars 21-24  outro     kick on 1+3 only, decaying gain
 *
 * The drop is at the start of bar 9 (timed to 15.0 s @ 128 BPM = exactly the
 * downbeat). White-noise riser is what tells `detectDropsAndSections` to fire
 * via brightDip score — it ramps brightness up through the build, then cuts.
 *
 * Run once and commit the .wav + truth.json. Deterministic output via a
 * seeded RNG so future runs reproduce the same fixture bit-for-bit.
 *
 * Usage:
 *   bun run scripts/gen-real-fixture.ts [--out fixtures/mock-128bpm-chorus.wav]
 */
import { resolve, dirname, basename } from "node:path";

const args = process.argv.slice(2);
let outPath = resolve("fixtures/mock-128bpm-chorus.wav");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") outPath = resolve(args[++i]);
}
const truthPath = resolve(
  dirname(outPath),
  basename(outPath).replace(/\.wav$/i, "") + ".truth.json"
);

const SAMPLE_RATE = 44100;
const BPM = 128;
const BEATS_PER_BAR = 4;
const TOTAL_BARS = 24;
const BAR_DURATION = (60 / BPM) * BEATS_PER_BAR; // 1.875 s @ 128
const TOTAL_DURATION = BAR_DURATION * TOTAL_BARS; // 45 s
const TOTAL_SAMPLES = Math.floor(SAMPLE_RATE * TOTAL_DURATION);
const FPS = 30;

// Phase regions (in bars, 0-indexed). bars [start, end) — end exclusive.
const SECTIONS = [
  { name: "intro",  startBar:  0, endBar:  4 },
  { name: "build",  startBar:  4, endBar:  8 },
  { name: "drop",   startBar:  8, endBar: 20 },
  { name: "outro",  startBar: 20, endBar: 24 },
];
const DROP_BAR = 8;
const DROP_TIME = DROP_BAR * BAR_DURATION; // 15.0 s

// Seeded LCG for reproducibility. Park-Miller minimal standard.
function makeRng(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
const rand = makeRng(424242);

// ─── Drum synths ───────────────────────────────────────────────────────────
// Kick: exponential pitch sweep from 120 Hz to 50 Hz + amplitude decay over
// ~120 ms. Real kicks have a low-frequency tone + a slight "click" — this
// captures both so the sub_kick band picks it up cleanly.
function synthKick(out: Float32Array, startSample: number, gain: number) {
  const lengthSec = 0.15;
  const N = Math.floor(SAMPLE_RATE * lengthSec);
  for (let i = 0; i < N && startSample + i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    const freq = 120 * Math.exp(-t * 25) + 50;
    const env = Math.exp(-t * 18);
    const phase = 2 * Math.PI * freq * t;
    const click = i < 64 ? Math.exp(-i / 32) * (rand() * 2 - 1) * 0.5 : 0;
    out[startSample + i] += (Math.sin(phase) * env + click * env) * gain;
  }
}

// Snare: short noise burst + thin 200 Hz tonal pulse, ~60 ms decay. Energy
// lives in 200-800 Hz body and 1500-4000 Hz brightness bands.
function synthSnare(out: Float32Array, startSample: number, gain: number) {
  const lengthSec = 0.08;
  const N = Math.floor(SAMPLE_RATE * lengthSec);
  for (let i = 0; i < N && startSample + i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.exp(-t * 35);
    const noise = (rand() * 2 - 1);
    const tone = Math.sin(2 * Math.PI * 200 * t);
    out[startSample + i] += (noise * 0.7 + tone * 0.3) * env * gain;
  }
}

// Hat: very short high-frequency noise burst, ~30 ms. Energy in hat_air band.
function synthHat(out: Float32Array, startSample: number, gain: number) {
  const lengthSec = 0.03;
  const N = Math.floor(SAMPLE_RATE * lengthSec);
  // Crude high-pass via 1-sample diff to push energy upward.
  let prev = 0;
  for (let i = 0; i < N && startSample + i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.exp(-t * 60);
    const noise = rand() * 2 - 1;
    const hp = noise - prev;
    prev = noise;
    out[startSample + i] += hp * env * gain;
  }
}

// White-noise riser: a slowly-increasing band-limited noise ramp covering
// the entire `build` section. Brightness peaks just before the drop, then
// vanishes — the brightDip signal `detectDropsAndSections` looks for.
function synthRiser(out: Float32Array, startSample: number, durationSec: number, gain: number) {
  const N = Math.floor(SAMPLE_RATE * durationSec);
  let prev = 0;
  for (let i = 0; i < N && startSample + i < out.length; i++) {
    const t = i / N; // 0..1 across build
    const env = Math.pow(t, 1.5); // accelerate toward end
    const noise = rand() * 2 - 1;
    const hp = noise - prev * 0.5; // mild HP for brightness
    prev = noise;
    out[startSample + i] += hp * env * gain;
  }
}

// ─── Layout ────────────────────────────────────────────────────────────────
const audio = new Float32Array(TOTAL_SAMPLES);
type TruthBeat = {
  time: number;
  frame: number;
  bar: number;        // 1-indexed bar
  beat: number;       // 1-indexed beat within bar
  kind: "kick" | "snare" | "hat";
  section: string;
};
const truthBeats: TruthBeat[] = [];

function sectionForBar(bar: number): { name: string; gain: number } {
  for (const s of SECTIONS) {
    if (bar >= s.startBar && bar < s.endBar) {
      // Per-section gain: intro quiet, build ramping up, drop loud, outro decay.
      let gain = 1.0;
      if (s.name === "intro") gain = 0.5;
      else if (s.name === "build") {
        const t = (bar - s.startBar) / (s.endBar - s.startBar);
        gain = 0.5 + 0.4 * t;
      } else if (s.name === "drop") gain = 1.0;
      else if (s.name === "outro") {
        const t = 1 - (bar - s.startBar) / (s.endBar - s.startBar);
        gain = 0.9 * t + 0.2;
      }
      return { name: s.name, gain };
    }
  }
  return { name: "outro", gain: 0.2 };
}

// Place drums bar by bar.
for (let bar = 0; bar < TOTAL_BARS; bar++) {
  const { name: section, gain } = sectionForBar(bar);
  const barStartSec = bar * BAR_DURATION;

  // Kick on beats 1 and 3 (every bar from intro through outro).
  for (const beat of [0, 2]) {
    const timeSec = barStartSec + beat * (60 / BPM);
    const startSample = Math.floor(timeSec * SAMPLE_RATE);
    synthKick(audio, startSample, 0.7 * gain);
    truthBeats.push({
      time: Math.round(timeSec * 1000) / 1000,
      frame: Math.round(timeSec * FPS),
      bar: bar + 1,
      beat: beat + 1,
      kind: "kick",
      section,
    });
  }

  // Snare on beats 2 and 4 — only during build, drop, and outro.
  if (section !== "intro") {
    for (const beat of [1, 3]) {
      const timeSec = barStartSec + beat * (60 / BPM);
      const startSample = Math.floor(timeSec * SAMPLE_RATE);
      synthSnare(audio, startSample, 0.6 * gain);
      truthBeats.push({
        time: Math.round(timeSec * 1000) / 1000,
        frame: Math.round(timeSec * FPS),
        bar: bar + 1,
        beat: beat + 1,
        kind: "snare",
        section,
      });
    }
  }

  // Hat on every 8th note — except intro (sparser hat) and outro (no hats).
  if (section !== "outro") {
    const hatPositions = section === "intro" ? [0.5, 1.5, 2.5, 3.5] : [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5];
    for (const beat of hatPositions) {
      const timeSec = barStartSec + beat * (60 / BPM);
      const startSample = Math.floor(timeSec * SAMPLE_RATE);
      synthHat(audio, startSample, 0.25 * gain);
      truthBeats.push({
        time: Math.round(timeSec * 1000) / 1000,
        frame: Math.round(timeSec * FPS),
        bar: bar + 1,
        beat: Math.floor(beat) + 1,
        kind: "hat",
        section,
      });
    }
  }
}

// White-noise riser through the entire build section, cuts off at drop.
const buildStartSec = SECTIONS[1].startBar * BAR_DURATION;
const buildDuration = (SECTIONS[1].endBar - SECTIONS[1].startBar) * BAR_DURATION;
synthRiser(audio, Math.floor(buildStartSec * SAMPLE_RATE), buildDuration, 0.4);

// ─── Truth packaging ───────────────────────────────────────────────────────
// Bar 1 beat 1 = first downbeat at t=0. Phrase boundaries every 4 bars
// (16 beats) match the section transitions: 0, 4, 8 (drop), 20 (outro).
truthBeats.sort((a, b) => a.time - b.time);

const phraseBoundaryBars = [0, 4, 8, 12, 16, 20]; // every 4 bars
const phraseBoundaryFrames = phraseBoundaryBars.map((b) =>
  Math.round(b * BAR_DURATION * FPS)
);

const truth = {
  audio: basename(outPath),
  sampleRate: SAMPLE_RATE,
  fps: FPS,
  bpm: BPM,
  duration: Math.round(TOTAL_DURATION * 1000) / 1000,
  sections: SECTIONS.map((s) => ({
    name: s.name,
    startSec: Math.round(s.startBar * BAR_DURATION * 1000) / 1000,
    endSec: Math.round(s.endBar * BAR_DURATION * 1000) / 1000,
  })),
  drop: {
    bar: DROP_BAR + 1,
    timeSec: DROP_TIME,
    frame: Math.round(DROP_TIME * FPS),
  },
  phraseLength: 16, // beats
  phraseBoundaries: phraseBoundaryFrames,
  beats: truthBeats,
};

// ─── Write WAV (mono PCM16) ────────────────────────────────────────────────
function writeMonoWav(samples: Float32Array, sampleRate: number): Buffer {
  const n = samples.length;
  const dataLen = n * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);  // PCM
  buf.writeUInt16LE(1, 22);  // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  // Soft-clip to ±0.95 to avoid PCM overflow on stacked drums.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const norm = peak > 0.95 ? 0.95 / peak : 1.0;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] * norm));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

const wav = writeMonoWav(audio, SAMPLE_RATE);
await Bun.write(outPath, wav);
await Bun.write(truthPath, JSON.stringify(truth, null, 2));
console.error(
  `wrote ${outPath} — ${(wav.length / 1024).toFixed(0)} KB, ${TOTAL_DURATION.toFixed(2)}s mono @ ${SAMPLE_RATE} Hz, ${BPM} BPM, ${TOTAL_BARS} bars`
);
console.error(`wrote ${truthPath} — ${truthBeats.length} beat events`);
