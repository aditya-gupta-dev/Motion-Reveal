/* eslint-disable no-restricted-globals */
// Pixel-diff Web Worker
// Maintains its own prev-frame buffer and glow buffer so the main thread
// only needs to send the current frame slice each tick.

let prevSlice: Uint8ClampedArray | null = null;
let glowSlice: Float32Array | null = null;

type ColorMode = 'binary' | 'heat' | 'neon';

interface FrameMsg {
  type: 'frame';
  currSlice: Uint8ClampedArray; // structured-clone copy
  startPixel: number;
  thresh: number;
  decay: number;
  noiseGate: number;
  colorMode: ColorMode;
  invert: boolean;
}

interface ResetMsg { type: 'reset' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
addEventListener('message', (e: MessageEvent<any>) => {
  const msg = e.data as FrameMsg | ResetMsg;

  if (msg.type === 'reset') {
    prevSlice = null;
    glowSlice = null;
    return;
  }

  if (msg.type !== 'frame') return;

  const { currSlice, startPixel, thresh, decay, noiseGate, colorMode, invert } = msg;
  const nPixels = currSlice.length >> 2; // / 4

  // Re-init glow buffer if size changed
  if (!glowSlice || glowSlice.length !== nPixels) {
    glowSlice = new Float32Array(nPixels);
    prevSlice = null;
  }

  const glow = glowSlice;
  const effectiveThresh = thresh * 3 + noiseGate * 3;

  // ── Update glow values ──────────────────────────────────────────────────
  if (prevSlice && prevSlice.length === currSlice.length) {
    for (let i = 0; i < nPixels; i++) {
      const p = i * 4;
      const diff =
        Math.abs(currSlice[p]     - prevSlice[p])   +
        Math.abs(currSlice[p + 1] - prevSlice[p + 1]) +
        Math.abs(currSlice[p + 2] - prevSlice[p + 2]);
      glow[i] = diff > effectiveThresh ? 1.0 : Math.max(0, glow[i] * decay);
    }
  } else {
    glow.fill(0);
  }

  // ── Render to output buffer ─────────────────────────────────────────────
  const out = new Uint8ClampedArray(nPixels * 4);

  for (let i = 0; i < nPixels; i++) {
    const b = glow[i];
    const op = i * 4;
    let r = 0, g = 0, bv = 0;

    if (colorMode === 'heat') {
      // black → blue → red → yellow → white
      if (b < 0.25)      { bv = Math.round(b * 4 * 255); }
      else if (b < 0.5)  { const s = (b - 0.25) * 4; r = Math.round(s * 255); bv = Math.round((1 - s) * 255); }
      else if (b < 0.75) { const s = (b - 0.5) * 4; r = 255; g = Math.round(s * 255); }
      else               { const s = (b - 0.75) * 4; r = 255; g = 255; bv = Math.round(s * 255); }
    } else if (colorMode === 'neon') {
      // phosphor green glow on dark background
      const t = b * b; // gamma compress for punchier look
      g  = Math.min(255, Math.round(t * 320));
      bv = Math.round(b * 90);
      r  = Math.round(b * 10);
    } else {
      // binary: white on black
      const v = Math.round(b * 255);
      r = v; g = v; bv = v;
    }

    if (invert) {
      out[op] = 255 - r; out[op + 1] = 255 - g; out[op + 2] = 255 - bv;
    } else {
      out[op] = r; out[op + 1] = g; out[op + 2] = bv;
    }
    out[op + 3] = 255;
  }

  // Store current frame as previous for next tick
  prevSlice = new Uint8ClampedArray(currSlice); // currSlice is already a copy

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — DOM lib types postMessage as Window.postMessage; in a worker the two-arg form is correct
  postMessage({ type: 'result', outBuffer: out.buffer, startPixel, nPixels }, [out.buffer]);
});
