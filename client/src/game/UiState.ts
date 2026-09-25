import Phaser from 'phaser';
import type { BuildingType } from '@forts/shared';
import type { Palette } from './theme';

/** Состояние, общее для сцен мира и интерфейса. */
export class UiState extends Phaser.Events.EventEmitter {
  selected: BuildingType = 'townhall';
  /** Области экрана (в пикселях канваса), занятые интерфейсом, — туда не ставим здания. */
  blockers: Phaser.Geom.Rectangle[] = [];

  constructor(public palette: Palette) {
    super();
  }

  select(type: BuildingType): void {
    if (type === this.selected) return;
    this.selected = type;
    this.emit('select', type);
  }

  setPalette(palette: Palette): void {
    this.palette = palette;
    this.emit('palette', palette);
  }

  isOverUi(x: number, y: number): boolean {
    return this.blockers.some((r) => r.contains(x, y));
  }
}
