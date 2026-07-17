/**
 * Turns a live CaptureSession into a Recording. The raw capture is stored
 * losslessly-ish at a high bitrate — it is source material, not the final
 * output. The exporter re-renders it with effects applied.
 */

import type { Recording } from '../timeline/model';
import { startDisplayCapture } from './displayCapture';
import { PointerTracker } from './pointerTracker';

const CANDIDATE_TYPES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

function pickMimeType(): string {
  for (const t of CANDIDATE_TYPES) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

export interface ActiveRecording {
  stop: () => Promise<Recording>;
  /** Fires if the user ends the capture from browser UI. */
  onEnded: (cb: () => void) => void;
}

export async function beginRecording(opts: {
  preferCurrentTab?: boolean;
}): Promise<ActiveRecording> {
  const session = await startDisplayCapture(opts);
  const mimeType = pickMimeType();

  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(session.stream, {
    mimeType: mimeType || undefined,
    videoBitsPerSecond: 40_000_000, // generous — this is our master copy
  });

  const tracker = new PointerTracker();
  const startTime = performance.now();
  if (session.mode === 'tab') tracker.start(startTime);

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.start(250);

  let endedCb: (() => void) | null = null;
  session.stream.getVideoTracks()[0].addEventListener('ended', () => endedCb?.());

  const stop = (): Promise<Recording> =>
    new Promise((resolve) => {
      recorder.onstop = () => {
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
