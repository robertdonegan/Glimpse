/**
 * Native capture bridge — active only inside the Tauri desktop app.
 *
 * The Rust side records the screen via macOS `screencapture` (which leaves
 * the cursor OUT of the pixels) and logs global mouse telemetry with rdev.
 * This module normalises that into the same `Recording` shape the browser
 * capture produces, so the editor pipeline is identical in both worlds —
 * with the difference that native screen recordings get full synthetic
 * cursor + auto-zoom treatment.
 */

import { invoke } from '@tauri-apps/api/core';
import type { Recording } from '../timeline/model';
import type { ActiveRecording } from './recorder';

export function isTauri(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  );
}

interface NativeCaptureResult {
  path: string;
  duration_ms: number;
  cursor: { t: number; x: number; y: number; hand: boolean }[];
  clicks: { t: number; x: number; y: number; button: number }[];
  keys: { t: number; label: string }[];
  screen_w: number;
  screen_h: number;
  has_audio: boolean;
}

export async function beginNativeRecording(opts: {
  audio?: boolean;
}): Promise<ActiveRecording> {
  await invoke('start_native_capture', { audio: opts.audio ?? false });

  const stop = async (): Promise<Recording> => {
    const res = await invoke<NativeCaptureResult>('stop_native_capture');
    const bytes = await invoke<ArrayBuffer>('read_recording', { path: res.path });
    const blob = new Blob([bytes], { type: 'video/quicktime' });

    const w = res.screen_w || 1;
    const h = res.screen_h || 1;
    return {
      blob,
      mimeType: 'video/quicktime',
      // Placeholder dims — the store re-probes the decoded video anyway.
      width: res.screen_w,
      height: res.screen_h,
      duration: res.duration_ms,
      mode: 'screen',
      cursor: res.cursor.map((s) => ({ t: s.t, x: s.x / w, y: s.y / h, hand: s.hand })),
      clicks: res.clicks.map((c) => ({ t: c.t, x: c.x / w, y: c.y / h, button: c.button })),
      keys: (res.keys ?? []).map((k) => ({ t: k.t, label: k.label })),
      hasAudio: res.has_audio,
    };
  };

  return { stop, onEnded: () => {} };
}
