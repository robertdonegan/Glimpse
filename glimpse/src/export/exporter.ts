/**
 * Offline export pipeline: seek the raw recording frame by frame, render
 * each frame through the same GlimpseRenderer + sampler the preview uses,
 * and encode with WebCodecs into a real MP4 (H.264) via mp4-muxer.
 *
 * Not realtime capture — a 60s recording exports as fast as the machine can
 * seek + encode, at full quality, with zero dropped frames. Falls back to
 * MediaRecorder (webm, realtime) where WebCodecs is unavailable.
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { Project } from '../timeline/model';
import { sampleFrame } from '../timeline/sampler';
import { GlimpseRenderer } from '../render/renderer';

export interface ExportProgress {
  frame: number;
  totalFrames: number;
}

export interface ExportResult {
  blob: Blob;
  extension: 'mp4' | 'webm';
}

export function webCodecsSupported(): boolean {
  return typeof VideoEncoder !== 'undefined';
}

/**
 * MediaRecorder-produced webm blobs report Infinity duration and refuse to
 * seek. Nudging currentTime past the end forces the browser to compute the
 * real duration. Ugly, well-known, works.
 */
export async function loadRecordingVideo(blob: Blob): Promise<HTMLVideoElement> {
  const video = document.createElement('video');
  video.src = URL.createObjectURL(blob);
  video.muted = true;
  video.playsInline = true;
  await new Promise<void>((res, rej) => {
    video.onloadedmetadata = () => res();
    video.onerror = () => rej(new Error('Could not load recording'));
  });
  if (!Number.isFinite(video.duration)) {
    await new Promise<void>((res) => {
      video.ondurationchange = () => {
        if (Number.isFinite(video.duration)) {
          video.ondurationchange = null;
          video.currentTime = 0;
          res();
        }
      };
      video.currentTime = Number.MAX_SAFE_INTEGER;
    });
  }
  return video;
}

function seekTo(video: HTMLVideoElement, timeSec: number): Promise<void> {
  return new Promise((res) => {
    const done = () => {
      video.removeEventListener('seeked', done);
      res();
    };
    if (Math.abs(video.currentTime - timeSec) < 1 / 240) return res();
    video.addEventListener('seeked', done);
    video.currentTime = timeSec;
  });
}

export async function exportProject(
  project: Project,
  onProgress: (p: ExportProgress) => void,
  signal?: AbortSignal,
): Promise<ExportResult> {
  if (!webCodecsSupported()) {
    return exportRealtimeFallback(project, onProgress, signal);
  }

  const { width, height, fps } = project.output;
  const durationSec = Math.min(project.recording.duration / 1000);
  const totalFrames = Math.max(1, Math.floor(durationSec * fps));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const renderer = new GlimpseRenderer(canvas, project);
  const video = await loadRecordingVideo(project.recording.blob);
  renderer.attachVideo(video);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height },
    fastStart: 'in-memory',
  });

  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      throw e;
    },
  });

  const config: VideoEncoderConfig = {
    codec: 'avc1.640033', // H.264 High, level 5.1 — handles 4K60
    width,
    height,
    bitrate: 16_000_000,
    framerate: fps,
  };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) config.codec = 'avc1.42003e'; // Baseline fallback
  encoder.configure(config);

  const frameDurationUs = 1_000_000 / fps;
  try {
    for (let i = 0; i < totalFrames; i++) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const tMs = (i / fps) * 1000;
      await seekTo(video, tMs / 1000);
      renderer.render(sampleFrame(project, tMs));

      const frame = new VideoFrame(canvas, {
        timestamp: i * frameDurationUs,
        duration: frameDurationUs,
      });
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();

      // Keep the encoder queue bounded so memory stays flat.
      if (encoder.encodeQueueSize > 8) {
        await new Promise<void>((res) => {
          const check = () => {
            if (encoder.encodeQueueSize <= 4) res();
            else setTimeout(check, 4);
          };
          check();
        });
      }
      onProgress({ frame: i + 1, totalFrames });
    }
    await encoder.flush();
    muxer.finalize();
    const { buffer } = muxer.target as ArrayBufferTarget;
    return { blob: new Blob([buffer], { type: 'video/mp4' }), extension: 'mp4' };
  } finally {
    encoder.state !== 'closed' && encoder.close();
    renderer.dispose();
    URL.revokeObjectURL(video.src);
  }
}

/** Realtime fallback: play the recording once, capture the preview canvas. */
async function exportRealtimeFallback(
  project: Project,
  onProgress: (p: ExportProgress) => void,
  signal?: AbortSignal,
): Promise<ExportResult> {
  const { width, height, fps } = project.output;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const renderer = new GlimpseRenderer(canvas, project);
  const video = await loadRecordingVideo(project.recording.blob);
  renderer.attachVideo(video);

  const stream = canvas.captureStream(fps);
  const chunks: BlobPart[] = [];
  const rec = new MediaRecorder(stream, { videoBitsPerSecond: 16_000_000 });
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const durationMs = project.recording.duration;
  const totalFrames = Math.floor((durationMs / 1000) * fps);

  await video.play();
  rec.start(250);

  await new Promise<void>((resolve) => {
    const tick = () => {
      if (signal?.aborted || video.ended || video.currentTime * 1000 >= durationMs) {
        return resolve();
      }
      const tMs = video.currentTime * 1000;
      renderer.render(sampleFrame(project, tMs));
      onProgress({ frame: Math.floor((tMs / 1000) * fps), totalFrames });
      requestAnimationFrame(tick);
    };
    tick();
  });

  return new Promise((resolve) => {
    rec.onstop = () => {
      renderer.dispose();
      URL.revokeObjectURL(video.src);
      resolve({ blob: new Blob(chunks, { type: 'video/webm' }), extension: 'webm' });
    };
    rec.stop();
  });
}
