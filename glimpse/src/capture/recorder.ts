/**
 * Turns a live CaptureSession into a Recording. The raw capture is stored
 * losslessly-ish at a high bitrate — it is source material, not the final
 * output. The exporter re-renders it with effects applied.
 */

import type { Recording } from '../timeline/model';
import { startDisplayCapture } from './displayCapture';
import { PointerTracker } from './pointerTracker';

const VIDEO_TYPES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

const AV_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

function pickMimeType(withAudio: boolean): string {
  for (const t of withAudio ? AV_TYPES : VIDEO_TYPES) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

/**
 * While capturing our own tab, hide the real OS cursor page-wide so the
 * synthetic cursor is the only one in the pixels. Only possible for pages we
 * control — which is exactly the tab-recording case.
 */
function hideNativeCursor(): () => void {
  const style = document.createElement('style');
  style.textContent = '*, *::before, *::after { cursor: none !important; }';
  document.head.appendChild(style);
  return () => style.remove();
}

export interface ActiveRecording {
  stop: () => Promise<Recording>;
  /** Fires if the user ends the capture from browser UI. */
  onEnded: (cb: () => void) => void;
}

export async function beginRecording(opts: {
  preferCurrentTab?: boolean;
  audio?: boolean;
}): Promise<ActiveRecording> {
  const session = await startDisplayCapture(opts);
  const hasAudio = session.stream.getAudioTracks().length > 0;
  const mimeType = pickMimeType(hasAudio);

  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(session.stream, {
    mimeType: mimeType || undefined,
    videoBitsPerSecond: 40_000_000, // generous — this is our master copy
    audioBitsPerSecond: hasAudio ? 256_000 : undefined,
  });

  const tracker = new PointerTracker();
  const startTime = performance.now();
  let restoreCursor: (() => void) | null = null;
  if (session.mode === 'tab') {
    tracker.start(startTime);
    restoreCursor = hideNativeCursor();
  }

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.start(250);

  let endedCb: (() => void) | null = null;
  session.stream.getVideoTracks()[0].addEventListener('ended', () => endedCb?.());

  const stop = (): Promise<Recording> =>
    new Promise((resolve) => {
      recorder.onstop = () => {
        restoreCursor?.();
        const duration = performance.now() - startTime;
        const log =
          session.mode === 'tab'
            ? tracker.stop()
            : { cursor: [], clicks: [] };
        session.stream.getTracks().forEach((t) => t.stop());
        resolve({
          blob: new Blob(chunks, { type: mimeType || 'video/webm' }),
          mimeType: mimeType || 'video/webm',
          width: session.width,
          height: session.height,
          duration,
          mode: session.mode,
          cursor: log.cursor,
          clicks: log.clicks,
          hasAudio,
        });
      };
      recorder.stop();
    });

  return {
    stop,
    onEnded: (cb) => {
      endedCb = cb;
    },
  };
}
