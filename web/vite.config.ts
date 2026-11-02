import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.DB_TOOL_API ?? 'http://127.0.0.1:3000';

export default defineConfig({
  // The packaged window serves index.html from app://, so assets must be relative.
  base: './',
  plugins: [react()],
  server: {
    // Bind the IPv4 loopback explicitly: the desktop shell waits on 127.0.0.1.
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
});
