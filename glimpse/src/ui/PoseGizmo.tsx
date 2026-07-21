/**
 * Blender-style rotation gizmo overlaid on the preview. Three axis rings —
 * red = tilt X, green = turn Y, blue = roll Z — drag to set the 3D pose. The
 * rings flatten with the current rotation so the widget reads as an orientation
 * indicator, not just handles.
 */
import { useRef, useState } from 'react';

type Pose = { rotX: number; rotY: number; rotZ: number };
type Axis = 'x' | 'y' | 'z';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const DEG = 180 / Math.PI;
// Full rotation on every axis.
const LIMIT = 180;

export function PoseGizmo({ pose, onChange }: { pose: Pose; onChange: (p: Pose) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  // Which ring is being dragged — kept highlighted even if the pointer strays.
  const [active, setActive] = useState<Axis | null>(null);

  const start = (axis: Axis) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setActive(axis);
    const rect = ref.current!.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let last = { x: e.clientX, y: e.clientY };
    let lastAng = Math.atan2(e.clientY - cy, e.clientX - cx);
    // Accumulate at full precision; commit rounded so values stay clean.
    const acc: Pose = { ...pose };

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - last.x;
      const dy = ev.clientY - last.y;
      last = { x: ev.clientX, y: ev.clientY };
      if (axis === 'x') {
        acc.rotX = clamp(acc.rotX - dy * 0.4, -LIMIT, LIMIT);
      } else if (axis === 'y') {
        acc.rotY = clamp(acc.rotY + dx * 0.4, -LIMIT, LIMIT);
      } else {
        const ang = Math.atan2(ev.clientY - cy, ev.clientX - cx);
        let d = (ang - lastAng) * DEG;
        if (d > 180) d -= 360;
        if (d < -180) d += 360;
        lastAng = ang;
        acc.rotZ = clamp(acc.rotZ + d, -LIMIT, LIMIT);
      }
      onChange({
        rotX: Math.round(acc.rotX),
        rotY: Math.round(acc.rotY),
        rotZ: Math.round(acc.rotZ),
      });
    };
    const up = () => {
      setActive(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Nested radii so the three rings stay distinct (and grabbable) even at a
  // flat pose, where all three would otherwise collapse onto one circle.
  const RX = 42;
  const RY = 33;
  const RZ = 24;
  // Flatten each ring by the cosine of its axis angle — a tilted circle in
  // perspective reads as an ellipse.
  const flatX = Math.max(2, RX * Math.abs(Math.cos((pose.rotX * Math.PI) / 180)));
  const flatY = Math.max(2, RY * Math.abs(Math.cos((pose.rotY * Math.PI) / 180)));

  return (
    <svg
      ref={ref}
      className="pose-gizmo"
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
    >
      <circle cx={50} cy={50} r={RX + 6} className="giz-boundary" />

      {/* Tilt X (red, outer): rotates about the screen-horizontal axis → flatten in Y. */}
      <ellipse cx={50} cy={50} rx={RX} ry={flatX} className="giz-hit" onPointerDown={start('x')} />
      <ellipse
        cx={50}
        cy={50}
        rx={RX}
        ry={flatX}
        className={`giz-ring giz-x${active === 'x' ? ' active' : ''}`}
      />

      {/* Turn Y (green, mid): rotates about the screen-vertical axis → flatten in X. */}
      <ellipse cx={50} cy={50} rx={flatY} ry={RY} className="giz-hit" onPointerDown={start('y')} />
      <ellipse
        cx={50}
        cy={50}
        rx={flatY}
        ry={RY}
        className={`giz-ring giz-y${active === 'y' ? ' active' : ''}`}
      />

      {/* Roll Z (blue, inner): in-plane circle, rotated by rotZ with a tick. */}
      <g transform={`rotate(${pose.rotZ} 50 50)`}>
        <circle cx={50} cy={50} r={RZ} className="giz-hit" onPointerDown={start('z')} />
        <circle
          cx={50}
          cy={50}
          r={RZ}
          className={`giz-ring giz-z${active === 'z' ? ' active' : ''}`}
        />
        <line
          x1={50}
          y1={50}
          x2={50}
          y2={50 - RZ}
          className={`giz-z giz-tick${active === 'z' ? ' active' : ''}`}
        />
      </g>

      <circle cx={50} cy={50} r={2} className="giz-center" />
    </svg>
  );
}
