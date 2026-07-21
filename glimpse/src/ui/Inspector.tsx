import { useRef, useState } from 'react';
import { useGlimpse } from '../state/store';
import { Icon } from './Icon';
import type { CursorStyle } from '../timeline/model';
import { clamp } from '../timeline/easing';

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  format,
  parse,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  /**
   * Map a number typed in *display* units back to the stored value (e.g. "7"
   * for 7% → 0.07). Identity when omitted.
   */
  parse?: (displayNum: number) => number;
  onChange: (v: number) => void;
}) {
  // While the field is focused it holds a free-text draft; on blur/Enter the
  // draft is parsed, mapped through `parse`, and clamped into range.
  const [draft, setDraft] = useState<string | null>(null);
  const display = format ? format(value) : String(value);

  const commitDraft = (raw: string) => {
    const num = parseFloat(raw);
    if (!Number.isNaN(num)) {
      const mapped = parse ? parse(num) : num;
      onChange(clamp(mapped, min, max));
    }
    setDraft(null);
  };

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
      <input
        className="value value-input"
        type="text"
        inputMode="decimal"
        value={draft ?? display}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => {
          setDraft(String(parseFloat(display)));
          requestAnimationFrame(() => e.target.select());
        }}
        onBlur={(e) => commitDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          else if (e.key === 'Escape') {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
        aria-label={`${label} value`}
      />
    </div>
  );
}

type Pose = { rotX: number; rotY: number; rotZ: number };

const POSE_PRESETS: Record<string, Pose> = {
  Flat: { rotX: 0, rotY: 0, rotZ: 0 },
  'Hero left': { rotX: 6, rotY: 18, rotZ: -2 },
  'Hero right': { rotX: 6, rotY: -18, rotZ: 2 },
  'Hero left XL': { rotX: 8, rotY: 32, rotZ: -3 },
  'Hero right XL': { rotX: 8, rotY: -32, rotZ: 3 },
  Floating: { rotX: 14, rotY: 0, rotZ: 0 },
  'Float up': { rotX: -12, rotY: 0, rotZ: 0 },
  Showcase: { rotX: 16, rotY: 26, rotZ: -4 },
};

/** Curated 4-corner gradients (A=TL, B=TR, C=BL, D=BR). */
const GRADIENT_PRESETS: { name: string; a: string; b: string; c: string; d: string }[] = [
  { name: 'Dusk', a: '#1b2a4a', b: '#0b3b39', c: '#14243f', d: '#123f3c' },
  { name: 'Sunset', a: '#ff8a5c', b: '#ffb26b', c: '#d16ba5', d: '#86a8e7' },
  { name: 'Ocean', a: '#1a2980', b: '#26d0ce', c: '#0f2027', d: '#2c5364' },
  { name: 'Grape', a: '#654ea3', b: '#eaafc8', c: '#42275a', d: '#734b6d' },
  { name: 'Ember', a: '#ff512f', b: '#f09819', c: '#870000', d: '#2a0d05' },
  { name: 'Forest', a: '#134e5e', b: '#71b280', c: '#0f3443', d: '#34e89e' },
  { name: 'Slate', a: '#2c2f34', b: '#41454b', c: '#17191c', d: '#33373d' },
  { name: 'Bloom', a: '#ee9ca7', b: '#ffdde1', c: '#b06ab3', d: '#4568dc' },
];

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

export function Inspector({
  selectedZoom,
  gizmo = false,
  onToggleGizmo,
}: {
  selectedZoom: string | null;
  gizmo?: boolean;
  onToggleGizmo?: () => void;
}) {
  const project = useGlimpse((s) => s.project);
  const patchStyle = useGlimpse((s) => s.patchStyle);
  const updateZoom = useGlimpse((s) => s.updateZoom);
  const removeZoom = useGlimpse((s) => s.removeZoom);
  const addOverlay = useGlimpse((s) => s.addOverlay);
  const updateOverlay = useGlimpse((s) => s.updateOverlay);
  const removeOverlay = useGlimpse((s) => s.removeOverlay);
  const addMusic = useGlimpse((s) => s.addMusic);
  const removeMusic = useGlimpse((s) => s.removeMusic);
  const removeRecordedAudio = useGlimpse((s) => s.removeRecordedAudio);
  const runExport = useGlimpse((s) => s.runExport);
  const runExportGif = useGlimpse((s) => s.runExportGif);
  const cancelExport = useGlimpse((s) => s.cancelExport);
  const exportPng = useGlimpse((s) => s.exportPng);
  const exporting = useGlimpse((s) => s.exporting);
  const progress = useGlimpse((s) => s.exportProgress);

  const [poseTemplates, setPoseTemplates] = useState<Record<string, Pose>>(loadPoseTemplates);
  const backdropInput = useRef<HTMLInputElement>(null);
  const overlayInput = useRef<HTMLInputElement>(null);
  const musicInput = useRef<HTMLInputElement>(null);

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

  const blurRegions = style.blur ?? [];
  const setBlur = (
    i: number,
    patch: Partial<{ x: number; y: number; w: number; h: number }>,
  ) =>
    patchStyle(
      'blur',
      blurRegions.map((r, j) => (j === i ? { ...r, ...patch } : r)),
    );

  return (
    <aside className="inspector">
      <div className="inspector-scroll">
      <details className="section" open>
        <summary>
          Cursor <Icon name="chevron-down" size={12} />
        </summary>
        {hasCursorData ? (
          <>
            <div className="row">
              <label>Style</label>
              <span className="select-wrap">
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
              </span>
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
              max={2}
              step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              parse={(n) => n / 100}
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
            <div className="row">
              <label>Return to start</label>
              <input
                type="checkbox"
                checked={style.cursor.returnToStart}
                onChange={(e) =>
                  patchStyle('cursor', { ...style.cursor, returnToStart: e.target.checked })
                }
                title="Ease the cursor back to its opening position at the end — for seamless loops"
              />
            </div>
            <div className="row">
              <label>Glide across cuts</label>
              <input
                type="checkbox"
                checked={style.cursor.bridgeCuts}
                onChange={(e) =>
                  patchStyle('cursor', { ...style.cursor, bridgeCuts: e.target.checked })
                }
                title="Ease the cursor between cut sections instead of jumping — for continuity"
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
      </details>

      <details className="section" open>
        <summary>
          Frame <Icon name="chevron-down" size={12} />
        </summary>
        <SliderRow
          label="Padding"
          value={style.padding}
          min={0}
          max={0.22}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          parse={(n) => n / 100}
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
        <SliderRow
          label="Size"
          value={style.frameScale ?? 1}
          min={0.2}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          parse={(n) => n / 100}
          onChange={(v) => patchStyle('frameScale', v)}
        />
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <label>Position</label>
          <div className="anchor-grid" role="group" aria-label="Recording position">
            {[0, 0.5, 1].map((py) =>
              [0, 0.5, 1].map((px) => {
                const pos = style.position ?? { x: 0.5, y: 0.5 };
                const on = Math.abs(pos.x - px) < 0.01 && Math.abs(pos.y - py) < 0.01;
                return (
                  <button
                    key={`${px}-${py}`}
                    className={`anchor-cell${on ? ' on' : ''}`}
                    aria-label={`Position ${px},${py}`}
                    onClick={() => patchStyle('position', { x: px, y: py })}
                  />
                );
              }),
            )}
          </div>
        </div>
        <SliderRow
          label="X"
          value={style.position?.x ?? 0.5}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          parse={(n) => n / 100}
          onChange={(v) => patchStyle('position', { ...(style.position ?? { x: 0.5, y: 0.5 }), x: v })}
        />
        <SliderRow
          label="Y"
          value={style.position?.y ?? 0.5}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          parse={(n) => n / 100}
          onChange={(v) => patchStyle('position', { ...(style.position ?? { x: 0.5, y: 0.5 }), y: v })}
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
          <span className="select-wrap">
          <select
            value={style.background.kind === 'image' ? 'gradient' : style.background.kind}
            onChange={(e) =>
              patchStyle('background', {
                ...style.background,
                kind: e.target.value as 'gradient' | 'corners' | 'solid',
              })
            }
            aria-label="Backdrop type"
          >
            <option value="gradient">Linear gradient</option>
            <option value="corners">4-corner gradient</option>
            <option value="solid">Solid</option>
          </select>
          </span>
        </div>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <label>Presets</label>
          <div className="gradient-presets">
            {GRADIENT_PRESETS.map((g) => (
              <button
                key={g.name}
                className="gradient-swatch"
                title={g.name}
                aria-label={`${g.name} gradient`}
                style={{
                  background: `linear-gradient(135deg, ${g.a}, ${g.b} 40%, ${g.c} 70%, ${g.d})`,
                }}
                onClick={() =>
                  patchStyle('background', {
                    ...style.background,
                    kind: 'corners',
                    colorA: g.a,
                    colorB: g.b,
                    colorC: g.c,
                    colorD: g.d,
                  })
                }
              />
            ))}
          </div>
        </div>
        <div className="row">
          <label>{style.background.kind === 'corners' ? 'Top' : 'Colours'}</label>
          <input
            type="color"
            value={style.background.colorA}
            onChange={(e) =>
              patchStyle('background', { ...style.background, colorA: e.target.value })
            }
            aria-label="Backdrop colour A"
          />
          {style.background.kind !== 'solid' && (
            <input
              type="color"
              value={style.background.colorB}
              onChange={(e) =>
                patchStyle('background', { ...style.background, colorB: e.target.value })
              }
              aria-label="Backdrop colour B"
            />
          )}
        </div>
        {style.background.kind === 'corners' && (
          <div className="row">
            <label>Bottom</label>
            <input
              type="color"
              value={style.background.colorC ?? style.background.colorB}
              onChange={(e) =>
                patchStyle('background', { ...style.background, colorC: e.target.value })
              }
              aria-label="Backdrop colour C (bottom-left)"
            />
            <input
              type="color"
              value={style.background.colorD ?? style.background.colorA}
              onChange={(e) =>
                patchStyle('background', { ...style.background, colorD: e.target.value })
              }
              aria-label="Backdrop colour D (bottom-right)"
            />
          </div>
        )}
        {style.background.kind === 'gradient' && (
          <SliderRow
            label="Angle"
            value={style.background.angle}
            min={0}
            max={360}
            step={5}
            format={(v) => `${v}°`}
            onChange={(v) => patchStyle('background', { ...style.background, angle: v })}
          />
        )}
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
      </details>

      <details className="section" open>
        <summary>
          Effects <Icon name="chevron-down" size={12} />
        </summary>
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
              parse={(n) => n / 100}
              onChange={(v) => patchStyle('dof', { ...style.dof, strength: v })}
            />
            <p className="hint">
              Blur follows real scene depth — tilt the 3D pose and the far edge
              defocuses naturally.
            </p>
          </>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <label>Spotlight</label>
          <input
            type="checkbox"
            checked={style.spotlight.enabled}
            onChange={(e) =>
              patchStyle('spotlight', { ...style.spotlight, enabled: e.target.checked })
            }
            title="Darken the frame except a pool of light — for dramatic emphasis"
          />
        </div>
        {style.spotlight.enabled && (
          <>
            <div className="row">
              <label>Follow cursor</label>
              <input
                type="checkbox"
                checked={style.spotlight.follow}
                disabled={!hasCursorData}
                onChange={(e) =>
                  patchStyle('spotlight', { ...style.spotlight, follow: e.target.checked })
                }
              />
            </div>
            <SliderRow
              label="Radius"
              value={style.spotlight.radius}
              min={0.05}
              max={0.6}
              step={0.01}
              format={(v) => `${Math.round(v * 100)}%`}
              parse={(n) => n / 100}
              onChange={(v) => patchStyle('spotlight', { ...style.spotlight, radius: v })}
            />
            <SliderRow
              label="Darkness"
              value={style.spotlight.strength}
              min={0}
              max={1}
              step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              parse={(n) => n / 100}
              onChange={(v) => patchStyle('spotlight', { ...style.spotlight, strength: v })}
            />
            {!style.spotlight.follow && (
              <>
                <SliderRow
                  label="Light X"
                  value={style.spotlight.x}
                  min={0}
                  max={1}
                  step={0.01}
                  format={(v) => `${Math.round(v * 100)}%`}
                  parse={(n) => n / 100}
                  onChange={(v) => patchStyle('spotlight', { ...style.spotlight, x: v })}
                />
                <SliderRow
                  label="Light Y"
                  value={style.spotlight.y}
                  min={0}
                  max={1}
                  step={0.01}
                  format={(v) => `${Math.round(v * 100)}%`}
                  parse={(n) => n / 100}
                  onChange={(v) => patchStyle('spotlight', { ...style.spotlight, y: v })}
                />
              </>
            )}
          </>
        )}

        <div className="row" style={{ marginTop: 12 }}>
          <label>Motion blur</label>
          <input
            type="checkbox"
            checked={style.motionBlur.enabled}
            onChange={(e) =>
              patchStyle('motionBlur', { ...style.motionBlur, enabled: e.target.checked })
            }
          />
        </div>
        {style.motionBlur.enabled && (
          <>
            <SliderRow
              label="Amount"
              value={style.motionBlur.amount}
              min={0}
              max={1}
              step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              parse={(n) => n / 100}
              onChange={(v) => patchStyle('motionBlur', { ...style.motionBlur, amount: v })}
            />
            <p className="hint">
              Renders extra sub-frames per frame — smoother motion, but export
              runs several times slower and hotter. Affects export only.
            </p>
          </>
        )}

        <div className="row" style={{ marginTop: 12 }}>
          <label>Keyboard overlay</label>
          <input
            type="checkbox"
            checked={style.keystrokes.enabled}
            onChange={(e) => patchStyle('keystrokes', { enabled: e.target.checked })}
          />
        </div>
        {style.keystrokes.enabled && !(recording.keys && recording.keys.length > 0) && (
          <p className="hint">
            No keystrokes captured in this recording. Native desktop capture and
            tab recordings log keys; other captures don't.
          </p>
        )}

        <div className="row" style={{ marginTop: 12 }}>
          <label>Redact (blur)</label>
          <button
            className="chip"
            onClick={() =>
              patchStyle('blur', [...blurRegions, { x: 0.4, y: 0.4, w: 0.22, h: 0.1 }])
            }
            title="Add a blurred rectangle to hide sensitive info; it tilts/zooms with the recording"
          >
            Add region
          </button>
        </div>
        {blurRegions.map((r, i) => (
          <div key={i} className="overlay-item">
            <div className="row" style={{ marginTop: 10 }}>
              <label>Region {i + 1}</label>
              <button
                className="chip"
                onClick={() =>
                  patchStyle(
                    'blur',
                    blurRegions.filter((_, j) => j !== i),
                  )
                }
              >
                ×
              </button>
            </div>
            <SliderRow
              label="X"
              value={r.x}
              min={0}
              max={1}
              step={0.01}
              format={(v) => `${Math.round(v * 100)}%`}
              parse={(n) => n / 100}
              onChange={(v) => setBlur(i, { x: v })}
            />
            <SliderRow
              label="Y"
              value={r.y}
              min={0}
              max={1}
              step={0.01}
              format={(v) => `${Math.round(v * 100)}%`}
              parse={(n) => n / 100}
              onChange={(v) => setBlur(i, { y: v })}
            />
            <SliderRow
              label="Width"
              value={r.w}
              min={0.02}
              max={1}
              step={0.01}
              format={(v) => `${Math.round(v * 100)}%`}
              parse={(n) => n / 100}
              onChange={(v) => setBlur(i, { w: v })}
            />
            <SliderRow
              label="Height"
              value={r.h}
              min={0.02}
              max={1}
              step={0.01}
              format={(v) => `${Math.round(v * 100)}%`}
              parse={(n) => n / 100}
              onChange={(v) => setBlur(i, { h: v })}
            />
          </div>
        ))}
      </details>

      <details className="section" open>
        <summary>
          3D pose <Icon name="chevron-down" size={12} />
        </summary>
        {onToggleGizmo && (
          <button
            className={`btn${gizmo ? ' on' : ''}`}
            style={{ width: '100%', marginBottom: 8 }}
            onClick={onToggleGizmo}
            title="Show a rotation gizmo on the preview — drag its rings to tilt, turn and roll"
          >
            {gizmo ? 'Hide rotate gizmo' : 'Rotate on canvas'}
          </button>
        )}
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
          min={-75}
          max={75}
          step={1}
          format={(v) => `${v}°`}
          onChange={(v) => patchStyle('pose', { ...style.pose, rotX: v })}
        />
        <SliderRow
          label="Turn Y"
          value={style.pose.rotY}
          min={-75}
          max={75}
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
      </details>

      {zoom && (
        <details className="section" open>
          <summary>
            Selected zoom <Icon name="chevron-down" size={12} />
          </summary>
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
            parse={(n) => n / 100}
            onChange={(v) => updateZoom(zoom.id, { focusX: v })}
          />
          <SliderRow
            label="Focus Y"
            value={zoom.focusY}
            min={0}
            max={1}
            step={0.01}
            format={(v) => `${Math.round(v * 100)}%`}
            parse={(n) => n / 100}
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
          <div className="row">
            <label>Custom tilt</label>
            <input
              type="checkbox"
              checked={!!zoom.pose}
              onChange={(e) =>
                updateZoom(zoom.id, {
                  pose: e.target.checked ? { rotX: 6, rotY: -14, rotZ: 1 } : undefined,
                })
              }
              title="Ease into a different 3D pose while this zoom is active"
            />
          </div>
          {zoom.pose && (
            <>
              <SliderRow
                label="Tilt X"
                value={zoom.pose.rotX}
                min={-75}
                max={75}
                step={1}
                format={(v) => `${v}°`}
                onChange={(v) => updateZoom(zoom.id, { pose: { ...zoom.pose!, rotX: v } })}
              />
              <SliderRow
                label="Turn Y"
                value={zoom.pose.rotY}
                min={-75}
                max={75}
                step={1}
                format={(v) => `${v}°`}
                onChange={(v) => updateZoom(zoom.id, { pose: { ...zoom.pose!, rotY: v } })}
              />
              <SliderRow
                label="Roll Z"
                value={zoom.pose.rotZ}
                min={-20}
                max={20}
                step={1}
                format={(v) => `${v}°`}
                onChange={(v) => updateZoom(zoom.id, { pose: { ...zoom.pose!, rotZ: v } })}
              />
            </>
          )}
          <button className="btn quiet" onClick={() => removeZoom(zoom.id)}>
            Remove zoom
          </button>
        </details>
      )}

      <details className="section" open>
        <summary>
          Audio track <Icon name="chevron-down" size={12} />
        </summary>
        <button
          className="btn"
          style={{ width: '100%' }}
          onClick={() => musicInput.current?.click()}
          title="Import a music or voice-over file onto the audio track"
        >
          <Icon name="audio" />
          {project.music ? 'Replace audio' : 'Add audio'}
        </button>
        <input
          ref={musicInput}
          type="file"
          accept="audio/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void addMusic(f);
            e.target.value = '';
          }}
        />
        {project.music && (
          <>
            <div className="row" style={{ marginTop: 8 }}>
              <label className="overlay-name" title={project.music.name}>
                {project.music.name}
              </label>
              <button
                className="chip"
                onClick={removeMusic}
                title="Delete the imported audio track"
              >
                Delete
              </button>
            </div>
            <SliderRow
              label="Volume"
              value={project.music.gain}
              min={0}
              max={1}
              step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              parse={(n) => n / 100}
              onChange={(v) => useGlimpse.getState().updateMusic({ gain: v })}
            />
            <p className="hint">Drag the green clip on the timeline to re-time it.</p>
          </>
        )}
        {recording.hasAudio && (
          <div className="row" style={{ marginTop: 8 }}>
            <label>Recorded sound</label>
            <button
              className="chip"
              onClick={removeRecordedAudio}
              title="Delete the audio captured with the recording"
            >
              Delete
            </button>
          </div>
        )}
      </details>

      <details className="section" open>
        <summary>
          Overlays &amp; idents <Icon name="chevron-down" size={12} />
        </summary>
        <button className="chip" onClick={() => overlayInput.current?.click()}>
          Add graphic (SVG, PNG…)
        </button>
        <p className="hint" style={{ marginTop: 6 }}>
          Toggle “Flat ident” on a graphic to pin it over the whole frame,
          unaffected by tilt or zoom — for titles and logos.
        </p>
        <input
          ref={overlayInput}
          type="file"
          accept="image/*,.svg"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) addOverlay(f);
            e.target.value = '';
          }}
        />
        {project.overlays.map((o) => (
          <div key={o.id} className="overlay-item">
            <div className="row" style={{ marginTop: 10 }}>
              <label className="overlay-name" title={o.name}>
                {o.name}
              </label>
              <button className="chip" onClick={() => removeOverlay(o.id)}>
                ×
              </button>
            </div>
            <div className="row">
              <label>Flat ident</label>
              <input
                type="checkbox"
                checked={!!o.flat}
                onChange={(e) => updateOverlay(o.id, { flat: e.target.checked })}
                title="Pin to the output frame (titles, idents) — ignores 3D tilt and zoom"
              />
            </div>
            <SliderRow
              label="X"
              value={o.x}
              min={0}
              max={1}
              step={0.01}
              format={(v) => `${Math.round(v * 100)}%`}
              parse={(n) => n / 100}
              onChange={(v) => updateOverlay(o.id, { x: v })}
            />
            <SliderRow
              label="Y"
              value={o.y}
              min={0}
              max={1}
              step={0.01}
              format={(v) => `${Math.round(v * 100)}%`}
              parse={(n) => n / 100}
              onChange={(v) => updateOverlay(o.id, { y: v })}
            />
            <SliderRow
              label="Size"
              value={o.scale}
              min={0.02}
              max={1}
              step={0.01}
              format={(v) => `${Math.round(v * 100)}%`}
              parse={(n) => n / 100}
              onChange={(v) => updateOverlay(o.id, { scale: v })}
            />
            <SliderRow
              label="Opacity"
              value={o.opacity}
              min={0}
              max={1}
              step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              parse={(n) => n / 100}
              onChange={(v) => updateOverlay(o.id, { opacity: v })}
            />
            <SliderRow
              label="From"
              value={o.start}
              min={0}
              max={recording.duration}
              step={100}
              format={(v) => `${(v / 1000).toFixed(1)}s`}
              parse={(n) => n * 1000}
              onChange={(v) => updateOverlay(o.id, { start: Math.min(v, o.end - 100) })}
            />
            <SliderRow
              label="To"
              value={o.end}
              min={0}
              max={recording.duration}
              step={100}
              format={(v) => `${(v / 1000).toFixed(1)}s`}
              parse={(n) => n * 1000}
              onChange={(v) => updateOverlay(o.id, { end: Math.max(v, o.start + 100) })}
            />
          </div>
        ))}
      </details>

      {/* end scroll region — export stays pinned below */}
      </div>

      <div className="export-panel">
        <h3>Export</h3>
        <div className="row">
          <label>Frame rate</label>
          <span className="select-wrap">
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
              <option value={120}>120 fps</option>
            </select>
          </span>
        </div>
        <button
          className="btn primary"
          onClick={() => void runExport()}
          disabled={exporting}
          style={{ width: '100%' }}
        >
          {exporting ? 'Rendering…' : 'Export MP4'}
        </button>
        <div className="export-buttons">
          <button
            className="btn"
            onClick={() => void runExportGif()}
            disabled={exporting}
            title="Animated GIF — reduced size & frame rate, honours trim + cuts"
          >
            Export GIF
          </button>
          <button
            className="btn"
            onClick={() => void exportPng(2)}
            disabled={exporting}
            title="Renders the current frame at 2× output resolution"
          >
            Export PNG
          </button>
        </div>
        {exporting && (
          <button
            className="btn"
            onClick={cancelExport}
            style={{ width: '100%', marginTop: 8 }}
          >
            Cancel render
          </button>
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
