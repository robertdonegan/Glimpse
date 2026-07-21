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
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import type { Project } from '../timeline/model';
import {
  sampleFrame,
  buildTimeline,
  outputDuration,
  outputToSource,
} from '../timeline/sampler';
import { GlimpseRenderer } from '../render/renderer';

export interface ExportProgress {
  frame: number;
  totalFrames: number;
}

export interface ExportResult {
  blob: Blob;
  extension: 'mp4' | 'webm' | 'png' | 'gif';
}

export function webCodecsSupported(): boolean {
  return typeof VideoEncoder !== 'undefined';
}

/**
 * Audio is an independent track: it plays straight through at 1×, unaffected
 * by the timeline's clip speeds, the global playback speed, or cuts. So the
 * only requirement is that the encoder exists and there's something to encode.
 */
export function audioExportable(project: Project): boolean {
  return (
    (project.recording.hasAudio || !!project.music) && typeof AudioEncoder !== 'undefined'
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

/**
 * Place one audio buffer flat on the output timeline at `whenSec`, at 1× —
 * no per-piece slicing, so cuts and clip/global speed never touch it.
 */
function scheduleFlat(
  ctx: OfflineAudioContext,
  buffer: AudioBuffer,
  whenSec: number,
  gain: number,
  durSec: number,
): void {
  const when = Math.max(0, whenSec);
  if (when >= durSec) return;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(g).connect(ctx.destination);
  // A negative offset (clip dragged to start before 0) is honoured by skipping
  // into the buffer.
  const into = Math.max(0, -whenSec);
  src.start(when, into, Math.min(buffer.duration - into, durSec - when));
}

/**
 * Mix recorded audio and imported music into one 48 kHz stereo buffer. Both
 * tracks play continuously at 1× — the soundtrack is deliberately independent
 * of the video edit (cuts, clip speeds, global playback speed).
 */
async function renderMixedAudio(project: Project, durSec: number): Promise<AudioBuffer | null> {
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(durSec * 48_000)), 48_000);
  let any = false;
  if (project.recording.hasAudio) {
    const b = await decodeAudio(project.recording.audioBlob ?? project.recording.blob);
    if (b) {
      scheduleFlat(ctx, b, 0, 1, durSec);
      any = true;
    }
  }
  if (project.music) {
    const b = await decodeAudio(project.music.blob);
    if (b) {
      scheduleFlat(ctx, b, project.music.offset / 1000, project.music.gain, durSec);
      any = true;
    }
  }
  return any ? ctx.startRendering() : null;
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
  /**
   * Global playback-speed multiplier (the timeline's speed slider). <1 slows
   * the whole export down, rendering every intermediate frame; 1 = untouched.
   */
  speed = 1,
): Promise<ExportResult> {
  if (!webCodecsSupported()) {
    return exportRealtimeFallback(project, onProgress, signal, speed);
  }

  const { width, height, fps } = project.output;
  // The piece list already encodes trim − cuts − clip speeds; walking it from
  // 0 renders exactly the kept footage, joined up.
  const pieces = buildTimeline(project);
  // The speed slider dilates the whole output timeline: at 0.25× the export
  // runs 4× longer, so we render 4× the frames and map each back to its
  // (undilated) instant on the piece timeline.
  const spd = Math.max(0.01, speed);
  const outDurationSec = Math.max(0.001, outputDuration(pieces) / 1000) / spd;
  const totalFrames = Math.max(1, Math.floor(outDurationSec * fps));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const renderer = new GlimpseRenderer(canvas, project);
  const video = await loadRecordingVideo(project.recording.blob);
  renderer.attachVideo(video);
  // Backdrop / overlay bitmaps decode async — wait for them or the first frames
  // render against black textures.
  await renderer.whenReady();

  // Audio is an independent 1× track — unaffected by cuts or speed.
  const withAudio = audioExportable(project);
  const audio = withAudio ? await renderMixedAudio(project, outDurationSec) : null;

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
  // Motion blur: render several sub-frames across a shutter window and average
  // them with a 'lighter' composite (each at 1/N alpha). N× the seeks/renders.
  const mb = project.style.motionBlur;
  const mbSamples = mb?.enabled ? Math.max(2, Math.round(2 + (mb.amount ?? 0.5) * 6)) : 1;
  const shutterMs = (1000 / fps) * 0.6;
  let accum: HTMLCanvasElement | null = null;
  let accumCtx: CanvasRenderingContext2D | null = null;
  if (mbSamples > 1) {
    accum = document.createElement('canvas');
    accum.width = width;
    accum.height = height;
    accumCtx = accum.getContext('2d');
  }
  try {
    for (let i = 0; i < totalFrames; i++) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      // Undilate: this output frame's instant on the (un-slowed) piece timeline.
      const tOutMs = (i / fps) * 1000 * spd;
      let frameSource: HTMLCanvasElement = canvas;
      if (mbSamples === 1 || !accumCtx) {
        const tSrcMs = outputToSource(pieces, tOutMs);
        await seekTo(video, tSrcMs / 1000);
        renderer.render(sampleFrame(project, tSrcMs, spd));
      } else {
        accumCtx.globalCompositeOperation = 'source-over';
        accumCtx.globalAlpha = 1;
        accumCtx.fillStyle = '#000';
        accumCtx.fillRect(0, 0, width, height);
        accumCtx.globalCompositeOperation = 'lighter';
        accumCtx.globalAlpha = 1 / mbSamples;
        for (let m = 0; m < mbSamples; m++) {
          const subOut = Math.max(0, tOutMs + ((m + 0.5) / mbSamples - 0.5) * shutterMs);
          const tSrc = outputToSource(pieces, subOut);
          await seekTo(video, tSrc / 1000);
          renderer.render(sampleFrame(project, tSrc, spd));
          accumCtx.drawImage(canvas, 0, 0);
        }
        accumCtx.globalCompositeOperation = 'source-over';
        accumCtx.globalAlpha = 1;
        frameSource = accum!;
      }

      const frame = new VideoFrame(frameSource, {
        timestamp: i * frameDurationUs,
        duration: frameDurationUs,
      });
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();

      // Keep the encoder queue bounded so memory stays flat. Wait on the
      // encoder's own 'dequeue' event rather than a 4ms busy-poll — the spin
      // pegged a core and ran the machine hot for no throughput gain.
      if (encoder.encodeQueueSize > 8) {
        await new Promise<void>((res) => {
          const onDequeue = () => {
            if (encoder.encodeQueueSize <= 4) {
              encoder.removeEventListener('dequeue', onDequeue);
              res();
            }
          };
          encoder.addEventListener('dequeue', onDequeue);
          onDequeue();
        });
      }
      onProgress({ frame: i + 1, totalFrames });
    }
    await encoder.flush();
    if (audio) await encodeAudioTrack(muxer, audio, 0, outDurationSec);
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
 * Export an animated GIF. GIFs are palette-limited and heavy, so this renders
 * at a reduced size and frame rate, quantising each frame to 256 colours.
 * Honours trim + cuts (via the piece timeline); no audio.
 */
export async function exportGif(
  project: Project,
  onProgress: (p: ExportProgress) => void,
  signal?: AbortSignal,
  speed = 1,
): Promise<ExportResult> {
  const GIF_FPS = 15;
  const spd = Math.max(0.01, speed);
  const MAX_W = 800;
  const aspect = project.output.width / project.output.height;
  const width = Math.min(MAX_W, project.output.width);
  const height = Math.max(2, Math.round(width / aspect));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const renderer = new GlimpseRenderer(canvas, project);
  renderer.resize(width, height);
  const video = await loadRecordingVideo(project.recording.blob);
  renderer.attachVideo(video);
  await renderer.whenReady();

  const pieces = buildTimeline(project);
  const durSec = Math.max(0.001, outputDuration(pieces) / 1000) / spd;
  const totalFrames = Math.max(1, Math.floor(durSec * GIF_FPS));
  const delay = Math.round(1000 / GIF_FPS);

  const gif = GIFEncoder();
  const read = document.createElement('canvas');
  read.width = width;
  read.height = height;
  const rctx = read.getContext('2d', { willReadFrequently: true })!;

  try {
    for (let i = 0; i < totalFrames; i++) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const tSrc = outputToSource(pieces, (i / GIF_FPS) * 1000 * spd);
      await seekTo(video, tSrc / 1000);
      renderer.render(sampleFrame(project, tSrc, spd));
      rctx.drawImage(canvas, 0, 0);
      const { data } = rctx.getImageData(0, 0, width, height);
      const palette = quantize(data, 256);
      const index = applyPalette(data, palette);
      gif.writeFrame(index, width, height, { palette, delay });
      onProgress({ frame: i + 1, totalFrames });
      if (i % 8 === 0) await new Promise((r) => setTimeout(r)); // keep UI alive
    }
    gif.finish();
    const bytes = new Uint8Array(gif.bytes()); // copy into a plain ArrayBuffer
    return { blob: new Blob([bytes], { type: 'image/gif' }), extension: 'gif' };
  } finally {
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
    await renderer.whenReady();
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
  speed = 1,
): Promise<ExportResult> {
  const { width, height, fps } = project.output;
  const spd = Math.max(0.01, speed);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const renderer = new GlimpseRenderer(canvas, project);
  const video = await loadRecordingVideo(project.recording.blob);
  renderer.attachVideo(video);
  await renderer.whenReady();

  const stream = canvas.captureStream(fps);
  const chunks: BlobPart[] = [];
  const rec = new MediaRecorder(stream, { videoBitsPerSecond: 16_000_000 });
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  // Honour the in/out trim just like the WebCodecs path — play only the
  // trimmed span rather than the whole recording.
  const trim = project.trim ?? { start: 0, end: project.recording.duration };
  const totalFrames = Math.max(1, Math.floor(((trim.end - trim.start) / 1000) * fps));

  // Slow the source playback to bake the speed multiplier into realtime capture.
  video.playbackRate = spd;
  video.currentTime = trim.start / 1000;
  await video.play();
  rec.start(250);

  await new Promise<void>((resolve) => {
    const tick = () => {
      if (signal?.aborted || video.ended || video.currentTime * 1000 >= trim.end) {
        return resolve();
      }
      const tMs = video.currentTime * 1000;
      // Jump over cut ranges so the fallback skips them like the main path.
      const cut = (project.cuts ?? []).find((c) => tMs >= c.start && tMs < c.end);
      if (cut) {
        video.currentTime = cut.end / 1000;
        requestAnimationFrame(tick);
        return;
      }
      renderer.render(sampleFrame(project, tMs, spd));
      onProgress({ frame: Math.floor(((tMs - trim.start) / 1000) * fps), totalFrames });
      requestAnimationFrame(tick);
    };
    tick();
  });

  const aborted = signal?.aborted ?? false;
  return new Promise((resolve, reject) => {
    rec.onstop = () => {
      renderer.dispose();
      URL.revokeObjectURL(video.src);
      if (aborted) {
        reject(new DOMException('Export cancelled', 'AbortError'));
        return;
      }
      resolve({ blob: new Blob(chunks, { type: 'video/webm' }), extension: 'webm' });
    };
    rec.stop();
  });
}
