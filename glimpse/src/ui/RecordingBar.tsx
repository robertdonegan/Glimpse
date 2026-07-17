import { useEffect, useState } from 'react';
import { useGlimpse } from '../state/store';

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export function RecordingBar() {
  const stopRecording = useGlimpse((s) => s.stopRecording);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const t0 = performance.now();
    const id = setInterval(() => setElapsed(performance.now() - t0), 250);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="recording">
      <div className="recording-bar" role="status" aria-live="polite">
        <span className="rec-dot" aria-hidden="true" />
        <span className="rec-time">{formatElapsed(elapsed)}</span>
        <button className="stop-btn" onClick={() => void stopRecording()}>
          Stop &amp; edit
        </button>
      </div>
      <p>
        Recording in progress. Switch to the tab or window you're demoing — come back
        here (or use the browser's own stop control) to finish.
      </p>
    </div>
  );
}
