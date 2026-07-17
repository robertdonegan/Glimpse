import { useState } from 'react';
import { useGlimpse } from '../state/store';

/** Six-blade aperture iris — the Glimpse mark. */
function ApertureMark() {
  const blades = Array.from({ length: 6 }, (_, i) => {
    const a = (i * 60 * Math.PI) / 180;
    const x1 = 50 + 34 * Math.cos(a);
    const y1 = 50 + 34 * Math.sin(a);
    const x2 = 50 + 34 * Math.cos(a + (110 * Math.PI) / 180);
    const y2 = 50 + 34 * Math.sin(a + (110 * Math.PI) / 180);
    return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />;
  });
  return (
    <svg width="72" height="72" viewBox="0 0 100 100" aria-hidden="true">
      <g stroke="var(--amber)" strokeWidth="3.4" strokeLinecap="round">
        {blades}
      </g>
    </svg>
  );
}

export function Welcome() {
  const startRecording = useGlimpse((s) => s.startRecording);
  const [error, setError] = useState<string | null>(null);
  const supported =
    typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;

  const begin = async (preferCurrentTab: boolean) => {
    setError(null);
    try {
      await startRecording(preferCurrentTab);
    } catch (e) {
      // User dismissed the picker — not an error worth shouting about.
      if ((e as DOMException)?.name === 'NotAllowedError') return;
      setError('Recording could not start. Check screen-sharing permissions and try again.');
    }
  };

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <span className="wordmark">Glimpse</span>
        <h1>
          Record a glimpse.
          <br />
          Ship it <em>beautiful</em>.
        </h1>
        <p className="lede">
          Screen recordings with a synthetic cursor, click-aware auto-zoom and 3D hero
          shots — edited after you record, entirely in your browser.
        </p>

        <button className="aperture" onClick={() => begin(true)} aria-label="Start recording this tab">
          <ApertureMark />
        </button>
        <div className="timecode">Tap the aperture to record this tab</div>

        <div className="capture-options">
          <button className="capture-option" onClick={() => begin(true)}>
            <span className="tag">FULL CURSOR MAGIC</span>
            <strong>Record this tab</strong>
            <span>
              Cursor and clicks are captured as data — restyle, resize and smooth the
              cursor after recording. Auto-zoom included.
            </span>
          </button>
          <button className="capture-option" onClick={() => begin(false)}>
            <span className="tag" style={{ color: 'var(--text-dim)', background: 'var(--panel-raised)' }}>
              PIXELS ONLY
            </span>
            <strong>Window or screen</strong>
            <span>
              Records any app. Zoom, backgrounds and 3D still apply, but the cursor is
              baked into the footage.
            </span>
          </button>
        </div>

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
