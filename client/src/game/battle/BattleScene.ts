import Phaser from 'phaser';
import {
  BATTLE_MARGIN,
  BUILDINGS,
  canDeployAt,
  TICKS_PER_SECOND,
  TILE,
  type BattleBase,
  type BattleBuilding,
  type BattleEvent,
  type BattleState,
  type BattleUnitState,
} from '@forts/shared';
import { buildingRoofCenter, drawBuilding, polygon } from '../buildingView';
import { directionOf, type Direction } from '../builder/grid';
import { getGameContext, type GameContext } from '../context';
import { getDpr } from '../display';
import { cellToWorld, footprintCorners, TILE_H, TILE_W, worldToCell, type Point } from '../iso';
import { shade } from '../theme';
import type { BattleController, DeployRejection } from './BattleController';
import { BATTLE_BOTTOM_BAR, BATTLE_PAD, BATTLE_TOP_BAR } from './layout';
import { naturalRunSpeed } from '../units/art';
import { createUnitView, isOnCamera, type UnitView } from '../units/UnitView';

const MS_PER_TICK = 1000 / TICKS_PER_SECOND;
/** Не больше стольких тиков за кадр — после долгой паузы бой не «проматывается». */
const MAX_STEPS_PER_FRAME = 5;
/** Зажатый палец высаживает юнит раз в столько тиков. */
const HOLD_EVERY_TICKS = 2;
const TOP_DEPTH = 1_000_000;
const FONT = 'system-ui, -apple-system, Roboto, sans-serif';
/** Полоски и вспышки увеличиваются так, чтобы предмет размера EFFECT_SIZE был не мельче MIN_EFFECT_CSS CSS-пикселей. */
const EFFECT_SIZE = 11;
const MIN_EFFECT_CSS = 10;
/** Юнит на экране не ниже стольких CSS-пикселей, как бы ни было уменьшено поле. */
const MIN_UNIT_CSS = 14;
/** Доля цикла attack, на которой виден удар (оружие касается цели). */
const STRIKE_AT = 0.5;
/** Насколько можно приблизить поле относительно «всё поле на экране». */
const MAX_ZOOM_FACTOR = 3;
/** Шаг визуального разброса толпы, единицы длины боя (клетка = TILE). */
const CROWD_SPREAD = TILE / 20;

interface BuildingView {
  building: BattleBuilding;
  body: Phaser.GameObjects.Graphics;
  destroyed: boolean;
}

interface BattleUnit {
  view: UnitView;
  /** Что играет сейчас: idle, run или attack. */
  anim: string;
  dir: Direction;
  dying: boolean;
}

/**
 * Поле боя. Бой считается тиками тем же движком, что на сервере
 * (BattleController.step), а рисуется каждый кадр: положение юнитов
 * интерполируется между предыдущим и текущим тиком.
 */
export class BattleScene extends Phaser.Scene {
  private ctx!: GameContext;
  private ctrl!: BattleController;
  private ground!: Phaser.GameObjects.Graphics;
  /** Красная зона, куда нельзя высаживать; видна при неудачной попытке. */
  private forbidden!: Phaser.GameObjects.Graphics;
  private bars!: Phaser.GameObjects.Graphics;
  private shownBase: BattleBase | null = null;
  private buildings = new Map<number, BuildingView>();
  private units = new Map<number, BattleUnit>();
  /** Положение юнитов до последнего тика — для интерполяции. */
  private prev = new Map<number, { x: number; y: number }>();
  private acc = 0;
  private logIndex = 0;
  private hold: { pointerId: number; x: number; y: number; lastTick: number } | null = null;
  /** Пальцы на экране — для щипка (двумя пальцами: масштаб и сдвиг поля). */
  private pointers = new Map<number, Point>();
  private pinch: { dist: number; zoom: number; mid: Point } | null = null;
  private fitZoom = 1;
  private home: Point = { x: 0, y: 0 };
  /** Во сколько раз увеличены юниты и полоски, чтобы оставаться различимыми. */
  private k = 1;

  constructor() {
    super('battle');
  }

  create(): void {
    this.ctx = getGameContext();
    this.ctrl = this.ctx.battle!;
    this.buildings = new Map();
    this.units = new Map();
    this.prev = new Map();
    this.shownBase = null;
    this.acc = 0;
    this.logIndex = 0;
    this.hold = null;
    this.pointers = new Map();
    this.pinch = null;

    this.ground = this.add.graphics().setDepth(-3);
    this.forbidden = this.add.graphics().setDepth(-2).setAlpha(0);
    this.bars = this.add.graphics().setDepth(TOP_DEPTH);
    this.cameras.main.setBackgroundColor(this.ctx.ui.palette.background);

    const onChange = () => this.syncBase();
    const onResize = () => this.fitCamera();
    this.ctrl.on('change', onChange);
    this.scale.on(Phaser.Scale.Events.RESIZE, onResize);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.ctrl.off('change', onChange);
      this.scale.off(Phaser.Scale.Events.RESIZE, onResize);
    });

    this.input.on('pointerdown', this.onPointerDown, this);
    this.input.on('pointermove', this.onPointerMove, this);
    this.input.on('pointerup', this.onPointerUp, this);
    this.input.on('pointerupoutside', this.onPointerUp, this);
    this.input.on('wheel', (pointer: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) =>
      this.zoomAt(this.cameras.main.zoom * Math.exp(-dy * 0.0015), pointer.x, pointer.y),
    );

    this.fitCamera();
    this.syncBase();
  }

  update(_time: number, delta: number): void {
    const sim = this.ctrl.sim;
    const running = this.ctrl.phase.kind === 'battle' && sim && !sim.finished;
    if (running) {
      this.acc += delta;
      let steps = 0;
      while (this.acc >= MS_PER_TICK && steps < MAX_STEPS_PER_FRAME) {
        this.rememberPositions(sim);
        this.ctrl.step();
        this.playEvents(sim);
        this.acc -= MS_PER_TICK;
        steps++;
        if (this.hold && sim.tick - this.hold.lastTick >= HOLD_EVERY_TICKS) this.holdDeploy();
      }
      if (steps === MAX_STEPS_PER_FRAME) this.acc = Math.min(this.acc, MS_PER_TICK);
    }
    if (sim && this.shownBase) this.render(sim, running ? Math.min(1, this.acc / MS_PER_TICK) : 1, !!running);
  }

  // ---------- Поле и здания ----------

  /** База сменилась (новая цель) — перерисовать поле и здания. */
  private syncBase(): void {
    const base = this.ctrl.base;
    if (!base || base === this.shownBase) return;
    this.shownBase = base;
    for (const v of this.buildings.values()) v.body.destroy();
    this.buildings.clear();
    this.drawGround(base);
    for (const b of base.buildings) {
      const body = this.add.graphics();
      drawBuilding(body, b.type, b.x, b.y);
      body.setDepth(this.depthOfBuilding(b));
      this.buildings.set(b.id, { building: b, body, destroyed: false });
    }
    // Юниты прошлой цели не нужны.
    for (const v of this.units.values()) this.destroyUnit(v);
    this.units.clear();
    this.fitCamera();
  }

  private depthOfBuilding(b: BattleBuilding): number {
    // Лагерь — плоская площадка: под юнитами и развалинами.
    if (b.type === 'camp') return -1.5;
    const s = BUILDINGS[b.type].size;
    return cellToWorld(b.x + s / 2, b.y + s / 2).y;
  }

  private drawGround(base: BattleBase): void {
    const p = this.ctx.ui.palette;
    const lo = -BATTLE_MARGIN;
    const hi = base.gridSize + BATTLE_MARGIN;
    const g = this.ground.clear();
    for (let row = lo; row < hi; row++) {
      for (let col = lo; col < hi; col++) {
        const inside = col >= 0 && row >= 0 && col < base.gridSize && row < base.gridSize;
        const color = (col + row) % 2 === 0 ? p.tileA : p.tileB;
        g.fillStyle(inside ? color : shade(color, 0.18), 1);
        polygon(g, footprintCorners(col, row, 1, 1));
        g.fillPath();
      }
    }
    g.lineStyle(2, p.tileLine, 0.8);
    polygon(g, footprintCorners(0, 0, base.gridSize, base.gridSize));
    g.strokePath();

    const f = this.forbidden.clear();
    f.fillStyle(p.danger, 1);
    for (let row = lo; row < hi; row++) {
      for (let col = lo; col < hi; col++) {
        if (canDeployAt(base, col, row) !== 'forbidden_zone') continue;
        polygon(f, footprintCorners(col, row, 1, 1));
        f.fillPath();
      }
    }
  }

  // ---------- Юниты и эффекты ----------

  private rememberPositions(sim: BattleState): void {
    for (const u of sim.units) if (u.spawned) this.prev.set(u.id, { x: u.x, y: u.y });
  }

  private unitPoint(u: BattleUnitState, alpha: number): Point {
    const before = this.prev.get(u.id) ?? u;
    // Юниты одной клетки идут одним путём; небольшой сдвиг по номеру — только
    // на экране, чтобы толпа не сливалась в одну точку.
    const jx = (((u.id * 7919) % 9) - 4) * CROWD_SPREAD;
    const jy = (((u.id * 104729) % 9) - 4) * CROWD_SPREAD;
    const x = before.x + (u.x - before.x) * alpha + jx;
    const y = before.y + (u.y - before.y) * alpha + jy;
    return cellToWorld(x / TILE, y / TILE);
  }

  private render(sim: BattleState, alpha: number, running: boolean): void {
    const zoom = this.cameras.main.zoom;
    this.k = Math.max(1, (MIN_EFFECT_CSS * getDpr()) / (zoom * EFFECT_SIZE));
    const k = this.k;
    const bars = this.bars.clear();
    for (const b of sim.buildings) {
      const view = this.buildings.get(b.id);
      if (!view) continue;
      if (!b.alive && !view.destroyed) this.collapse(view);
      if (b.alive && b.hp < b.maxHp) {
        const roof = buildingRoofCenter(view.building.type, view.building.x, view.building.y);
        this.hpBar(bars, roof.x, roof.y - 8 * k, 30 * Math.min(k, 1.6), b.hp / b.maxHp, 0x43a047);
      }
    }
    for (const u of sim.units) {
      if (!u.spawned) continue;
      let unit = this.units.get(u.id);
      if (!unit) {
        if (!u.alive) continue;
        unit = { view: createUnitView(this, u.troop), anim: '', dir: 's', dying: false };
        this.units.set(u.id, unit);
      }
      const at = this.unitPoint(u, alpha);
      // Юнит не мельче MIN_UNIT_CSS на экране — при сильном отдалении увеличивается.
      const ku = Math.max(1, (MIN_UNIT_CSS * getDpr()) / (zoom * unit.view.height));
      // Глубина — по Y ног.
      unit.view.setPosition(at.x, at.y);
      unit.view.setDepth(at.y);
      if (!unit.dying) unit.view.setSize(ku);
      if (!u.alive && !unit.dying) this.killUnit(unit);
      else if (u.alive) this.animateUnit(sim, u, unit, at, running);
      if (u.alive && u.hp < u.stats.hp) this.hpBar(bars, at.x, at.y - unit.view.height * ku - 5 * k, 14 * k, u.hp / u.stats.hp, 0xfdd835);
    }
  }

  private hpBar(g: Phaser.GameObjects.Graphics, cx: number, y: number, w: number, ratio: number, color: number): void {
    const h = 3 * this.k;
    const b = Math.max(1, this.k * 0.7);
    g.fillStyle(0x000000, 0.55).fillRect(cx - w / 2 - b, y - b, w + 2 * b, h + 2 * b);
    g.fillStyle(ratio > 0.35 ? color : 0xe53935, 1).fillRect(cx - w / 2, y, w * Math.max(0, ratio), h);
  }

  /**
   * Анимация по состоянию движка (сам бой не меняется): сдвинулся за тик —
   * run по направлению движения; стоит у живой цели — attack лицом к ней;
   * иначе idle. За экраном анимация на паузе.
   */
  private animateUnit(sim: BattleState, u: BattleUnitState, unit: BattleUnit, at: Point, running: boolean): void {
    const onScreen = isOnCamera(this.cameras.main, at.x, at.y, TILE_W);
    unit.view.setPaused(!onScreen);
    if (!onScreen) return;
    const prev = this.prev.get(u.id);
    const moving = running && prev !== undefined && (prev.x !== u.x || prev.y !== u.y);
    const struck = this.struckBuilding(sim, u);
    if (moving) {
      unit.dir = directionOf(u.x - prev.x, u.y - prev.y);
      const speed = (u.stats.speed * TICKS_PER_SECOND) / TILE;
      this.playUnit(unit, 'run', { timeScale: speed / naturalRunSpeed(this, u.troop) });
    } else if (running && struck) {
      unit.dir = directionOf(struck.centerX - u.x, struck.centerY - u.y);
      const attackMs = u.stats.attackTicks * MS_PER_TICK;
      const cycle = unit.view.cycleMs('attack');
      // Цикл attack длится ровно столько, сколько между ударами; начинаем так,
      // чтобы новый цикл начался с ближайшим ударом движка.
      this.playUnit(unit, 'attack', { timeScale: cycle > 0 ? cycle / attackMs : 1, start: 1 - u.cooldown / u.stats.attackTicks });
    } else {
      this.playUnit(unit, 'idle');
    }
  }

  private playUnit(unit: BattleUnit, anim: string, opts: { timeScale?: number; start?: number } = {}): void {
    unit.view.play(anim, unit.dir, opts);
    unit.anim = anim;
  }

  /** Здание, которое юнит бьёт (или вот-вот ударит): сломать преграду на пути, иначе цель. */
  private struckBuilding(sim: BattleState, u: BattleUnitState) {
    const blocker = u.blocker >= 0 ? sim.buildings[u.blocker] : undefined;
    if (blocker?.alive) return blocker;
    const target = u.target >= 0 ? sim.buildings[u.target] : undefined;
    return target?.alive ? target : undefined;
  }

  private killUnit(unit: BattleUnit): void {
    unit.dying = true;
    unit.view.die(unit.dir, () => unit.view.destroy());
  }

  private destroyUnit(unit: BattleUnit): void {
    unit.view.destroy();
  }

  /** Здание разрушено: коробка исчезает, остаются развалины и облако пыли. */
  private collapse(view: BuildingView): void {
    view.destroyed = true;
    const { type, x, y } = view.building;
    const size = BUILDINGS[type].size;
    const rubble = this.add.graphics().setDepth(-1);
    const color = BUILDINGS[type].color;
    rubble.fillStyle(shade(color, -0.55), 0.85);
    polygon(rubble, footprintCorners(x + 0.1, y + 0.1, size - 0.2, size - 0.2));
    rubble.fillPath();
    const c = cellToWorld(x + size / 2, y + size / 2);
    rubble.fillStyle(shade(color, -0.25), 1);
    for (let i = 0; i < 3 + size * 2; i++) {
      const a = (i * 2.4) % (Math.PI * 2);
      const d = (i % 3) * 5 * size;
      rubble.fillCircle(c.x + Math.cos(a) * d, c.y + Math.sin(a) * d * 0.5, 2 + (i % 2) * 2);
    }
    this.tweens.add({ targets: view.body, alpha: 0, duration: 250, onComplete: () => view.body.setVisible(false) });
    const puff = this.add.circle(c.x, c.y - 10, 8 * size, 0xbdbdbd, 0.7).setDepth(TOP_DEPTH - 1);
    this.tweens.add({ targets: puff, scale: 1.8, alpha: 0, duration: 500, ease: 'Cubic.Out', onComplete: () => puff.destroy() });
  }

  /** Снаряды и вспышки по событиям последнего тика. */
  private playEvents(sim: BattleState): void {
    const log = sim.log ?? [];
    for (; this.logIndex < log.length; this.logIndex++) this.playEvent(sim, log[this.logIndex]!);
  }

  private playEvent(sim: BattleState, e: BattleEvent): void {
    const buildingOf = (id: number) => this.buildings.get(id)?.building;
    switch (e.kind) {
      case 'shot': {
        const tower = buildingOf(e.building);
        const u = sim.units[e.unit];
        if (!tower || !u) return;
        const from = buildingRoofCenter(tower.type, tower.x, tower.y);
        const to = this.unitPoint(u, 1);
        this.projectile(from, { x: to.x, y: to.y - 6 * this.k }, 0xffca28, 3.5, 140);
        break;
      }
      case 'hit': {
        const u = sim.units[e.unit];
        const target = buildingOf(e.building);
        if (!u || !target) return;
        const unit = this.units.get(u.id);
        const show = () => this.showHit(u, target, e.damage);
        if (!unit || unit.view.cycleMs('attack') === 0) {
          show();
          break;
        }
        // Есть анимация удара: урон уже нанесён движком, а виден — на середине
        // замаха. Цикл attack начинается заново с каждым ударом движка.
        if (unit.anim === 'attack') unit.view.setProgress(0);
        this.time.delayedCall(u.stats.attackTicks * MS_PER_TICK * STRIKE_AT, () => {
          if (!unit.dying) show();
        });
        break;
      }
      case 'deploy': {
        const at = cellToWorld(e.x + 0.5, e.y + 0.5);
        const ring = this.add.ellipse(at.x, at.y, TILE_W * 0.6, TILE_H * 0.6).setStrokeStyle(2, 0xffffff, 0.9).setDepth(-1);
        this.tweens.add({ targets: ring, scale: 1.6, alpha: 0, duration: 400, onComplete: () => ring.destroy() });
        break;
      }
      default:
        break;
    }
  }

  /** Видимый удар юнита по зданию: снаряд лучника или вспышка, и число урона. */
  private showHit(u: BattleUnitState, target: BattleBuilding, damage: number): void {
    const from = this.unitPoint(u, 1);
    const s = BUILDINGS[target.type].size;
    const to = cellToWorld(target.x + s / 2, target.y + s / 2);
    if (u.troop === 'archer') {
      this.projectile({ x: from.x, y: from.y - 8 * this.k }, { x: to.x, y: to.y - 12 }, 0x8d6e63, 2, 180);
      return;
    }
    // Удар вплотную: вспышка между юнитом и зданием.
    const at = { x: from.x + (to.x - from.x) * 0.25, y: from.y + (to.y - from.y) * 0.25 - 10 * this.k };
    const flash = this.add.circle(at.x, at.y, (u.troop === 'ram' ? 7 : 4) * this.k, 0xffffff, 0.9).setDepth(TOP_DEPTH - 2);
    this.tweens.add({ targets: flash, scale: 1.8, alpha: 0, duration: 160, onComplete: () => flash.destroy() });
    const label = this.add
      .text(at.x, at.y, `-${damage}`, { fontFamily: FONT, fontSize: '11px', fontStyle: 'bold', color: '#ffeb3b', resolution: getDpr() })
      .setOrigin(0.5, 1)
      .setStroke('#000000', 3)
      .setScale(this.k)
      .setDepth(TOP_DEPTH - 1);
    this.tweens.add({ targets: label, y: at.y - 16 * this.k, alpha: { from: 1, to: 0 }, duration: 600, ease: 'Cubic.Out', onComplete: () => label.destroy() });
  }

  private projectile(from: Point, to: Point, color: number, r: number, duration: number): void {
    const dot = this.add.circle(from.x, from.y, r * this.k, color, 1).setStrokeStyle(1, 0x000000, 0.4).setDepth(TOP_DEPTH - 2);
    this.tweens.add({ targets: dot, x: to.x, y: to.y, duration, onComplete: () => dot.destroy() });
  }

  // ---------- Ввод: высадка ----------

  private cellAt(pointer: Phaser.Input.Pointer): { col: number; row: number } {
    const world = this.screenToWorld(pointer.x, pointer.y);
    return worldToCell(world.x, world.y);
  }

  private onPointerDown(pointer: Phaser.Input.Pointer): void {
    if (this.pointers.size === 0 && this.ctrl.blockers.some((r) => r.contains(pointer.x, pointer.y))) return;
    this.pointers.set(pointer.id, { x: pointer.x, y: pointer.y });
    if (this.pointers.size === 2) {
      // Второй палец — щипок: высадка зажатием прекращается.
      this.hold = null;
      const [a, b] = [...this.pointers.values()] as [Point, Point];
      this.pinch = { dist: Math.max(1, Phaser.Math.Distance.Between(a.x, a.y, b.x, b.y)), zoom: this.cameras.main.zoom, mid: midpoint(a, b) };
      return;
    }
    if (this.pointers.size > 2 || this.ctrl.phase.kind !== 'battle' || !this.ctrl.sim) return;
    const { col, row } = this.cellAt(pointer);
    if (this.tryDeploy(col, row, true)) {
      this.hold = { pointerId: pointer.id, x: col, y: row, lastTick: this.ctrl.sim.tick };
    }
  }

  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    const last = this.pointers.get(pointer.id);
    if (last) {
      last.x = pointer.x;
      last.y = pointer.y;
    }
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()] as [Point, Point];
      const mid = midpoint(a, b);
      const cam = this.cameras.main;
      // Сдвиг двумя пальцами; границы поля проверит zoomAt.
      cam.scrollX -= (mid.x - this.pinch.mid.x) / cam.zoom;
      cam.scrollY -= (mid.y - this.pinch.mid.y) / cam.zoom;
      this.pinch.mid = mid;
      const dist = Math.max(1, Phaser.Math.Distance.Between(a.x, a.y, b.x, b.y));
      this.zoomAt(this.pinch.zoom * (dist / this.pinch.dist), mid.x, mid.y);
      return;
    }
    if (!this.hold || this.hold.pointerId !== pointer.id) return;
    const { col, row } = this.cellAt(pointer);
    this.hold.x = col;
    this.hold.y = row;
  }

  private onPointerUp(pointer: Phaser.Input.Pointer): void {
    this.pointers.delete(pointer.id);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.hold?.pointerId === pointer.id) this.hold = null;
  }

  private holdDeploy(): void {
    const hold = this.hold!;
    hold.lastTick = this.ctrl.sim!.tick;
    // Палец уехал в запрещённую зону или войска кончились — перестаём.
    if (!this.tryDeploy(hold.x, hold.y, false)) this.hold = null;
  }

  /** Высадка; при отказе — подсказка (подсвеченная зона). true — получилось. */
  private tryDeploy(col: number, row: number, tap: boolean): boolean {
    const rejection = this.ctrl.deploy(col, row);
    if (!rejection) {
      if (tap) this.ctx.platform.haptic('light');
      return true;
    }
    if (tap) this.reject(rejection, col, row);
    return false;
  }

  private reject(reason: DeployRejection, col: number, row: number): void {
    this.ctx.platform.haptic('error');
    this.ctrl.emit('rejected', reason);
    if (reason === 'none_left') return;
    this.tweens.killTweensOf(this.forbidden);
    this.forbidden.setAlpha(0.45);
    this.tweens.add({ targets: this.forbidden, alpha: 0, delay: 700, duration: 600 });
    const mark = this.add.graphics().setDepth(TOP_DEPTH - 3);
    mark.lineStyle(2, this.ctx.ui.palette.danger, 1);
    polygon(mark, footprintCorners(col, row, 1, 1));
    mark.strokePath();
    this.tweens.add({ targets: mark, alpha: 0, delay: 500, duration: 500, onComplete: () => mark.destroy() });
  }

  // ---------- Камера ----------

  /** Поле целиком между верхней и нижней панелями интерфейса. */
  private fitCamera(): void {
    const cam = this.cameras.main;
    const { width, height } = this.scale;
    cam.setSize(width, height);
    const base = this.shownBase ?? this.ctrl.base;
    const grid = base?.gridSize ?? 12;
    const field = grid + 2 * BATTLE_MARGIN;
    const s = getDpr();
    const insets = this.ctx.platform.getSafeAreaInsets();
    const top = (insets.top + BATTLE_TOP_BAR + BATTLE_PAD * 2) * s;
    const bottom = (insets.bottom + BATTLE_BOTTOM_BAR + BATTLE_PAD * 2) * s;
    const availH = Math.max(1, height - top - bottom);
    // Над полем — высота самых высоких зданий.
    this.fitZoom = Math.min(width / (field * TILE_W * 1.02), availH / (field * TILE_H + TILE_H * 2.5));
    const center = cellToWorld(grid / 2, grid / 2);
    const screenShift = top + availH / 2 - height / 2;
    this.home = { x: center.x, y: center.y - TILE_H - screenShift / this.fitZoom };
    cam.setZoom(this.fitZoom);
    cam.centerOn(this.home.x, this.home.y);
  }

  /** Масштаб с неподвижной точкой (x, y) экрана; не мельче «всего поля» и не крупнее MAX_ZOOM_FACTOR. */
  private zoomAt(zoom: number, x: number, y: number): void {
    const cam = this.cameras.main;
    const anchor = this.screenToWorld(x, y);
    cam.zoom = Phaser.Math.Clamp(zoom, this.fitZoom, this.fitZoom * MAX_ZOOM_FACTOR);
    const hw = cam.width / 2;
    const hh = cam.height / 2;
    cam.scrollX = anchor.x - hw - (x - cam.x - hw) / cam.zoom;
    cam.scrollY = anchor.y - hh - (y - cam.y - hh) / cam.zoom;
    // Центр экрана не уходит дальше края поля от «домашнего» положения.
    const field = ((this.shownBase?.gridSize ?? 12) + 2 * BATTLE_MARGIN) * TILE_W;
    const maxShift = (field / 2) * (1 - this.fitZoom / cam.zoom);
    const cx = Phaser.Math.Clamp(cam.scrollX + hw, this.home.x - maxShift, this.home.x + maxShift);
    const cy = Phaser.Math.Clamp(cam.scrollY + hh, this.home.y - maxShift / 2, this.home.y + maxShift / 2);
    cam.scrollX = cx - hw;
    cam.scrollY = cy - hh;
  }

  private screenToWorld(x: number, y: number): Point {
    const cam = this.cameras.main;
    const hw = cam.width / 2;
    const hh = cam.height / 2;
    return { x: cam.scrollX + hw + (x - cam.x - hw) / cam.zoom, y: cam.scrollY + hh + (y - cam.y - hh) / cam.zoom };
  }
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
