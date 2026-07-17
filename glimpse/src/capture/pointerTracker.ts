/**
 * Records pointer movement and clicks as timestamped telemetry while a tab
 * capture is running. This is the data stream that makes post-record cursor
 * effects possible — the pixels never contain a cursor at all.
 *
 * Scope note: in a browser we can only observe pointer events for pages we
 * control (this tab, or same-origin iframes). That is why Glimpse's hero
 * mode is "record this tab". A future Tauri wrapper swaps this module for a
 * global mouse hook and nothing else has to change.
 */

import type { ClickEvent, CursorSample } from '../timeline/model';

export interface PointerLog {
  cursor: CursorSample[];
  clicks: ClickEvent[];
}

export class PointerTracker {
  private cursor: CursorSample[] = [];
  private clicks: ClickEvent[] = [];
  private t0 = 0;
  private lastSampleT = -Infinity;
  private running = false;

  /** Minimum ms between stored samples — 240 Hz is plenty. */
  private readonly minInterval = 1000 / 240;

  private onMove = (e: PointerEvent) => {
    if (!this.running) return;
    const t = performance.now() - this.t0;
    if (t - this.lastSampleT < this.minInterval) return;
    this.lastSampleT = t;
    this.cursor.push({
      t,
      x: e.clientX / window.innerWidth,
      y: e.clientY / window.innerHeight,
    });
  };

  private onDown = (e: PointerEvent) => {
    if (!this.running) return;
    this.clicks.push({
      t: performance.now() - this.t0,
      x: e.clientX / window.innerWidth,
      y: e.clientY / window.innerHeight,
      button: e.button,
    });
  };

  start(startTime: number): void {
    this.t0 = startTime;
    this.cursor = [];
    this.clicks = [];
    this.lastSampleT = -Infinity;
    this.running = true;
    window.addEventListener('pointermove', this.onMove, { capture: true, passive: true });
    window.addEventListener('pointerdown', this.onDown, { capture: true, passive: true });
  }

  stop(): PointerLog {
    this.running = false;
    window.removeEventListener('pointermove', this.onMove, { capture: true });
    window.removeEventListener('pointerdown', this.onDown, { capture: true });
    return { cursor: this.cursor, clicks: this.clicks };
  }
}
