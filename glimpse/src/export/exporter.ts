/**
 * Offline export pipeline: seek the raw recording frame by frame, render
 * each frame through the same GlimpseRenderer + sampler the preview uses,
 * and encode with WebCodecs into a real MP4 (H.264 + AAC) via mp4-muxer.
 *
 * Clip speeds are applied here: the exporter walks *output* time and maps
 * each frame back to the source instant on screen, so slow passes render
 * every intermediate frame at full quality.
 *
 * Not realtime capture — a 60s recording exports as fast as the machine can
 * seek + encode, at full quality, with zero dropped frames. Falls back to
 * MediaRecorder (webm, realtime) where WebCodecs is unavailable.
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { Project } from '../timeline/model';
import { sampleFrame, outputToSource, sourceToOutput } from '../timeline/sampler';
import { GlimpseRenderer } from '../render/renderer';

export interface ExportProgress {
  frame: number;
  totalFrames: number;
}

export interface ExportResult {
  blob: Blob;
  extension: 'mp4' | 'webm' | 'png';
}

export function webCodecsSupported(): boolean {
  return typeof VideoEncoder !== 'undefined';
}

/** Audio survives export only at uniform 1× speed (no resampling pipeline). */
export function audioExportable(project: Project): boolean {
  return (
    project.recording.hasAudio &&
    typeof AudioEncoder !== 'undefined' &&
    project.zooms.every((z) => (z.speed || 1) === 1)
  );
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

/** Decode the recording's audio track to PCM. Null if decode fails. */
async function decodeAudio(blob: Blob): Promise<AudioBuffer | null> {
  try {
    const ctx = new AudioContext();
    const buf = await blob.arrayBuffer();
    const audio = await ctx.decodeAudioData(buf);
    void ctx.close();
    return audio;
  } catch {
    return null;
  }
}

/** Encode a slice of an AudioBuffer as AAC chunks into the muxer. */
async function encodeAudioTrack(
  muxer: Muxer<ArrayBufferTarget>,
  audio: AudioBuffer,
  startSec: number,
  maxDurationSec: number,
): Promise<void> {
  const channels = Math.min(audio.numberOfChannels, 2);
  const encoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => {
      throw e;
    },
  });
  encoder.configure({
    codec: 'mp4a.40.2', // AAC-LC
    sampleRate: audio.sampleRate,
    numberOfChannels: channels,
    bitrate: 192_000,
  });

  const startFrame = Math.min(audio.length, Math.floor(startSec * audio.sampleRate));
  const endFrame = Math.min(
    audio.length,
    startFrame + Math.floor(maxDurationSec * audio.sampleRate),
  );
  const CHUNK = 16_384;
  for (let off = startFrame; off < endFrame; off += CHUNK) {
    const len = Math.min(CHUNK, endFrame - off);
    const planar = new Float32Array(channels * len);
    for (let ch = 0; ch < channels; ch++) {
      planar.set(audio.getChannelData(ch).subarray(off, off + len), ch * len);
    }
    const data = new AudioData({
      format: 'f32-planar',
      sampleRate: audio.sampleRate,
      numberOfFrames: len,
      numberOfChannels: channels,
      timestamp: Math.round(((off - startFrame) / audio.sampleRate) * 1_000_000),
      data: planar,
    });
    encoder.encode(data);
    data.close();
  }
  await encoder.flush();
  encoder.close();
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
  const srcDurationMs = project.recording.duration;
  const trim = project.trim ?? { start: 0, end: srcDurationMs };
  // Export walks the output timeline restricted to the trimmed span.
  const outStartMs = sourceToOutput(project.zooms, trim.start);
  const outEndMs = sourceToOutput(project.zooms, trim.end);
  const outDurationSec = Math.max(0.001, (outEndMs - outStartMs) / 1000);
  const totalFrames = Math.max(1, Math.floor(outDurationSec * fps));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const renderer = new GlimpseRenderer(canvas, project);
  const video = await loadRecordingVideo(project.recording.blob);
  renderer.attachVideo(video);

  const withAudio = audioExportable(project);
  const audio = withAudio ? await decodeAudio(project.recording.blob) : null;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height },
    ...(audio
      ? {
          audio: {
            codec: 'aac' as const,
            sampleRate: audio.sampleRate,
            numberOfChannels: Math.min(audio.numberOfChannels, 2),
          },
        }
      : {}),
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
      const tOutMs = outStartMs + (i / fps) * 1000;
      const tSrcMs = outputToSource(project.zooms, tOutMs, srcDurationMs);
      await seekTo(video, tSrcMs / 1000);
      renderer.render(sampleFrame(project, tSrcMs));

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
    if (audio) await encodeAudioTrack(muxer, audio, trim.start / 1000, outDurationSec);
    muxer.finalize();
    const { buffer } = muxer.target as ArrayBufferTarget;
    return { blob: new Blob([buffer], { type: 'video/mp4' }), extension: 'mp4' };
  } finally {
    encoder.state !== 'closed' && encoder.close();
    renderer.dispose();
    URL.revokeObjectURL(video.src);
  }
}

/**
 * Render a single frame as a high-resolution PNG. `scale` multiplies the
 * project's output size (2 → 4K-ish from a 1080p project).
 */
export async function exportStill(project: Project, tMs: number, scale = 2): Promise<Blob> {
  const width = Math.round(project.output.width * scale);
  const height = Math.round(project.output.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const renderer = new GlimpseRenderer(canvas, project);
  renderer.resize(width, height);
  const video = await loadRecordingVideo(project.recording.blob);
  try {
    renderer.attachVideo(video);
    await seekTo(video, tMs / 1000);
    renderer.render(sampleFrame(project, tMs));
    return await new Promise<Blob>((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG encode failed'))), 'image/png'),
    );
  } finally {
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
