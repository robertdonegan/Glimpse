/**
 * Turns a live CaptureSession into a Recording. The raw capture is stored
 * losslessly-ish at a high bitrate — it is source material, not the final
 * output. The exporter re-renders it with effects applied.
 *
 * Audio is captured to a second, audio-only MediaRecorder: decodeAudioData
 * chokes on video containers, so the exporter needs a clean opus blob.
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
 * control — which is exactly the current-tab case. The recording bar opts
 * back in via CSS so "Stop & edit" stays clickable.
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
  });

  // Audio rides in its own recorder so the exporter can decode it cleanly.
  const audioChunks: BlobPart[] = [];
  let audioRecorder: MediaRecorder | null = null;
  if (hasAudio) {
    const audioStream = new MediaStream(session.stream.getAudioTracks());
    audioRecorder = new MediaRecorder(audioStream, {
      mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : undefined,
      audioBitsPerSecond: 256_000,
    });
    audioRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };
    audioRecorder.start(250);
  }

  // Pointer telemetry only means anything when the pixels are OUR tab.
  // (Picking another tab in the share sheet also reports mode 'tab', but we
  // can't observe its pointer — overlaying our own would lie.)
  const ownTab = session.mode === 'tab' && !!opts.preferCurrentTab;
  const tracker = new PointerTracker();
  const startTime = performance.now();
  let restoreCursor: (() => void) | null = null;
  if (ownTab) {
    tracker.start(startTime);
    restoreCursor = hideNativeCursor();
  }

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.start(250);

  let endedCb: (() => void) | null = null;
  session.stream.getVideoTracks()[0].addEventListener('ended', () => endedCb?.());

  const stop = (): Promise<Recording> => {
    const audioDone = new Promise<void>((res) => {
      if (!audioRecorder || audioRecorder.state === 'inactive') return res();
      audioRecorder.onstop = () => res();
      audioRecorder.stop();
    });
    const videoDone = new Promise<void>((res) => {
      recorder.onstop = () => res();
      recorder.stop();
    });
    return Promise.all([audioDone, videoDone]).then(() => {
      restoreCursor?.();
      const duration = performance.now() - startTime;
      const log = ownTab ? tracker.stop() : { cursor: [], clicks: [], keys: [] };
      session.stream.getTracks().forEach((t) => t.stop());
      return {
        blob: new Blob(chunks, { type: mimeType || 'video/webm' }),
        mimeType: mimeType || 'video/webm',
        width: session.width,
        height: session.height,
        duration,
        mode: session.mode,
        cursor: log.cursor,
        clicks: log.clicks,
        keys: log.keys,
        hasAudio,
        audioBlob: hasAudio
          ? new Blob(audioChunks, { type: 'audio/webm' })
          : undefined,
      };
    });
  };

  return {
    stop,
    onEnded: (cb) => {
      endedCb = cb;
    },
  };
}
