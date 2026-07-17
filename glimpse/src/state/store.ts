import { create } from 'zustand';
import type { Project, Recording, StyleSettings, ZoomSegment } from '../timeline/model';
import { createProject, makeId } from '../timeline/model';
import { generateAutoZooms } from '../timeline/autoZoom';
import { beginRecording, type ActiveRecording } from '../capture/recorder';
import { exportProject, type ExportProgress } from '../export/exporter';

export type Screen = 'welcome' | 'recording' | 'editor';

interface GlimpseState {
  screen: Screen;
  project: Project | null;
  active: ActiveRecording | null;

  // Playback
  playhead: number; // ms
  playing: boolean;

  // Export
  exporting: boolean;
  exportProgress: ExportProgress | null;

  startRecording: (preferCurrentTab: boolean) => Promise<void>;
  stopRecording: () => Promise<void>;
  discardProject: () => void;

  setPlayhead: (t: number) => void;
  setPlaying: (p: boolean) => void;

  updateStyle: (patch: Partial<StyleSettings>) => void;
  patchStyle: <K extends keyof StyleSettings>(key: K, value: StyleSettings[K]) => void;

  addZoomAt: (t: number) => void;
  updateZoom: (id: string, patch: Partial<ZoomSegment>) => void;
  removeZoom: (id: string) => void;
  applyAutoZoom: () => void;

  runExport: () => Promise<void>;
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

export const useGlimpse = create<GlimpseState>((set, get) => ({
  screen: 'welcome',
  project: null,
  active: null,
  playhead: 0,
  playing: false,
  exporting: false,
  exportProgress: null,

  startRecording: async (preferCurrentTab) => {
    const active = await beginRecording({ preferCurrentTab });
    active.onEnded(() => void get().stopRecording());
    set({ active, screen: 'recording' });
  },

  stopRecording: async () => {
    const { active } = get();
    if (!active) return;
    set({ active: null });
    const recording: Recording = await active.stop();
    const project = createProject(recording);
    // Auto-zoom on arrival when we have click data — the "it already looks
    // good" first impression. Fully editable afterwards.
    if (recording.mode === 'tab' && recording.clicks.length > 0) {
      project.zooms = generateAutoZooms(recording.clicks, recording.duration);
    }
    set({ project, screen: 'editor', playhead: 0, playing: false });
  },

  discardProject: () => set({ project: null, screen: 'welcome', playhead: 0, playing: false }),

  setPlayhead: (t) => {
    const d = get().project?.recording.duration ?? 0;
    set({ playhead: Math.max(0, Math.min(t, d)) });
  },
  setPlaying: (playing) => set({ playing }),

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

  runExport: async () => {
    const p = get().project;
    if (!p || get().exporting) return;
    set({ exporting: true, exportProgress: null, playing: false });
    try {
      const result = await exportProject(p, (exportProgress) => set({ exportProgress }));
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `glimpse-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${result.extension}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } finally {
      set({ exporting: false, exportProgress: null });
    }
  },
}));
