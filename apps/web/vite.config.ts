import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const gameServerUrl = process.env['GAME_SERVER_URL'] ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    proxy: {
      '/api': gameServerUrl,
      '/healthz': gameServerUrl,
      '/readyz': gameServerUrl,
      '/room': {
        target: gameServerUrl,
        ws: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
  },
  build: {
    target: 'baseline-widely-available',
    sourcemap: true,
    manifest: 'vite-manifest.json',
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'react-vendor',
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 3,
            },
            {
              name: 'base-ui-vendor',
              test: /node_modules[\\/]@base-ui[\\/]/,
              priority: 2,
            },
          ],
        },
      },
    },
  },
});
