import type { LoginCredentials } from '@forts/shared';
import type { HapticKind, Platform, PlayerInfo, SafeAreaInsets, ThemeInfo } from './Platform';
import type { TelegramWebApp } from './telegram-types';

export class TelegramPlatform implements Platform {
  readonly kind = 'telegram';

  constructor(private readonly webApp: TelegramWebApp) {}

  getPlayer(): PlayerInfo {
    const user = this.webApp.initDataUnsafe.user;
    if (!user) {
      return { id: 'tg-unknown', name: 'Player', languageCode: 'en' };
    }
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || 'Player';
    return { id: String(user.id), name, languageCode: user.language_code ?? 'en' };
  }

  ready(): void {
    this.webApp.ready();
  }

  expand(): void {
    this.webApp.expand();
    // Свайп вниз по игре не должен сворачивать мини-приложение (Bot API 7.7+).
    if (this.webApp.isVersionAtLeast('7.7')) {
      this.webApp.disableVerticalSwipes?.();
    }
  }

  haptic(kind: HapticKind): void {
    const h = this.webApp.HapticFeedback;
    switch (kind) {
      case 'light':
      case 'medium':
      case 'heavy':
        h.impactOccurred(kind);
        break;
      case 'success':
      case 'warning':
      case 'error':
        h.notificationOccurred(kind);
        break;
      case 'selection':
        h.selectionChanged();
        break;
    }
  }

  getLoginCredentials(): LoginCredentials {
    return { kind: 'telegram', initData: this.webApp.initData };
  }

  getTheme(): ThemeInfo {
    return { scheme: this.webApp.colorScheme, bgColor: this.webApp.themeParams.bg_color };
  }

  onThemeChange(cb: (theme: ThemeInfo) => void): void {
    this.webApp.onEvent('themeChanged', () => cb(this.getTheme()));
  }

  getSafeAreaInsets(): SafeAreaInsets {
    const device = this.webApp.safeAreaInset;
    const content = this.webApp.contentSafeAreaInset;
    const sum = (side: keyof SafeAreaInsets) => (device?.[side] ?? 0) + (content?.[side] ?? 0);
    return { top: sum('top'), bottom: sum('bottom'), left: sum('left'), right: sum('right') };
  }

  onViewportChange(cb: () => void): void {
    for (const event of ['viewportChanged', 'safeAreaChanged', 'contentSafeAreaChanged', 'fullscreenChanged']) {
      this.webApp.onEvent(event, cb);
    }
  }
}
