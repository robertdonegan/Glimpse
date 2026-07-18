import { useEffect, useRef } from 'react';
import { useGlimpse } from '../state/store';
import { outputDuration } from '../timeline/sampler';

/** Peak data per blob, computed once. */
const peaksCache = new WeakMap<Blob, Float32Array>();

async function computePeaks(blob: Blob, buckets = 600): Promise<Float32Array> {
  const cached = peaksCache.get(blob);
  if (cached) return cached;
  const ctx = new AudioContext();
  try {
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    const ch = audio.getChannelData(0);
    const peaks = new Float32Array(buckets);
    const step = Math.max(1, Math.floor(ch.length / buckets));
    for (let i = 0; i < buckets; i++) {
      let max = 0;
      const start = i * step;
      const end = Math.min(ch.length, start + step);
      for (let j = start; j < end; j += 16) {
        const v = Math.abs(ch[j]);
        if (v > max) max = v;
      }
      peaks[i] = max;
    }
    peaksCache.set(blob, peaks);
    return peaks;
  } finally {
    void ctx.close();
  }
}

/** Mirror-image waveform strip for an audio blob. */
function Waveform({ blob, color }: { blob: Blob; color: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let dead = false;
    void computePeaks(blob)
      .then((peaks) => {
        if (dead || !canvasRef.current) return;
        const cv = canvasRef.current;
        const ctx = cv.getContext('2d')!;
        ctx.clearRect(0, 0, cv.width, cv.height);
        ctx.fillStyle = color;
        const mid = cv.height / 2;
        const w = cv.width / peaks.length;
        for (let i = 0; i < peaks.length; i++) {
          const h = Math.max(1, peaks[i] * mid);
          ctx.fillRect(i * w, mid - h, Math.max(1, w - 0.5), h * 2);
        }
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [blob, color]);
  return <canvas ref={canvasRef} className="waveform" width={600} height={30} />;
}

function tc(ms: number): string {
  const s = ms / 1000;
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(Math.floor(s % 60)).padStart(2, '0');
  const ff = String(Math.floor((s % 1) * 30)).padStart(2, '0');
  return `${mm}:${ss}.${ff}`;
}

export function Timeline({
  selectedZoom,
  onSelectZoom,
}: {
  selectedZoom: string | null;
  onSelectZoom: (id: string | null) => void;
}) {
  const project = useGlimpse((s) => s.project);
  const playhead = useGlimpse((s) => s.playhead);
  const playing = useGlimpse((s) => s.playing);
  const setPlayhead = useGlimpse((s) => s.setPlayhead);
  const setPlaying = useGlimpse((s) => s.setPlaying);
  const togglePlay = useGlimpse((s) => s.togglePlay);
  const loop = useGlimpse((s) => s.loop);
  const toggleLoop = useGlimpse((s) => s.toggleLoop);
  const setTrim = useGlimpse((s) => s.setTrim);
  const addZoomAt = useGlimpse((s) => s.addZoomAt);
  const updateZoom = useGlimpse((s) => s.updateZoom);
  const applyAutoZoom = useGlimpse((s) => s.applyAutoZoom);
  const addMusic = useGlimpse((s) => s.addMusic);
  const updateMusic = useGlimpse((s) => s.updateMusic);
  const removeMusic = useGlimpse((s) => s.removeMusic);
  const updateOverlay = useGlimpse((s) => s.updateOverlay);
  const previewRate = useGlimpse((s) => s.previewRate);
  const setPreviewRate = useGlimpse((s) => s.setPreviewRate);

  const trackRef = useRef<HTMLDivElement>(null);
  const musicInput = useRef<HTMLInputElement>(null);

  if (!project) return null;
  const duration = project.recording.duration;
  const outDuration = outputDuration(project.zooms, duration);
  const frameMs = 1000 / project.output.fps;

  const timeAt = (clientX: number): number => {
    const rect = trackRef.current!.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * duration;
  };

  const scrubFrom = (clientX: number) => {
    setPlaying(false);
    setPlayhead(timeAt(clientX));
    const move = (ev: PointerEvent) => setPlayhead(timeAt(ev.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onTrackPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.zoom-seg, .trim-handle, .playhead-grip')) return;
    onSelectZoom(null);
    scrubFrom(e.clientX);
  };

  /** Drag an in/out trim marker. */
  const onTrimPointerDown = (e: React.PointerEvent, side: 'start' | 'end') => {
    e.stopPropagation();
    const move = (ev: PointerEvent) => {
      const t = timeAt(ev.clientX);
      if (side === 'start') setTrim({ start: t });
      else setTrim({ end: t });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** Drag a whole segment, or one of its trim handles. */
  const onSegPointerDown = (
    e: React.PointerEvent,
    id: string,
    part: 'body' | 'start' | 'end',
  ) => {
    e.stopPropagation();
    onSelectZoom(id);
    const seg = project.zooms.find((z) => z.id === id)!;
    const grabOffset = timeAt(e.clientX) - seg.start;

    const move = (ev: PointerEvent) => {
      const st = useGlimpse.getState().project;
      const s = st?.zooms.find((z) => z.id === id);
      if (!s) return;
      const t = timeAt(ev.clientX);
      if (part === 'body') {
        const len = s.end - s.start;
        const start = Math.max(0, Math.min(t - grabOffset, duration - len));
        updateZoom(id, { start, end: start + len });
      } else if (part === 'start') {
        updateZoom(id, { start: Math.max(0, Math.min(t, s.end - 200)) });
      } else {
        updateZoom(id, { end: Math.min(duration, Math.max(t, s.start + 200)) });
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const hasClicks = project.recording.clicks.length > 0;
  const flatOverlays = project.overlays.filter((o) => o.flat);

  const jump = (t: number) => {
    setPlaying(false);
    setPlayhead(t);
  };

  /** Drag a flat ident along the timeline to re-time it (keeps its length). */
  const onIdentPointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    const ov = project.overlays.find((o) => o.id === id);
    if (!ov) return;
    const grabOffset = timeAt(e.clientX) - ov.start;
    const move = (ev: PointerEvent) => {
      const o = useGlimpse.getState().project?.overlays.find((x) => x.id === id);
      if (!o) return;
      const len = o.end - o.start;
      const start = Math.max(0, Math.min(timeAt(ev.clientX) - grabOffset, duration - len));
      updateOverlay(id, { start, end: start + len });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** Drag the music clip along the timeline to re-time it. */
  const onMusicPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    const music = project.music;
    if (!music) return;
    const grabOffset = timeAt(e.clientX) - music.offset;
    const move = (ev: PointerEvent) => {
      const m = useGlimpse.getState().project?.music;
      if (!m) return;
      const offset = Math.max(
        -m.duration + 200,
        Math.min(timeAt(ev.clientX) - grabOffset, duration - 200),
      );
      updateMusic({ offset });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="timeline">
      <div className="timeline-head">
        <div className="timecode">
          <strong>{tc(playhead)}</strong> / {tc(duration)}
          {Math.abs(outDuration - duration) > 1 && (
            <span title="Output duration after clip speeds"> → {tc(outDuration)}</span>
          )}
        </div>
        <div className="timeline-actions">
          <div className="transport" role="group" aria-label="Transport">
            <button className="btn" onClick={() => jump(0)} title="Go to start" aria-label="Go to start">
              ⏮
            </button>
            <button
              className="btn"
              onClick={() => jump(playhead - frameMs)}
              title="Previous frame"
              aria-label="Previous frame"
            >
              ◀︎
            </button>
            <button
              className="btn"
              onClick={togglePlay}
              title={playing ? 'Pause (space)' : 'Play (space)'}
              aria-label={playing ? 'Pause' : 'Play'}
            >
              {playing ? '⏸' : '▶'}
            </button>
            <button
              className="btn"
              onClick={() => jump(playhead + frameMs)}
              title="Next frame"
              aria-label="Next frame"
            >
              ▶︎
            </button>
            <button
              className="btn"
              onClick={() => jump(duration)}
              title="Go to end"
              aria-label="Go to end"
            >
              ⏭
            </button>
            <button
              className={`btn${loop ? ' on' : ''}`}
              onClick={toggleLoop}
              title="Loop playback"
              aria-label="Loop playback"
              aria-pressed={loop}
            >
              ⟳
            </button>
          </div>
          <button
            className="btn"
            onClick={() => setTrim({ start: playhead })}
            title="Set the in-point at the playhead — export starts here"
          >
            ⌐ In
          </button>
          <button
            className="btn"
            onClick={() => setTrim({ end: playhead })}
            title="Set the out-point at the playhead — export ends here"
          >
            Out ¬
          </button>
          <button className="btn" onClick={() => addZoomAt(playhead)}>
            Add zoom
          </button>
          <button
            className="btn"
            onClick={applyAutoZoom}
            disabled={!hasClicks}
            title={hasClicks ? 'Regenerate zooms from your clicks' : 'Needs a tab recording with clicks'}
          >
            Auto-zoom
          </button>
          <button
            className="btn"
            onClick={() => musicInput.current?.click()}
            title="Import a music or voice-over file onto the audio track"
          >
            {project.music ? 'Replace audio' : 'Add audio'}
          </button>
          <input
            ref={musicInput}
            type="file"
            accept="audio/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void addMusic(f);
              e.target.value = '';
            }}
          />
          <select
            className="rate-select"
            value={previewRate}
            onChange={(e) => setPreviewRate(Number(e.target.value))}
            title="Preview playback speed (slow viewing only — export is unaffected)"
            aria-label="Preview playback speed"
          >
            <option value={1}>1×</option>
            <option value={0.5}>0.5×</option>
            <option value={0.25}>0.25×</option>
          </select>
        </div>
      </div>

      <div
        ref={trackRef}
        className="timeline-track"
        onPointerDown={onTrackPointerDown}
        role="slider"
        aria-label="Timeline"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={playhead}
      >
        {project.zooms.map((z) => (
          <div
            key={z.id}
            className={`zoom-seg${z.id === selectedZoom ? ' selected' : ''}`}
            style={{
              left: `${(z.start / duration) * 100}%`,
              width: `${((z.end - z.start) / duration) * 100}%`,
            }}
            onPointerDown={(e) => onSegPointerDown(e, z.id, 'body')}
          >
            <span
              className="seg-handle left"
              onPointerDown={(e) => onSegPointerDown(e, z.id, 'start')}
              aria-hidden="true"
            />
            <span className="seg-label">
              {z.scale.toFixed(1)}×{(z.speed || 1) !== 1 ? ` · ${z.speed}×spd` : ''}
            </span>
            <span
              className="seg-handle right"
              onPointerDown={(e) => onSegPointerDown(e, z.id, 'end')}
              aria-hidden="true"
            />
          </div>
        ))}
        {/* Trimmed-out regions + draggable in/out markers. */}
        <div
          className="trim-shade"
          style={{ left: 0, width: `${(project.trim.start / duration) * 100}%` }}
        />
        <div
          className="trim-shade"
          style={{
            left: `${(project.trim.end / duration) * 100}%`,
            width: `${((duration - project.trim.end) / duration) * 100}%`,
          }}
        />
        <div
          className="trim-handle"
          style={{ left: `${(project.trim.start / duration) * 100}%` }}
          onPointerDown={(e) => onTrimPointerDown(e, 'start')}
          title="Drag the in-point"
        />
        <div
          className="trim-handle right"
          style={{ left: `${(project.trim.end / duration) * 100}%` }}
          onPointerDown={(e) => onTrimPointerDown(e, 'end')}
          title="Drag the out-point"
        />
        <div className="playhead" style={{ left: `${(playhead / duration) * 100}%` }} />
        <div
          className="playhead-grip"
          style={{ left: `${(playhead / duration) * 100}%` }}
          onPointerDown={(e) => {
            e.stopPropagation();
            scrubFrom(e.clientX);
          }}
          title="Drag to scrub"
        />
      </div>

      {flatOverlays.length > 0 && (
        <div className="idents-lane" title="Flat idents — drag to re-time">
          {flatOverlays.map((o) => (
            <div
              key={o.id}
              className="ident-clip"
              style={{
                left: `${(o.start / duration) * 100}%`,
                width: `${((o.end - o.start) / duration) * 100}%`,
              }}
              onPointerDown={(e) => onIdentPointerDown(e, o.id)}
              title={`${o.name} — drag to re-time`}
            >
              <span className="ident-label">{o.name}</span>
            </div>
          ))}
          <div className="playhead" style={{ left: `${(playhead / duration) * 100}%` }} />
        </div>
      )}

      {(project.recording.audioBlob || project.music) && (
        <div className="audio-lane">
          {project.recording.audioBlob && (
            <div className="audio-rec" title="Recorded audio (locked to the video)">
              <Waveform blob={project.recording.audioBlob} color="rgba(45, 212, 191, 0.6)" />
            </div>
          )}
          {project.music && (
            <div
              className="music-clip"
              style={{
                left: `${(project.music.offset / duration) * 100}%`,
                width: `${(project.music.duration / duration) * 100}%`,
              }}
              onPointerDown={onMusicPointerDown}
              title={`${project.music.name} — drag to re-time`}
            >
              <Waveform blob={project.music.blob} color="rgba(147, 197, 253, 0.95)" />
              <button
                className="music-remove"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={removeMusic}
                title="Remove audio track"
                aria-label="Remove audio track"
              >
                ×
              </button>
            </div>
          )}
          <div className="playhead" style={{ left: `${(playhead / duration) * 100}%` }} />
        </div>
      )}
    </div>
  );
}
