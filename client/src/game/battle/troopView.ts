import type Phaser from 'phaser';
import { TROOPS, type TroopType } from '@forts/shared';
import { shade } from '../theme';

/**
 * Юнит-заглушка с центром в (0, 0): у каждого войска своя фигура, чтобы
 * их было легко различить на поле. size — примерный диаметр.
 */
export function drawTroop(g: Phaser.GameObjects.Graphics, troop: TroopType, size: number): void {
  const color = TROOPS[troop].color;
  const r = size / 2;
  g.lineStyle(Math.max(1, size / 8), shade(color, -0.55), 1);
  g.fillStyle(color, 1);
  switch (troop) {
    case 'warrior':
      g.fillCircle(0, 0, r);
      g.strokeCircle(0, 0, r);
      // Меч.
      g.lineStyle(Math.max(1, size / 7), 0xeceff1, 1).lineBetween(r * 0.1, r * 0.35, r * 0.9, -r * 0.6);
      break;
    case 'archer':
      g.fillTriangle(0, -r * 1.1, r, r * 0.8, -r, r * 0.8);
      g.strokeTriangle(0, -r * 1.1, r, r * 0.8, -r, r * 0.8);
      break;
    case 'ram':
      g.fillRoundedRect(-r * 1.3, -r * 0.7, r * 2.6, r * 1.4, r * 0.3);
      g.strokeRoundedRect(-r * 1.3, -r * 0.7, r * 2.6, r * 1.4, r * 0.3);
      g.fillStyle(shade(color, -0.4), 1).fillCircle(-r * 0.7, r * 0.7, r * 0.35).fillCircle(r * 0.7, r * 0.7, r * 0.35);
      break;
  }
}
