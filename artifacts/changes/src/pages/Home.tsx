import React, { useState, useRef, useEffect, useCallback } from 'react';
import DiffWorker from '../workers/diff.worker?worker';
import { openRecDB, appendChunk, getAllChunks, clearChunks, getBestMime, downloadBlob } from '../lib/recording';
import { convertToMp4 } from '../lib/convert';

/* ─── Types ──────────────────────────────────────────────────────────────── */
type Mode = 'IDLE' | 'WEBCAM' | 'VIDEO';
type ColorMode = 'binary' | 'heat' | 'neon';

interface Settings {
  threshold:   number;        // 1–50  motion sensitivity
  trail:       number;        // 0–0.98 decay per frame
  noiseGate:   number;        // 0–30  hard floor (camera grain suppression)
  blur:        number;        // 0–8px CSS blur on output
  invert:      boolean;       // flip white/black
  showSource:  boolean;
  colorMode:   ColorMode;     // binary | heat | neon
  frameSkip:   number;        // 1–4 process every Nth frame
  numWorkers:  number;        // 1 | 2 | 4
  showFps:     boolean;
  recFormat:   'webm' | 'mp4'; // preferred recording container
}

const DEFAULT: Settings = {
  threshold: 15, trail: 0.70, noiseGate: 0,
  blur: 0, invert: false, showSource: true,
  colorMode: 'binary', frameSkip: 1, numWorkers: 2, showFps: false,
  recFormat: 'webm',
};

/* ─── Sub-components ─────────────────────────────────────────────────────── */
function Slider({ label, value, min, max, step, display, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  display?: string; onChange: (v: number) => void;
}) {
  return (
    <div className="setting-row">
      <div className="setting-label-row">
        <span className="setting-label">{label}</span>
        <span className="setting-value">{display ?? value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        className="range-input" onChange={e => onChange(+e.target.value)}
        data-testid={`slider-${label.toLowerCase()}`} />
    </div>
  );
}

function Toggle({ label, value, onChange }: {
  label: string; value: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="setting-row toggle-row">
      <span className="setting-label">{label}</span>
      <button className={`toggle-btn${value ? ' toggle-btn--on' : ''}`}
        onClick={() => onChange(!value)}
        data-testid={`toggle-${label.toLowerCase().replace(/\s+/g, '-')}`}>
        {value ? 'on' : 'off'}
      </button>
    </div>
  );
}

function Select<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: { v: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="setting-row">
      <span className="setting-label">{label}</span>
      <div className="select-group">
        {options.map(o => (
          <button key={o.v}
            className={`select-opt${value === o.v ? ' select-opt--on' : ''}`}
            onClick={() => onChange(o.v)}
            data-testid={`select-${label.toLowerCase()}-${o.v}`}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ─── Main component ─────────────────────────────────────────────────────── */
export default function Home() {
  const [mode,         setMode]         = useState<Mode>('IDLE');
  const [cameraStatus, setCameraStatus] = useState('');
  const [isPaused,     setIsPaused]     = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings,     setSettings]     = useState<Settings>(DEFAULT);
  const [isRecording,    setIsRecording]    = useState(false);
  const [hasRecording,   setHasRecording]   = useState(false);
  const [conversionPct,  setConversionPct]  = useState<number | null>(null); // null = idle

  /* ── canvas / video refs ─────────────────────────────────────────────── */
  const videoRef        = useRef<HTMLVideoElement>(null);
  const outputCanvasRef = useRef<HTMLCanvasElement>(null);
  const hiddenCanvasRef = useRef<HTMLCanvasElement>(null);

  /* ── loop control refs ───────────────────────────────────────────────── */
  const rafRef          = useRef<number | undefined>(undefined);
  const lastTimeRef     = useRef(-1);
  const frameSkipCtr    = useRef(0);

  /* ── worker refs ─────────────────────────────────────────────────────── */
  const workersRef      = useRef<Worker[]>([]);
  const pendingRef      = useRef(0);
  const frameOutRef     = useRef<Uint8ClampedArray | null>(null);
  const frameWRef       = useRef(0);
  const frameHRef       = useRef(0);
  const dimResetRef     = useRef(false); // flag: send reset on next dispatch

  /* ── recording refs ──────────────────────────────────────────────────── */
  const mrRef           = useRef<MediaRecorder | null>(null);
  const recDbRef        = useRef<IDBDatabase | null>(null);
  const lastBlobRef     = useRef<{ blob: Blob; ext: string } | null>(null);

  /* ── FPS refs ────────────────────────────────────────────────────────── */
  const fpsTimesRef     = useRef<number[]>([]);
  const fpsSpanRef      = useRef<HTMLSpanElement | null>(null);

  /* ── misc ────────────────────────────────────────────────────────────── */
  const fileInputRef    = useRef<HTMLInputElement>(null);
  const videoSrcRef     = useRef('');

  /* shadow refs for RAF closure access */
  const settingsRef  = useRef(settings);
  const isPausedRef  = useRef(isPaused);
  const modeRef      = useRef(mode);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { isPausedRef.current = isPaused; }, [isPaused]);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setSettings(s => ({ ...s, [k]: v }));

  /* ── FPS display (direct DOM, no re-render) ──────────────────────────── */
  const updateFps = useCallback(() => {
    const now = performance.now();
    const times = fpsTimesRef.current;
    times.push(now);
    if (times.length > 40) times.splice(0, times.length - 40);
    if (times.length >= 2 && fpsSpanRef.current && settingsRef.current.showFps) {
      const fps = (times.length - 1) / (times[times.length - 1] - times[0]) * 1000;
      fpsSpanRef.current.textContent = `${fps.toFixed(0)} fps`;
    } else if (fpsSpanRef.current && !settingsRef.current.showFps) {
      fpsSpanRef.current.textContent = '';
    }
  }, []);

  /* ── processFrame ────────────────────────────────────────────────────── */
  // Defined as a stable ref so the worker onmessage handler can call it.
  const processFrameRef = useRef<() => void>(() => {});

  const makeProcessFrame = useCallback(() => {
    return function processFrame() {
      const video        = videoRef.current;
      const outputCanvas = outputCanvasRef.current;
      const hiddenCanvas = hiddenCanvasRef.current;
      const workers      = workersRef.current;

      if (!video || !outputCanvas || !hiddenCanvas || workers.length === 0) {
        rafRef.current = requestAnimationFrame(processFrameRef.current);
        return;
      }
      if (video.readyState < 2 || isPausedRef.current) {
        rafRef.current = requestAnimationFrame(processFrameRef.current);
        return;
      }

      const isWebcam = modeRef.current === 'WEBCAM';
      if (!isWebcam && video.currentTime === lastTimeRef.current) {
        rafRef.current = requestAnimationFrame(processFrameRef.current);
        return;
      }
      lastTimeRef.current = video.currentTime;

      // frame skip
      frameSkipCtr.current = (frameSkipCtr.current + 1) % settingsRef.current.frameSkip;
      if (frameSkipCtr.current !== 0) {
        rafRef.current = requestAnimationFrame(processFrameRef.current);
        return;
      }

      const w = video.videoWidth;
      const h = video.videoHeight;
      if (w === 0 || h === 0) {
        rafRef.current = requestAnimationFrame(processFrameRef.current);
        return;
      }

      // resize canvases + flag workers to reset on dimension change
      if (hiddenCanvas.width !== w || hiddenCanvas.height !== h) {
        hiddenCanvas.width = w;
        hiddenCanvas.height = h;
        dimResetRef.current = true;
      }
      if (outputCanvas.width !== w || outputCanvas.height !== h) {
        outputCanvas.width = w;
        outputCanvas.height = h;
      }

      const hiddenCtx = hiddenCanvas.getContext('2d', { willReadFrequently: true });
      if (!hiddenCtx) {
        rafRef.current = requestAnimationFrame(processFrameRef.current);
        return;
      }

      hiddenCtx.drawImage(video, 0, 0, w, h);
      const curr       = hiddenCtx.getImageData(0, 0, w, h).data;
      const totalPx    = w * h;
      const numWorkers = workers.length;
      const { threshold, trail, noiseGate, colorMode, invert } = settingsRef.current;

      // Prepare output assembly buffer
      frameOutRef.current = new Uint8ClampedArray(totalPx * 4);
      frameWRef.current   = w;
      frameHRef.current   = h;
      pendingRef.current  = numWorkers;

      // Send reset if dimensions changed
      if (dimResetRef.current) {
        workers.forEach(w => w.postMessage({ type: 'reset' }));
        dimResetRef.current = false;
      }

      // Dispatch pixel strips to workers
      for (let i = 0; i < numWorkers; i++) {
        const startPixel = Math.floor(i * totalPx / numWorkers);
        const endPixel   = Math.floor((i + 1) * totalPx / numWorkers);
        // subarray creates a view (no copy); postMessage structured-clone copies the view's bytes
        const currSlice  = curr.subarray(startPixel * 4, endPixel * 4);
        workers[i].postMessage({
          type: 'frame', currSlice, startPixel,
          thresh: threshold, decay: trail, noiseGate, colorMode, invert,
        });
      }
      // next rAF scheduled by worker result handler
    };
  }, []);

  /* ── Workers: create / wire / tear-down ──────────────────────────────── */
  useEffect(() => {
    if (mode === 'IDLE') return;

    const n = settings.numWorkers;
    const workers: Worker[] = Array.from({ length: n }, () => new DiffWorker());

    // Wire up result handler on each worker
    workers.forEach(worker => {
      worker.onmessage = (e: MessageEvent) => {
        if (e.data.type !== 'result') return;
        const { outBuffer, startPixel, nPixels } = e.data;
        // Copy this strip into the assembly buffer
        if (frameOutRef.current) {
          frameOutRef.current.set(new Uint8ClampedArray(outBuffer), startPixel * 4);
        }
        pendingRef.current--;
        if (pendingRef.current === 0) {
          // All strips done — draw assembled frame
          const canvas = outputCanvasRef.current;
          const ctx = canvas?.getContext('2d');
          if (ctx && frameOutRef.current) {
            // Copy into a plain ArrayBuffer so ImageData constructor is satisfied
            const imageData = new ImageData(
              new Uint8ClampedArray(frameOutRef.current),
              frameWRef.current,
              frameHRef.current,
            );
            ctx.putImageData(imageData, 0, 0);
          }
          updateFps();
          // Schedule next frame
          if (!isPausedRef.current && modeRef.current !== 'IDLE') {
            rafRef.current = requestAnimationFrame(processFrameRef.current);
          }
        }
      };
    });

    workersRef.current = workers;
    processFrameRef.current = makeProcessFrame();
    frameSkipCtr.current = 0;
    lastTimeRef.current  = -1;
    dimResetRef.current  = true;

    // Kick off the rAF loop
    rafRef.current = requestAnimationFrame(processFrameRef.current);

    return () => {
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);
      workers.forEach(w => w.terminate());
      workersRef.current = [];
      pendingRef.current = 0;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, settings.numWorkers, makeProcessFrame, updateFps]);

  /* ── Webcam setup ────────────────────────────────────────────────────── */
  useEffect(() => {
    if (mode !== 'WEBCAM') return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    setCameraStatus('requesting camera...');

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'user' }, audio: false })
      .then(s => {
        if (cancelled) { s.getTracks().forEach(t => t.stop()); return; }
        stream = s;
        const vid = videoRef.current;
        if (vid) { vid.srcObject = s; vid.play().catch(() => {}); }
        setCameraStatus('');
      })
      .catch(() => { if (!cancelled) setCameraStatus('camera access denied'); });

    return () => {
      cancelled = true;
      stream?.getTracks().forEach(t => t.stop());
      const vid = videoRef.current;
      if (vid) { vid.srcObject = null; vid.pause(); }
      lastTimeRef.current = -1;
      dimResetRef.current = true;
    };
  }, [mode]);

  /* ── Pause / play ────────────────────────────────────────────────────── */
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || mode === 'IDLE') return;
    if (isPaused) { vid.pause(); } else { vid.play().catch(() => {}); }
  }, [isPaused, mode]);

  /* ── Blur CSS filter ─────────────────────────────────────────────────── */
  useEffect(() => {
    const c = outputCanvasRef.current;
    if (c) c.style.filter = settings.blur > 0 ? `blur(${settings.blur}px)` : '';
  }, [settings.blur]);

  /* ── Recording ───────────────────────────────────────────────────────── */
  const startRecording = useCallback(async () => {
    const canvas = outputCanvasRef.current;
    if (!canvas) return;
    const db = await openRecDB();
    await clearChunks(db);
    recDbRef.current = db;
    lastBlobRef.current = null;
    setHasRecording(false);
    setConversionPct(null);

    // Always record in the best available WebM format (most supported).
    // If the user wants MP4 and the browser can natively record it, use that.
    // Otherwise we convert with FFmpeg after the recording stops.
    const wantMp4 = settingsRef.current.recFormat === 'mp4';
    const nativeMp4Mime = ['video/mp4;codecs=avc1', 'video/mp4']
      .find(m => MediaRecorder.isTypeSupported(m));
    const { mimeType: bestWebm } = getBestMime();
    const recordMime    = (wantMp4 && nativeMp4Mime) ? nativeMp4Mime : (bestWebm || '');
    const nativelyMp4   = recordMime.includes('mp4');
    const needsConvert  = wantMp4 && !nativelyMp4;

    const stream = canvas.captureStream(30);
    const opts   = recordMime ? { mimeType: recordMime } : {};
    const mr     = new MediaRecorder(stream, opts);

    mr.ondataavailable = async (ev) => {
      if (ev.data.size > 0 && recDbRef.current) {
        await appendChunk(recDbRef.current, ev.data);
      }
    };

    mr.onstop = async () => {
      const db2 = recDbRef.current;
      if (!db2) return;
      const chunks   = await getAllChunks(db2);
      const rawBlob  = new Blob(chunks, { type: recordMime || 'video/webm' });
      await clearChunks(db2);

      if (needsConvert) {
        // FFmpeg: webm → mp4 on the client
        setConversionPct(0);
        try {
          const mp4Blob = await convertToMp4(rawBlob, pct => setConversionPct(pct));
          lastBlobRef.current = { blob: mp4Blob, ext: 'mp4' };
        } catch (err) {
          console.error('MP4 conversion failed, falling back to WebM', err);
          lastBlobRef.current = { blob: rawBlob, ext: 'webm' };
        }
        setConversionPct(null);
      } else {
        lastBlobRef.current = { blob: rawBlob, ext: nativelyMp4 ? 'mp4' : 'webm' };
      }
      setHasRecording(true);
    };

    mr.start(1000);
    mrRef.current = mr;
    setIsRecording(true);
  }, []);

  const stopRecording = useCallback(() => {
    mrRef.current?.stop();
    mrRef.current = null;
    setIsRecording(false);
  }, []);

  const downloadRecording = useCallback(() => {
    const rec = lastBlobRef.current;
    if (rec) downloadBlob(rec.blob, `changes-${Date.now()}.${rec.ext}`);
  }, []);

  /* Auto-stop recording when video file ends */
  const handleVideoEnded = useCallback(() => {
    if (isRecording) stopRecording();
  }, [isRecording, stopRecording]);

  /* ── File upload ─────────────────────────────────────────────────────── */
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (videoSrcRef.current) URL.revokeObjectURL(videoSrcRef.current);
    const url = URL.createObjectURL(file);
    videoSrcRef.current = url;
    lastTimeRef.current = -1;
    dimResetRef.current = true;
    setIsPaused(false);
    setMode('VIDEO');
  };

  /* ── Reset ───────────────────────────────────────────────────────────── */
  const reset = useCallback(() => {
    if (isRecording) stopRecording();
    if (videoSrcRef.current) { URL.revokeObjectURL(videoSrcRef.current); videoSrcRef.current = ''; }
    setCameraStatus('');
    setIsPaused(false);
    setHasRecording(false);
    lastBlobRef.current = null;
    fpsTimesRef.current = [];
    if (fpsSpanRef.current) fpsSpanRef.current.textContent = '';
    setMode('IDLE');
  }, [isRecording, stopRecording]);

  /* revoke blob on unmount */
  useEffect(() => () => {
    if (videoSrcRef.current) URL.revokeObjectURL(videoSrcRef.current);
  }, []);

  const isActive = mode !== 'IDLE';

  /* ─────────────────────────────────────────────────────────────────────── */
  return (
    <div className="app-root">

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title" data-testid="app-title">CHANGES</h1>
          {isActive && settings.showFps && (
            <span ref={fpsSpanRef} className="fps-badge" data-testid="fps-display" />
          )}
        </div>

        {isActive && (
          <div className="header-controls">
            {/* Recording buttons — always visible when active */}
            {isRecording ? (
              <button className="ctrl-btn ctrl-btn--stop-rec" onClick={stopRecording}
                data-testid="button-stop-record">
                <span className="rec-dot rec-dot--live" />STOP REC
              </button>
            ) : (
              <button className="ctrl-btn ctrl-btn--rec" onClick={startRecording}
                data-testid="button-record">
                <span className="rec-dot" />REC
              </button>
            )}

            {conversionPct !== null && (
              <span className="conversion-badge" data-testid="conversion-status">
                Converting {conversionPct}%…
              </span>
            )}

            {hasRecording && conversionPct === null && (
              <button className="ctrl-btn ctrl-btn--download" onClick={downloadRecording}
                data-testid="button-download">
                ↓ Download
              </button>
            )}

            <button className="ctrl-btn" onClick={() => setIsPaused(p => !p)}
              data-testid="button-pause-play">
              {isPaused ? 'Play' : (mode === 'WEBCAM' ? 'Freeze' : 'Pause')}
            </button>

            <button className={`ctrl-btn${settingsOpen ? ' ctrl-btn--active' : ''}`}
              onClick={() => setSettingsOpen(o => !o)}
              data-testid="button-settings">
              Settings
            </button>

            <button className="ctrl-btn" onClick={reset} data-testid="button-switch-source">
              ← Source
            </button>
          </div>
        )}
      </header>

      {/* ── Settings panel ───────────────────────────────────────────────── */}
      {isActive && settingsOpen && (
        <div className="settings-backdrop" onClick={() => setSettingsOpen(false)} />
      )}
      {isActive && (
        <div className={`settings-panel${settingsOpen ? ' settings-panel--open' : ''}`}>
          {/* mobile drawer handle */}
          <div className="drawer-handle" onClick={() => setSettingsOpen(false)} />
          <div className="settings-grid">

            {/* ── Processing ─────────────────────────────── */}
            <div className="setting-section">
              <div className="section-title">Processing</div>
              <Slider label="Sensitivity" value={settings.threshold}
                min={1} max={50} step={1} onChange={v => set('threshold', v)} />
              <Slider label="Noise Gate" value={settings.noiseGate}
                min={0} max={30} step={1}
                display={settings.noiseGate === 0 ? 'off' : `${settings.noiseGate}`}
                onChange={v => set('noiseGate', v)} />
              <Slider label="Trail" value={settings.trail}
                min={0} max={0.98} step={0.01}
                display={`${Math.round(settings.trail * 100)}%`}
                onChange={v => set('trail', v)} />
            </div>

            {/* ── Rendering ──────────────────────────────── */}
            <div className="setting-section">
              <div className="section-title">Rendering</div>
              <Select label="Color Mode" value={settings.colorMode}
                options={[
                  { v: 'binary', label: 'B/W' },
                  { v: 'heat',   label: 'Heat' },
                  { v: 'neon',   label: 'Neon' },
                ]}
                onChange={v => set('colorMode', v)} />
              <Slider label="Blur" value={settings.blur}
                min={0} max={8} step={0.5}
                display={settings.blur === 0 ? 'off' : `${settings.blur}px`}
                onChange={v => set('blur', v)} />
              <Toggle label="Invert"      value={settings.invert}      onChange={v => set('invert', v)} />
              <Toggle label="Show Source" value={settings.showSource}  onChange={v => set('showSource', v)} />
              <Toggle label="Show FPS"    value={settings.showFps}     onChange={v => set('showFps', v)} />
            </div>

            {/* ── Recording ──────────────────────────────── */}
            <div className="setting-section">
              <div className="section-title">Recording</div>
              <Select label="Format" value={settings.recFormat}
                options={[
                  { v: 'webm', label: 'WebM' },
                  { v: 'mp4',  label: 'MP4'  },
                ]}
                onChange={v => set('recFormat', v)} />
            </div>

            {/* ── Performance ────────────────────────────── */}
            <div className="setting-section">
              <div className="section-title">Performance</div>
              <Select label="Workers" value={String(settings.numWorkers) as '1'|'2'|'4'}
                options={[
                  { v: '1', label: '1×' },
                  { v: '2', label: '2×' },
                  { v: '4', label: '4×' },
                ]}
                onChange={v => set('numWorkers', +v)} />
              <Select label="Frame Skip" value={String(settings.frameSkip) as '1'|'2'|'3'|'4'}
                options={[
                  { v: '1', label: '1:1' },
                  { v: '2', label: '1:2' },
                  { v: '3', label: '1:3' },
                  { v: '4', label: '1:4' },
                ]}
                onChange={v => set('frameSkip', +v)} />
            </div>

          </div>
        </div>
      )}

      {/* ── Main content ─────────────────────────────────────────────────── */}
      {mode === 'IDLE' ? (
        <main className="idle-main">
          <div className="idle-card">
            <p className="idle-tagline">see what moves</p>
            <div className="idle-buttons">
              <button className="source-btn"
                onClick={() => { setMode('WEBCAM'); setIsPaused(false); }}
                data-testid="button-use-webcam">
                Use Webcam
              </button>
              <button className="source-btn"
                onClick={() => fileInputRef.current?.click()}
                data-testid="button-upload-video">
                Upload Video
              </button>
              <input type="file" accept="video/*" className="hidden"
                ref={fileInputRef} onChange={handleFileUpload}
                data-testid="input-file-video" />
            </div>
          </div>
        </main>
      ) : (
        <main className="active-main">
          <div className={`panels${settings.showSource ? '' : ' panels--single'}`}>

            {/* Source panel — always in DOM so videoRef stays mounted */}
            <div className="panel" style={{ display: settings.showSource ? 'flex' : 'none' }}>
              <div className="panel-label">Source</div>
              {cameraStatus && (
                <div className="panel-status">
                  <span className="panel-status-text">{cameraStatus}</span>
                  {cameraStatus === 'camera access denied' && (
                    <button className="ctrl-btn mt-4" onClick={reset}>← Back</button>
                  )}
                </div>
              )}
              <video ref={videoRef}
                src={mode === 'VIDEO' ? videoSrcRef.current : undefined}
                playsInline loop={mode === 'VIDEO'} muted
                className={`panel-video${cameraStatus ? ' panel-video--hidden' : ''}`}
                onEnded={handleVideoEnded}
                data-testid="video-source" />
            </div>

            {/* Output panel */}
            <div className="panel">
              {isRecording && <div className="panel-rec-badge">● REC</div>}
              <div className="panel-label">Output</div>
              <canvas ref={outputCanvasRef} className="panel-canvas" data-testid="canvas-output" />
            </div>

          </div>

          {/* hidden processing canvas */}
          <canvas ref={hiddenCanvasRef} className="hidden" />
        </main>
      )}
    </div>
  );
}
