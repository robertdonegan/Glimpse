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
  /** Active keystroke for the HUD: label + fade (0 = just pressed, 1 = gone). */
  key: { label: string; age: number } | null;
  /** Source time of this frame (drives time-windowed overlays). */
  t: number;
}

/** How long a keystroke stays on the HUD before it has fully faded. */
const KEY_WINDOW_MS = 1400;

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

/**
 * @param speed Global playback-speed multiplier in effect (the timeline speed
 * slider). Only the click-highlight pulse uses it: the flash is kept to a fixed
 * real-time duration, so slowing the video down doesn't stretch it out.
 */
export function sampleFrame(project: Project, t: number, speed = 1): FrameState {
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
      let cx = pos.x;
      let cy = pos.y;

      // Extra smoothing beyond 1×: a windowed low-pass over the path.
      if (style.cursor.smoothing > 1) {
        const extra = Math.min(style.cursor.smoothing - 1, 2);
        const w = 90 + extra * 170; // half-window, ms
        let ax = 0;
        let ay = 0;
        let n = 0;
        for (const dt of [-w, -w / 2, 0, w / 2, w]) {
          const p = sampleCursor(recording.cursor, t + dt, 1);
          if (p) {
            ax += p.x;
            ay += p.y;
            n++;
          }
        }
        if (n > 0) {
          const f = Math.min(1, extra);
          cx = lerp(cx, ax / n, f);
          cy = lerp(cy, ay / n, f);
        }
      }

      // Glide across cuts: when a section is removed the source time jumps from
      // the cut's start to its end, snapping the cursor. If enabled, ease the
      // cursor out of its pre-cut position over a short window after playback
      // resumes, so it flows into the new position instead of teleporting.
      if (style.cursor.bridgeCuts) {
        const BRIDGE_MS = 400;
        for (const c of project.cuts ?? []) {
          if (t >= c.end && t < c.end + BRIDGE_MS) {
            const before = sampleCursor(recording.cursor, c.start, style.cursor.smoothing);
            if (before) {
              const k = smoother((t - c.end) / BRIDGE_MS);
              cx = lerp(before.x, cx, k);
              cy = lerp(before.y, cy, k);
            }
            break;
          }
        }
      }

      // Return to start: ease the cursor back to its opening position over the
      // tail of the trimmed span, so a looped export has no visible jump.
      if (style.cursor.returnToStart) {
        const start = project.trim?.start ?? 0;
        const end = project.trim?.end ?? recording.duration;
        const ret = Math.min(700, (end - start) * 0.35);
        if (ret > 0 && t > end - ret) {
          const startPos = sampleCursor(recording.cursor, start, style.cursor.smoothing);
          if (startPos) {
            const k = smoother((t - (end - ret)) / ret);
            cx = lerp(cx, startPos.x, k);
            cy = lerp(cy, startPos.y, k);
          }
        }
      }

      let pulse = 0;
      if (style.cursor.clickHighlight) {
        // The pulse is a fixed real-time flash: convert the source-time gap
        // since each click into real (output) time by dividing out the local
        // playback rate — the clip's own speed times the global speed — so
        // slow-motion doesn't drag the highlight out with it.
        const localSpeed = Math.max(0.01, speedAt(zooms, t) * speed);
        for (let i = recording.clicks.length - 1; i >= 0; i--) {
          const dt = (t - recording.clicks[i].t) / localSpeed;
          if (dt < 0) continue;
          if (dt > CLICK_PULSE_MS) break;
          pulse = Math.max(pulse, 1 - dt / CLICK_PULSE_MS);
        }
      }
      cursor = {
        visible: true,
        x: cx,
        y: cy,
        clickPulse: pulse,
        hand: pos.hand && style.cursor.handOnHover,
      };
    }
  }

  // Keystroke HUD: the most recent key at/before t, still within its window.
  let key: FrameState['key'] = null;
  if (style.keystrokes.enabled && recording.keys && recording.keys.length) {
    for (let i = recording.keys.length - 1; i >= 0; i--) {
      const dt = t - recording.keys[i].t;
      if (dt < 0) continue;
      if (dt > KEY_WINDOW_MS) break;
      key = { label: recording.keys[i].label, age: dt / KEY_WINDOW_MS };
      break;
    }
  }

  return { camera, cursor, pose, key, t };
}

/* ---------- Timeline: source-time ↔ output-time mapping ----------
 *
 * The output timeline is a list of "pieces": the source ranges that survive
 * trim − cuts, each split at zoom-speed boundaries so speed is constant per
 * piece, laid out end-to-end. Cuts simply aren't represented, so playback and
 * export skip them for free. Source footage is never resampled — the exporter
 * walks output time and asks which source instant is on screen.
 */

export interface TimelinePiece {
  srcStart: number;
  srcEnd: number;
  speed: number;
  outStart: number;
  outEnd: number;
}

/** Playback speed at a given source time. */
export function speedAt(zooms: ZoomSegment[], tSrc: number): number {
  for (const z of zooms) {
    if (tSrc >= z.start && tSrc <= z.end) return z.speed || 1;
  }
  return 1;
}

/** True when a source instant falls inside a removed (cut) range. */
export function isCut(cuts: Project['cuts'], tSrc: number): boolean {
  if (!cuts) return false;
  for (const c of cuts) if (tSrc >= c.start && tSrc < c.end) return true;
  return false;
}

/** Build the output-timeline pieces for a project (trim − cuts, by speed). */
export function buildTimeline(project: Project): TimelinePiece[] {
  const { zooms, recording } = project;
  const srcDuration = recording.duration;
  const trim = project.trim ?? { start: 0, end: srcDuration };
  const cuts = (project.cuts ?? []).slice().sort((a, b) => a.start - b.start);

  // Kept source intervals = trim span minus every cut.
  let kept = [{ start: Math.max(0, trim.start), end: Math.min(srcDuration, trim.end) }];
  for (const c of cuts) {
    const next: { start: number; end: number }[] = [];
    for (const s of kept) {
      if (c.end <= s.start || c.start >= s.end) {
        next.push(s);
        continue;
      }
      if (c.start > s.start) next.push({ start: s.start, end: c.start });
      if (c.end < s.end) next.push({ start: c.end, end: s.end });
    }
    kept = next;
  }

  // Split each kept interval at zoom boundaries so speed is constant per piece.
  const pieces: TimelinePiece[] = [];
  let out = 0;
  for (const s of kept) {
    if (s.end - s.start <= 1e-3) continue;
    const marks = new Set<number>([s.start, s.end]);
    for (const z of zooms) {
      if (z.start > s.start && z.start < s.end) marks.add(z.start);
      if (z.end > s.start && z.end < s.end) marks.add(z.end);
    }
    const sorted = [...marks].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (b - a <= 1e-3) continue;
      const speed = speedAt(zooms, (a + b) / 2) || 1;
      const outLen = (b - a) / speed;
      pieces.push({ srcStart: a, srcEnd: b, speed, outStart: out, outEnd: out + outLen });
      out += outLen;
    }
  }
  return pieces;
}

/** Total output duration of a piece list. */
export function outputDuration(pieces: TimelinePiece[]): number {
  return pieces.length ? pieces[pieces.length - 1].outEnd : 0;
}

/** Map a source-time instant to its position on the output timeline. */
export function sourceToOutput(pieces: TimelinePiece[], tSrc: number): number {
  if (!pieces.length) return 0;
  if (tSrc <= pieces[0].srcStart) return 0;
  for (const p of pieces) {
    if (tSrc < p.srcStart) return p.outStart; // inside a cut → collapse
    if (tSrc <= p.srcEnd) return p.outStart + (tSrc - p.srcStart) / p.speed;
  }
  return pieces[pieces.length - 1].outEnd;
}

/** Map an output-time instant back to the source-time instant on screen. */
export function outputToSource(pieces: TimelinePiece[], tOut: number): number {
  if (!pieces.length) return 0;
  if (tOut <= 0) return pieces[0].srcStart;
  for (const p of pieces) {
    if (tOut <= p.outEnd) return p.srcStart + (tOut - p.outStart) * p.speed;
  }
  return pieces[pieces.length - 1].srcEnd;
}
