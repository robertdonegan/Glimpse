# Verify Glimpse (web build)

Build/launch:

```bash
cd glimpse
npx vite --port 5199 --strictPort   # dev server
```

Drive with Playwright (install once in a temp dir: `npm i playwright && npx playwright install chromium`).

Gotchas:

- **Screen capture doesn't work headless or without macOS screen-recording
  permission** — you can't reach the editor through the record flow.
  Instead synthesize a `.glimpse` project file in-page and open it:
  1. In `page.evaluate`, record a 2s canvas via `canvas.captureStream()` +
     `MediaRecorder` (`video/webm`) to get a real decodable video blob.
  2. Build the GLMP container: `[4B magic 0x474c4d50][4B JSON len][JSON meta][video]`
     — see `src/state/projectFile.ts` for the meta shape (`version: 3`,
     `videoSize`, minimal `recording` with `cursor`/`clicks` arrays;
     `normalizeProject` fills style defaults). Return as base64, write to disk.
  3. `delete window.showOpenFilePicker` in-page so "Open project…" falls back
     to a transient `<input type=file>` that Playwright's `filechooser` event
     can intercept, then `chooser.setFiles(path)`.
- Wait for `.timeline-track` to confirm the editor mounted.
- Theme toggle = click `.logo-btn` (top-left logo). Check
  `document.documentElement.dataset.theme`.
- **Full-page screenshots can render stale/mixed frames in headless Chromium**
  (element screenshots and actual PNG pixels are correct). When a full-page
  shot looks wrong, verify by sampling PNG pixels (decode via canvas in a
  throwaway page) or take element screenshots before concluding a bug.

Useful flows: Add zoom (controls bar), select `.zoom-seg`, Shift+drag on
`.timeline-track` to cut, `.dirty-star` appears after edits and clears on save.
