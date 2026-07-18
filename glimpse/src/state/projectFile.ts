/**
 * Project persistence: a `.glimpse` file is a tiny binary container —
 *
 *   [4B magic "GLMP"] [4B JSON length] [JSON metadata] [raw video bytes]
 *
 * JSON carries everything except pixels (edits, style, telemetry); the video
 * blob is appended verbatim so saving is fast and lossless. Uses the File
 * System Access API when available ("Save" rewrites the same file), and
 * falls back to a download otherwise.
 */

import type { Project, Recording } from '../timeline/model';
import { normalizeProject } from '../timeline/model';
import { isTauri } from '../capture/nativeCapture';

const MAGIC = 0x474c4d50; // "GLMP"
const VERSION = 3;

interface ProjectMeta {
  version: number;
  name: string;
  zooms: Project['zooms'];
  overlays?: Project['overlays'];
  style: Project['style'];
  output: Project['output'];
  trim?: Project['trim'];
  cuts?: Project['cuts'];
  recording: Omit<Recording, 'blob' | 'audioBlob'>;
  /** v2+: byte length of the video segment (audio follows it). */
  videoSize?: number;
  audioSize?: number;
  /** v3: imported music — metadata here, bytes after the recorded audio. */
  music?: { name: string; offset: number; duration: number; gain: number };
  musicSize?: number;
}

export function serializeProject(p: Project): Blob {
  const { blob, audioBlob, ...recMeta } = p.recording;
  const meta: ProjectMeta = {
    version: VERSION,
    name: p.name,
    zooms: p.zooms,
    overlays: p.overlays,
    style: p.style,
    output: p.output,
    trim: p.trim,
    cuts: p.cuts,
    recording: recMeta,
    videoSize: blob.size,
    audioSize: audioBlob?.size ?? 0,
    music: p.music
      ? {
          name: p.music.name,
          offset: p.music.offset,
          duration: p.music.duration,
          gain: p.music.gain,
        }
      : undefined,
    musicSize: p.music?.blob.size ?? 0,
  };
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const head = new ArrayBuffer(8);
  const dv = new DataView(head);
  dv.setUint32(0, MAGIC);
  dv.setUint32(4, json.byteLength);
  const parts: BlobPart[] = [head, json, blob];
  if (audioBlob) parts.push(audioBlob);
  if (p.music) parts.push(p.music.blob);
  return new Blob(parts, { type: 'application/octet-stream' });
}

export async function deserializeProject(file: Blob): Promise<Project> {
  const headBuf = await file.slice(0, 8).arrayBuffer();
  const dv = new DataView(headBuf);
  if (dv.getUint32(0) !== MAGIC) throw new Error('Not a Glimpse project file');
  const jsonLen = dv.getUint32(4);
  const jsonBuf = await file.slice(8, 8 + jsonLen).arrayBuffer();
  const meta = JSON.parse(new TextDecoder().decode(jsonBuf)) as ProjectMeta;

  const videoStart = 8 + jsonLen;
  // v1 files: everything after the JSON is video. v2+: explicit sizes.
  const videoEnd = meta.videoSize ? videoStart + meta.videoSize : file.size;
  const videoBlob = file.slice(videoStart, videoEnd, meta.recording.mimeType);
  const audioEnd = videoEnd + (meta.audioSize ?? 0);
  const audioBlob =
    meta.audioSize && meta.audioSize > 0
      ? file.slice(videoEnd, audioEnd, 'audio/webm')
      : undefined;
  const music =
    meta.music && meta.musicSize && meta.musicSize > 0
      ? { ...meta.music, blob: file.slice(audioEnd, audioEnd + meta.musicSize) }
      : undefined;

  return normalizeProject({
    name: meta.name,
    zooms: meta.zooms,
    overlays: meta.overlays,
    style: meta.style,
    output: meta.output,
    trim: meta.trim,
    cuts: meta.cuts,
    music,
    recording: { ...meta.recording, blob: videoBlob, audioBlob },
  } as Project);
}

/* ---------- File System Access (with download fallback) ---------- */

/**
 * A saved-file reference: a File System Access handle (browser) or an absolute
 * path string (Tauri desktop). "Save" reuses it; "Save as" forces a picker.
 */
export type ProjectHandle = FileSystemFileHandle | string;
type SaveHandle = ProjectHandle;

const PICKER_TYPES = [
  {
    description: 'Glimpse project',
    accept: { 'application/octet-stream': ['.glimpse'] as const },
  },
];

export function fsAccessSupported(): boolean {
  return 'showSaveFilePicker' in window;
}

/** Returns the handle used (for subsequent quick saves), or null on fallback. */
export async function saveProjectFile(
  project: Project,
  existing: SaveHandle | null,
  forcePicker: boolean,
): Promise<SaveHandle | null> {
  const blob = serializeProject(project);

  // Desktop app: WKWebView has no showSaveFilePicker, so use the native save
  // dialog + fs write. "Save" reuses the known path (no prompt, one file);
  // only "Save as" / first save opens the dialog.
  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    let path = typeof existing === 'string' ? existing : null;
    if (!path || forcePicker) {
      path = await save({
        defaultPath: `${project.name || 'glimpse-project'}.glimpse`,
        filters: [{ name: 'Glimpse project', extensions: ['glimpse'] }],
      });
      if (!path) throw new DOMException('Save cancelled', 'AbortError');
    }
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    return path;
  }

  if (fsAccessSupported()) {
    // Tauri returned above, so any handle here is a real FS Access handle.
    let handle = typeof existing === 'string' ? null : existing;
    if (!handle || forcePicker) {
      handle = await window.showSaveFilePicker({
        suggestedName: `${project.name || 'glimpse-project'}.glimpse`,
        types: PICKER_TYPES,
      });
    }
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return handle;
  }

  // Fallback: plain download. No handle to remember.
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.name || 'glimpse-project'}.glimpse`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return null;
}

/** Open via picker (or a supplied File from an <input>). */
export async function openProjectFile(
  file?: File,
): Promise<{ project: Project; handle: SaveHandle | null }> {
  if (file) return { project: await deserializeProject(file), handle: null };

  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'Glimpse project', extensions: ['glimpse'] }],
    });
    if (typeof path !== 'string') throw new DOMException('No file chosen', 'AbortError');
    const bytes = await readFile(path);
    return { project: await deserializeProject(new Blob([bytes])), handle: path };
  }

  if ('showOpenFilePicker' in window) {
    const [handle] = await window.showOpenFilePicker({ types: PICKER_TYPES });
    const picked = await handle.getFile();
    return { project: await deserializeProject(picked), handle };
  }

  // Fallback: transient <input type=file>.
  const project = await new Promise<Project>((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.glimpse';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return reject(new DOMException('No file chosen', 'AbortError'));
      resolve(deserializeProject(f));
    };
    input.click();
  });
  return { project, handle: null };
}

/* Minimal ambient types for the File System Access API (not yet in lib.dom
   for all TS configs). */
declare global {
  interface Window {
    showSaveFilePicker(options?: {
      suggestedName?: string;
      types?: readonly { description: string; accept: Record<string, readonly string[]> }[];
    }): Promise<FileSystemFileHandle>;
    showOpenFilePicker(options?: {
      types?: readonly { description: string; accept: Record<string, readonly string[]> }[];
    }): Promise<FileSystemFileHandle[]>;
  }
}
