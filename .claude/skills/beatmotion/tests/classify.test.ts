import { describe, expect, test } from "bun:test";
import { classify, type ClassifierFeatures } from "../bin/classify.ts";

const base: ClassifierFeatures = {
  bpm: 120,
  bpmConfidence: 0.9,
  bpmStability: 1.0,
  subBassRatioMean: 0.2,
  brightnessNorm: 0.10,
  brightnessVar: 0.005,
  fluxMean: 0.3,
  flatnessMean: 0.15,
  onsetRate: 3.0,
  energyMean: 0.5,
  energySlope: 0.0,
};

describe("classify — axis classes", () => {
  test("bpmClass: slow / mid / fast / dnb", () => {
    expect(classify({ ...base, bpm: 75 }).bpmClass).toBe("slow");
    expect(classify({ ...base, bpm: 110 }).bpmClass).toBe("mid");
    expect(classify({ ...base, bpm: 150 }).bpmClass).toBe("fast");
    expect(classify({ ...base, bpm: 180 }).bpmClass).toBe("dnb");
  });
  test("subBassClass: thin / balanced / heavy", () => {
    expect(classify({ ...base, subBassRatioMean: 0.10 }).subBassClass).toBe("thin");
    expect(classify({ ...base, subBassRatioMean: 0.22 }).subBassClass).toBe("balanced");
    expect(classify({ ...base, subBassRatioMean: 0.40 }).subBassClass).toBe("heavy");
  });
  test("brightClass: dark / warm / neutral / bright", () => {
    expect(classify({ ...base, brightnessNorm: 0.03 }).brightClass).toBe("dark");
    expect(classify({ ...base, brightnessNorm: 0.07 }).brightClass).toBe("warm");
    expect(classify({ ...base, brightnessNorm: 0.13 }).brightClass).toBe("neutral");
    expect(classify({ ...base, brightnessNorm: 0.22 }).brightClass).toBe("bright");
  });
  test("grooveClass: sparse / moderate / dense / relentless", () => {
    expect(classify({ ...base, onsetRate: 1.2 }).grooveClass).toBe("sparse");
    expect(classify({ ...base, onsetRate: 3.5 }).grooveClass).toBe("moderate");
    expect(classify({ ...base, onsetRate: 5.0 }).grooveClass).toBe("dense");
    expect(classify({ ...base, onsetRate: 7.0 }).grooveClass).toBe("relentless");
  });
  test("intensityProfile: build / sustain / decline / varied", () => {
    expect(classify({ ...base, energySlope: 0.15 }).intensityProfile).toBe("build");
    expect(classify({ ...base, energySlope: 0.02 }).intensityProfile).toBe("sustain");
    expect(classify({ ...base, energySlope: -0.15 }).intensityProfile).toBe("decline");
  });
});

describe("classify — genre rules", () => {
  test("EDM: 128 BPM + heavy sub + dense onsets + flatness > 0.2", () => {
    const c = classify({
      ...base,
      bpm: 128,
      subBassRatioMean: 0.30,
      onsetRate: 4.5,
      flatnessMean: 0.25,
    });
    expect(c.genre).toBe("edm");
  });

  test("house: 124 BPM + heavy sub + dense + tonal flatness", () => {
    const c = classify({
      ...base,
      bpm: 124,
      subBassRatioMean: 0.28,
      onsetRate: 4.0,
      flatnessMean: 0.12,
    });
    expect(c.genre).toBe("house");
  });

  test("hip-hop: 85 BPM + heavy sub + dark brightness + moderate density", () => {
    const c = classify({
      ...base,
      bpm: 85,
      subBassRatioMean: 0.30,
      brightnessNorm: 0.08,
      onsetRate: 2.5,
    });
    expect(c.genre).toBe("hiphop");
  });

  test("drum & bass: 175 BPM + dense onsets", () => {
    const c = classify({
      ...base,
      bpm: 175,
      onsetRate: 6.0,
    });
    expect(c.genre).toBe("drum_and_bass");
  });

  test("ballad: 75 BPM + sparse + warm + low flux", () => {
    const c = classify({
      ...base,
      bpm: 75,
      onsetRate: 1.5,
      brightnessNorm: 0.07,
      fluxMean: 0.2,
      subBassRatioMean: 0.10,
    });
    expect(c.genre).toBe("ballad");
  });

  test("lofi: slow + dark + low energy + tonal", () => {
    const c = classify({
      ...base,
      bpm: 70,
      brightnessNorm: 0.05,
      energyMean: 0.3,
      flatnessMean: 0.08,
      subBassRatioMean: 0.10,
    });
    expect(c.genre).toBe("lofi");
  });

  test("fallback: 'general' for features that don't match any rule", () => {
    const c = classify({
      ...base,
      bpm: 200,
      onsetRate: 1.0,
      subBassRatioMean: 0.05,
      brightnessNorm: 0.30,
      fluxMean: 0.1,
      flatnessMean: 0.05,
    });
    expect(c.genre).toBe("general");
  });

  test("confidence is reduced when BPM confidence is weak", () => {
    const a = classify({ ...base, bpm: 128, subBassRatioMean: 0.30, onsetRate: 4.5, flatnessMean: 0.25, bpmConfidence: 0.9 });
    const b = classify({ ...base, bpm: 128, subBassRatioMean: 0.30, onsetRate: 4.5, flatnessMean: 0.25, bpmConfidence: 0.3 });
    expect(b.confidence).toBeLessThanOrEqual(a.confidence);
  });
});
