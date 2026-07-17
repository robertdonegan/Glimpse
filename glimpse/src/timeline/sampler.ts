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
}

export interface FrameState {
  camera: CameraState;
  cursor: CursorState;
}

const IDLE_CAMERA: CameraState = { scale: 1, focusX: 0.5, focusY: 0.5 };

export function sampleCamera(zooms: ZoomSegment[], t: number): CameraState {
  // Segments are non-overlapping by construction (enforced in the store).
  for (const z of zooms) {
    if (t < z.start || t > z.end) continue;
    const ramp = Math.min(z.ramp, (z.end - z.start) / 2);
    let k = 1;
    if (t < z.start + ramp) k = smoother((t - z.start) / ramp);
    else if (t > z.end - ramp) k = smoother((z.end - t) / ramp);
    return {
      scale: lerp(1, z.scale, k),
      focusX: lerp(0.5, z.focusX, k),
      focusY: lerp(0.5, z.focusY, k),
    };
  }
  return IDLE_CAMERA;
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
): { x: number; y: number } | null {
  if (samples.length === 0) return null;
  if (samples.length === 1 || t <= samples[0].t) {
    return { x: samples[0].x, y: samples[0].y };
  }
  const last = samples[samples.length - 1];
  if (t >= last.t) return { x: last.x, y: last.y };

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
  return { x: lerp(raw.x, smooth.x, s), y: lerp(raw.y, smooth.y, s) };
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

  let cursor: CursorState = { visible: false, x: 0.5, y: 0.5, clickPulse: 0 };
  if (recording.mode === 'tab' && style.cursor.style !== 'none') {
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
      cursor = { visible: true, x: pos.x, y: pos.y, clickPulse: pulse };
    }
  }

  return { camera, cursor };
}
