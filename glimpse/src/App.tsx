import { useEffect, useRef, useState } from 'react';
import { useGlimpse } from './state/store';
import { isTauri } from './capture/nativeCapture';
import { Welcome } from './ui/Welcome';
import { RecordingBar } from './ui/RecordingBar';
import { Editor } from './ui/Editor';
import { FrameView } from './ui/FrameView';

type TauriWindow = { destroy: () => Promise<void> };

/**
 * Warn before losing unsaved edits. The web build leans on the browser's
 * native beforeunload prompt; the desktop app intercepts the window close and
 * shows an in-app confirm (a native dialog inside onCloseRequested can deadlock
 * the event loop, leaving its buttons unresponsive).
 */
function useUnsavedGuard(): { asking: boolean; cancel: () => void; quit: () => void } {
  const [asking, setAsking] = useState(false);
  const winRef = useRef<TauriWindow | null>(null);

  useEffect(() => {
    // Web build: native beforeunload prompt. On desktop the close-request
    // handler owns this, so don't double up.
    let onBeforeUnload: ((e: BeforeUnloadEvent) => void) | undefined;
    if (!isTauri()) {
      onBeforeUnload = (e: BeforeUnloadEvent) => {
        if (useGlimpse.getState().dirty) {
          e.preventDefault();
          e.returnValue = '';
        }
      };
      window.addEventListener('beforeunload', onBeforeUnload);
    }

    let unlisten: (() => void) | undefined;
    if (isTauri()) {
      void (async () => {
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const win = getCurrentWindow();
          winRef.current = win;
          unlisten = await win.onCloseRequested((event) => {
            if (!useGlimpse.getState().dirty) return; // nothing unsaved — let it close
            event.preventDefault();
            setAsking(true);
          });
        } catch {
          /* window API unavailable — nothing to guard */
        }
      })();
    }

    return () => {
      if (onBeforeUnload) window.removeEventListener('beforeunload', onBeforeUnload);
      unlisten?.();
    };
  }, []);

  return {
    asking,
    cancel: () => setAsking(false),
    quit: () => {
      setAsking(false);
      void winRef.current?.destroy();
    },
  };
}

function QuitConfirm({ onCancel, onQuit }: { onCancel: () => void; onQuit: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal-overlay" onPointerDown={onCancel} role="presentation">
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-label="Unsaved changes"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h3>Unsaved changes</h3>
        <p>You have unsaved changes. Quit without saving?</p>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button className="btn primary" onClick={onQuit}>
            Quit without saving
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const screen = useGlimpse((s) => s.screen);
  const guard = useUnsavedGuard();

  let view;
  if (screen === 'recording') view = <RecordingBar />;
  else if (screen === 'editor') view = <Editor />;
  else if (screen === 'frame') view = <FrameView />;
  else view = <Welcome />;

  return (
    <>
      {view}
      {guard.asking && <QuitConfirm onCancel={guard.cancel} onQuit={guard.quit} />}
    </>
  );
}
