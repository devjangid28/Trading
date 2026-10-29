import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Fail loudly if 5173 is taken. The old silent auto-increment to 5174 is a
    // trap after a restart: a stale dev server keeps the bookmarked :5173, the
    // browser talks to it, and the user sees a blank page while the terminal
    // says the new server is "ready".
    strictPort: true,
    host: true,
    watch: {
      // These trees are rewritten constantly by the API (SQLite DB/WAL files)
      // or hold very large artefacts (the ~32 MB fixture manifest, Playwright
      // traces). Watching them churns the dev server for no benefit and was how
      // a cold CSS build ended up stalled.
      ignored: [
        '**/fixtures/**',
        '**/data/**',
        '**/server/data/**',
        '**/qa/.artifacts/**',
        '**/dist/**',
      ],
    },
    proxy: {
      // Targets the mock API port when ORDERFLOW_API_PORT is set, so the
      // Playwright suite drives the fixture-backed server rather than whatever
      // happens to be running on the default port.
      '/api': {
        target: process.env.ORDERFLOW_API_PORT
          ? `http://127.0.0.1:${process.env.ORDERFLOW_API_PORT}`
          : 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
