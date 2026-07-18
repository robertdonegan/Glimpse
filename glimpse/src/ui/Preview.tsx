import { useEffect, useRef } from 'react';
import { useGlimpse } from '../state/store';
import { GlimpseRenderer } from '../render/renderer';
import { sampleFrame, speedAt } from '../timeline/sampler';
import { loadRecordingVideo } from '../export/exporter';

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * Live preview. The recording plays in a hidden <video>; every animation
 * frame we sample the timeline at video.currentTime and hand it to the same
 * renderer the exporter uses. What you preview is literally what you export.
 *
 * Dragging the canvas pans the selected zoom (or the zoom under the
 * playhead) — direct-manipulation framing.
 */
export function Preview({ selectedZoom }: { selectedZoom: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GlimpseRenderer | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const musicRef = useRef<HTMLAudioElement | null>(null);

  const project = useGlimpse((s) => s.project);
  const playing = useGlimpse((s) => s.playing);
  const playhead = useGlimpse((s) => s.playhead);

  // Imported music plays through its own element, synced in the render loop.
  useEffect(() => {
    const blob = project?.music?.blob;
    if (!blob) {
      musicRef.current?.pause();
      musicRef.current = null;
      return;
    }
    const el = new Audio(URL.createObjectURL(blob));
    el.preload = 'auto';
    musicRef.current = el;
    return () => {
      el.pause();
      URL.revokeObjectURL(el.src);
      if (musicRef.current === el) musicRef.current = null;
    };
  }, [project?.music?.blob]);

  // Mount renderer + recording video once per project.
  useEffect(() => {
    if (!project || !canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.width = project.output.width;
    canvas.height = project.output.height;
    canvas.style.setProperty(
      '--preview-aspect',
      `${project.output.width} / ${project.output.height}`,
    );

    // Preview never reads the buffer back, so skip preserveDrawingBuffer —
    // avoids driver tiling seams on some GPUs.
    const renderer = new GlimpseRenderer(canvas, project, { preserveDrawingBuffer: false });
    rendererRef.current = renderer;

    let disposed = false;
    let raf = 0;

    void loadRecordingVideo(project.recording.blob).then((video) => {
      if (disposed) return;
      videoRef.current = video;
      // loadRecordingVideo mutes for its duration probe — the preview should
      // be audible.
      video.muted = false;
      video.volume = 1;
      renderer.attachVideo(video);

      const loop = () => {
        if (disposed) return;
        const st = useGlimpse.getState();
        const current = st.project ?? project;
        const tMs = st.playing ? video.currentTime * 1000 : st.playhead;
        if (st.playing) {
          // Jump over cut ranges so playback only shows kept footage.
          const cut = (current.cuts ?? []).find((c) => tMs >= c.start && tMs < c.end);
          if (cut) {
            video.currentTime = cut.end / 1000;
            raf = requestAnimationFrame(loop);
            return;
          }
          st.setPlayhead(tMs);
          // Clip speeds drive the preview's playback rate live (so a 0.5×
          // slow pass previews exactly as it exports), scaled by the
          // preview-only slow-viewing rate.
          const rate = speedAt(current.zooms, tMs) * st.previewRate;
          video.playbackRate = rate;
          const trimEnd = current.trim?.end ?? current.recording.duration;
          if (video.ended || tMs >= trimEnd) {
            if (st.loop) {
              video.currentTime = (current.trim?.start ?? 0) / 1000;
              void video.play();
            } else {
              st.setPlaying(false);
            }
          }

          // Keep the music track in lockstep with the timeline.
          const music = current.music;
          const el = musicRef.current;
          if (music && el) {
            const rel = (tMs - music.offset) / 1000;
            const active = rel >= 0 && rel < music.duration / 1000;
            el.volume = music.gain;
            el.playbackRate = Math.max(0.0625, rate);
            if (active) {
              if (el.paused) {
                el.currentTime = rel;
                void el.play();
              } else if (Math.abs(el.currentTime - rel) > 0.25) {
                el.currentTime = rel; // drift correction
              }
            } else if (!el.paused) {
              el.pause();
            }
          }
        } else if (musicRef.current && !musicRef.current.paused) {
          musicRef.current.pause();
        }
        renderer.render(sampleFrame(current, tMs));
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      renderer.dispose();
      rendererRef.current = null;
      if (videoRef.current) {
        videoRef.current.pause();
        URL.revokeObjectURL(videoRef.current.src);
        videoRef.current = null;
      }
    };
    // Recording identity defines the session; style/zoom edits flow through
    // getState() in the loop without a remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.recording]);

  // Keep the renderer in sync with style edits.
  useEffect(() => {
    if (project) rendererRef.current?.applyStyle(project.style);
  }, [project?.style]);

  // …and with overlay graphics.
  useEffect(() => {
    if (project) rendererRef.current?.applyOverlays(project.overlays);
  }, [project?.overlays]);

  // Play/pause and scrubbing drive the hidden video element.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) {
      video.currentTime = useGlimpse.getState().playhead / 1000;
      void video.play();
    } else {
      video.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  useEffect(() => {
    const video = videoRef.current;
    if (video && !playing) video.currentTime = playhead / 1000;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playhead]);

  /** The zoom a canvas drag should reframe. */
  const panTarget = () => {
    const st = useGlimpse.getState();
    const p = st.project;
    if (!p) return null;
    const z =
      p.zooms.find((z) => z.id === selectedZoom) ??
      p.zooms.find((z) => st.playhead >= z.start && st.playhead <= z.end) ??
      null;
    return z && !z.follow ? z : null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const zoom = panTarget();
    const canvas = canvasRef.current;
    if (!zoom || !canvas) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    let last = { x: e.clientX, y: e.clientY };

    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - last.x) / rect.width;
      const dy = (ev.clientY - last.y) / rect.height;
      last = { x: ev.clientX, y: ev.clientY };
      const st = useGlimpse.getState();
      const cur = st.project?.zooms.find((z) => z.id === zoom.id);
      if (!cur) return;
      const s = Math.max(cur.scale, 1e-3);
      st.updateZoom(zoom.id, {
        focusX: clamp01(cur.focusX - dx / s),
        focusY: clamp01(cur.focusY - dy / s),
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const pannable =
    !!project &&
    !!(
      project.zooms.find((z) => z.id === selectedZoom) ??
      project.zooms.find((z) => playhead >= z.start && playhead <= z.end)
    );

  return (
    <div className="preview-wrap">
      <canvas
        ref={canvasRef}
        className={`preview-canvas${pannable ? ' pannable' : ''}`}
        onPointerDown={onPointerDown}
        title={pannable ? 'Drag to pan the zoom framing' : undefined}
      />
    </div>
  );
}
