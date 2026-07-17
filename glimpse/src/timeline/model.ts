/**
 * Glimpse timeline model.
 *
 * A Project is: one raw recording (pixels) + event tracks (cursor, clicks)
 * + an edit list (zoom segments, style, camera pose). Pixels are never
 * modified; every effect is applied at render time. This is what makes
 * post-record cursor replacement and re-editable zooms possible.
 */

/** Milliseconds from the start of the recording. */
export type Ms = number;

export interface CursorSample {
  t: Ms;
  /** Normalised [0..1] coordinates within the captured surface. */
  x: number;
  y: number;
}

export interface ClickEvent {
  t: Ms;
  x: number;
  y: number;
  button: number;
}

/**
 * How the recording was made. Determines which effects are available.
 * - 'tab'    — we captured our own tab: full cursor data, synthetic cursor on.
 * - 'window' — pixels only: cursor is baked in, synthetic cursor off.
 * - 'screen' — pixels only, same constraint as window.
 */
export type CaptureMode = 'tab' | 'window' | 'screen';

export interface Recording {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
  duration: Ms;
  mode: CaptureMode;
  cursor: CursorSample[];
  clicks: ClickEvent[];
}

/** A keyframed zoom region on the timeline. */
export interface ZoomSegment {
  id: string;
  start: Ms;
  end: Ms;
  /** Zoom factor, 1 = fit, 2 = 200%. */
  scale: number;
  /** Normalised focal point on the recording. */
  focusX: number;
  focusY: number;
  /** Ramp duration for ease in/out of the zoom. */
  ramp: Ms;
}

export type CursorStyle = 'default' | 'circle' | 'none';

export interface StyleSettings {
  background: BackgroundSettings;
  /** Padding around the recording as a fraction of the frame (0–0.25). */
  padding: number;
  /** Corner radius in recording pixels. */
  cornerRadius: number;
  shadow: boolean;
  cursor: {
    style: CursorStyle;
    /** Multiplier on native cursor size. */
    size: number;
    /** 0 = raw path, 1 = maximum smoothing. */
    smoothing: number;
    clickHighlight: boolean;
  };
  /** Static 3D pose for hero shots, degrees. */
  pose: { rotX: number; rotY: number; rotZ: number };
}

export interface BackgroundSettings {
  kind: 'gradient' | 'solid';
  colorA: string;
  colorB: string;
  /** Gradient angle in degrees. */
  angle: number;
}

export interface Project {
  recording: Recording;
  zooms: ZoomSegment[];
  style: StyleSettings;
  /** Output frame size. */
  output: { width: number; height: number; fps: number };
}

export const DEFAULT_STYLE: StyleSettings = {
  background: { kind: 'gradient', colorA: '#1b2a4a', colorB: '#0b3b39', angle: 35 },
  padding: 0.08,
  cornerRadius: 16,
  shadow: true,
  cursor: { style: 'default', size: 1.6, smoothing: 0.7, clickHighlight: true },
  pose: { rotX: 0, rotY: 0, rotZ: 0 },
};

export function createProject(recording: Recording): Project {
  const landscape = recording.width >= recording.height;
  return {
    recording,
    zooms: [],
    style: structuredClone(DEFAULT_STYLE),
    output: landscape
      ? { width: 1920, height: 1080, fps: 60 }
      : { width: 1080, height: 1920, fps: 60 },
  };
}

let counter = 0;
export function makeId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}
