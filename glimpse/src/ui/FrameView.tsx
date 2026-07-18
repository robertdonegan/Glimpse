import { useEffect, useRef, useState } from 'react';
import { useGlimpse } from '../state/store';

/**
 * Frame mode: embed the page you want to demo inside Glimpse's own tab, then
 * record THIS tab — pointer telemetry works because the pixels are ours.
 * While recording, all Glimpse chrome disappears; only the framed page shows.
 *
 * Cross-origin pages can't share pointer events or hide their cursor, so the
 * glimpse-bridge snippet (one script tag) relays telemetry from inside the
 * page. Same-origin frames get the bridge injected automatically.
 */
export function FrameView() {
  const active = useGlimpse((s) => s.active);
  const startRecording = useGlimpse((s) => s.startRecording);
  const stopRecording = useGlimpse((s) => s.stopRecording);
  const exitFrame = useGlimpse((s) => s.exitFrame);

  const [url, setUrl] = useState('');
  const [loadedUrl, setLoadedUrl] = useState('');
  const [audio, setAudio] = useState(false);
  const [copied, setCopied] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const recording = !!active;

  const normalize = (u: string) =>
    u && !/^https?:\/\//i.test(u) ? `http://${u}` : u;

  const go = () => setLoadedUrl(normalize(url.trim()));

  // Same-origin frames: inject the bridge ourselves. Cross-origin throws —
  // that's the case the copy-paste snippet covers.
  const onFrameLoad = () => {
    try {
      const doc = iframeRef.current?.contentDocument;
      if (doc && !doc.querySelector('script[data-glimpse-bridge]')) {
        const s = doc.createElement('script');
        s.src = `${location.origin}/glimpse-bridge.js`;
        s.dataset.glimpseBridge = '1';
        (doc.head ?? doc.documentElement).appendChild(s);
      }
    } catch {
      /* cross-origin — snippet required for cursor magic */
    }
  };

  // Tell the bridge when recording starts/stops (it hides the page cursor).
  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { __glimpse: true, type: 'state', recording },
      '*',
    );
  }, [recording, loadedUrl]);

  // Stop from the keyboard (parent focus) or relayed by the bridge (iframe
  // focus) — the UI is invisible while recording.
  useEffect(() => {
    const stop = () => {
      if (useGlimpse.getState().active) void useGlimpse.getState().stopRecording();
    };
    const onKey = (e: KeyboardEvent) => {
      if (!useGlimpse.getState().active) return;
      if (e.code === 'Escape' || e.code === 'Backspace' || e.code === 'Delete') {
        e.preventDefault();
        stop();
      }
    };
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { __glimpse?: boolean; type?: string };
      if (d && d.__glimpse === true && d.type === 'key') stop();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('message', onMsg);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('message', onMsg);
    };
  }, []);

  const record = async () => {
    try {
      await startRecording(true, audio, true);
    } catch (e) {
      if ((e as DOMException)?.name === 'NotAllowedError') return;
      window.alert('Recording could not start. Check screen-sharing permissions.');
    }
  };

  const snippet = `<script src="${location.origin}/glimpse-bridge.js"></scr` + `ipt>`;
  const copySnippet = () => {
    void navigator.clipboard.writeText(snippet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="frame-view">
      {!recording && (
        <div className="frame-bar">
          <button className="btn quiet" onClick={exitFrame} title="Back">
            ←
          </button>
          <input
            className="frame-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && go()}
            placeholder="localhost:3000 — or any URL that allows embedding"
            spellCheck={false}
            aria-label="Page URL to frame"
          />
          <button className="btn" onClick={go}>
            Load
          </button>
          <label className="audio-toggle">
            <input
              type="checkbox"
              checked={audio}
              onChange={(e) => setAudio(e.target.checked)}
            />
            Audio
          </label>
          <button
            className="btn"
            onClick={copySnippet}
            title="Cross-origin page? Paste this one-line script into its HTML to enable cursor telemetry, hover-hand and a hidden cursor"
          >
            {copied ? 'Copied ✓' : 'Copy snippet'}
          </button>
          <button
            className="btn primary"
            onClick={() => void record()}
            disabled={!loadedUrl}
            title="Record this tab — the bar disappears; esc / backspace stops"
          >
            ● Record
          </button>
        </div>
      )}

      {loadedUrl ? (
        <iframe
          ref={iframeRef}
          className={`frame-embed${recording ? ' recording' : ''}`}
          src={loadedUrl}
          onLoad={onFrameLoad}
          title="Framed page"
        />
      ) : (
        <div className="frame-empty">
          <p>
            Load the page you want to demo. It fills this tab; recording captures
            only the page — Glimpse's chrome disappears.
          </p>
          <p>
            <strong>Most public sites won't load here.</strong> Google, GitHub and
            nearly every SaaS app send <code>X-Frame-Options</code> / CSP{' '}
            <code>frame-ancestors</code> headers that forbid embedding — a browser
            security rule Glimpse can't override. Frame mode only works for pages
            that <em>allow</em> being iframed (your own app, localhost, docs sites
            you control).
          </p>
          <p>
            Want cursor telemetry over <em>any</em> window or app — Figma, VS Code,
            a native program? That needs OS-level capture, which the browser can't
            do. Run the <strong>Glimpse desktop app</strong> (Tauri build): its
            native capture records cursor-free pixels of the whole screen and logs
            global mouse telemetry, so every zoom / follow / synthetic-cursor
            effect works over anything on screen.
          </p>
        </div>
      )}

      {recording && (
        <button
          className="frame-stop"
          onClick={() => void stopRecording()}
          title="Stop recording (esc / backspace)"
          aria-label="Stop recording"
        >
          ■
        </button>
      )}
    </div>
  );
}
