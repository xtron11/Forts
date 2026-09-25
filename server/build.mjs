/**
 * Сборка сервера в JavaScript для production: src/*.ts и @forts/shared
 * собираются в dist/, пакеты из node_modules остаются внешними и
 * подключаются при запуске. Запуск: node dist/index.js
 */
import { rm } from 'node:fs/promises';
import { build } from 'esbuild';

const root = import.meta.dirname;
await rm(`${root}/dist`, { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts', 'src/migrateCli.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  plugins: [
    {
      // Наш shared собираем внутрь (он в TypeScript), остальные пакеты — внешние.
      name: 'external-packages',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith('@forts/') ? undefined : { external: true }));
      },
    },
  ],
});
