import Phaser from 'phaser';
import {
  BASE_GRID_SIZE,
  checkBuild,
  checkPlacement,
  footprintSize,
  isCollectReady,
  isProducer,
  levelConfig,
  PRODUCERS,
  type BuildingPlacement,
  type BuildingType,
  type PlacedBuilding,
} from '@forts/shared';
import { ApiError } from '../../api/ApiClient';
import { t } from '../../i18n';
import { buildingOutline, buildingRoofCenter, drawBuilding, pointInPolygon, polygon } from '../buildingView';
import { getGameContext, type GameContext } from '../context';
import { BuilderCrew } from '../builder/BuilderCrew';
import { BuilderAnimations, preloadBuilder } from '../builder/builderAnims';
import { createBuilderView, type BuilderView } from '../builder/BuilderView';
import { buildingBox, sortByDepth, type DepthBox } from '../depthSort';
import { getDpr } from '../display';
import { formatCountdown, formatNumber } from '../format';
import { cellToWorld, footprintCorners, TILE_H, TILE_W, worldToCell, type Point } from '../iso';
import { errorMessage, ruleMessage, type Message } from '../messages';
import { RESOURCE_COLORS, toCss } from '../theme';

const N = BASE_GRID_SIZE;
/** Сдвиг пальца (в CSS-пикселях), после которого касание считается перетаскиванием, а не тапом. */
const TAP_SLOP = 8;
/** При перетаскивании пальцем здание рисуется выше касания (CSS-пиксели), чтобы палец его не закрывал. */
const DRAG_TOUCH_LIFT = 56;
const TOP_DEPTH = Number.MAX_SAFE_INTEGER;
const OVERLAY_DEPTH = TOP_DEPTH - 2;
const FONT = 'system-ui, -apple-system, Roboto, sans-serif';
/** Радиус значка сбора и зоны тапа по нему, CSS-пиксели. */
const ICON_RADIUS = 12;
const ICON_LIFT = 26;

interface Gesture {
  startX: number;
  startY: number;
  /** Палец сдвинулся или был щипок — тап уже не засчитываем. */
  moved: boolean;
  pinchDist: number;
  pinchZoom: number;
  pinchMid: Point;
}

/**
 * Здание на поле. Таймер и значок сбора живут в мире над крышей, но
 * масштабируются обратно к зуму камеры — на экране всегда одного размера.
 */
interface BuildingView {
  building: PlacedBuilding;
  body: Phaser.GameObjects.Graphics;
  timer?: { box: Phaser.GameObjects.Container; text: Phaser.GameObjects.Text; bar: Phaser.GameObjects.Graphics };
  icon?: Phaser.GameObjects.Container;
}

export class WorldScene extends Phaser.Scene {
  private ctx!: GameContext;
  private grid!: Phaser.GameObjects.Graphics;
  /** Подсветка места под курсором или перетаскиваемым зданием. */
  private hover!: Phaser.GameObjects.Graphics;
  /** Полупрозрачное перетаскиваемое здание. */
  private ghost!: Phaser.GameObjects.Graphics;
  /** Рамка выбранного здания на земле. */
  private selection!: Phaser.GameObjects.Graphics;
  private views = new Map<number, BuildingView>();
  /** Строители — только картинка: куда идти, решают данные сервера. */
  private crew = new BuilderCrew();
  private builderViews: BuilderView[] = [];
  /** Здания, отправленные на сервер и ещё не подтверждённые. */
  private pending: BuildingPlacement[] = [];
  private synced = false;

  private pointers = new Map<number, Point>();
  private gesture: Gesture | null = null;
  private minZoom = 0.5;
  private maxZoom = 4;

  constructor() {
    super('world');
  }

  preload(): void {
    preloadBuilder(this);
  }

  create(): void {
    this.ctx = getGameContext();
    const { ui, base } = this.ctx;
    const builderAnims = BuilderAnimations.create(this);
    this.builderViews = this.crew.builders.map(() => createBuilderView(this, builderAnims));

    this.grid = this.add.graphics().setDepth(-1);
    this.selection = this.add.graphics().setDepth(0);
    this.hover = this.add.graphics().setDepth(TOP_DEPTH);
    this.ghost = this.add.graphics().setDepth(TOP_DEPTH).setAlpha(0.6);
    this.applyPalette();
    this.fitCamera(true);
    this.syncViews();

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
    const onUi = () => {
      this.clearGhost();
      this.updateSelection();
    };
    const onBase = () => this.syncViews();
    const onResize = () => this.fitCamera(false);
    ui.on('palette', onPalette);
    ui.on('change', onUi);
    base.on('change', onBase);
    this.scale.on(Phaser.Scale.Events.RESIZE, onResize);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      ui.off('palette', onPalette);
      ui.off('change', onUi);
      base.off('change', onBase);
      this.scale.off(Phaser.Scale.Events.RESIZE, onResize);
    });
  }

  /** Каждый кадр: строители, таймеры строек, значки сбора, размер надписей под зум. */
  update(time: number, delta: number): void {
    if (this.crew.update(delta)) this.updateDepths();
    this.crew.builders.forEach((b, i) => this.builderViews[i]!.update(b, time));

    const now = this.ctx.base.now();
    const scale = getDpr() / this.cameras.main.zoom;
    for (const view of this.views.values()) {
      const b = view.building;
      if (view.timer) {
        const { box, text, bar } = view.timer;
        const total = (levelConfig(b.type, b.level + 1)?.buildSeconds ?? 0) * 1000;
        const left = Math.max(0, (b.finishAt ?? now) - now);
        text.setText(formatCountdown(left));
        const progress = total > 0 ? 1 - left / total : 1;
        bar.clear().fillStyle(0x000000, 0.5).fillRect(-28, 0, 56, 4).fillStyle(this.ctx.ui.palette.valid, 1).fillRect(-28, 0, 56 * progress, 4);
        box.setScale(scale);
      }
      if (view.icon) {
        view.icon.setVisible(b.finishAt === null && isCollectReady(b, now) && this.ctx.ui.mode.kind === 'none');
        view.icon.setScale(scale);
      }
    }
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
    this.updateSelection();
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

  private updateSelection(): void {
    const { ui, base } = this.ctx;
    const id = ui.selectedId ?? (ui.mode.kind === 'move' ? ui.mode.id : null);
    const b = id === null ? undefined : base.get(id);
    if (b) this.drawFootprint(this.selection, b.type, b.x, b.y, ui.palette.accent);
    else this.selection.clear();
    for (const view of this.views.values()) {
      const moving = ui.mode.kind === 'move' && ui.mode.id === view.building.id;
      view.body.setAlpha(moving ? 0.35 : 1);
    }
  }

  // ---------- Здания ----------

  /** Пересоздаёт здания по состоянию из стора; новые появляются с анимацией. */
  private syncViews(): void {
    const known = new Set(this.views.keys());
    for (const view of this.views.values()) this.destroyView(view);
    this.views.clear();
    this.crew.sync(this.ctx.base.buildings);
    for (const b of this.ctx.base.buildings) {
      const view = this.addView(b);
      if (this.synced && !known.has(b.id)) {
        view.body.setAlpha(0).setY(-TILE_H);
        this.tweens.add({ targets: view.body, y: 0, alpha: 1, duration: 180, ease: 'Back.Out' });
      }
    }
    this.synced = true;
    this.updateDepths();
    this.updateSelection();
  }

  private addView(building: PlacedBuilding): BuildingView {
    const body = this.add.graphics();
    drawBuilding(body, building.type, building.x, building.y, building.level === 0);
    const view: BuildingView = { building, body };
    const roof = buildingRoofCenter(building.type, building.x, building.y);

    if (building.finishAt !== null) {
      const text = this.label(0, -12, '', 12, '#ffffff').setOrigin(0.5);
      const bg = this.add.graphics().fillStyle(0x000000, 0.6).fillRoundedRect(-30, -22, 60, 20, 6);
      const bar = this.add.graphics();
      const box = this.add.container(roof.x, roof.y - 6, [bg, text, bar]).setDepth(OVERLAY_DEPTH);
      view.timer = { box, text, bar };
    }

    if (isProducer(building.type)) {
      const color = RESOURCE_COLORS[PRODUCERS[building.type].resource];
      const bubble = this.add.graphics();
      bubble.fillStyle(0xffffff, 1).fillCircle(0, -ICON_LIFT, ICON_RADIUS + 2);
      bubble.fillTriangle(-6, -ICON_LIFT + 10, 6, -ICON_LIFT + 10, 0, -ICON_LIFT + 18);
      bubble.fillStyle(color, 1).fillCircle(0, -ICON_LIFT, ICON_RADIUS - 1);
      bubble.lineStyle(2, 0x000000, 0.25).strokeCircle(0, -ICON_LIFT, ICON_RADIUS - 5);
      const icon = this.add.container(roof.x, roof.y, [bubble]).setDepth(OVERLAY_DEPTH).setVisible(false);
      this.tweens.add({ targets: bubble, y: -4, duration: 600, yoyo: true, repeat: -1, ease: 'Sine.InOut' });
      view.icon = icon;
    }

    this.views.set(building.id, view);
    return view;
  }

  private destroyView(view: BuildingView): void {
    if (view.icon) this.tweens.killTweensOf(view.icon.list);
    view.body.destroy();
    view.timer?.box.destroy();
    view.icon?.destroy();
  }

  /** Здания и строители в одном порядке: строитель — квадрат клетки под ногами. */
  private updateDepths(): void {
    const items: { box: DepthBox; obj: Phaser.GameObjects.Components.Depth }[] = [];
    for (const b of this.ctx.base.buildings) {
      const view = this.views.get(b.id);
      if (view) items.push({ box: buildingBox(b), obj: view.body });
    }
    this.crew.builders.forEach((b, i) => items.push({ box: b.depthBox(), obj: this.builderViews[i]!.obj }));
    sortByDepth(items, (item) => item.box).forEach((item, i) => item.obj.setDepth(i + 1));
  }

  private label(x: number, y: number, text: string, size: number, color: string): Phaser.GameObjects.Text {
    return this.add.text(x, y, text, { fontFamily: FONT, fontSize: `${size}px`, fontStyle: 'bold', color, resolution: getDpr() });
  }

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

  /** Занятые места: подтверждённые здания и ждущие ответа сервера, кроме переносимого. */
  private occupied(exceptId?: number): BuildingPlacement[] {
    return [...this.ctx.base.buildings.filter((b) => b.id !== exceptId), ...this.pending];
  }

  /** Здание под точкой экрана: сначала значки сбора, затем силуэты — от ближних к дальним. */
  private hitTest(screen: Point, world: Point): { id: number; icon: boolean } | undefined {
    const iconR = (ICON_RADIUS + 8) * getDpr();
    for (const view of this.views.values()) {
      if (!view.icon?.visible) continue;
      const pos = this.worldToScreen(view.icon.x, view.icon.y);
      const cy = pos.y - ICON_LIFT * getDpr();
      if (Phaser.Math.Distance.Between(screen.x, screen.y, pos.x, cy) <= iconR) return { id: view.building.id, icon: true };
    }
    const ordered = sortByDepth(this.ctx.base.buildings, buildingBox).reverse();
    for (const b of ordered) {
      if (pointInPolygon(world, buildingOutline(b.type, b.x, b.y))) return { id: b.id, icon: false };
    }
    return undefined;
  }

  private onTap(pointer: Phaser.Input.Pointer): void {
    const { ui, base, platform } = this.ctx;
    const world = this.screenToWorld(pointer.x, pointer.y);
    if (ui.mode.kind === 'place') {
      void this.place(ui.mode.type, world);
      return;
    }
    if (ui.mode.kind === 'move') {
      void this.moveTo(ui.mode.id, world);
      return;
    }
    const hit = this.hitTest(pointer, world);
    if (!hit) {
      ui.select(null);
      if (ui.menuOpen) ui.setMenuOpen(false);
      return;
    }
    const b = base.get(hit.id)!;
    // Тап по шахте/ферме со значком — сразу сбор, как в привычных стратегиях.
    if (hit.icon || (isCollectReady(b, base.now()) && b.finishAt === null)) {
      void this.collect(hit.id);
      return;
    }
    platform.haptic('selection');
    ui.select(hit.id);
  }

  /**
   * Ставит здание: сначала проверки теми же функциями из shared, затем
   * запрос к серверу. Здание появляется, только если сервер его подтвердил.
   */
  private async place(type: BuildingType, world: Point): Promise<void> {
    if (!this.isOnField(world)) return;
    const { platform, base, ui } = this.ctx;
    const { x, y } = this.anchorAt(type, world);

    const spot = checkPlacement(this.occupied(), type, x, y);
    if (!spot.ok) return this.reject(type, x, y, world, errorMessage(spot.reason));
    const rules = checkBuild(base.resources, base.buildings, type, base.now());
    if (!rules.ok) return this.reject(type, x, y, world, ruleMessage(rules));

    const placement: BuildingPlacement = { type, x, y };
    this.pending.push(placement);
    const view = this.add.graphics().setDepth(TOP_DEPTH - 1).setAlpha(0.5);
    drawBuilding(view, type, x, y);
    platform.haptic('light');

    try {
      const res = await base.place(type, x, y);
      if (!res) return;
      // Бот пока не может писать — после постройки предложить уведомления о её готовности.
      if (res.player.askWriteAccess && platform.canRequestWriteAccess()) ui.offerNotifications();
      // Мгновенные постройки (стены) удобно ставить подряд — режим остаётся.
      if (rules.level.buildSeconds > 0 && ui.mode.kind === 'place') ui.setMode({ kind: 'none' });
    } catch (err) {
      console.warn('Building rejected', err);
      this.reject(type, x, y, world, errorMessage(err instanceof ApiError ? err.code : 'network'));
    } finally {
      view.destroy();
      this.pending.splice(this.pending.indexOf(placement), 1);
    }
  }

  private async moveTo(id: number, world: Point): Promise<void> {
    const { base, ui, platform } = this.ctx;
    const b = base.get(id);
    if (!b || !this.isOnField(world)) return;
    const { x, y } = this.anchorAt(b.type, world);
    const spot = checkPlacement(this.occupied(id), b.type, x, y);
    if (!spot.ok) return this.reject(b.type, x, y, world, errorMessage(spot.reason));
    try {
      const res = await base.move(id, x, y);
      if (!res) return;
      platform.haptic('light');
      ui.select(id);
    } catch (err) {
      console.warn('Move rejected', err);
      this.reject(b.type, x, y, world, errorMessage(err instanceof ApiError ? err.code : 'network'));
    }
  }

  private async collect(id: number): Promise<void> {
    const { base, ui, platform } = this.ctx;
    const b = base.get(id);
    if (!b) return;
    try {
      const res = await base.collect(id);
      if (!res) return;
      platform.haptic('light');
      this.floatText(buildingRoofCenter(b.type, b.x, b.y), `+${formatNumber(res.collected.amount)}`, RESOURCE_COLORS[res.collected.resource]);
    } catch (err) {
      platform.haptic('warning');
      const msg = errorMessage(err instanceof ApiError ? err.code : 'network');
      ui.toast(msg.key, msg.params);
    }
  }

  /** «+123» над зданием: всплывает и тает. */
  private floatText(at: Point, text: string, color: number): void {
    const scale = getDpr() / this.cameras.main.zoom;
    const label = this.label(at.x, at.y - ICON_LIFT * scale, text, 18, toCss(color))
      .setOrigin(0.5, 1)
      .setStroke('#000000', 4)
      .setScale(scale)
      .setDepth(TOP_DEPTH);
    this.tweens.add({
      targets: label,
      y: label.y - 36 * scale,
      alpha: { from: 1, to: 0 },
      duration: 900,
      ease: 'Cubic.Out',
      onComplete: () => label.destroy(),
    });
  }

  /** Красный след на месте и короткое сообщение, почему нельзя. */
  private reject(type: BuildingType, x: number, y: number, at: Point, message: Message): void {
    this.ctx.platform.haptic('error');
    const g = this.add.graphics().setDepth(TOP_DEPTH);
    this.drawFootprint(g, type, x, y, this.ctx.ui.palette.danger);
    const label = this.add
      .text(at.x, at.y - TILE_H, t(message.key, message.params), {
        fontFamily: FONT,
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

  private worldToScreen(x: number, y: number): Point {
    const cam = this.cameras.main;
    const hw = cam.width / 2;
    const hh = cam.height / 2;
    return { x: (x - cam.scrollX - hw) * cam.zoom + hw + cam.x, y: (y - cam.scrollY - hh) * cam.zoom + hh + cam.y };
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
    const { ui } = this.ctx;
    // Здание вытащили из меню на поле — меню больше не нужно, поле должно быть видно.
    if (ui.drag?.pointerId === pointer.id && ui.menuOpen && !ui.isOverUi(pointer.x, pointer.y)) ui.setMenuOpen(false);

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
      // Отпустили над меню — это был тап по строке: дальше здание ставится тапом по полю.
      if (ui.isOverUi(pointer.x, pointer.y)) ui.setMode({ kind: 'place', type });
      else void this.place(type, this.dragWorldPoint(pointer));
      return;
    }

    if (!this.pointers.delete(pointer.id)) return;
    const g = this.gesture;
    if (this.pointers.size === 0) {
      this.gesture = null;
      if (g && !g.moved) this.onTap(pointer);
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
   * проверка, что на сервере). При перетаскивании из меню рисуется и само
   * здание; в режимах постановки и переноса — под курсором мыши.
   */
  private updateGhost(pointer: Phaser.Input.Pointer): void {
    const { ui, base } = this.ctx;
    const dragging = ui.drag?.pointerId === pointer.id;
    const { mode } = ui;
    const moving = mode.kind === 'move' ? base.get(mode.id) : undefined;
    const type = dragging ? ui.drag!.type : mode.kind === 'place' ? mode.type : moving?.type;
    if (!type || (!dragging && (pointer.wasTouch || ui.drag)) || ui.isOverUi(pointer.x, pointer.y)) {
      this.clearGhost();
      return;
    }
    const world = dragging ? this.dragWorldPoint(pointer) : this.screenToWorld(pointer.x, pointer.y);
    if (!this.isOnField(world)) {
      this.clearGhost();
      return;
    }
    const { x, y } = this.anchorAt(type, world);
    const ok = checkPlacement(this.occupied(moving?.id), type, x, y).ok;
    this.drawFootprint(this.hover, type, x, y, ok ? ui.palette.valid : ui.palette.danger);
    drawBuilding(this.ghost, type, x, y);
  }
}

