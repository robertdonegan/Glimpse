import { useGlimpse } from '../state/store';
import type { CursorStyle } from '../timeline/model';

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="row">
      <label>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
      />
      <span className="value">{format ? format(value) : value}</span>
    </div>
  );
}

const POSE_PRESETS: Record<string, { rotX: number; rotY: number; rotZ: number }> = {
  Flat: { rotX: 0, rotY: 0, rotZ: 0 },
  'Hero left': { rotX: 6, rotY: 18, rotZ: -2 },
  'Hero right': { rotX: 6, rotY: -18, rotZ: 2 },
  Floating: { rotX: 14, rotY: 0, rotZ: 0 },
};

export function Inspector({ selectedZoom }: { selectedZoom: string | null }) {
  const project = useGlimpse((s) => s.project);
  const patchStyle = useGlimpse((s) => s.patchStyle);
  const updateStyle = useGlimpse((s) => s.updateStyle);
  const updateZoom = useGlimpse((s) => s.updateZoom);
  const removeZoom = useGlimpse((s) => s.removeZoom);
  const runExport = useGlimpse((s) => s.runExport);
  const exporting = useGlimpse((s) => s.exporting);
  const progress = useGlimpse((s) => s.exportProgress);

  if (!project) return null;
  const { style, recording } = project;
  const tabMode = recording.mode === 'tab';
  const zoom = project.zooms.find((z) => z.id === selectedZoom) ?? null;

  return (
    <aside className="inspector">
      <div className="section">
        <h3>Cursor</h3>
        {tabMode ? (
          <>
            <div className="row">
              <label>Style</label>
              <select
                value={style.cursor.style}
                onChange={(e) =>
                  patchStyle('cursor', {
                    ...style.cursor,
                    style: e.target.value as CursorStyle,
                  })
                }
              >
                <option value="default">Pointer</option>
                <option value="circle">Circle</option>
                <option value="none">Hidden</option>
              </select>
            </div>
            <SliderRow
              label="Size"
              value={style.cursor.size}
              min={0.6}
              max={4}
              step={0.1}
              format={(v) => `${v.toFixed(1)}×`}
              onChange={(v) => patchStyle('cursor', { ...style.cursor, size: v })}
            />
            <SliderRow
              label="Smoothing"
              value={style.cursor.smoothing}
              min={0}
              max={1}
              step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => patchStyle('cursor', { ...style.cursor, smoothing: v })}
            />
            <div className="row">
              <label>Click highlight</label>
              <input
                type="checkbox"
                checked={style.cursor.clickHighlight}
                onChange={(e) =>
                  patchStyle('cursor', { ...style.cursor, clickHighlight: e.target.checked })
                }
              />
            </div>
          </>
        ) : (
          <p className="hint">
            Cursor effects need a tab recording — this capture has the cursor baked
            into its pixels.
          </p>
        )}
      </div>

      <div className="section">
        <h3>Frame</h3>
        <SliderRow
          label="Padding"
          value={style.padding}
          min={0}
          max={0.22}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => patchStyle('padding', v)}
        />
        <SliderRow
          label="Corners"
          value={style.cornerRadius}
          min={0}
          max={64}
          step={1}
          format={(v) => `${v}px`}
          onChange={(v) => patchStyle('cornerRadius', v)}
        />
        <div className="row">
          <label>Shadow</label>
          <input
            type="checkbox"
            checked={style.shadow}
            onChange={(e) => patchStyle('shadow', e.target.checked)}
          />
        </div>
        <div className="row">
          <label>Backdrop</label>
          <input
            type="color"
            value={style.background.colorA}
            onChange={(e) =>
              patchStyle('background', { ...style.background, colorA: e.target.value })
            }
            aria-label="Backdrop colour A"
          />
          <input
            type="color"
            value={style.background.colorB}
            onChange={(e) =>
              patchStyle('background', { ...style.background, colorB: e.target.value })
            }
            aria-label="Backdrop colour B"
          />
        </div>
        <SliderRow
          label="Angle"
          value={style.background.angle}
          min={0}
          max={360}
          step={5}
          format={(v) => `${v}°`}
          onChange={(v) => patchStyle('background', { ...style.background, angle: v })}
        />
      </div>

      <div className="section">
        <h3>3D pose</h3>
        <div className="seg-row" style={{ marginBottom: 12 }}>
          {Object.entries(POSE_PRESETS).map(([name, pose]) => {
            const on =
              style.pose.rotX === pose.rotX &&
              style.pose.rotY === pose.rotY &&
              style.pose.rotZ === pose.rotZ;
            return (
              <button
                key={name}
                className={`chip${on ? ' on' : ''}`}
                onClick={() => patchStyle('pose', pose)}
              >
                {name}
              </button>
            );
          })}
        </div>
        <SliderRow
          label="Tilt X"
          value={style.pose.rotX}
          min={-45}
          max={45}
          step={1}
          format={(v) => `${v}°`}
          onChange={(v) => patchStyle('pose', { ...style.pose, rotX: v })}
        />
        <SliderRow
          label="Turn Y"
          value={style.pose.rotY}
          min={-45}
          max={45}
          step={1}
          format={(v) => `${v}°`}
          onChange={(v) => patchStyle('pose', { ...style.pose, rotY: v })}
        />
        <SliderRow
          label="Roll Z"
          value={style.pose.rotZ}
          min={-20}
          max={20}
          step={1}
          format={(v) => `${v}°`}
          onChange={(v) => patchStyle('pose', { ...style.pose, rotZ: v })}
        />
      </div>

      {zoom && (
        <div className="section">
          <h3>Selected zoom</h3>
          <SliderRow
            label="Scale"
            value={zoom.scale}
            min={1.1}
            max={4}
            step={0.1}
            format={(v) => `${v.toFixed(1)}×`}
            onChange={(v) => updateZoom(zoom.id, { scale: v })}
          />
          <SliderRow
            label="Focus X"
            value={zoom.focusX}
            min={0}
            max={1}
            step={0.01}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => updateZoom(zoom.id, { focusX: v })}
          />
          <SliderRow
            label="Focus Y"
            value={zoom.focusY}
            min={0}
            max={1}
            step={0.01}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => updateZoom(zoom.id, { focusY: v })}
          />
          <SliderRow
            label="Ramp"
            value={zoom.ramp}
            min={150}
            max={1500}
            step={50}
            format={(v) => `${v}ms`}
            onChange={(v) => updateZoom(zoom.id, { ramp: v })}
          />
          <button className="btn quiet" onClick={() => removeZoom(zoom.id)}>
            Remove zoom
          </button>
        </div>
      )}

      <div className="section">
        <h3>Export</h3>
        <div className="row">
          <label>Frame rate</label>
          <select
            value={project.output.fps}
            onChange={(e) =>
              useGlimpse.setState({
                project: {
                  ...project,
                  output: { ...project.output, fps: Number(e.target.value) },
                },
              })
            }
          >
            <option value={30}>30 fps</option>
            <option value={60}>60 fps</option>
          </select>
        </div>
        <button className="btn primary" onClick={() => void runExport()} disabled={exporting} style={{ width: '100%' }}>
          {exporting ? 'Rendering…' : 'Export MP4'}
        </button>
        {exporting && progress && (
          <>
            <div className="export-progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.totalFrames} aria-valuenow={progress.frame}>
              <div style={{ width: `${(progress.frame / progress.totalFrames) * 100}%` }} />
            </div>
            <p className="hint">
              Frame {progress.frame} of {progress.totalFrames}
            </p>
          </>
        )}
      </div>
    </aside>
  );
}
