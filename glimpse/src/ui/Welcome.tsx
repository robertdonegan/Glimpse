import { useState } from 'react';
import { useGlimpse } from '../state/store';
import { isTauri } from '../capture/nativeCapture';

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
  const openProject = useGlimpse((s) => s.openProject);
  const [error, setError] = useState<string | null>(null);
  const [audio, setAudio] = useState(false);
  const native = isTauri();
  const supported =
    native ||
    (typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia);

  const begin = async (preferCurrentTab: boolean) => {
    setError(null);
    try {
      if (native) await startNativeRecording(audio);
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
        <span className="wordmark">Glimpse</span>

        <button
          className="aperture"
          onClick={() => begin(true)}
          aria-label={native ? 'Start native screen recording' : 'Start recording this tab'}
        >
          <PlayMark />
        </button>

        {native ? (
          <div className="capture-options">
            <button className="capture-option" onClick={() => begin(true)}>
              <strong>Record screen</strong>
              <span>Native capture — cursor as data, any app</span>
            </button>
          </div>
        ) : (
          <div className="capture-options">
            <button className="capture-option" onClick={() => begin(true)}>
              <strong>This tab</strong>
              <span>Cursor as data — restyle after</span>
            </button>
            <button className="capture-option" onClick={() => begin(false)}>
              <strong>Window / screen</strong>
              <span>Any app, cursor baked in</span>
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
