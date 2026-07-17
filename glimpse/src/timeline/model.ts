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
  /** True when the pointer was over an interactive element (link, button…). */
  hand?: boolean;
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
  /** Whether the capture stream included an audio track. */
  hasAudio: boolean;
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
  /**
   * Playback speed of this clip. 1 = realtime, 0.5 = half-speed slow pass,
   * 2 = double speed. Source footage is untouched; the mapping happens at
   * preview/export time.
   */
  speed: number;
  /** Camera tracks the recorded cursor instead of the static focus point. */
  follow?: boolean;
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
    /** Switch to a hand cursor while hovering interactive elements. */
    handOnHover: boolean;
    /** Brand colour for the cursor body (outline auto-contrasts). */
    color: string;
  };
  /** Static 3D pose for hero shots, degrees. */
  pose: { rotX: number; rotY: number; rotZ: number };
  /** Depth-of-field bokeh driven by real scene depth (3D pose). */
  dof: { enabled: boolean; strength: number };
}

export interface BackgroundSettings {
  kind: 'gradient' | 'solid' | 'image';
  colorA: string;
  colorB: string;
  /** Gradient angle in degrees. */
  angle: number;
  /** Data-URL of an uploaded backdrop image (kind === 'image'). */
  imageData?: string;
}

export interface Project {
  name: string;
  recording: Recording;
  zooms: ZoomSegment[];
  style: StyleSettings;
  /** Output frame size. */
  output: { width: number; height: number; fps: number };
  /** In/out points (source ms) — playback and export use only this span. */
  trim: { start: Ms; end: Ms };
}

export const DEFAULT_STYLE: StyleSettings = {
  background: { kind: 'gradient', colorA: '#1b2a4a', colorB: '#0b3b39', angle: 35 },
  padding: 0.08,
  cornerRadius: 16,
  shadow: true,
  cursor: {
    style: 'default',
    size: 1.6,
    smoothing: 0.7,
    clickHighlight: true,
    handOnHover: true,
    color: '#111111',
  },
  pose: { rotX: 0, rotY: 0, rotZ: 0 },
  dof: { enabled: false, strength: 0.5 },
};

export function createProject(recording: Recording): Project {
  const landscape = recording.width >= recording.height;
  return {
    name: 'Untitled',
    recording,
    zooms: [],
    style: structuredClone(DEFAULT_STYLE),
    output: landscape
      ? { width: 1920, height: 1080, fps: 60 }
      : { width: 1080, height: 1920, fps: 60 },
    trim: { start: 0, end: recording.duration },
  };
}

/** Fill in any fields added since a project file was written. */
export function normalizeProject(p: Project): Project {
  const style = { ...structuredClone(DEFAULT_STYLE), ...p.style };
  style.cursor = { ...DEFAULT_STYLE.cursor, ...p.style?.cursor };
  style.dof = { ...DEFAULT_STYLE.dof, ...p.style?.dof };
  style.background = { ...DEFAULT_STYLE.background, ...p.style?.background };
  return {
    ...p,
    name: p.name || 'Untitled',
    style,
    zooms: (p.zooms ?? []).map((z) => ({ ...z, speed: z.speed ?? 1 })),
    recording: { ...p.recording, hasAudio: p.recording.hasAudio ?? false },
    trim: p.trim ?? { start: 0, end: p.recording.duration },
  };
}

let counter = 0;
export function makeId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}
