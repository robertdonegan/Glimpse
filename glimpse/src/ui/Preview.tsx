import { useEffect, useRef } from 'react';
import { useGlimpse } from '../state/store';
import { GlimpseRenderer } from '../render/renderer';
import { sampleFrame } from '../timeline/sampler';
import { loadRecordingVideo } from '../export/exporter';

/**
 * Live preview. The recording plays in a hidden <video>; every animation
 * frame we sample the timeline at video.currentTime and hand it to the same
 * renderer the exporter uses. What you preview is literally what you export.
 */
export function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GlimpseRenderer | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const project = useGlimpse((s) => s.project);
  const playing = useGlimpse((s) => s.playing);
  const playhead = useGlimpse((s) => s.playhead);

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

    const renderer = new GlimpseRenderer(canvas, project);
    rendererRef.current = renderer;

    let disposed = false;
    let raf = 0;

    void loadRecordingVideo(project.recording.blob).then((video) => {
      if (disposed) return;
      videoRef.current = video;
      renderer.attachVideo(video);

      const loop = () => {
        if (disposed) return;
        const st = useGlimpse.getState();
        const tMs = st.playing ? video.currentTime * 1000 : st.playhead;
        if (st.playing) {
          st.setPlayhead(tMs);
          if (video.ended || tMs >= project.recording.duration) st.setPlaying(false);
        }
        const current = st.project ?? project;
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

  // Play/pause and scrubbing drive the hidden video element.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) {
      video.currentTime = playhead / 1000;
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

  return (
    <div className="preview-wrap">
      <canvas ref={canvasRef} className="preview-canvas" />
    </div>
  );
}
