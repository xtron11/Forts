import './style.css';
import { ApiClient } from './api/ApiClient';
import { createGame } from './game/createGame';
import { paletteFor, toCss } from './game/theme';
import { initI18n, t } from './i18n';
import { createPlatform, type Platform } from './platform';

function apiUrl(): string {
  const url = import.meta.env.VITE_API_URL?.trim();
  if (url) return url.replace(/\/+$/, '');
  if (import.meta.env.DEV) return 'http://localhost:3000';
  throw new Error('VITE_API_URL is not set');
}

/** Экран «нет связи» с кнопкой повтора — вместо игры. */
function showConnectError(platform: Platform): void {
  const box = document.createElement('div');
  box.className = 'fatal';
  const text = document.createElement('p');
  text.textContent = t('error.connect');
  const retry = document.createElement('button');
  retry.textContent = t('error.retry');
  retry.addEventListener('click', () => window.location.reload());
  box.append(text, retry);
  document.body.append(box);
  platform.ready();
}

async function main(): Promise<void> {
  const platform = await createPlatform();
  platform.expand();
  initI18n(platform.getPlayer().languageCode);

  const palette = paletteFor(platform.getTheme());
  document.body.style.backgroundColor = toCss(palette.background);
  document.body.style.color = toCss(palette.hudText);

  const api = new ApiClient(apiUrl());
  let base;
  try {
    await api.login(platform.getLoginCredentials());
    base = await api.getMe();
  } catch (err) {
    console.error('Login failed', err);
    showConnectError(platform);
    return;
  }

  const root = document.getElementById('game');
  if (!root) throw new Error('#game element not found');
  // Колесо/щипок трекпада не должны масштабировать страницу вместо игры.
  root.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });

  createGame(root, platform, api, base);
  platform.ready();
}

main().catch((err: unknown) => {
  console.error(err);
  document.body.textContent = 'Failed to start the game';
});
