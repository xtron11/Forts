import type Phaser from 'phaser';
import { BUILDINGS, type BuildingType } from '@forts/shared';
import { footprintCorners, TILE_H, type Point } from './iso';
import { shade } from './theme';

/** Высота коробки-заглушки в высотах клетки — чисто визуальный параметр. */
const STUB_HEIGHT: Record<BuildingType, number> = {
  townhall: 2.2,
  goldmine: 1.2,
  farm: 0.6,
  barracks: 1.5,
  tower: 2.6,
  wall: 0.9,
};

export function polygon(g: Phaser.GameObjects.Graphics, points: readonly Point[]): void {
  g.beginPath();
  g.moveTo(points[0]!.x, points[0]!.y);
  for (let i = 1; i < points.length; i++) g.lineTo(points[i]!.x, points[i]!.y);
  g.closePath();
}

/** Рисует здание-коробку в мировых координатах. */
export function drawBuilding(g: Phaser.GameObjects.Graphics, type: BuildingType, col: number, row: number): void {
  const { size, color } = BUILDINGS[type];
  const [top, right, bottom, left] = footprintCorners(col, row, size, size);
  const h = STUB_HEIGHT[type] * TILE_H;
  const up = (p: Point): Point => ({ x: p.x, y: p.y - h });

  const faces: [Point[], number][] = [
    [[left, bottom, up(bottom), up(left)], shade(color, -0.3)],
    [[bottom, right, up(right), up(bottom)], shade(color, -0.12)],
    [[up(top), up(right), up(bottom), up(left)], shade(color, 0.15)],
  ];
  g.clear();
  g.lineStyle(1, shade(color, -0.55), 1);
  for (const [points, fill] of faces) {
    g.fillStyle(fill, 1);
    polygon(g, points);
    g.fillPath();
    g.strokePath();
  }
}
