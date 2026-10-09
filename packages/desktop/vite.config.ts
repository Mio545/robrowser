import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Vite config for the Electron renderer (spec 2 / 9).
 *
 * The renderer is bundled to `dist/renderer`, which is exactly where the main
 * process looks for `index.html` (`join(__dirname, '../renderer/index.html')`).
 * `base: './'` keeps the asset URLs relative so `loadFile()` works when the app
 * is packaged inside an asar archive.
 */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome120',
  },
  server: {
    port: 5273,
    strictPort: true,
  },
});
