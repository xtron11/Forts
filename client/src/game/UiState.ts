import Phaser from 'phaser';
import type { BuildingType } from '@forts/shared';
import type { TextKey } from '../i18n';
import type { Palette } from './theme';

/** Здание, которое тянут из меню постройки на поле. */
export interface BuildingDrag {
  type: BuildingType;
  pointerId: number;
}

/** Что делает тап по полю: обычный выбор здания, постановка нового или перенос. */
export type WorldMode = { kind: 'none' } | { kind: 'place'; type: BuildingType } | { kind: 'move'; id: number };

/**
 * Состояние интерфейса, общее для сцен мира и HUD. Событие 'change' —
 * изменились mode, выбранное здание или открытость меню; 'toast' —
 * показать короткое сообщение.
 */
export class UiState extends Phaser.Events.EventEmitter {
  mode: WorldMode = { kind: 'none' };
  /** Здание, для которого открыта панель. */
  selectedId: number | null = null;
  menuOpen = false;
  drag: BuildingDrag | null = null;
  /** Показано предложение присылать уведомления. */
  notifyPrompt = false;
  /** Предложение уже показывали в этой сессии — второй раз не показываем. */
  private notifyPromptShown = false;
  /** Области экрана (в пикселях канваса), занятые интерфейсом, — там касания не доходят до мира. */
  blockers: Phaser.Geom.Rectangle[] = [];

  constructor(public palette: Palette) {
    super();
  }

  setMode(mode: WorldMode): void {
    this.mode = mode;
    this.selectedId = null;
    this.menuOpen = false;
    this.emit('change');
  }

  select(id: number | null): void {
    if (id === this.selectedId && this.mode.kind === 'none' && !this.menuOpen) return;
    this.selectedId = id;
    this.mode = { kind: 'none' };
    this.menuOpen = false;
    this.emit('change');
  }

  setMenuOpen(open: boolean): void {
    if (open === this.menuOpen) return;
    this.menuOpen = open;
    if (open) {
      this.selectedId = null;
      this.mode = { kind: 'none' };
    }
    this.emit('change');
  }

  /** Палец/кнопка мыши зажаты на строке меню — дальше мир ведёт перетаскивание. */
  startDrag(type: BuildingType, pointerId: number): void {
    this.drag = { type, pointerId };
  }

  endDrag(): void {
    this.drag = null;
  }

  /** Предложить уведомления (один раз за сессию). */
  offerNotifications(): void {
    if (this.notifyPromptShown) return;
    this.notifyPromptShown = true;
    this.notifyPrompt = true;
    this.emit('change');
  }

  closeNotifyPrompt(): void {
    if (!this.notifyPrompt) return;
    this.notifyPrompt = false;
    this.emit('change');
  }

  toast(text: TextKey, params?: Record<string, string | number>): void {
    this.emit('toast', text, params);
  }

  setPalette(palette: Palette): void {
    this.palette = palette;
    this.emit('palette', palette);
  }

  isOverUi(x: number, y: number): boolean {
    return this.blockers.some((r) => r.contains(x, y));
  }
}
