import { useRef } from 'react';
import { useGlimpse } from '../state/store';
import { outputDuration } from '../timeline/sampler';

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

  const trackRef = useRef<HTMLDivElement>(null);

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

  const jump = (t: number) => {
    setPlaying(false);
    setPlayhead(t);
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
    </div>
  );
}
