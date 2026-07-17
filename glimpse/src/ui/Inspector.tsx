import { useRef, useState } from 'react';
import { useGlimpse } from '../state/store';
import type { CursorStyle } from '../timeline/model';
import { audioExportable } from '../export/exporter';

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

type Pose = { rotX: number; rotY: number; rotZ: number };

const POSE_PRESETS: Record<string, Pose> = {
  Flat: { rotX: 0, rotY: 0, rotZ: 0 },
  'Hero left': { rotX: 6, rotY: 18, rotZ: -2 },
  'Hero right': { rotX: 6, rotY: -18, rotZ: 2 },
  Floating: { rotX: 14, rotY: 0, rotZ: 0 },
};

const POSE_STORE_KEY = 'glimpse.poseTemplates';

function loadPoseTemplates(): Record<string, Pose> {
  try {
    return JSON.parse(localStorage.getItem(POSE_STORE_KEY) ?? '{}') as Record<string, Pose>;
  } catch {
    return {};
  }
}

function savePoseTemplates(t: Record<string, Pose>): void {
  localStorage.setItem(POSE_STORE_KEY, JSON.stringify(t));
}

export function Inspector({ selectedZoom }: { selectedZoom: string | null }) {
  const project = useGlimpse((s) => s.project);
  const patchStyle = useGlimpse((s) => s.patchStyle);
  const updateZoom = useGlimpse((s) => s.updateZoom);
  const removeZoom = useGlimpse((s) => s.removeZoom);
  const runExport = useGlimpse((s) => s.runExport);
  const exportPng = useGlimpse((s) => s.exportPng);
  const exporting = useGlimpse((s) => s.exporting);
  const progress = useGlimpse((s) => s.exportProgress);

  const [poseTemplates, setPoseTemplates] = useState<Record<string, Pose>>(loadPoseTemplates);
  const backdropInput = useRef<HTMLInputElement>(null);

  if (!project) return null;
  const { style, recording } = project;
  const hasCursorData = recording.cursor.length > 0;
  const zoom = project.zooms.find((z) => z.id === selectedZoom) ?? null;

  const poseMatches = (pose: Pose) =>
    style.pose.rotX === pose.rotX &&
    style.pose.rotY === pose.rotY &&
    style.pose.rotZ === pose.rotZ;

  const savePoseTemplate = () => {
    const name = window.prompt('Template name?');
    if (!name) return;
    const next = { ...poseTemplates, [name]: { ...style.pose } };
    setPoseTemplates(next);
    savePoseTemplates(next);
  };

  const deletePoseTemplate = (name: string) => {
    const next = { ...poseTemplates };
    delete next[name];
    setPoseTemplates(next);
    savePoseTemplates(next);
  };

  const onBackdropFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () =>
      patchStyle('background', {
        ...style.background,
        kind: 'image',
        imageData: reader.result as string,
      });
    reader.readAsDataURL(file);
  };

  const audioDropped = recording.hasAudio && !audioExportable(project);

  return (
    <aside className="inspector">
      <div className="section">
        <h3>Cursor</h3>
        {hasCursorData ? (
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
            <div className="row">
              <label>Hand on hover</label>
              <input
                type="checkbox"
                checked={style.cursor.handOnHover}
                onChange={(e) =>
                  patchStyle('cursor', { ...style.cursor, handOnHover: e.target.checked })
                }
              />
            </div>
            <div className="row">
              <label>Colour</label>
              <input
                type="color"
                value={style.cursor.color}
                onChange={(e) =>
                  patchStyle('cursor', { ...style.cursor, color: e.target.value })
                }
                aria-label="Cursor colour"
              />
            </div>
          </>
        ) : (
          <p className="hint">
            Cursor effects need telemetry — record a tab (browser) or use the
            desktop app's native capture. This recording has the cursor baked
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
              patchStyle('background', {
                ...style.background,
                kind: style.background.kind === 'image' ? 'gradient' : style.background.kind,
                colorA: e.target.value,
              })
            }
            aria-label="Backdrop colour A"
          />
          <input
            type="color"
            value={style.background.colorB}
            onChange={(e) =>
              patchStyle('background', {
                ...style.background,
                kind: style.background.kind === 'image' ? 'gradient' : style.background.kind,
                colorB: e.target.value,
              })
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
        <div className="row">
          <label>Image</label>
          <div className="seg-row">
            <button className="chip" onClick={() => backdropInput.current?.click()}>
              {style.background.kind === 'image' ? 'Replace…' : 'Upload…'}
            </button>
            {style.background.kind === 'image' && (
              <button
                className="chip"
                onClick={() =>
                  patchStyle('background', {
                    ...style.background,
                    kind: 'gradient',
                    imageData: undefined,
                  })
                }
              >
                Clear
              </button>
            )}
          </div>
          <input
            ref={backdropInput}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => onBackdropFile(e.target.files?.[0])}
          />
        </div>
      </div>

      <div className="section">
        <h3>Effects</h3>
        <div className="row">
          <label>Depth of field</label>
          <input
            type="checkbox"
            checked={style.dof.enabled}
            onChange={(e) => patchStyle('dof', { ...style.dof, enabled: e.target.checked })}
          />
        </div>
        {style.dof.enabled && (
          <>
            <SliderRow
              label="Strength"
              value={style.dof.strength}
              min={0}
              max={1}
              step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => patchStyle('dof', { ...style.dof, strength: v })}
            />
            <p className="hint">
              Blur follows real scene depth — tilt the 3D pose and the far edge
              defocuses naturally.
            </p>
          </>
        )}
      </div>

      <div className="section">
        <h3>3D pose</h3>
        <div className="seg-row" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
          {Object.entries(POSE_PRESETS).map(([name, pose]) => (
            <button
              key={name}
              className={`chip${poseMatches(pose) ? ' on' : ''}`}
              onClick={() => patchStyle('pose', pose)}
            >
              {name}
            </button>
          ))}
        </div>
        {Object.keys(poseTemplates).length > 0 && (
          <div className="seg-row" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
            {Object.entries(poseTemplates).map(([name, pose]) => (
              <button
                key={name}
                className={`chip${poseMatches(pose) ? ' on' : ''}`}
                onClick={() => patchStyle('pose', pose)}
                title="Saved template — right-click to delete"
                onContextMenu={(e) => {
                  e.preventDefault();
                  deletePoseTemplate(name);
                }}
              >
                {name}
              </button>
            ))}
          </div>
        )}
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
        <button className="btn quiet" onClick={savePoseTemplate}>
          Save pose as template
        </button>
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
            label="Speed"
            value={zoom.speed || 1}
            min={0.25}
            max={2}
            step={0.05}
            format={(v) => `${v.toFixed(2)}×`}
            onChange={(v) => updateZoom(zoom.id, { speed: v })}
          />
          {recording.cursor.length > 0 && (
            <div className="row">
              <label>Follow cursor</label>
              <input
                type="checkbox"
                checked={!!zoom.follow}
                onChange={(e) => updateZoom(zoom.id, { follow: e.target.checked })}
              />
            </div>
          )}
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
        <button
          className="btn primary"
          onClick={() => void runExport()}
          disabled={exporting}
          style={{ width: '100%' }}
        >
          {exporting ? 'Rendering…' : 'Export MP4'}
        </button>
        <button
          className="btn"
          onClick={() => void exportPng(2)}
          disabled={exporting}
          style={{ width: '100%', marginTop: 8 }}
          title="Renders the current frame at 2× output resolution"
        >
          Export PNG frame (2×)
        </button>
        {audioDropped && (
          <p className="hint">
            Audio is skipped when clip speeds differ from 1× — reset speeds to keep
            the soundtrack.
          </p>
        )}
        {exporting && progress && (
          <>
            <div
              className="export-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={progress.totalFrames}
              aria-valuenow={progress.frame}
            >
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
