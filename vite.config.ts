import { defineConfig } from 'vite';

export default defineConfig({
  // Vite builds the client into dist/, which Wrangler serves as static assets
  // and the Worker sits in front of for /api routes.
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
    // `npm run dev` runs the UI alone; point /api at a local `wrangler dev`
    // so the game, leaderboard and banner all work while iterating.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
});
