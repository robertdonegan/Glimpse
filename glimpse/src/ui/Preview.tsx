import { useEffect, useRef } from 'react';
import { useGlimpse } from '../state/store';
import { GlimpseRenderer } from '../render/renderer';
import { sampleFrame, speedAt, buildTimeline, sourceToOutput } from '../timeline/sampler';
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
  /** Wall-clock instant playback last started — the music track's own clock,
   * so it stays independent of video cuts and speed. */
  const playStartRef = useRef(0);
  /** True once the music element has been started for this play session, so the
   * loop never re-seeks or re-triggers it mid-clip (which stuttered). */
  const musicStartedRef = useRef(false);

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

          // The music track is deliberately independent of the video edit —
          // it plays straight through at 1×, unaffected by cuts or speed. Start
          // it once at the right spot, then let it play natively: re-seeking a
          // compressed audio element every frame snapped it back to cluster
          // boundaries and stuttered ("a split second every second").
          const music = current.music;
          const el = musicRef.current;
          if (music && el) {
            const wall = (performance.now() - playStartRef.current) / 1000;
            const pos = wall - music.offset / 1000; // music-local seconds
            const active = pos >= 0 && pos < music.duration / 1000;
            el.volume = music.gain;
            el.playbackRate = 1;
            if (active && !musicStartedRef.current) {
              // Seek once, at the start of the clip's window, then leave it be.
              el.currentTime = Math.max(0, pos);
              void el.play();
              musicStartedRef.current = true;
            } else if (!active && musicStartedRef.current) {
              el.pause();
              musicStartedRef.current = false;
            }
          }
        } else if (musicRef.current) {
          if (!musicRef.current.paused) musicRef.current.pause();
          musicStartedRef.current = false; // fresh start next time play begins
        }
        renderer.render(sampleFrame(current, tMs, st.previewRate));
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
      const st = useGlimpse.getState();
      // Anchor the music clock to the playhead's position on the output
      // timeline, so the (independent) soundtrack lines up where it will on
      // export regardless of cuts before the playhead.
      if (st.project) {
        const outMs = sourceToOutput(buildTimeline(st.project), st.playhead);
        playStartRef.current = performance.now() - outMs;
      }
      musicStartedRef.current = false; // start the music fresh for this session
      video.currentTime = st.playhead / 1000;
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
    const canvas = canvasRef.current;
    if (!canvas) return;
    const zoom = panTarget();
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    let last = { x: e.clientX, y: e.clientY };

    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - last.x) / rect.width;
      const dy = (ev.clientY - last.y) / rect.height;
      last = { x: ev.clientX, y: ev.clientY };
      const st = useGlimpse.getState();
      if (zoom) {
        // A zoom under the playhead — drag reframes it.
        const cur = st.project?.zooms.find((z) => z.id === zoom.id);
        if (!cur) return;
        const s = Math.max(cur.scale, 1e-3);
        st.updateZoom(zoom.id, {
          focusX: clamp01(cur.focusX - dx / s),
          focusY: clamp01(cur.focusY - dy / s),
        });
      } else {
        // No zoom — drag repositions the recording within the output frame.
        const p = st.project;
        if (!p) return;
        const pos = p.style.position ?? { x: 0.5, y: 0.5 };
        st.patchStyle('position', {
          x: clamp01(pos.x + dx),
          y: clamp01(pos.y + dy),
        });
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // The canvas is always draggable: a zoom under the playhead pans, otherwise
  // the whole recording repositions.
  const pannable = !!project;

  return (
    <div className="preview-wrap">
      <canvas
        ref={canvasRef}
        className={`preview-canvas${pannable ? ' pannable' : ''}`}
        onPointerDown={onPointerDown}
        title="Drag to reposition the recording (or pan a zoom under the playhead)"
      />
    </div>
  );
}
