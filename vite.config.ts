import { defineConfig } from 'vite';

// The app is static files only: no server code, no runtime dependencies.
export default defineConfig({
  base: './',
  build: { target: 'esnext', outDir: 'dist', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 2000 },
  worker: { format: 'es' },
});
