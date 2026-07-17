import { useRef } from 'react';
import { useGlimpse } from '../state/store';

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
  const addZoomAt = useGlimpse((s) => s.addZoomAt);
  const updateZoom = useGlimpse((s) => s.updateZoom);
  const applyAutoZoom = useGlimpse((s) => s.applyAutoZoom);

  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; grabOffset: number } | null>(null);

  if (!project) return null;
  const duration = project.recording.duration;

  const timeAt = (clientX: number): number => {
    const rect = trackRef.current!.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * duration;
  };

  const onTrackPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.zoom-seg')) return;
    onSelectZoom(null);
    setPlaying(false);
    setPlayhead(timeAt(e.clientX));

    const move = (ev: PointerEvent) => setPlayhead(timeAt(ev.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onSegPointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    onSelectZoom(id);
    const seg = project.zooms.find((z) => z.id === id)!;
    drag.current = { id, grabOffset: timeAt(e.clientX) - seg.start };

    const move = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const st = useGlimpse.getState().project;
      const s = st?.zooms.find((z) => z.id === d.id);
      if (!s) return;
      const len = s.end - s.start;
      const start = Math.max(0, Math.min(timeAt(ev.clientX) - d.grabOffset, duration - len));
      updateZoom(d.id, { start, end: start + len });
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const hasClicks = project.recording.mode === 'tab' && project.recording.clicks.length > 0;

  return (
    <div className="timeline">
      <div className="timeline-head">
        <div className="timecode">
          <strong>{tc(playhead)}</strong> / {tc(duration)}
        </div>
        <div className="timeline-actions">
          <button className="btn" onClick={() => setPlaying(!playing)}>
            {playing ? 'Pause' : 'Play'}
          </button>
          <button className="btn" onClick={() => addZoomAt(playhead)}>
            Add zoom at playhead
          </button>
          <button
            className="btn"
            onClick={applyAutoZoom}
            disabled={!hasClicks}
            title={hasClicks ? 'Regenerate zooms from your clicks' : 'Needs a tab recording with clicks'}
          >
            Auto-zoom from clicks
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
            onPointerDown={(e) => onSegPointerDown(e, z.id)}
          >
            {z.scale.toFixed(1)}×
          </div>
        ))}
        <div className="playhead" style={{ left: `${(playhead / duration) * 100}%` }} />
      </div>
    </div>
  );
}
