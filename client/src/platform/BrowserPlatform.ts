import type { LoginCredentials } from '@forts/shared';
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
 * настроить через URL: ?name=Вася&lang=en&id=42. Сервер пускает его
 * только в режиме разработки; у каждого id своя база.
 */
export class BrowserPlatform implements Platform {
  readonly kind = 'browser';
  private readonly player: PlayerInfo;
  private readonly devId: number;
  private readonly darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  constructor() {
    const params = new URLSearchParams(window.location.search);
    const id = Number(params.get('id'));
    this.devId = Number.isInteger(id) && id > 0 ? id : 1;
    this.player = {
      id: `dev-${this.devId}`,
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

  getLoginCredentials(): LoginCredentials {
    return { kind: 'dev', devId: this.devId, name: this.player.name, languageCode: this.player.languageCode };
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
