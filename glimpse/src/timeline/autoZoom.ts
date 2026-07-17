/**
 * Auto-zoom: derive zoom segments from click events. Clicks that happen
 * close together in time and space are grouped into a single segment whose
 * focus is the centroid of the cluster. This only works in 'tab' mode where
 * we have click data — which is exactly why cursor telemetry is captured as
 * its own track rather than baked into pixels.
 */

import type { ClickEvent, ZoomSegment } from './model';
import { makeId } from './model';
import { clamp } from './easing';

interface AutoZoomOptions {
  scale: number;
  leadIn: number; // ms before the first click in a cluster
  holdAfter: number; // ms after the last click
  ramp: number;
  clusterGapMs: number; // clicks closer than this merge into one segment
  clusterDist: number; // normalised distance threshold for merging
}

const DEFAULTS: AutoZoomOptions = {
  scale: 1.9,
  leadIn: 600,
  holdAfter: 1100,
  ramp: 650,
  clusterGapMs: 2500,
  clusterDist: 0.28,
};

export function generateAutoZooms(
  clicks: ClickEvent[],
  duration: number,
  opts: Partial<AutoZoomOptions> = {},
): ZoomSegment[] {
  const o = { ...DEFAULTS, ...opts };
  if (clicks.length === 0) return [];

  const clusters: ClickEvent[][] = [];
  let current: ClickEvent[] = [clicks[0]];
  for (let i = 1; i < clicks.length; i++) {
    const prev = current[current.length - 1];
    const c = clicks[i];
    const near =
      c.t - prev.t < o.clusterGapMs &&
      Math.hypot(c.x - prev.x, c.y - prev.y) < o.clusterDist;
    if (near) current.push(c);
    else {
      clusters.push(current);
      current = [c];
    }
  }
  clusters.push(current);

  const segments: ZoomSegment[] = clusters.map((cluster) => {
    const cx = cluster.reduce((s, c) => s + c.x, 0) / cluster.length;
    const cy = cluster.reduce((s, c) => s + c.y, 0) / cluster.length;
    return {
      id: makeId('zoom'),
      start: clamp(cluster[0].t - o.leadIn, 0, duration),
      end: clamp(cluster[cluster.length - 1].t + o.holdAfter, 0, duration),
      scale: o.scale,
      // Keep the focus inside the zoomable area so we never pan past an edge.
      focusX: clamp(cx, 0.5 / o.scale, 1 - 0.5 / o.scale),
      focusY: clamp(cy, 0.5 / o.scale, 1 - 0.5 / o.scale),
      ramp: o.ramp,
    };
  });

  // Merge any segments the padding caused to overlap.
  const merged: ZoomSegment[] = [];
  for (const s of segments) {
    const prev = merged[merged.length - 1];
    if (prev && s.start <= prev.end) {
      prev.end = Math.max(prev.end, s.end);
      prev.focusX = (prev.focusX + s.focusX) / 2;
      prev.focusY = (prev.focusY + s.focusY) / 2;
    } else merged.push({ ...s });
  }
  return merged;
}
