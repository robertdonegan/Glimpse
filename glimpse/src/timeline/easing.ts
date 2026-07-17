/** Easing utilities. Everything Glimpse animates goes through these. */

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Smootherstep — C2 continuous, no visible velocity kink at the ends. */
export function smoother(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/**
 * Critically damped spring step. Integrates position/velocity toward a
 * target — this is what gives the cursor its "weight" instead of a
 * mechanical tween. `halflife` is how long it takes to close half the
 * remaining distance, in ms.
 */
export interface SpringState {
  value: number;
  velocity: number;
}

export function springStep(
  s: SpringState,
  target: number,
  dtMs: number,
  halflifeMs: number,
): void {
  const omega = 2 * (0.6931471805599453 / Math.max(halflifeMs, 1e-3)); // ln2 / halflife
  const x = s.value - target;
  const v = s.velocity;
  const dt = dtMs;
  const exp = Math.exp(-omega * dt);
  s.value = target + (x + (v + omega * x) * dt) * exp;
  s.velocity = (v - (v + omega * x) * omega * dt) * exp;
}
