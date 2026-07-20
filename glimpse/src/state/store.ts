import { create } from 'zustand';
import type {
  MusicTrack,
  Overlay,
  Project,
  Recording,
  StyleSettings,
  ZoomSegment,
} from '../timeline/model';
import { createProject, makeId } from '../timeline/model';
import { generateAutoZooms } from '../timeline/autoZoom';
import { beginRecording, type ActiveRecording } from '../capture/recorder';
import { beginNativeRecording, type CaptureTarget } from '../capture/nativeCapture';
import { enterCompactWindow, restoreWindow } from '../capture/appWindow';
import {
  exportProject,
  exportGif,
  exportStill,
  loadRecordingVideo,
  type ExportProgress,
} from '../export/exporter';
import { saveProjectFile, openProjectFile, type ProjectHandle } from './projectFile';

export type Screen = 'welcome' | 'recording' | 'editor' | 'frame';

interface GlimpseState {
  screen: Screen;
  project: Project | null;
  active: ActiveRecording | null;
  /** File handle (browser) or path (desktop) for quick "Save" once the project
   * has a home on disk. */
  fileHandle: ProjectHandle | null;
  /** True when the project has edits not yet written to disk — drives the
   * unsaved asterisk beside the project name. */
  dirty: boolean;

  // Playback
  playhead: number; // ms
  playing: boolean;
  loop: boolean;
  /** Preview-only playback rate (slow viewing). Export is unaffected. */
  previewRate: number;

  // Export
  exporting: boolean;
  exportProgress: ExportProgress | null;

  // Undo / redo history (project snapshots — playback state is excluded).
  past: Project[];
  future: Project[];
  undo: () => void;
  redo: () => void;

  startRecording: (
    preferCurrentTab: boolean,
    withAudio: boolean,
    keepScreen?: boolean,
  ) => Promise<void>;
  /** Desktop app only: cursor-free native screen/window capture + telemetry. */
  startNativeRecording: (withAudio: boolean, target?: CaptureTarget) => Promise<void>;
  stopRecording: () => Promise<void>;
  enterFrame: () => void;
  exitFrame: () => void;
  discardProject: () => void;

  saveProject: (as?: boolean) => Promise<void>;
  openProject: (file?: File) => Promise<void>;
  setProjectName: (name: string) => void;

  setPlayhead: (t: number) => void;
  setPlaying: (p: boolean) => void;
  /** Space-bar friendly: respects trim in/out points when starting. */
  togglePlay: () => void;
  toggleLoop: () => void;
  setTrim: (patch: Partial<Project['trim']>) => void;
  /** Remove a source-time range from playback + export. */
  addCut: (start: number, end: number) => void;
  removeCut: (index: number) => void;

  updateStyle: (patch: Partial<StyleSettings>) => void;
  patchStyle: <K extends keyof StyleSettings>(key: K, value: StyleSettings[K]) => void;

  addZoomAt: (t: number) => void;
  updateZoom: (id: string, patch: Partial<ZoomSegment>) => void;
  removeZoom: (id: string) => void;
  applyAutoZoom: () => void;

  addOverlay: (file: File) => void;
  updateOverlay: (id: string, patch: Partial<Overlay>) => void;
  removeOverlay: (id: string) => void;

  addMusic: (file: File) => Promise<void>;
  updateMusic: (patch: Partial<Omit<MusicTrack, 'blob'>>) => void;
  removeMusic: () => void;
  setPreviewRate: (rate: number) => void;

  runExport: () => Promise<void>;
  /** Export the trimmed/cut timeline as an animated GIF. */
  runExportGif: () => Promise<void>;
  /** Abort an in-progress export. */
  cancelExport: () => void;
  exportPng: (scale?: number) => Promise<void>;
}

/** Keep zoom segments sorted and clamped so they never overlap. */
function normaliseZooms(zooms: ZoomSegment[], duration: number): ZoomSegment[] {
  const sorted = [...zooms].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    const z = sorted[i];
    z.start = Math.max(0, Math.min(z.start, duration));
    z.end = Math.max(z.start + 200, Math.min(z.end, duration));
    const next = sorted[i + 1];
    if (next && z.end > next.start) z.end = next.start;
  }
  return sorted;
}

/** Keep cuts clamped, sorted and merged so they never overlap. */
function normaliseCuts(
  cuts: { start: number; end: number }[],
  duration: number,
): { start: number; end: number }[] {
  const clamped = cuts
    .map((c) => ({
      start: Math.max(0, Math.min(c.start, duration)),
      end: Math.max(0, Math.min(c.end, duration)),
    }))
    .filter((c) => c.end - c.start >= 50)
    .sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const c of clamped) {
    const prev = merged[merged.length - 1];
    if (prev && c.start <= prev.end) prev.end = Math.max(prev.end, c.end);
    else merged.push({ ...c });
  }
  return merged;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

/** How far back the undo stack remembers. */
const HISTORY_LIMIT = 60;
/** Edits closer together than this collapse into one undo step (drag = 1 step). */
const COALESCE_MS = 350;

export const useGlimpse = create<GlimpseState>((set, get) => {
  let lastCommit = 0;
  /** Live export controller, so the UI can cancel a render mid-flight. */
  let exportAbort: AbortController | null = null;

  /**
   * Apply a project change while recording an undo step. Rapid successive
   * edits (a slider drag) coalesce into a single step; discrete actions each
   * get their own — so one Cmd+Z undoes an accidental Auto-zoom.
   */
  const commit = (next: Project): void => {
    const cur = get().project;
    if (!cur) {
      set({ project: next });
      return;
    }
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const coalesce = now - lastCommit < COALESCE_MS && get().past.length > 0;
    lastCommit = now;
    const past = coalesce ? get().past : [...get().past, cur].slice(-HISTORY_LIMIT);
    set({ project: next, past, future: [], dirty: true });
  };

  return {
  screen: 'welcome',
  project: null,
  active: null,
  fileHandle: null,
  dirty: false,
  playhead: 0,
  playing: false,
  loop: false,
  previewRate: 1,
  exporting: false,
  exportProgress: null,
  past: [],
  future: [],

  undo: () => {
    const { past, project, future } = get();
    if (past.length === 0 || !project) return;
    lastCommit = 0; // never coalesce across an undo boundary
    set({
      project: past[past.length - 1],
      past: past.slice(0, -1),
      future: [project, ...future].slice(0, HISTORY_LIMIT),
      dirty: true,
    });
  },

  redo: () => {
    const { future, project, past } = get();
    if (future.length === 0 || !project) return;
    lastCommit = 0;
    set({
      project: future[0],
      future: future.slice(1),
      past: [...past, project].slice(-HISTORY_LIMIT),
      dirty: true,
    });
  },

  startRecording: async (preferCurrentTab, withAudio, keepScreen = false) => {
    const active = await beginRecording({ preferCurrentTab, audio: withAudio });
    active.onEnded(() => void get().stopRecording());
    // Frame mode keeps its own screen mounted — it IS the recorded content.
    set(keepScreen ? { active } : { active, screen: 'recording' });
  },

  enterFrame: () => set({ screen: 'frame' }),
  exitFrame: () => {
    if (!get().active) set({ screen: 'welcome' });
  },

  startNativeRecording: async (withAudio, target) => {
    const active = await beginNativeRecording({ audio: withAudio, target });
    set({ active, screen: 'recording' });
    // Shrink to a floating controller so the recorded screen behind is usable.
    void enterCompactWindow();
  },

  stopRecording: async () => {
    const { active } = get();
    if (!active) return;
    set({ active: null });
    void restoreWindow(); // back to full size for the editor
    let recording: Recording;
    try {
      recording = await active.stop();
    } catch (e) {
      // Never strand the user on the recording screen — surface the error
      // and return to the start.
      window.alert(
        `Recording could not be finalised: ${e instanceof Error ? e.message : String(e)}`,
      );
      set({ screen: 'welcome' });
      return;
    }

    // Trust the decoded pixels, not the track settings, for dimensions —
    // capture settings routinely misreport window sizes, which stretched
    // the recording to the wrong aspect ratio.
    try {
      const probe = await loadRecordingVideo(recording.blob);
      if (probe.videoWidth && probe.videoHeight) {
        recording.width = probe.videoWidth;
        recording.height = probe.videoHeight;
      }
      URL.revokeObjectURL(probe.src);
    } catch {
      /* keep the reported settings */
    }

    const project = createProject(recording);
    // Auto-zoom on arrival when we have click data — the "it already looks
    // good" first impression. Fully editable afterwards. Click telemetry
    // comes from tab captures (browser) or native captures (desktop app).
    if (recording.clicks.length > 0) {
      project.zooms = generateAutoZooms(recording.clicks, recording.duration);
    }
    set({
      project,
      screen: 'editor',
      playhead: 0,
      playing: false,
      fileHandle: null,
      dirty: true, // fresh recording — nothing on disk yet
      past: [],
      future: [],
    });
  },

  discardProject: () =>
    set({
      project: null,
      screen: 'welcome',
      playhead: 0,
      playing: false,
      fileHandle: null,
      dirty: false,
      past: [],
      future: [],
    }),

  saveProject: async (as = false) => {
    const { project, fileHandle } = get();
    if (!project) return;
    try {
      const handle = await saveProjectFile(project, fileHandle, as);
      if (handle) set({ fileHandle: handle, dirty: false });
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return; // picker dismissed
      throw e;
    }
  },

  openProject: async (file) => {
    try {
      const { project, handle } = await openProjectFile(file);
      set({
        project,
        fileHandle: handle,
        screen: 'editor',
        playhead: 0,
        playing: false,
        dirty: false,
        past: [],
        future: [],
      });
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return;
      throw e;
    }
  },

  setProjectName: (name) => {
    const p = get().project;
    if (p) commit({ ...p, name });
  },

  setPlayhead: (t) => {
    const d = get().project?.recording.duration ?? 0;
    set({ playhead: Math.max(0, Math.min(t, d)) });
  },
  setPlaying: (playing) => set({ playing }),

  togglePlay: () => {
    const { playing, project, playhead } = get();
    if (!project) return;
    if (playing) return set({ playing: false });
    const { start, end } = project.trim;
    // Restart from the in-point when the playhead sits outside the trim.
    if (playhead < start || playhead >= end - 30) set({ playhead: start });
    set({ playing: true });
  },

  toggleLoop: () => set({ loop: !get().loop }),

  setTrim: (patch) => {
    const p = get().project;
    if (!p) return;
    const d = p.recording.duration;
    const t = { ...p.trim, ...patch };
    t.start = Math.max(0, Math.min(t.start, d - 100));
    t.end = Math.max(t.start + 100, Math.min(t.end, d));
    commit({ ...p, trim: t });
  },

  addCut: (start, end) => {
    const p = get().project;
    if (!p) return;
    const d = p.recording.duration;
    commit({ ...p, cuts: normaliseCuts([...(p.cuts ?? []), { start, end }], d) });
  },

  removeCut: (index) => {
    const p = get().project;
    if (!p) return;
    commit({ ...p, cuts: (p.cuts ?? []).filter((_, i) => i !== index) });
  },

  updateStyle: (patch) => {
    const p = get().project;
    if (!p) return;
    commit({ ...p, style: { ...p.style, ...patch } });
  },

  patchStyle: (key, value) => {
    const p = get().project;
    if (!p) return;
    commit({ ...p, style: { ...p.style, [key]: value } });
  },

  addZoomAt: (t) => {
    const p = get().project;
    if (!p) return;
    const seg: ZoomSegment = {
      id: makeId('zoom'),
      start: t,
      end: Math.min(t + 2500, p.recording.duration),
      scale: 1.8,
      focusX: 0.5,
      focusY: 0.5,
      ramp: 600,
      speed: 1,
    };
    commit({ ...p, zooms: normaliseZooms([...p.zooms, seg], p.recording.duration) });
  },

  updateZoom: (id, patch) => {
    const p = get().project;
    if (!p) return;
    const zooms = p.zooms.map((z) => (z.id === id ? { ...z, ...patch } : z));
    commit({ ...p, zooms: normaliseZooms(zooms, p.recording.duration) });
  },

  removeZoom: (id) => {
    const p = get().project;
    if (!p) return;
    commit({ ...p, zooms: p.zooms.filter((z) => z.id !== id) });
  },

  applyAutoZoom: () => {
    const p = get().project;
    if (!p) return;
    commit({ ...p, zooms: generateAutoZooms(p.recording.clicks, p.recording.duration) });
  },

  addOverlay: (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      const p = get().project;
      if (!p) return;
      const overlay: Overlay = {
        id: makeId('ovl'),
        name: file.name,
        imageData: reader.result as string,
        x: 0.5,
        y: 0.5,
        scale: 0.25,
        start: 0,
        end: p.recording.duration,
        opacity: 1,
      };
      commit({ ...p, overlays: [...p.overlays, overlay] });
    };
    reader.readAsDataURL(file);
  },

  updateOverlay: (id, patch) => {
    const p = get().project;
    if (!p) return;
    commit({
      ...p,
      overlays: p.overlays.map((o) => (o.id === id ? { ...o, ...patch } : o)),
    });
  },

  removeOverlay: (id) => {
    const p = get().project;
    if (!p) return;
    commit({ ...p, overlays: p.overlays.filter((o) => o.id !== id) });
  },

  addMusic: async (file) => {
    const p = get().project;
    if (!p) return;
    // Decode once for the real duration; the blob itself is kept verbatim.
    let duration = 0;
    try {
      const ctx = new AudioContext();
      const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
      duration = decoded.duration * 1000;
      void ctx.close();
    } catch {
      window.alert('Could not decode that audio file.');
      return;
    }
    const music: MusicTrack = {
      name: file.name,
      offset: 0,
      duration,
      gain: 0.8,
      blob: file,
    };
    commit({ ...get().project!, music });
  },

  updateMusic: (patch) => {
    const p = get().project;
    if (!p?.music) return;
    commit({ ...p, music: { ...p.music, ...patch } });
  },

  removeMusic: () => {
    const p = get().project;
    if (!p) return;
    commit({ ...p, music: undefined });
  },

  setPreviewRate: (previewRate) => set({ previewRate }),

  runExport: async () => {
    const p = get().project;
    if (!p || get().exporting) return;
    const controller = new AbortController();
    exportAbort = controller;
    set({ exporting: true, exportProgress: null, playing: false });
    try {
      const result = await exportProject(
        p,
        (exportProgress) => set({ exportProgress }),
        controller.signal,
      );
      downloadBlob(result.blob, `${p.name || 'glimpse'}-${stamp()}.${result.extension}`);
    } catch (e) {
      // Cancellation is expected, not an error worth surfacing.
      if ((e as DOMException)?.name !== 'AbortError') throw e;
    } finally {
      exportAbort = null;
      set({ exporting: false, exportProgress: null });
    }
  },

  runExportGif: async () => {
    const p = get().project;
    if (!p || get().exporting) return;
    const controller = new AbortController();
    exportAbort = controller;
    set({ exporting: true, exportProgress: null, playing: false });
    try {
      const result = await exportGif(p, (exportProgress) => set({ exportProgress }), controller.signal);
      downloadBlob(result.blob, `${p.name || 'glimpse'}-${stamp()}.gif`);
    } catch (e) {
      if ((e as DOMException)?.name !== 'AbortError') throw e;
    } finally {
      exportAbort = null;
      set({ exporting: false, exportProgress: null });
    }
  },

  cancelExport: () => exportAbort?.abort(),

  exportPng: async (scale = 2) => {
    const { project, playhead, exporting } = get();
    if (!project || exporting) return;
    set({ exporting: true, playing: false });
    try {
      const blob = await exportStill(project, playhead, scale);
      downloadBlob(blob, `${project.name || 'glimpse'}-${stamp()}.png`);
    } finally {
      set({ exporting: false });
    }
  },
  };
});
