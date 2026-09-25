export interface PlayerInfo {
  id: string;
  name: string;
  /** IETF-код языка, например "ru" или "en-US". */
  languageCode: string;
}

export type ColorScheme = 'light' | 'dark';

export interface ThemeInfo {
  scheme: ColorScheme;
  /** Цвет фона от платформы (#rrggbb), если она его задаёт. */
  bgColor?: string;
}

export interface SafeAreaInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export type HapticKind = 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error' | 'selection';

/**
 * Всё, что зависит от площадки (Telegram, браузер, позже Яндекс Игры).
 * Игровой код работает только с этим интерфейсом.
 */
export interface Platform {
  readonly kind: 'telegram' | 'browser';
  getPlayer(): PlayerInfo;
  /** Сообщить площадке, что игра загрузилась. */
  ready(): void;
  /** Развернуть игру на максимальную доступную высоту. */
  expand(): void;
  haptic(kind: HapticKind): void;
  /** Подписанные данные запуска для проверки на сервере ('' вне Telegram). */
  getInitData(): string;
  getTheme(): ThemeInfo;
  onThemeChange(cb: (theme: ThemeInfo) => void): void;
  /** Отступы в CSS-пикселях, которые нельзя перекрывать интерфейсом. */
  getSafeAreaInsets(): SafeAreaInsets;
  /** Вызывается, когда площадка меняет видимую область без события resize. */
  onViewportChange(cb: () => void): void;
}
