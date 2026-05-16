/**
 * Pure-TypeScript radix-2 Cooley-Tukey FFT.
 *
 * Up until Phase 5, beatmotion explicitly avoided FFT (the README brags
 * "no FFT" — onset detection used a log-energy derivative ODF). The user
 * has now asked for spectral analysis in depth, so this module lands the
 * minimum FFT we need: in-place complex transform, Hann window, and a
 * convenience that computes a real-input power spectrum per video frame.
 *
 * Implementation notes:
 *   - Input length MUST be a power of two. Callers should zero-pad or
 *     truncate before calling.
 *   - The forward transform divides by N at the end of `power()` rather
 *     than inside `fft()` so the raw transform is reversible by `ifft()`.
 *   - Hann window is precomputed once per requested length (cached) to
 *     avoid recomputing `cos` per frame in the hot path.
 *   - All operations are O(N log N) and run comfortably at video FPS rates
 *     for FFT sizes up to 4096 on a 28-second clip.
 */

const isPowerOfTwo = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;

const HANN_CACHE = new Map<number, Float32Array>();

/**
 * Hann window of length n. Used to taper the edges of each FFT frame so
 * the implicit periodicity assumption of the DFT doesn't create spectral
 * leakage from frame-boundary discontinuities.
 *
 *   w[i] = 0.5 * (1 - cos(2π · i / (n - 1)))
 *
 * Returns the same Float32Array on repeated calls for a given n.
 */
export function hannWindow(n: number): Float32Array {
  const cached = HANN_CACHE.get(n);
  if (cached) return cached;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  HANN_CACHE.set(n, out);
  return out;
}

/**
 * In-place radix-2 Cooley-Tukey FFT. Operates on two parallel Float32Arrays
 * (real, imag) of the same length, which must be a power of two.
 *
 * Forward transform: no scaling applied. Callers normalize as needed.
 */
export function fft(real: Float32Array, imag: Float32Array): void {
  const n = real.length;
  if (n !== imag.length) throw new Error("fft: real.length must equal imag.length");
  if (!isPowerOfTwo(n)) throw new Error(`fft: length ${n} is not a power of two`);
  if (n < 2) return;

  // Bit-reverse permutation. After this step element i holds what was at
  // bit-reversed index of i, which is the order Cooley-Tukey expects.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = real[i]; real[i] = real[j]; real[j] = tr;
      const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
    }
  }

  // Butterflies. `len` doubles each pass; `half` is the per-pass twiddle
  // step size. The twiddle factor w = exp(-i·2π/len) is built iteratively
  // via complex multiplication to avoid cos/sin in the inner loop.
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wStepReal = Math.cos(angle);
    const wStepImag = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wReal = 1;
      let wImag = 0;
      for (let k = 0; k < half; k++) {
        const ar = real[i + k];
        const ai = imag[i + k];
        const br = real[i + k + half];
        const bi = imag[i + k + half];
        // t = w * b
        const tr = wReal * br - wImag * bi;
        const ti = wReal * bi + wImag * br;
        real[i + k] = ar + tr;
        imag[i + k] = ai + ti;
        real[i + k + half] = ar - tr;
        imag[i + k + half] = ai - ti;
        const nextW = wReal * wStepReal - wImag * wStepImag;
        wImag = wReal * wStepImag + wImag * wStepReal;
        wReal = nextW;
      }
    }
  }
}

/**
 * Inverse FFT. Computes the conjugate, applies the forward transform, then
 * conjugates again and divides by N. Useful for round-trip tests.
 */
export function ifft(real: Float32Array, imag: Float32Array): void {
  const n = real.length;
  for (let i = 0; i < n; i++) imag[i] = -imag[i];
  fft(real, imag);
  const inv = 1 / n;
  for (let i = 0; i < n; i++) {
    real[i] = real[i] * inv;
    imag[i] = -imag[i] * inv;
  }
}

/**
 * Compute the power spectrum of a real-valued time-domain frame:
 *
 *   1. Hann-window the input.
 *   2. FFT (treating input as complex with imag = 0).
 *   3. Return magnitudes for bins [0, N/2] (DC + positive frequencies).
 *
 * The returned array has length `N/2 + 1`. Each value is `sqrt(re² + im²)`
 * — linear magnitude, not log-scaled (callers can take log if they want
 * dB-style values).
 *
 * `out` may be supplied to avoid allocation in tight loops; if provided it
 * must be at least `N/2 + 1` long.
 */
export function powerSpectrum(
  frame: Float32Array,
  out?: Float32Array
): Float32Array {
  const n = frame.length;
  if (!isPowerOfTwo(n)) throw new Error(`powerSpectrum: length ${n} not power of two`);
  const window = hannWindow(n);
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let i = 0; i < n; i++) real[i] = frame[i] * window[i];
  fft(real, imag);
  const halfN = n >> 1;
  const target = out ?? new Float32Array(halfN + 1);
  for (let i = 0; i <= halfN; i++) {
    target[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
  }
  return target;
}

/**
 * Convert FFT bin index to Hz. Bin `i` of an N-point FFT taken at
 * `sampleRate` samples per second corresponds to `i * sampleRate / N` Hz.
 */
export function binToHz(bin: number, sampleRate: number, fftSize: number): number {
  return (bin * sampleRate) / fftSize;
}

/**
 * Convert Hz to FFT bin index (rounded).
 */
export function hzToBin(hz: number, sampleRate: number, fftSize: number): number {
  return Math.round((hz * fftSize) / sampleRate);
}

/**
 * Compute a spectrogram over `mono` at a target frame rate (typically video
 * FPS) using `fftSize` per frame. The frame at video-time `t` is centered
 * on sample `round(t * sampleRate)` and pulls `fftSize` samples symmetric
 * around it (zero-padded if it runs off the start/end).
 *
 * Output: `spec[videoFrame]` is the power spectrum at that video frame,
 * length `fftSize / 2 + 1`. The full 2D array is `totalFrames × (fftSize/2+1)`.
 *
 * Memory cost is non-trivial for long songs at high FPS — at 30fps × 1025
 * bins × 4 bytes × duration seconds = ~123 KB per second. We don't keep
 * the full spectrogram in the sidecar (only summary features), but the
 * analyzer needs it in RAM transiently to compute spectral features.
 */
export function spectrogramAtFps(
  mono: Float32Array,
  sampleRate: number,
  fps: number,
  fftSize: number = 2048,
  totalFrames?: number
): Float32Array[] {
  if (!isPowerOfTwo(fftSize)) {
    throw new Error(`spectrogramAtFps: fftSize ${fftSize} not power of two`);
  }
  const numFrames = totalFrames ?? Math.floor((mono.length / sampleRate) * fps);
  const half = fftSize >> 1;
  const out: Float32Array[] = new Array(numFrames);
  const buf = new Float32Array(fftSize);
  for (let f = 0; f < numFrames; f++) {
    const centerSample = Math.round((f / fps) * sampleRate);
    const start = centerSample - half;
    for (let i = 0; i < fftSize; i++) {
      const s = start + i;
      buf[i] = s >= 0 && s < mono.length ? mono[s] : 0;
    }
    out[f] = powerSpectrum(buf);
  }
  return out;
}
