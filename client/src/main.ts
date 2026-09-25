import './style.css';
import { createGame } from './game/createGame';
import { paletteFor, toCss } from './game/theme';
import { initI18n } from './i18n';
import { createPlatform } from './platform';

async function main(): Promise<void> {
  const platform = await createPlatform();
  platform.expand();
  initI18n(platform.getPlayer().languageCode);

  document.body.style.backgroundColor = toCss(paletteFor(platform.getTheme()).background);

  const root = document.getElementById('game');
  if (!root) throw new Error('#game element not found');
  // Колесо/щипок трекпада не должны масштабировать страницу вместо игры.
  root.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });

  createGame(root, platform);
  platform.ready();
}

main().catch((err: unknown) => {
  console.error(err);
  document.body.textContent = 'Failed to start the game';
});
