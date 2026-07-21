import { useEffect } from 'react';
import { useGlimpse } from './state/store';
import { isTauri } from './capture/nativeCapture';
import { Welcome } from './ui/Welcome';
import { RecordingBar } from './ui/RecordingBar';
import { Editor } from './ui/Editor';
import { FrameView } from './ui/FrameView';

/**
 * Warn before losing unsaved edits — the browser's native beforeunload prompt
 * for the web build, and a confirm dialog intercepting the window close on the
 * desktop app.
 */
function useUnsavedGuard(): void {
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useGlimpse.getState().dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    let unlisten: (() => void) | undefined;
    if (isTauri()) {
      void (async () => {
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const win = getCurrentWindow();
          unlisten = await win.onCloseRequested(async (event) => {
            if (!useGlimpse.getState().dirty) return;
            event.preventDefault();
            const { confirm } = await import('@tauri-apps/plugin-dialog');
            const quit = await confirm('You have unsaved changes. Quit without saving?', {
              title: 'Glimpse',
              kind: 'warning',
            });
            if (quit) await win.destroy();
          });
        } catch {
          /* window/dialog unavailable — nothing to guard */
        }
      })();
    }

    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      unlisten?.();
    };
  }, []);
}

export default function App() {
  const screen = useGlimpse((s) => s.screen);
  useUnsavedGuard();
  if (screen === 'recording') return <RecordingBar />;
  if (screen === 'editor') return <Editor />;
  if (screen === 'frame') return <FrameView />;
  return <Welcome />;
}
