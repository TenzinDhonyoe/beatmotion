/**
 * IIR biquad bandpass filters for beatmotion's multi-band onset analysis.
 *
 * Pure TypeScript, no external deps, no FFT. Implements the Robert Bristow-
 * Johnson "Audio EQ Cookbook" constant-skirt-gain bandpass with transposed
 * direct-form II processing. One biquad is a 2-pole filter; cascade two for
 * a 4-pole filter when steeper rolloff is needed (e.g. isolating sub-bass
 * kicks at 20-120 Hz, where neighbouring bands creep close).
 *
 * The center frequency is the geometric mean of the band edges and Q is
 * derived from the bandwidth, which keeps the filter musically sensible
 * regardless of where the band sits in the spectrum.
 */

export type BiquadCoeffs = {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
};

/**
 * RBJ constant-skirt-gain bandpass coefficients, normalized by a0 so the
 * processing loop doesn't need to divide on every sample.
 */
export function rbjBandpass(sampleRate: number, centerHz: number, q: number): BiquadCoeffs {
  const omega = (2 * Math.PI * centerHz) / sampleRate;
  const sin = Math.sin(omega);
  const cos = Math.cos(omega);
  const alpha = sin / (2 * Math.max(q, 1e-6));

  // Constant skirt gain, peak gain = Q.
  const b0n = sin / 2;
  const b1n = 0;
  const b2n = -sin / 2;
  const a0 = 1 + alpha;
  const a1n = -2 * cos;
  const a2n = 1 - alpha;

  return {
    b0: b0n / a0,
    b1: b1n / a0,
    b2: b2n / a0,
    a1: a1n / a0,
    a2: a2n / a0,
  };
}

/**
 * Apply a single biquad in place. Transposed direct-form II — minimal state
 * (two doubles), one mul-add per sample for each of the 5 coefficients.
 * Produces `out`, which may alias `input` if you want to overwrite.
 */
export function applyBiquad(
  input: Float32Array,
  coeffs: BiquadCoeffs,
  out: Float32Array = new Float32Array(input.length)
): Float32Array {
  let z1 = 0;
  let z2 = 0;
  const { b0, b1, b2, a1, a2 } = coeffs;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    out[i] = y;
  }
  return out;
}

/**
 * Convenience: filter `samples` through a 2-pole (or cascaded 4-pole) RBJ
 * bandpass centered at the geometric mean of [loHz, hiHz]. Allocates one new
 * Float32Array per stage so the caller can keep the input array intact.
 */
export function bandpass(
  samples: Float32Array,
  sampleRate: number,
  loHz: number,
  hiHz: number,
  poles: number = 2
): Float32Array {
  const centerHz = Math.sqrt(Math.max(1, loHz) * Math.max(1, hiHz));
  const bandwidth = Math.max(1, hiHz - loHz);
  const q = centerHz / bandwidth;
  const coeffs = rbjBandpass(sampleRate, centerHz, q);

  const stages = Math.max(1, Math.round(poles / 2));
  let current = samples;
  for (let s = 0; s < stages; s++) {
    const next = new Float32Array(current.length);
    applyBiquad(current, coeffs, next);
    current = next;
  }
  return current;
}
