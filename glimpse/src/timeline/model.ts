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

/** A keystroke (or chord) captured during recording, for the on-screen HUD. */
export interface KeyEvent {
  t: Ms;
  /** Display label, modifiers composed in — e.g. "⌘⇧S", "↵", "Space". */
  label: string;
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
  /** Keystrokes captured during recording (tab capture or native desktop). */
  keys?: KeyEvent[];
  /** Whether the capture stream included an audio track. */
  hasAudio: boolean;
  /**
   * Audio-only sidecar recording (webm/opus). Browsers can't reliably
   * decode audio out of a video container, so audio is captured to its own
   * blob alongside the video.
   */
  audioBlob?: Blob;
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
  /**
   * Optional 3D pose override while this zoom is active — the frame eases
   * from the base pose into this tilt and back out on the segment's ramp.
   */
  pose?: { rotX: number; rotY: number; rotZ: number };
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
  /** On-screen keystroke HUD (needs captured key telemetry). */
  keystrokes: { enabled: boolean };
  /**
   * Redaction: blurred rectangles pinned to the recording (normalised x,y from
   * top-left, w,h as fractions) — hides sensitive info, tilts/zooms with the
   * content.
   */
  blur?: { x: number; y: number; w: number; h: number }[];
}

export interface BackgroundSettings {
  kind: 'gradient' | 'corners' | 'solid' | 'image';
  /** Linear: start/end. Corners: A=top-left, B=top-right. */
  colorA: string;
  colorB: string;
  /** Corners only: C=bottom-left, D=bottom-right. */
  colorC?: string;
  colorD?: string;
  /** Gradient angle in degrees (linear mode). */
  angle: number;
  /** Data-URL of an uploaded backdrop image (kind === 'image'). */
  imageData?: string;
}

/** An imported graphic (SVG/PNG/…) composited over the recording. */
export interface Overlay {
  id: string;
  name: string;
  /** Data-URL of the source image. */
  imageData: string;
  /** Normalised centre position on the recording. */
  x: number;
  y: number;
  /** Width as a fraction of the recording width. */
  scale: number;
  /** Visible time window, source ms. */
  start: Ms;
  end: Ms;
  opacity: number;
  /**
   * Render in screen space, above the tilted/scaled scene (idents, lower
   * thirds, titles). When false the graphic is composited onto the recording
   * and tilts/zooms with it.
   */
  flat?: boolean;
}

/** An imported audio track (music / voice-over) mixed under the recording. */
export interface MusicTrack {
  name: string;
  /** Start position on the timeline, source ms. May sit before 0. */
  offset: Ms;
  /** Track length, ms (decoded once on import). */
  duration: Ms;
  /** 0..1 mix gain. */
  gain: number;
  /** The audio file itself — serialized as a segment of the project file. */
  blob: Blob;
}

export interface Project {
  name: string;
  recording: Recording;
  zooms: ZoomSegment[];
  overlays: Overlay[];
  music?: MusicTrack;
  style: StyleSettings;
  /** Output frame size. */
  output: { width: number; height: number; fps: number };
  /** In/out points (source ms) — playback and export use only this span. */
  trim: { start: Ms; end: Ms };
  /**
   * Removed source-time ranges (ms). Everything inside a cut is dropped from
   * playback and export — the surrounding footage joins up. Sorted,
   * non-overlapping (store invariant).
   */
  cuts?: { start: Ms; end: Ms }[];
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
  keystrokes: { enabled: false },
  blur: [],
};

export function createProject(recording: Recording): Project {
  const landscape = recording.width >= recording.height;
  return {
    name: 'Untitled',
    recording,
    zooms: [],
    overlays: [],
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
  style.keystrokes = { ...DEFAULT_STYLE.keystrokes, ...p.style?.keystrokes };
  style.blur = p.style?.blur ?? [];
  return {
    ...p,
    name: p.name || 'Untitled',
    style,
    zooms: (p.zooms ?? []).map((z) => ({ ...z, speed: z.speed ?? 1 })),
    overlays: p.overlays ?? [],
    recording: {
      ...p.recording,
      hasAudio: p.recording.hasAudio ?? false,
      keys: p.recording.keys ?? [],
    },
    trim: p.trim ?? { start: 0, end: p.recording.duration },
    cuts: p.cuts ?? [],
  };
}

let counter = 0;
export function makeId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}
