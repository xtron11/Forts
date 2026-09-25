import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Доступ с телефона в локальной сети и через туннель (ngrok, cloudflared).
    host: true,
    allowedHosts: true,
    // VITE_API_URL=/api — запросы к API идут через dev-сервер Vite, и для
    // Telegram хватает одного туннеля на порт 5173.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
