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
  // Лагерь — низкая площадка: на ней стоят войска.
  camp: 0.25,
  tower: 2.6,
  wall: 0.9,
};

export function polygon(g: Phaser.GameObjects.Graphics, points: readonly Point[]): void {
  g.beginPath();
  g.moveTo(points[0]!.x, points[0]!.y);
  for (let i = 1; i < points.length; i++) g.lineTo(points[i]!.x, points[i]!.y);
  g.closePath();
}

/** Лежит ли точка внутри многоугольника (чётность пересечений луча). */
export function pointInPolygon(p: Point, points: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!;
    const b = points[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function box(type: BuildingType, col: number, row: number) {
  const { size } = BUILDINGS[type];
  const [top, right, bottom, left] = footprintCorners(col, row, size, size);
  const h = STUB_HEIGHT[type] * TILE_H;
  const up = (p: Point): Point => ({ x: p.x, y: p.y - h });
  return { top, right, bottom, left, up };
}

/** Силуэт коробки на экране (мировые координаты) — для попадания тапом. */
export function buildingOutline(type: BuildingType, col: number, row: number): Point[] {
  const { top, right, bottom, left, up } = box(type, col, row);
  return [left, bottom, right, up(right), up(top), up(left)];
}

/** Точка над серединой крыши — туда вешаются таймер и значок сбора. */
export function buildingRoofCenter(type: BuildingType, col: number, row: number): Point {
  const { top, bottom, up } = box(type, col, row);
  return up({ x: top.x, y: (top.y + bottom.y) / 2 });
}

/**
 * Рисует здание-коробку в мировых координатах. Недостроенное (level 0) —
 * низкий каркас в цвет здания.
 */
export function drawBuilding(g: Phaser.GameObjects.Graphics, type: BuildingType, col: number, row: number, constructing = false): void {
  const { color } = BUILDINGS[type];
  const b = box(type, col, row);
  const { top, right, bottom, left } = b;
  const up = constructing ? (p: Point): Point => ({ x: p.x, y: p.y - TILE_H * 0.35 }) : b.up;

  const faces: [Point[], number][] = [
    [[left, bottom, up(bottom), up(left)], shade(color, -0.3)],
    [[bottom, right, up(right), up(bottom)], shade(color, -0.12)],
    [[up(top), up(right), up(bottom), up(left)], shade(color, 0.15)],
  ];
  g.clear();
  g.lineStyle(1, shade(color, -0.55), 1);
  for (const [points, fill] of faces) {
    g.fillStyle(constructing ? shade(fill, 0.35) : fill, 1);
    polygon(g, points);
    g.fillPath();
    g.strokePath();
  }
  if (type === 'camp' && !constructing) drawCampDetails(g, b, color);
  if (constructing) {
    // Стойки лесов по углам.
    const full = b.up;
    g.lineStyle(2, shade(color, -0.45), 0.9);
    for (const p of [left, bottom, right, top]) g.lineBetween(p.x, p.y, p.x, full(p).y);
    g.lineBetween(full(left).x, full(left).y, full(bottom).x, full(bottom).y);
    g.lineBetween(full(bottom).x, full(bottom).y, full(right).x, full(right).y);
  }
}

/** Утоптанная земля посередине и столбы с флажками по дальним углам — чтобы не закрывать войска. */
function drawCampDetails(g: Phaser.GameObjects.Graphics, b: ReturnType<typeof box>, color: number): void {
  const { top, right, bottom, left, up } = b;
  const cx = top.x;
  const cy = (top.y + bottom.y) / 2;
  const inset = (p: Point): Point => up({ x: cx + (p.x - cx) * 0.8, y: cy + (p.y - cy) * 0.8 });
  g.fillStyle(shade(color, 0.35), 1);
  polygon(g, [top, right, bottom, left].map(inset));
  g.fillPath();
  const pole = TILE_H * 1.1;
  for (const corner of [left, top, right]) {
    const base = up(corner);
    g.lineStyle(2, shade(color, -0.6), 1).lineBetween(base.x, base.y, base.x, base.y - pole);
    g.fillStyle(0xe53935, 1).fillTriangle(base.x, base.y - pole, base.x + 9, base.y - pole + 3, base.x, base.y - pole + 6);
  }
}
