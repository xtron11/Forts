import Phaser from 'phaser';
import {
  BASE_GRID_SIZE,
  checkPlacement,
  footprintSize,
  type BuildingPlacement,
  type BuildingType,
  type PlacedBuilding,
} from '@forts/shared';
import { ApiError } from '../../api/ApiClient';
import { t, type TextKey } from '../../i18n';
import { drawBuilding, polygon } from '../buildingView';
import { getGameContext, type GameContext } from '../context';
import { sortByDepth } from '../depthSort';
import { getDpr } from '../display';
import { cellToWorld, footprintCorners, TILE_H, TILE_W, worldToCell, type Point } from '../iso';

const N = BASE_GRID_SIZE;
/** Сдвиг пальца (в CSS-пикселях), после которого касание считается перетаскиванием, а не тапом. */
const TAP_SLOP = 8;
/** При перетаскивании пальцем здание рисуется выше касания (CSS-пиксели), чтобы палец его не закрывал. */
const DRAG_TOUCH_LIFT = 56;
const TOP_DEPTH = Number.MAX_SAFE_INTEGER;

/** Текст отказа по коду ошибки проверки или сервера. */
function rejectionText(code: string): TextKey {
  switch (code) {
    case 'overlap':
      return 'build.error.overlap';
    case 'out_of_bounds':
      return 'build.error.outOfBounds';
    case 'limit_reached':
      return 'build.error.limit';
    case 'network':
      return 'error.network';
    default:
      return 'build.cannotPlace';
  }
}

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
  /** Подсветка места под курсором или перетаскиваемым зданием. */
  private hover!: Phaser.GameObjects.Graphics;
  /** Полупрозрачное перетаскиваемое здание. */
  private ghost!: Phaser.GameObjects.Graphics;
  private views = new Map<number, Phaser.GameObjects.Graphics>();
  /** Здания, отправленные на сервер и ещё не подтверждённые. */
  private pending: BuildingPlacement[] = [];

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
    this.hover = this.add.graphics().setDepth(TOP_DEPTH);
    this.ghost = this.add.graphics().setDepth(TOP_DEPTH).setAlpha(0.6);
    this.applyPalette();
    this.fitCamera(true);
    for (const b of this.ctx.base.buildings) this.addView(b);
    this.updateDepths();

    // Все сцены получают ввод: мир сам игнорирует касания по интерфейсу,
    // зато никогда не теряет pointerup, если палец отпустили над кнопкой.
    this.input.setGlobalTopOnly(false);
    this.input.addPointer(1);
    this.input.on('pointerdown', this.onPointerDown, this);
    this.input.on('pointermove', this.onPointerMove, this);
    this.input.on('pointerup', this.onPointerUp, this);
    this.input.on('pointerupoutside', this.onPointerUp, this);
    this.input.on('gameout', () => this.clearGhost());
    this.input.on('wheel', this.onWheel, this);

    const onPalette = () => this.applyPalette();
    const onSelect = () => this.clearGhost();
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
  private anchorAt(type: BuildingType, world: Point): { x: number; y: number } {
    const cell = worldToCell(world.x, world.y);
    const offset = Math.floor((footprintSize(type) - 1) / 2);
    return { x: cell.col - offset, y: cell.row - offset };
  }

  private isOnField(world: Point): boolean {
    const cell = worldToCell(world.x, world.y);
    return cell.col >= 0 && cell.row >= 0 && cell.col < N && cell.row < N;
  }

  /** Подтверждённые здания и те, что ждут ответа сервера, — чтобы не ставить друг на друга. */
  private occupied(): BuildingPlacement[] {
    return [...this.ctx.base.buildings, ...this.pending];
  }

  /**
   * Ставит здание: сначала проверка той же функцией из shared, затем
   * запрос к серверу. Здание остаётся, только если сервер его подтвердил.
   */
  private async place(type: BuildingType, world: Point): Promise<void> {
    if (!this.isOnField(world)) return;
    const { platform, api, base } = this.ctx;
    const { x, y } = this.anchorAt(type, world);

    const check = checkPlacement(this.occupied(), type, x, y);
    if (!check.ok) {
      this.reject(type, x, y, world, rejectionText(check.reason));
      return;
    }

    const placement: BuildingPlacement = { type, x, y };
    this.pending.push(placement);
    const view = this.add.graphics().setDepth(TOP_DEPTH - 1).setAlpha(0.5);
    drawBuilding(view, type, x, y);
    platform.haptic('light');

    try {
      const { building } = await api.placeBuilding({ type, x, y });
      base.buildings.push(building);
      view.destroy();
      const placed = this.addView(building);
      this.updateDepths();
      placed.setAlpha(0).setY(-TILE_H);
      this.tweens.add({ targets: placed, y: 0, alpha: 1, duration: 180, ease: 'Back.Out' });
    } catch (err) {
      view.destroy();
      console.warn('Building rejected', err);
      this.reject(type, x, y, world, rejectionText(err instanceof ApiError ? err.code : 'network'));
    } finally {
      this.pending.splice(this.pending.indexOf(placement), 1);
    }
  }

  private addView(building: PlacedBuilding): Phaser.GameObjects.Graphics {
    const view = this.add.graphics();
    drawBuilding(view, building.type, building.x, building.y);
    this.views.set(building.id, view);
    return view;
  }

  private updateDepths(): void {
    sortByDepth(this.ctx.base.buildings).forEach((b, i) => this.views.get(b.id)?.setDepth(i + 1));
  }

  /** Красный след на месте и короткое сообщение, почему нельзя. */
  private reject(type: BuildingType, x: number, y: number, at: Point, text: TextKey): void {
    this.ctx.platform.haptic('error');
    const g = this.add.graphics().setDepth(TOP_DEPTH);
    this.drawFootprint(g, type, x, y, this.ctx.ui.palette.danger);
    const label = this.add
      .text(at.x, at.y - TILE_H, t(text), {
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
      .setDepth(TOP_DEPTH);
    this.tweens.add({
      targets: [g, label],
      alpha: 0,
      delay: 900,
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
      this.updateGhost(pointer);
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
    const { ui } = this.ctx;
    if (ui.drag?.pointerId === pointer.id) {
      const { type } = ui.drag;
      ui.endDrag();
      this.clearGhost();
      // Отпустили над панелью — это был просто выбор здания.
      if (!ui.isOverUi(pointer.x, pointer.y)) void this.place(type, this.dragWorldPoint(pointer));
      return;
    }

    if (!this.pointers.delete(pointer.id)) return;
    const g = this.gesture;
    if (this.pointers.size === 0) {
      this.gesture = null;
      if (g && !g.moved) void this.place(ui.selected, this.screenToWorld(pointer.x, pointer.y));
    }
    // Если после щипка остался один палец, он продолжает панорамирование со своей текущей позиции.
  }

  private onWheel(pointer: Phaser.Input.Pointer, _over: unknown, _dx: number, dy: number): void {
    this.zoomAt(this.cameras.main.zoom * Math.exp(-dy * 0.0015), pointer.x, pointer.y);
  }

  /** Точка мира, куда ставится перетаскиваемое здание. */
  private dragWorldPoint(pointer: Phaser.Input.Pointer): Point {
    const lift = pointer.wasTouch ? DRAG_TOUCH_LIFT * getDpr() : 0;
    return this.screenToWorld(pointer.x, pointer.y - lift);
  }

  private clearGhost(): void {
    this.hover.clear();
    this.ghost.clear();
  }

  /**
   * Подсветка места: зелёная — можно поставить, красная — нельзя (та же
   * проверка, что на сервере). Во время перетаскивания здания с панели
   * рисуется и само здание; без перетаскивания — только для мыши.
   */
  private updateGhost(pointer: Phaser.Input.Pointer): void {
    const { ui } = this.ctx;
    const dragging = ui.drag?.pointerId === pointer.id;
    if ((!dragging && (pointer.wasTouch || ui.drag)) || ui.isOverUi(pointer.x, pointer.y)) {
      this.clearGhost();
      return;
    }
    const world = dragging ? this.dragWorldPoint(pointer) : this.screenToWorld(pointer.x, pointer.y);
    if (!this.isOnField(world)) {
      this.clearGhost();
      return;
    }
    const type = ui.drag?.type ?? ui.selected;
    const { x, y } = this.anchorAt(type, world);
    const ok = checkPlacement(this.occupied(), type, x, y).ok;
    this.drawFootprint(this.hover, type, x, y, ok ? ui.palette.valid : ui.palette.danger);
    if (dragging) drawBuilding(this.ghost, type, x, y);
    else this.ghost.clear();
  }
}
