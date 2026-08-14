import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const workbenchRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    fs: {
      allow: [workbenchRoot],
    },
    proxy: {
      '/workbench/api': {
        target: 'http://127.0.0.1:5800',
        changeOrigin: true,
      },
    },
  },
  build: {
    sourcemap: true,
  },
});
