import Phaser from 'phaser';
import { BASE_GRID_SIZE, canPlaceBuilding, footprintSize, type BuildingType, type PlacedBuilding } from '@forts/shared';
import { t } from '../../i18n';
import { drawBuilding, polygon } from '../buildingView';
import { getGameContext, type GameContext } from '../context';
import { sortByDepth } from '../depthSort';
import { getDpr } from '../display';
import { cellToWorld, footprintCorners, TILE_H, TILE_W, worldToCell, type Point } from '../iso';

const N = BASE_GRID_SIZE;
/** Сдвиг пальца (в CSS-пикселях), после которого касание считается перетаскиванием, а не тапом. */
const TAP_SLOP = 8;

interface Gesture {
  startX: number;
  startY: number;
  /** Палец сдвинулся или был щипок — тап уже не засчитываем. */
  moved: boolean;
  pinchDist: number;
  pinchZoom: number;
  pinchMid: Point;
}

export class WorldScene extends Phaser.Scene {
  private ctx!: GameContext;
  private grid!: Phaser.GameObjects.Graphics;
  private hover!: Phaser.GameObjects.Graphics;
  private buildings: PlacedBuilding[] = [];
  private views = new Map<number, Phaser.GameObjects.Graphics>();
  private nextId = 1;

  private pointers = new Map<number, Point>();
  private gesture: Gesture | null = null;
  private minZoom = 0.5;
  private maxZoom = 4;

  constructor() {
    super('world');
  }

  create(): void {
    this.ctx = getGameContext();
    const { ui } = this.ctx;

    this.grid = this.add.graphics().setDepth(-1);
    this.hover = this.add.graphics().setDepth(Number.MAX_SAFE_INTEGER);
    this.applyPalette();
    this.fitCamera(true);

    // Все сцены получают ввод: мир сам игнорирует касания по интерфейсу,
    // зато никогда не теряет pointerup, если палец отпустили над кнопкой.
    this.input.setGlobalTopOnly(false);
    this.input.addPointer(1);
    this.input.on('pointerdown', this.onPointerDown, this);
    this.input.on('pointermove', this.onPointerMove, this);
    this.input.on('pointerup', this.onPointerUp, this);
    this.input.on('pointerupoutside', this.onPointerUp, this);
    this.input.on('gameout', () => this.hover.clear());
    this.input.on('wheel', this.onWheel, this);

    const onPalette = () => this.applyPalette();
    const onSelect = () => this.hover.clear();
    const onResize = () => this.fitCamera(false);
    ui.on('palette', onPalette);
    ui.on('select', onSelect);
    this.scale.on(Phaser.Scale.Events.RESIZE, onResize);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      ui.off('palette', onPalette);
      ui.off('select', onSelect);
      this.scale.off(Phaser.Scale.Events.RESIZE, onResize);
    });
  }

  // ---------- Отрисовка ----------

  private applyPalette(): void {
    const p = this.ctx.ui.palette;
    this.cameras.main.setBackgroundColor(p.background);
    const g = this.grid.clear();
    for (let row = 0; row < N; row++) {
      for (let col = 0; col < N; col++) {
        g.fillStyle((col + row) % 2 === 0 ? p.tileA : p.tileB, 1);
        polygon(g, footprintCorners(col, row, 1, 1));
        g.fillPath();
      }
    }
    g.lineStyle(1, p.tileLine, 0.6);
    for (let i = 0; i <= N; i++) {
      g.lineBetween(cellToWorld(i, 0).x, cellToWorld(i, 0).y, cellToWorld(i, N).x, cellToWorld(i, N).y);
      g.lineBetween(cellToWorld(0, i).x, cellToWorld(0, i).y, cellToWorld(N, i).x, cellToWorld(N, i).y);
    }
  }

  private drawFootprint(g: Phaser.GameObjects.Graphics, type: BuildingType, col: number, row: number, color: number) {
    const size = footprintSize(type);
    g.clear();
    g.fillStyle(color, 0.35);
    g.lineStyle(2, color, 0.9);
    polygon(g, footprintCorners(col, row, size, size));
    g.fillPath();
    g.strokePath();
  }

  // ---------- Здания ----------

  /** Клетка-якорь так, чтобы здание встало по центру под пальцем. */
  private anchorAt(type: BuildingType, world: Point): { col: number; row: number } {
    const cell = worldToCell(world.x, world.y);
    const offset = Math.floor((footprintSize(type) - 1) / 2);
    return { col: cell.col - offset, row: cell.row - offset };
  }

  private tryPlace(screenX: number, screenY: number): void {
    const world = this.screenToWorld(screenX, screenY);
    const cell = worldToCell(world.x, world.y);
    if (cell.col < 0 || cell.row < 0 || cell.col >= N || cell.row >= N) return;

    const { ui, platform } = this.ctx;
    const type = ui.selected;
    const { col, row } = this.anchorAt(type, world);

    if (!canPlaceBuilding(this.buildings, type, col, row)) {
      platform.haptic('error');
      this.flashInvalid(type, col, row, world);
      return;
    }

    const building: PlacedBuilding = { id: this.nextId++, type, col, row };
    this.buildings.push(building);
    const view = this.add.graphics();
    drawBuilding(view, type, col, row);
    this.views.set(building.id, view);
    this.updateDepths();
    platform.haptic('light');

    view.setAlpha(0).setY(-TILE_H);
    this.tweens.add({ targets: view, y: 0, alpha: 1, duration: 180, ease: 'Back.Out' });
  }

  private updateDepths(): void {
    sortByDepth(this.buildings).forEach((b, i) => this.views.get(b.id)?.setDepth(i + 1));
  }

  private flashInvalid(type: BuildingType, col: number, row: number, at: Point): void {
    const danger = this.ctx.ui.palette.danger;
    const g = this.add.graphics().setDepth(Number.MAX_SAFE_INTEGER);
    this.drawFootprint(g, type, col, row, danger);
    const label = this.add
      .text(at.x, at.y - TILE_H, t('build.cannotPlace'), {
        fontFamily: 'system-ui, -apple-system, Roboto, sans-serif',
        fontSize: '14px',
        fontStyle: 'bold',
        color: '#ffffff',
        backgroundColor: '#00000099',
        padding: { x: 6, y: 3 },
        resolution: getDpr(),
      })
      .setOrigin(0.5, 1)
      .setScale(getDpr() / this.cameras.main.zoom)
      .setDepth(Number.MAX_SAFE_INTEGER);
    this.tweens.add({
      targets: [g, label],
      alpha: 0,
      delay: 500,
      duration: 400,
      onComplete: () => {
        g.destroy();
        label.destroy();
      },
    });
  }

  // ---------- Камера ----------

  private screenToWorld(x: number, y: number): Point {
    const cam = this.cameras.main;
    const hw = cam.width / 2;
    const hh = cam.height / 2;
    return { x: cam.scrollX + hw + (x - cam.x - hw) / cam.zoom, y: cam.scrollY + hh + (y - cam.y - hh) / cam.zoom };
  }

  /** Меняет масштаб так, чтобы точка мира под (x, y) экрана осталась на месте. */
  private zoomAt(zoom: number, x: number, y: number): void {
    const cam = this.cameras.main;
    const anchor = this.screenToWorld(x, y);
    cam.zoom = Phaser.Math.Clamp(zoom, this.minZoom, this.maxZoom);
    const hw = cam.width / 2;
    const hh = cam.height / 2;
    cam.scrollX = anchor.x - hw - (x - cam.x - hw) / cam.zoom;
    cam.scrollY = anchor.y - hh - (y - cam.y - hh) / cam.zoom;
    this.clampScroll();
  }

  private panBy(dx: number, dy: number): void {
    const cam = this.cameras.main;
    cam.scrollX -= dx / cam.zoom;
    cam.scrollY -= dy / cam.zoom;
    this.clampScroll();
  }

  /** Центр экрана не уходит за пределы поля. */
  private clampScroll(): void {
    const cam = this.cameras.main;
    const hw = cam.width / 2;
    const hh = cam.height / 2;
    cam.scrollX = Phaser.Math.Clamp(cam.scrollX + hw, (-N * TILE_W) / 2, (N * TILE_W) / 2) - hw;
    cam.scrollY = Phaser.Math.Clamp(cam.scrollY + hh, 0, N * TILE_H) - hh;
  }

  private fitCamera(initial: boolean): void {
    const cam = this.cameras.main;
    const { width, height } = this.scale;
    const center = initial ? cellToWorld(N / 2, N / 2) : { x: cam.scrollX + cam.width / 2, y: cam.scrollY + cam.height / 2 };
    cam.setSize(width, height);

    const fitZoom = Math.min(width / (N * TILE_W * 1.1), height / (N * TILE_H * 1.8));
    this.minZoom = fitZoom * 0.7;
    this.maxZoom = Math.max(fitZoom * 4, getDpr() * 3);
    cam.zoom = initial ? fitZoom : Phaser.Math.Clamp(cam.zoom, this.minZoom, this.maxZoom);
    cam.centerOn(center.x, center.y);
    this.clampScroll();
  }

  // ---------- Ввод ----------

  private onPointerDown(pointer: Phaser.Input.Pointer): void {
    if (this.pointers.size === 0 && this.ctx.ui.isOverUi(pointer.x, pointer.y)) return;
    if (this.pointers.size >= 2) return;
    this.pointers.set(pointer.id, { x: pointer.x, y: pointer.y });
    this.hover.clear();

    if (this.pointers.size === 1) {
      this.gesture = { startX: pointer.x, startY: pointer.y, moved: false, pinchDist: 0, pinchZoom: 1, pinchMid: { x: 0, y: 0 } };
    } else if (this.gesture) {
      const [a, b] = [...this.pointers.values()] as [Point, Point];
      this.gesture.moved = true;
      this.gesture.pinchDist = Math.max(1, Phaser.Math.Distance.Between(a.x, a.y, b.x, b.y));
      this.gesture.pinchZoom = this.cameras.main.zoom;
      this.gesture.pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }

  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    const last = this.pointers.get(pointer.id);
    if (!last || !this.gesture) {
      this.updateHover(pointer);
      return;
    }
    const g = this.gesture;

    if (this.pointers.size === 2) {
      last.x = pointer.x;
      last.y = pointer.y;
      const [a, b] = [...this.pointers.values()] as [Point, Point];
      const dist = Math.max(1, Phaser.Math.Distance.Between(a.x, a.y, b.x, b.y));
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.panBy(mid.x - g.pinchMid.x, mid.y - g.pinchMid.y);
      this.zoomAt(g.pinchZoom * (dist / g.pinchDist), mid.x, mid.y);
      g.pinchMid = mid;
      return;
    }

    if (!g.moved && Phaser.Math.Distance.Between(g.startX, g.startY, pointer.x, pointer.y) > TAP_SLOP * getDpr()) {
      g.moved = true;
    }
    if (g.moved) this.panBy(pointer.x - last.x, pointer.y - last.y);
    last.x = pointer.x;
    last.y = pointer.y;
  }

  private onPointerUp(pointer: Phaser.Input.Pointer): void {
    if (!this.pointers.delete(pointer.id)) return;
    const g = this.gesture;
    if (this.pointers.size === 0) {
      this.gesture = null;
      if (g && !g.moved) this.tryPlace(pointer.x, pointer.y);
    }
    // Если после щипка остался один палец, он продолжает панорамирование со своей текущей позиции.
  }

  private onWheel(pointer: Phaser.Input.Pointer, _over: unknown, _dx: number, dy: number): void {
    this.zoomAt(this.cameras.main.zoom * Math.exp(-dy * 0.0015), pointer.x, pointer.y);
  }

  /** Подсветка места под курсором мыши (на тач-экранах её нет). */
  private updateHover(pointer: Phaser.Input.Pointer): void {
    if (pointer.wasTouch || this.ctx.ui.isOverUi(pointer.x, pointer.y)) {
      this.hover.clear();
      return;
    }
    const world = this.screenToWorld(pointer.x, pointer.y);
    const cell = worldToCell(world.x, world.y);
    if (cell.col < 0 || cell.row < 0 || cell.col >= N || cell.row >= N) {
      this.hover.clear();
      return;
    }
    const { ui } = this.ctx;
    const { col, row } = this.anchorAt(ui.selected, world);
    const ok = canPlaceBuilding(this.buildings, ui.selected, col, row);
    this.drawFootprint(this.hover, ui.selected, col, row, ok ? 0xffffff : ui.palette.danger);
  }
}
