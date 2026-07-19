/**
 * Lazy FFmpeg.wasm loader + WebM→MP4 converter.
 *
 * Uses the single-threaded core (@ffmpeg/core-st) loaded from CDN via
 * blob URLs — no COOP/COEP headers required.  The FFmpeg instance is
 * cached after first load so subsequent conversions skip the ~25 MB fetch.
 */
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL, fetchFile } from '@ffmpeg/util';

const CDN = 'https://unpkg.com/@ffmpeg/core-st@0.12.6/dist/esm';

let _instance: FFmpeg | null = null;
let _loading: Promise<FFmpeg> | null = null;

async function getFFmpeg(): Promise<FFmpeg> {
  if (_instance) return _instance;
  if (_loading)  return _loading;

  _loading = (async () => {
    const ff = new FFmpeg();
    await ff.load({
      coreURL: await toBlobURL(`${CDN}/ffmpeg-core.js`,   'text/javascript'),
      wasmURL: await toBlobURL(`${CDN}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    _instance = ff;
    _loading  = null;
    return ff;
  })();

  return _loading;
}

export type ProgressCallback = (pct: number) => void;

/** Safely copy a Uint8Array whose underlying buffer may be SharedArrayBuffer into a plain Blob. */
function toBlob(data: Uint8Array | string, mimeType: string): Blob {
  if (typeof data === 'string') {
    // readFile can return a string for text files — shouldn't happen for video but handle it
    return new Blob([data], { type: mimeType });
  }
  // Copy into a plain ArrayBuffer to satisfy the Blob constructor's type constraints
  const plain = new Uint8Array(data.length);
  plain.set(data);
  return new Blob([plain.buffer], { type: mimeType });
}

/**
 * Convert any Blob (typically video/webm from MediaRecorder) to MP4.
 * Returns a new Blob with type 'video/mp4'.
 *
 * Throws if FFmpeg fails — caller should catch and fall back gracefully.
 */
export async function convertToMp4(
  input: Blob,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  const ff = await getFFmpeg();

  // @ffmpeg/ffmpeg uses overloaded `on` — type the callback explicitly
  const progressCb = onProgress
    ? (ev: { progress: number; time: number }) => {
        onProgress(Math.min(99, Math.round(ev.progress * 100)));
      }
    : null;

  if (progressCb) ff.on('progress', progressCb);

  try {
    await ff.writeFile('input.webm', await fetchFile(input));
    await ff.exec([
      '-i',        'input.webm',
      '-c:v',      'libx264',
      '-preset',   'ultrafast',  // speed over file size — runs on main thread
      '-crf',      '23',
      '-c:a',      'aac',
      '-movflags', '+faststart', // moov atom at front — good for web playback
      'output.mp4',
    ]);
    const data = await ff.readFile('output.mp4');
    return toBlob(data as Uint8Array | string, 'video/mp4');
  } finally {
    if (progressCb) ff.off('progress', progressCb);
    await ff.deleteFile('input.webm').catch(() => {});
    await ff.deleteFile('output.mp4').catch(() => {});
  }
}
