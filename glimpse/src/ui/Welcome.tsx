import { useEffect, useState } from 'react';
import { useGlimpse } from '../state/store';
import { isTauri, listDisplays, type DisplayInfo } from '../capture/nativeCapture';

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
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [displayId, setDisplayId] = useState<number | undefined>(undefined);
  const native = isTauri();

  // Desktop: enumerate screens so the user can pick which one to record.
  useEffect(() => {
    if (!native) return;
    void listDisplays().then((ds) => {
      setDisplays(ds);
      const main = ds.find((d) => d.is_main) ?? ds[0];
      if (main) setDisplayId(main.id);
    });
  }, [native]);
  const supported =
    native ||
    (typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia);

  const begin = async (preferCurrentTab: boolean) => {
    setError(null);
    try {
      if (native) await startNativeRecording(audio, displayId);
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
          <div className="capture-options" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            {displays.length > 1 && (
              <select
                className="rate-select"
                value={displayId ?? ''}
                onChange={(e) => setDisplayId(Number(e.target.value))}
                aria-label="Screen to record"
              >
                {displays.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            )}
            <button className="capture-option" onClick={() => begin(true)}>
              <strong>Record screen</strong>
              <span>
                {displays.length > 1
                  ? 'Native capture — pick the screen above'
                  : 'Native capture — cursor as data, any app'}
              </span>
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
