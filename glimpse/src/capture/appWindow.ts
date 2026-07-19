/**
 * Desktop window chrome for recording. During a native capture we shrink
 * Glimpse to a small always-on-top controller tucked in a corner, so the user
 * can click the screen / app being recorded behind it. Restored on stop.
 */

import { isTauri } from './nativeCapture';

const NORMAL = { w: 1280, h: 820 };
const COMPACT = { w: 300, h: 132 };

let compact = false;

export async function enterCompactWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow, LogicalSize, LogicalPosition } = await import(
      '@tauri-apps/api/window'
    );
    const win = getCurrentWindow();
    await win.setAlwaysOnTop(true);
    await win.setSize(new LogicalSize(COMPACT.w, COMPACT.h));
    await win.setPosition(new LogicalPosition(24, 24));
    compact = true;
  } catch {
    /* window control unavailable — recording still works */
  }
}

export async function restoreWindow(): Promise<void> {
  if (!isTauri() || !compact) return;
  compact = false;
  try {
    const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    await win.setAlwaysOnTop(false);
    await win.setSize(new LogicalSize(NORMAL.w, NORMAL.h));
    await win.center();
  } catch {
    /* ignore */
  }
}
