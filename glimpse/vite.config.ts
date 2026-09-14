import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Project Pages live under https://<user>.github.io/Glimpse/ — assets must be
  // requested from that sub-path. The deploy workflow sets GITHUB_PAGES=true;
  // dev and the Tauri desktop build keep the root base.
  base: process.env.GITHUB_PAGES ? '/Glimpse/' : '/',
  plugins: [react()],
  build: {
    rollupOptions: {
      // audio-test.html is a dev diagnostic; don't let it bloat the main bundle.
      input: {
        main: 'index.html',
        audioTest: 'audio-test.html',
      },
    },
  },
  server: {
    // tauri.conf.json's devUrl is baked to 5175 — refuse to silently move
    // ports, otherwise the Tauri window loads whatever happens to own the port.
    port: 5175,
    strictPort: true,
    headers: {
      // Required for SharedArrayBuffer if we later move export into a worker
      // with multi-threaded encoding. Harmless otherwise.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
