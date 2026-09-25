/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Адрес игрового API, например http://localhost:3000 или /api (через прокси Vite). */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
