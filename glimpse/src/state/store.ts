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
import { beginNativeRecording } from '../capture/nativeCapture';
import {
  exportProject,
  exportStill,
  loadRecordingVideo,
  type ExportProgress,
} from '../export/exporter';
import { saveProjectFile, openProjectFile } from './projectFile';

export type Screen = 'welcome' | 'recording' | 'editor';

interface GlimpseState {
  screen: Screen;
  project: Project | null;
  active: ActiveRecording | null;
  /** File handle for quick "Save" once the project has a home on disk. */
  fileHandle: FileSystemFileHandle | null;

  // Playback
  playhead: number; // ms
  playing: boolean;
  loop: boolean;
  /** Preview-only playback rate (slow viewing). Export is unaffected. */
  previewRate: number;

  // Export
  exporting: boolean;
  exportProgress: ExportProgress | null;

  startRecording: (preferCurrentTab: boolean, withAudio: boolean) => Promise<void>;
  /** Desktop app only: cursor-free native screen capture + global telemetry. */
  startNativeRecording: (withAudio: boolean) => Promise<void>;
  stopRecording: () => Promise<void>;
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

export const useGlimpse = create<GlimpseState>((set, get) => ({
  screen: 'welcome',
  project: null,
  active: null,
  fileHandle: null,
  playhead: 0,
  playing: false,
  loop: false,
  previewRate: 1,
  exporting: false,
  exportProgress: null,

  startRecording: async (preferCurrentTab, withAudio) => {
    const active = await beginRecording({ preferCurrentTab, audio: withAudio });
    active.onEnded(() => void get().stopRecording());
    set({ active, screen: 'recording' });
  },

  startNativeRecording: async (withAudio) => {
    const active = await beginNativeRecording({ audio: withAudio });
    set({ active, screen: 'recording' });
  },

  stopRecording: async () => {
    const { active } = get();
    if (!active) return;
    set({ active: null });
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
    set({ project, screen: 'editor', playhead: 0, playing: false, fileHandle: null });
  },

  discardProject: () =>
    set({ project: null, screen: 'welcome', playhead: 0, playing: false, fileHandle: null }),

  saveProject: async (as = false) => {
    const { project, fileHandle } = get();
    if (!project) return;
    try {
      const handle = await saveProjectFile(project, fileHandle, as);
      if (handle) set({ fileHandle: handle });
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
      });
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return;
      throw e;
    }
  },

  setProjectName: (name) => {
    const p = get().project;
    if (p) set({ project: { ...p, name } });
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
    set({ project: { ...p, trim: t } });
  },

  updateStyle: (patch) => {
    const p = get().project;
    if (!p) return;
    set({ project: { ...p, style: { ...p.style, ...patch } } });
  },

  patchStyle: (key, value) => {
    const p = get().project;
    if (!p) return;
    set({ project: { ...p, style: { ...p.style, [key]: value } } });
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
    set({
      project: { ...p, zooms: normaliseZooms([...p.zooms, seg], p.recording.duration) },
    });
  },

  updateZoom: (id, patch) => {
    const p = get().project;
    if (!p) return;
    const zooms = p.zooms.map((z) => (z.id === id ? { ...z, ...patch } : z));
    set({ project: { ...p, zooms: normaliseZooms(zooms, p.recording.duration) } });
  },

  removeZoom: (id) => {
    const p = get().project;
    if (!p) return;
    set({ project: { ...p, zooms: p.zooms.filter((z) => z.id !== id) } });
  },

  applyAutoZoom: () => {
    const p = get().project;
    if (!p) return;
    set({
      project: {
        ...p,
        zooms: generateAutoZooms(p.recording.clicks, p.recording.duration),
      },
    });
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
      set({ project: { ...p, overlays: [...p.overlays, overlay] } });
    };
    reader.readAsDataURL(file);
  },

  updateOverlay: (id, patch) => {
    const p = get().project;
    if (!p) return;
    set({
      project: {
        ...p,
        overlays: p.overlays.map((o) => (o.id === id ? { ...o, ...patch } : o)),
      },
    });
  },

  removeOverlay: (id) => {
    const p = get().project;
    if (!p) return;
    set({ project: { ...p, overlays: p.overlays.filter((o) => o.id !== id) } });
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
    set({ project: { ...get().project!, music } });
  },

  updateMusic: (patch) => {
    const p = get().project;
    if (!p?.music) return;
    set({ project: { ...p, music: { ...p.music, ...patch } } });
  },

  removeMusic: () => {
    const p = get().project;
    if (!p) return;
    set({ project: { ...p, music: undefined } });
  },

  setPreviewRate: (previewRate) => set({ previewRate }),

  runExport: async () => {
    const p = get().project;
    if (!p || get().exporting) return;
    set({ exporting: true, exportProgress: null, playing: false });
    try {
      const result = await exportProject(p, (exportProgress) => set({ exportProgress }));
      downloadBlob(result.blob, `${p.name || 'glimpse'}-${stamp()}.${result.extension}`);
    } finally {
      set({ exporting: false, exportProgress: null });
    }
  },

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
}));
