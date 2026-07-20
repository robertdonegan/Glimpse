import { useEffect, useState } from 'react';
import { useGlimpse } from '../state/store';
import {
  isTauri,
  listSources,
  type Sources,
  type CaptureTarget,
} from '../capture/nativeCapture';
import { LogoMark } from './Icon';

/** Play triangle — tap to record. */
function PlayMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5.5 L18 12 L8 18.5 Z" fill="currentColor" />
    </svg>
  );
}

export function Welcome() {
  const startRecording = useGlimpse((s) => s.startRecording);
  const startNativeRecording = useGlimpse((s) => s.startNativeRecording);
  const enterFrame = useGlimpse((s) => s.enterFrame);
  const openProject = useGlimpse((s) => s.openProject);
  const [error, setError] = useState<string | null>(null);
  const [audio, setAudio] = useState(false);
  const [sources, setSources] = useState<Sources>({ displays: [], windows: [] });
  const [selected, setSelected] = useState<string>(''); // "display:ID" | "window:ID"
  const native = isTauri();

  // Desktop: enumerate screens + windows so the user can pick what to record.
  useEffect(() => {
    if (!native) return;
    void listSources().then((s) => {
      setSources(s);
      const first = s.displays.find((d) => d.is_main) ?? s.displays[0];
      if (first) setSelected(`display:${first.id}`);
    });
  }, [native]);

  const targetFromSelection = (): CaptureTarget | undefined => {
    const [kind, idStr] = selected.split(':');
    const id = Number(idStr);
    if (kind === 'window') {
      const w = sources.windows.find((win) => win.id === id);
      if (w) return { kind: 'window', id, x: w.x, y: w.y, w: w.width, h: w.height };
    }
    const d = sources.displays.find((disp) => disp.id === id) ?? sources.displays[0];
    if (d) return { kind: 'display', id: d.id, x: d.x, y: d.y, w: d.width, h: d.height };
    return undefined;
  };
  const supported =
    native ||
    (typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia);

  const begin = async (preferCurrentTab: boolean) => {
    setError(null);
    try {
      if (native) await startNativeRecording(audio, targetFromSelection());
      else await startRecording(preferCurrentTab, audio);
    } catch (e) {
      // User dismissed the picker — not an error worth shouting about.
      if ((e as DOMException)?.name === 'NotAllowedError') return;
      setError(
        native
          ? `${e instanceof Error ? e.message : String(e)}`
          : 'Recording could not start. Check screen-sharing permissions and try again.',
      );
    }
  };

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <LogoMark size={40} />
        <span className="wordmark">Glimpse</span>

        <button
          className="aperture"
          onClick={() => begin(true)}
          aria-label={native ? 'Start native screen recording' : 'Start recording this tab'}
        >
          <PlayMark />
        </button>

        {native ? (
          <div className="capture-options" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <select
              className="rate-select"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              aria-label="What to record"
            >
              {sources.displays.length > 0 && (
                <optgroup label="Screens">
                  {sources.displays.map((d) => (
                    <option key={`d${d.id}`} value={`display:${d.id}`}>
                      {d.label}
                    </option>
                  ))}
                </optgroup>
              )}
              {sources.windows.length > 0 && (
                <optgroup label="App / browser windows">
                  {sources.windows.map((w) => (
                    <option key={`w${w.id}`} value={`window:${w.id}`}>
                      {w.app} — {w.title}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <button className="capture-option" onClick={() => begin(true)}>
              <strong>Record selection</strong>
              <span>Native capture — cursor as data, effects applied after</span>
            </button>
          </div>
        ) : (
          <div className="capture-options">
            <button className="capture-option" onClick={() => begin(true)}>
              <strong>This tab</strong>
              <span>Cursor as data — restyle after</span>
            </button>
            <button className="capture-option" onClick={() => begin(false)}>
              <strong>Other tab / window / screen</strong>
              <span>Pick anything in the share sheet — cursor baked in</span>
            </button>
            <button className="capture-option" onClick={enterFrame}>
              <strong>Frame a URL</strong>
              <span>Embed a page here and keep cursor magic</span>
            </button>
          </div>
        )}

        <label className="audio-toggle">
          <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} />
          Capture audio
        </label>

        <button className="btn quiet open-project" onClick={() => void openProject()}>
          Open project…
        </button>

        {!supported && (
          <p className="unsupported">
            This browser doesn't support screen capture. Glimpse needs a desktop
            Chromium browser or recent Firefox/Safari.
          </p>
        )}
        {error && <p className="unsupported">{error}</p>}
      </div>
    </div>
  );
}
