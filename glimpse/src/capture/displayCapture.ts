/**
 * The capture layer. Deliberately a small, swappable surface: the rest of
 * Glimpse only ever sees a MediaStream plus a CaptureMode. A native (Tauri)
 * build replaces this file with ScreenCaptureKit / Windows.Graphics.Capture
 * bindings and the editor, sampler, renderer and exporter are untouched.
 */

import type { CaptureMode } from '../timeline/model';

export interface CaptureSession {
  stream: MediaStream;
  mode: CaptureMode;
  width: number;
  height: number;
}

interface StartOptions {
  /** Ask the browser to offer the current tab first (Chromium). */
  preferCurrentTab?: boolean;
  audio?: boolean;
}

export async function startDisplayCapture(
  opts: StartOptions = {},
): Promise<CaptureSession> {
  const constraints: DisplayMediaStreamOptions & Record<string, unknown> = {
    video: {
      frameRate: { ideal: 60 },
      // In tab mode we want a cursor-free canvas so the synthetic cursor
      // can replace it. Browsers that ignore this hint still work — the
      // baked cursor just sits underneath the synthetic one.
      cursor: 'never',
    } as MediaTrackConstraints,
    audio: opts.audio ?? false,
    // Chromium-only hints; ignored elsewhere.
    preferCurrentTab: opts.preferCurrentTab ?? false,
    selfBrowserSurface: 'include',
    surfaceSwitching: 'exclude',
  };

  const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
  const track = stream.getVideoTracks()[0];
  const settings = track.getSettings();

  const surface = (settings as MediaTrackSettings & { displaySurface?: string })
    .displaySurface;
  const mode: CaptureMode =
    surface === 'browser' ? 'tab' : surface === 'window' ? 'window' : 'screen';

  return {
    stream,
    mode,
    width: settings.width ?? 1920,
    height: settings.height ?? 1080,
  };
}
