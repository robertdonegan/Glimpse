/**
 * The sampler answers one question: "at time t, what does the frame look
 * like?" It is pure and deterministic, which means the live preview and the
 * offline exporter render *exactly* the same video — there is no separate
 * export path to drift out of sync.
 */

import type { Project, CursorSample, ZoomSegment } from './model';
import { clamp, lerp, smoother } from './easing';

export interface CameraState {
  /** Zoom factor applied to the recording plane. */
  scale: number;
  /** Normalised focal point the camera is centred on. */
  focusX: number;
  focusY: number;
}

export interface CursorState {
  visible: boolean;
  x: number;
  y: number;
  /** 0..1 click flash intensity (decays after each click). */
  clickPulse: number;
  /** Pointer was over an interactive element — show the hand cursor. */
  hand: boolean;
}

export interface FrameState {
  camera: CameraState;
  cursor: CursorState;
  /** 3D pose for this frame, degrees — base style blended with zoom tilt. */
  pose: { rotX: number; rotY: number; rotZ: number };
  /** Source time of this frame (drives time-windowed overlays). */
  t: number;
}

const IDLE_CAMERA: CameraState = { scale: 1, focusX: 0.5, focusY: 0.5 };

/** Ease-in/out blend factor for a segment at time t. */
function rampK(z: ZoomSegment, t: number): number {
  const ramp = Math.min(z.ramp, (z.end - z.start) / 2);
  if (t < z.start + ramp) return smoother((t - z.start) / ramp);
  if (t > z.end - ramp) return smoother((z.end - t) / ramp);
  return 1;
}

/** The segment covering time t, if any (non-overlapping by store invariant). */
export function segmentAt(zooms: ZoomSegment[], t: number): ZoomSegment | null {
  for (const z of zooms) {
    if (t >= z.start && t <= z.end) return z;
  }
  return null;
}

export function sampleCamera(zooms: ZoomSegment[], t: number): CameraState {
  const z = segmentAt(zooms, t);
  if (!z) return IDLE_CAMERA;
  const k = rampK(z, t);
  return {
    scale: lerp(1, z.scale, k),
    focusX: lerp(0.5, z.focusX, k),
    focusY: lerp(0.5, z.focusY, k),
  };
}

/**
 * Cursor position via centripetal Catmull-Rom through the recorded samples,
 * blended with the raw path by the smoothing setting. Deterministic —
 * unlike an integrated spring, sampling t=5.0s always yields the same point,
 * which the exporter depends on.
 */
export function sampleCursor(
  samples: CursorSample[],
  t: number,
  smoothing: number,
): { x: number; y: number; hand: boolean } | null {
  if (samples.length === 0) return null;
  if (samples.length === 1 || t <= samples[0].t) {
    return { x: samples[0].x, y: samples[0].y, hand: !!samples[0].hand };
  }
  const last = samples[samples.length - 1];
  if (t >= last.t) return { x: last.x, y: last.y, hand: !!last.hand };

  // Binary search for the segment containing t.
  let lo = 0;
  let hi = samples.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  const i = lo;
  const p1 = samples[i];
  const p2 = samples[i + 1];
  const p0 = samples[Math.max(0, i - 1)];
  const p3 = samples[Math.min(samples.length - 1, i + 2)];
  const u = (t - p1.t) / Math.max(p2.t - p1.t, 1e-6);

  const raw = { x: lerp(p1.x, p2.x, u), y: lerp(p1.y, p2.y, u) };
  const smooth = {
    x: catmull(p0.x, p1.x, p2.x, p3.x, u),
    y: catmull(p0.y, p1.y, p2.y, p3.y, u),
  };
  const s = clamp(smoothing, 0, 1);
  const hand = !!(u < 0.5 ? p1.hand : p2.hand);
  return { x: lerp(raw.x, smooth.x, s), y: lerp(raw.y, smooth.y, s), hand };
}

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

const CLICK_PULSE_MS = 420;

export function sampleFrame(project: Project, t: number): FrameState {
  const { recording, style, zooms } = project;
  const camera = sampleCamera(zooms, t);

  // Per-zoom 3D tilt: ease from the base pose into the segment's pose on the
  // same ramp as the zoom, and back out on the outro.
  const seg = segmentAt(zooms, t);
  let pose = { ...style.pose };
  if (seg?.pose) {
    const k = rampK(seg, t);
    pose = {
      rotX: lerp(style.pose.rotX, seg.pose.rotX, k),
      rotY: lerp(style.pose.rotY, seg.pose.rotY, k),
      rotZ: lerp(style.pose.rotZ, seg.pose.rotZ, k),
    };
  }

  // Follow-cam: the zoom tracks a trailing Gaussian-weighted average of the
  // cursor path — calm, deterministic (same t always gives the same shot),
  // export-safe. A wide window (720ms) with a soft centre lag glides the
  // camera instead of snapping to every jitter, which is what made the old
  // 4-tap boxcar feel jerky.
  if (seg?.follow && recording.cursor.length > 0) {
    const k = rampK(seg, t);
    const WINDOW = 720; // ms of history to average over
    const STEP = 60; // sample spacing
    const CENTER = 200; // lag the weighting favours (gentle trailing)
    const SIGMA = 240; // spread of the Gaussian kernel
    let ax = 0;
    let ay = 0;
    let wsum = 0;
    for (let lag = 0; lag <= WINDOW; lag += STEP) {
      const p = sampleCursor(recording.cursor, Math.max(0, t - lag), 1);
      if (!p) continue;
      const d = lag - CENTER;
      const w = Math.exp(-(d * d) / (2 * SIGMA * SIGMA));
      ax += p.x * w;
      ay += p.y * w;
      wsum += w;
    }
    if (wsum > 0) {
      const half = 0.5 / Math.max(camera.scale, 1e-3);
      camera.focusX = lerp(0.5, clamp(ax / wsum, half, 1 - half), k);
      camera.focusY = lerp(0.5, clamp(ay / wsum, half, 1 - half), k);
    }
  }

  let cursor: CursorState = { visible: false, x: 0.5, y: 0.5, clickPulse: 0, hand: false };
  // Cursor telemetry exists for tab captures (browser) and native captures
  // (desktop app) — gate on the data, not the capture mode.
  if (recording.cursor.length > 0 && style.cursor.style !== 'none') {
    const pos = sampleCursor(recording.cursor, t, style.cursor.smoothing);
    if (pos) {
      let pulse = 0;
      if (style.cursor.clickHighlight) {
        for (let i = recording.clicks.length - 1; i >= 0; i--) {
          const dt = t - recording.clicks[i].t;
          if (dt < 0) continue;
          if (dt > CLICK_PULSE_MS) break;
          pulse = Math.max(pulse, 1 - dt / CLICK_PULSE_MS);
        }
      }
      cursor = {
        visible: true,
        x: pos.x,
        y: pos.y,
        clickPulse: pulse,
        hand: pos.hand && style.cursor.handOnHover,
      };
    }
  }

  return { camera, cursor, pose, t };
}

/* ---------- Clip speed: source-time ↔ output-time mapping ----------
 *
 * Zoom segments carry a playback speed. Source footage is never resampled;
 * instead the exporter walks output time and asks "which source instant is
 * on screen now?". Outside segments speed is 1. Segments are sorted and
 * non-overlapping (store invariant).
 */

/** Playback speed at a given source time. */
export function speedAt(zooms: ZoomSegment[], tSrc: number): number {
  for (const z of zooms) {
    if (tSrc >= z.start && tSrc <= z.end) return z.speed || 1;
  }
  return 1;
}

/** Total output duration once clip speeds are applied. */
export function outputDuration(zooms: ZoomSegment[], srcDuration: number): number {
  let out = 0;
  let cur = 0;
  for (const z of zooms) {
    if (z.start >= srcDuration) break;
    out += Math.max(0, z.start - cur);
    out += (Math.min(z.end, srcDuration) - z.start) / (z.speed || 1);
    cur = Math.min(z.end, srcDuration);
  }
  out += Math.max(0, srcDuration - cur);
  return out;
}

/** Map a source-time instant to its position on the output timeline. */
export function sourceToOutput(zooms: ZoomSegment[], tSrc: number): number {
  let out = 0;
  let src = 0;
  for (const z of zooms) {
    if (tSrc <= z.start) break;
    out += Math.max(0, z.start - src);
    const segEnd = Math.min(z.end, tSrc);
    out += (segEnd - z.start) / (z.speed || 1);
    src = Math.max(src, segEnd);
    if (tSrc <= z.end) return out;
  }
  return out + Math.max(0, tSrc - src);
}

/** Map an output-time instant back to the source-time instant on screen. */
export function outputToSource(zooms: ZoomSegment[], tOut: number, srcDuration: number): number {
  let out = 0;
  let src = 0;
  for (const z of zooms) {
    if (z.start >= srcDuration) break;
    const gap = Math.max(0, z.start - src);
    if (tOut <= out + gap) return src + (tOut - out);
    out += gap;
    src = z.start;

    const segSrcLen = Math.min(z.end, srcDuration) - z.start;
    const segOutLen = segSrcLen / (z.speed || 1);
    if (tOut <= out + segOutLen) return src + (tOut - out) * (z.speed || 1);
    out += segOutLen;
    src = Math.min(z.end, srcDuration);
  }
  return Math.min(src + (tOut - out), srcDuration);
}
