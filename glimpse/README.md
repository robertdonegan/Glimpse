# Glimpse

Record a glimpse. Ship it beautiful. Browser-based screen recording with a
post-record synthetic cursor, click-aware auto-zoom, styled backdrops and 3D
hero-shot poses. Everything runs client-side — nothing is uploaded.

## Run it

```bash
npm install
npm run dev
```

Open the printed URL in a **desktop Chromium browser** (Chrome, Edge, Arc,
Brave). Screen capture and WebCodecs export both work best there. Firefox and
Safari fall back to the realtime webm exporter.

## The core idea

Pixels and cursor are recorded as **separate streams**. In tab mode the
capture asks the browser for a cursor-free video (`cursor: "never"`) while a
`PointerTracker` logs cursor positions and clicks at up to 240 Hz. Every
effect — cursor restyle/resize/smoothing, click pulses, auto-zoom — is applied
at render time, which is why it's all editable after recording.

The second load-bearing decision: **one render path**. The live preview and
the exporter both call `sampleFrame(project, t)` (pure, deterministic) and
feed the result to the same `GlimpseRenderer`. What you preview is what you
export, bit for bit.

## Architecture

```
src/
  capture/
    displayCapture.ts   getDisplayMedia wrapper — the swappable capture layer
    pointerTracker.ts   cursor + click telemetry (tab mode)
    recorder.ts         session → Recording (raw webm master + event tracks)
  timeline/
    model.ts            Project / Recording / ZoomSegment / StyleSettings
    sampler.ts          t → camera + cursor state (Catmull-Rom cursor path)
    autoZoom.ts         click clusters → zoom segments
    easing.ts           smootherstep, spring helpers
  render/
    renderer.ts         Three.js compositor: gradient backdrop, rounded-corner
                        video plane (SDF shader), soft shadow, cursor sprites,
                        zoom transform, 3D pose group
  export/
    exporter.ts         WebCodecs + mp4-muxer offline H.264 export;
                        MediaRecorder realtime fallback
  state/store.ts        Zustand: recording lifecycle, edits, playback, export
  ui/                   Welcome / RecordingBar / Editor / Preview /
                        Timeline / Inspector
```

## Capture modes and their honest limits

| Mode | Cursor effects | Why |
| --- | --- | --- |
| This tab | Full (restyle, resize, smooth, click zoom) | Pointer events are observable in our own page |
| Window / screen | None — cursor baked into pixels | Browsers expose no global mouse position |

Zoom, backdrops, padding, corners, shadow and 3D pose work in every mode.

A **browser extension** would extend cursor telemetry to any website tab
(content scripts). Full parity with native apps needs a desktop wrapper:
`displayCapture.ts` + `pointerTracker.ts` are the only files a **Tauri**
build replaces (ScreenCaptureKit / Windows.Graphics.Capture + a global mouse
hook); the sampler, renderer, exporter and UI ship unchanged.

## Roadmap candidates

- Animated pose keyframes (rotate in/out for hero shots, not just a static pose)
- Trim + speed segments on the timeline
- Motion blur on fast cursor movement (velocity from the sampler is already available)
- Webcam bubble track
- Wallpaper/image backdrops, background noise/grain
- `.glimpse` project files (Recording blob + JSON edit list in a zip)
- Export to GIF (WebCodecs → gifenc)
- Tauri shell for native window capture

## Known scaffold rough edges

- Zoom segments drag to move; resizing is via the inspector, not edge handles
- Export runs on the main thread; a worker + OffscreenCanvas would keep the UI
  interactive during long renders (COOP/COEP headers are already set in
  `vite.config.ts` for when that lands)
- `cursor: "never"` is a hint — a few browsers ignore it and the baked cursor
  will sit under the synthetic one in tab mode
- Safari's WebCodecs H.264 support varies; the webm fallback covers it
