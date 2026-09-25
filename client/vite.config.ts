import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Доступ с телефона в локальной сети и через туннель (ngrok, cloudflared).
    host: true,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
