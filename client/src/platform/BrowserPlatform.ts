import type { HapticKind, Platform, PlayerInfo, SafeAreaInsets, ThemeInfo } from './Platform';

const VIBRATION_MS: Record<HapticKind, number | number[]> = {
  light: 10,
  medium: 20,
  heavy: 35,
  selection: 5,
  success: [10, 40, 10],
  warning: [20, 60, 20],
  error: [30, 50, 30, 50, 30],
};

/**
 * Запуск в обычном браузере для разработки. Тестового игрока можно
 * настроить через URL: ?name=Вася&lang=en&id=42
 */
export class BrowserPlatform implements Platform {
  readonly kind = 'browser';
  private readonly player: PlayerInfo;
  private readonly darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  constructor() {
    const params = new URLSearchParams(window.location.search);
    this.player = {
      id: params.get('id') ?? 'dev-player',
      name: params.get('name') ?? 'Dev Player',
      languageCode: params.get('lang') ?? navigator.language ?? 'en',
    };
  }

  getPlayer(): PlayerInfo {
    return this.player;
  }

  ready(): void {}

  expand(): void {}

  haptic(kind: HapticKind): void {
    navigator.vibrate?.(VIBRATION_MS[kind]);
  }

  getInitData(): string {
    return '';
  }

  getTheme(): ThemeInfo {
    return { scheme: this.darkQuery.matches ? 'dark' : 'light' };
  }

  onThemeChange(cb: (theme: ThemeInfo) => void): void {
    this.darkQuery.addEventListener('change', () => cb(this.getTheme()));
  }

  getSafeAreaInsets(): SafeAreaInsets {
    return { top: 0, bottom: 0, left: 0, right: 0 };
  }

  onViewportChange(): void {
    // В браузере достаточно обычного события resize.
  }
}
