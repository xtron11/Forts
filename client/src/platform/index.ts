import { BrowserPlatform } from './BrowserPlatform';
import type { Platform } from './Platform';
import { TelegramPlatform } from './TelegramPlatform';

export type * from './Platform';

const TELEGRAM_SDK_URL = 'https://telegram.org/js/telegram-web-app.js';

/**
 * Telegram передаёт параметры запуска в hash (#tgWebAppData=...), а SDK
 * сохраняет их в sessionStorage на случай перезагрузки страницы.
 */
function isLaunchedFromTelegram(): boolean {
  if (window.location.hash.includes('tgWebAppData')) return true;
  try {
    return sessionStorage.getItem('__telegram__initParams') !== null;
  } catch {
    return false;
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

/** Выбирает реализацию платформы автоматически. */
export async function createPlatform(): Promise<Platform> {
  if (isLaunchedFromTelegram()) {
    try {
      await loadScript(TELEGRAM_SDK_URL);
      const webApp = window.Telegram?.WebApp;
      if (webApp && webApp.initData) {
        return new TelegramPlatform(webApp);
      }
    } catch (err) {
      console.warn('Telegram SDK unavailable, falling back to browser platform', err);
    }
  }
  return new BrowserPlatform();
}
