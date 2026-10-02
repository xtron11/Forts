import Phaser from 'phaser';
import {
  BATTLE_MAX_TICKS,
  RESOURCE_TYPES,
  STAR_DESTRUCTION_PERCENT,
  TICKS_PER_SECOND,
  TROOP_TYPES,
  type Resources,
  type TroopCount,
  type TroopType,
} from '@forts/shared';
import { ApiError } from '../../api/ApiClient';
import { t, type TextKey } from '../../i18n';
import { getGameContext, type GameContext } from '../context';
import { getDpr } from '../display';
import { formatCountdown, formatNumber } from '../format';
import { errorMessage } from '../messages';
import { RESOURCE_COLORS, toCss } from '../theme';
import type { BattleController, DeployRejection } from './BattleController';
import { BATTLE_BOTTOM_BAR, BATTLE_PAD, BATTLE_TOP_BAR } from './layout';
import { troopAnimations } from '../units/art';
import { pickResultPose, type ResultPose } from './resultPose';
import { addTroopIcon, addTroopPose } from './troopView';

/** Высота места под юнита с анимацией victory/defeat в окне итога, CSS-пиксели. */
const RESULT_POSE_H = 96;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const STAR_COLOR = 0xffc107;

const REJECTION_TEXT: Readonly<Record<DeployRejection, TextKey>> = {
  forbidden_zone: 'battle.forbidden',
  out_of_bounds: 'battle.outOfBounds',
  none_left: 'battle.noneLeft',
};

/**
 * Интерфейс боя: экран поиска (превью, добыча, кнопки), панель войск,
 * таймер, звёзды и процент разрушения, экран итога. Размеры — в CSS-пикселях × dpr.
 */
export class BattleHudScene extends Phaser.Scene {
  private ctx!: GameContext;
  private ctrl!: BattleController;
  private tickers: (() => void)[] = [];
  private toastObj: Phaser.GameObjects.Text | undefined;
  private rebuildPending = false;
  private bottomTop = 0;
  /** Персонаж окна итога: выбирается один раз на итог, а не при каждой перерисовке. */
  private pose: { report: unknown; pose: ResultPose | null } | undefined;

  constructor() {
    super('battleHud');
  }

  create(): void {
    this.ctx = getGameContext();
    this.ctrl = this.ctx.battle!;
    const rebuild = () => {
      if (this.rebuildPending) return;
      this.rebuildPending = true;
      this.events.once(Phaser.Scenes.Events.UPDATE, () => {
        this.rebuildPending = false;
        this.build();
      });
    };
    const onRejected = (reason: DeployRejection) => this.showToast(t(REJECTION_TEXT[reason]));
    const onError = (err: unknown) => {
      const msg = errorMessage(err instanceof ApiError ? err.code : 'network');
      this.showToast(t(msg.key, msg.params));
    };
    this.ctrl.on('change', rebuild);
    this.ctrl.on('rejected', onRejected);
    this.ctrl.on('error', onError);
    this.ctx.ui.on('palette', rebuild);
    this.scale.on(Phaser.Scale.Events.RESIZE, rebuild);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.ctrl.off('change', rebuild);
      this.ctrl.off('rejected', onRejected);
      this.ctrl.off('error', onError);
      this.ctx.ui.off('palette', rebuild);
      this.scale.off(Phaser.Scale.Events.RESIZE, rebuild);
    });
    this.build();
  }

  update(): void {
    for (const tick of this.tickers) tick();
  }

  private build(): void {
    this.children.removeAll(true);
    this.tickers = [];
    this.toastObj = undefined;
    const { width, height } = this.scale;
    this.cameras.main.setSize(width, height);
    const s = getDpr();
    const insets = this.ctx.platform.getSafeAreaInsets();
    const pad = BATTLE_PAD * s;
    const left = insets.left * s + pad;
    const w = width - insets.right * s - pad - left;
    const top = insets.top * s + pad;
    const bottom = height - insets.bottom * s - pad;
    const blockers: Phaser.Geom.Rectangle[] = [];
    this.bottomTop = bottom - BATTLE_BOTTOM_BAR * s;

    const p = this.ctrl.phase;
    switch (p.kind) {
      case 'searching':
        this.centerNote(t('battle.searching'), s);
        blockers.push(this.buildBackOnly(left, bottom, w, s));
        break;
      case 'scout':
      case 'starting':
        blockers.push(this.buildScoutTop(p.target.townhallLevel, p.target.lootPreview, left, top, w, s));
        blockers.push(this.buildScoutBottom(p.target.nextCost, p.kind === 'starting', left, bottom, w, s));
        if (p.kind === 'starting') this.centerNote(t('battle.starting'), s);
        break;
      case 'battle':
      case 'finishing':
        blockers.push(this.buildBattleTop(p.kind === 'battle', left, top, w, s));
        blockers.push(this.buildTroopBar(left, bottom, w, s));
        if (p.kind === 'finishing') this.centerNote(t('battle.finishing'), s);
        else if (this.ctrl.orders.length === 0) this.hint(t('battle.hint'), this.bottomTop - 10 * s, s);
        break;
      case 'result':
        blockers.push(new Phaser.Geom.Rectangle(0, 0, width, height));
        this.buildResult(width, height, s);
        break;
    }
    this.ctrl.blockers = blockers;
  }

  // ---------- Примитивы ----------

  private text(x: number, y: number, value: string, size: number, color: number, bold = false) {
    return this.add.text(x, y, value, { fontFamily: FONT, fontSize: `${size}px`, fontStyle: bold ? 'bold' : 'normal', color: toCss(color) });
  }

  private panel(x: number, y: number, w: number, h: number, s: number, fill?: number, stroke?: number, alpha = 0.94) {
    const g = this.add.graphics();
    g.fillStyle(fill ?? this.ctx.ui.palette.hudBg, fill === undefined ? alpha : 1);
    g.fillRoundedRect(x, y, w, h, 12 * s);
    if (stroke !== undefined) g.lineStyle(2 * s, stroke, 1).strokeRoundedRect(x, y, w, h, 12 * s);
    return g;
  }

  private button(x: number, y: number, w: number, h: number, s: number, label: string, fill: number, onTap: () => void, enabled = true) {
    this.panel(x, y, w, h, s, fill).setAlpha(enabled ? 1 : 0.5);
    const text = this.text(x + w / 2, y + h / 2, label, 15 * s, 0xffffff, true).setOrigin(0.5);
    if (text.width > w - 12 * s) text.setScale((w - 12 * s) / text.width);
    this.add.zone(x, y, w, h).setOrigin(0).setInteractive({ useHandCursor: true }).on('pointerup', onTap);
    return text;
  }

  private resources(x: number, y: number, amounts: Resources, s: number, size: number, alignRight: boolean): void {
    const r = size * 0.45;
    const parts = RESOURCE_TYPES.map((type) => {
      const label = this.text(0, y, formatNumber(amounts[type]), size, this.ctx.ui.palette.hudText, true).setOrigin(0, 0.5);
      return { type, label, w: 2 * r + 4 * s + label.width };
    });
    const gap = 10 * s;
    const total = parts.reduce((n, it) => n + it.w, 0) + gap * (parts.length - 1);
    let cursor = alignRight ? x - total : x;
    for (const it of parts) {
      this.add.circle(cursor + r, y, r, RESOURCE_COLORS[it.type]).setStrokeStyle(Math.max(1, 1.5 * s), 0x000000, 0.25);
      it.label.setX(cursor + 2 * r + 4 * s);
      cursor += it.w + gap;
    }
  }

  /** Звезда с центром в (cx, cy): рисуется вокруг своего начала координат, чтобы масштабироваться от центра. */
  private star(cx: number, cy: number, r: number, filled: boolean, s: number): Phaser.GameObjects.Graphics {
    const g = this.add.graphics().setPosition(cx, cy);
    paintStar(g, r, filled, s);
    return g;
  }

  private centerNote(message: string, s: number): void {
    const { width, height } = this.scale;
    this.text(width / 2, height / 2, message, 16 * s, 0xffffff, true)
      .setOrigin(0.5)
      .setBackgroundColor('#000000b3')
      .setPadding(14 * s, 8 * s, 14 * s, 8 * s);
  }

  private hint(message: string, bottom: number, s: number): void {
    this.text(this.scale.width / 2, bottom, message, 13 * s, 0xffffff, true)
      .setOrigin(0.5, 1)
      .setBackgroundColor('#00000080')
      .setPadding(10 * s, 5 * s, 10 * s, 5 * s);
  }

  // ---------- Поиск ----------

  private buildBackOnly(x: number, bottom: number, w: number, s: number): Phaser.Geom.Rectangle {
    const h = 52 * s;
    const bw = Math.min(140 * s, w);
    this.button(x, bottom - h, bw, h, s, t('battle.back'), this.ctx.ui.palette.hudMuted, () => this.ctrl.exit());
    return new Phaser.Geom.Rectangle(x, bottom - h, bw, h);
  }

  private buildScoutTop(townhall: number, loot: Resources, x: number, y: number, w: number, s: number): Phaser.Geom.Rectangle {
    const { palette } = this.ctx.ui;
    const h = BATTLE_TOP_BAR * s;
    this.panel(x, y, w, h, s);
    this.text(x + 14 * s, y + h / 2 - 1 * s, t('battle.townhall', { level: townhall }), 15 * s, palette.hudText, true).setOrigin(0, 1);
    this.text(x + 14 * s, y + h / 2 + 3 * s, t('battle.lootPreview'), 12 * s, palette.hudMuted).setOrigin(0, 0);
    this.resources(x + w - 14 * s, y + h / 2, loot, s, 16 * s, true);
    return new Phaser.Geom.Rectangle(x, y, w, h);
  }

  private buildScoutBottom(nextCost: number, busy: boolean, x: number, bottom: number, w: number, s: number): Phaser.Geom.Rectangle {
    const { palette } = this.ctx.ui;
    const { platform, base } = this.ctx;
    const h = BATTLE_BOTTOM_BAR * s;
    const y = bottom - h;
    this.panel(x, y, w, h, s);
    const army = this.ctrl.armySize();
    const info = army > 0 ? t('battle.army', { count: army }) : t('reason.noTroops');
    this.text(x + w / 2, y + 12 * s, info, 13 * s, army > 0 ? palette.hudMuted : palette.danger, army === 0).setOrigin(0.5, 0);

    const gap = 8 * s;
    const bh = 52 * s;
    const by = y + h - bh - 10 * s;
    const bw = (w - 20 * s - 2 * gap) / 3;
    let bx = x + 10 * s;
    this.button(bx, by, bw, bh, s, t('battle.back'), palette.hudMuted, () => !busy && this.ctrl.exit(), !busy);
    bx += bw + gap;
    const canNext = !busy && base.resources.gold >= nextCost;
    const nextLabel = this.button(bx, by, bw, bh, s, t('battle.next'), 0x6d4c41, () => {
      if (busy) return;
      if (!canNext) {
        platform.haptic('warning');
        this.showToast(t('reason.gold'));
        return;
      }
      platform.haptic('selection');
      void this.ctrl.search(true);
    }, canNext);
    nextLabel.setOrigin(0.5, 1).setY(by + bh / 2 + 2 * s);
    // Цена «Следующей» под надписью.
    this.resourcesInline(bx + bw / 2, by + bh / 2 + 12 * s, nextCost, s);
    bx += bw + gap;
    this.button(bx, by, bw, bh, s, t('battle.attack'), palette.danger, () => {
      if (busy) return;
      if (army === 0) {
        platform.haptic('warning');
        this.showToast(t('reason.noTroops'));
        return;
      }
      platform.haptic('heavy');
      void this.ctrl.attack();
    }, !busy && army > 0);
    return new Phaser.Geom.Rectangle(x, y, w, h);
  }

  private resourcesInline(cx: number, cy: number, gold: number, s: number): void {
    const label = this.text(0, cy, formatNumber(gold), 12 * s, 0xffffff, true).setOrigin(0, 0.5);
    const r = 5 * s;
    const total = 2 * r + 4 * s + label.width;
    const x0 = cx - total / 2;
    this.add.circle(x0 + r, cy, r, RESOURCE_COLORS.gold);
    label.setX(x0 + 2 * r + 4 * s);
  }

  // ---------- Бой ----------

  private buildBattleTop(canEnd: boolean, x: number, y: number, w: number, s: number): Phaser.Geom.Rectangle {
    const { palette } = this.ctx.ui;
    const h = BATTLE_TOP_BAR * s;
    this.panel(x, y, w, h, s);

    const timer = this.text(x + 14 * s, y + h / 2, '', 20 * s, palette.hudText, true).setOrigin(0, 0.5);
    const cx = x + w / 2 - 34 * s;
    const starR = 10 * s;
    const stars = [0, 1, 2].map((i) => this.star(cx + (i - 1) * 22 * s, y + h / 2, starR, false, s));
    const percent = this.text(cx + 38 * s, y + h / 2, '', 17 * s, palette.hudText, true).setOrigin(0, 0.5);
    let shown = 0;
    this.tickers.push(() => {
      const sim = this.ctrl.sim;
      if (!sim) return;
      timer.setText(formatCountdown(((BATTLE_MAX_TICKS - sim.tick) * 1000) / TICKS_PER_SECOND));
      const live = liveScore(sim);
      percent.setText(`${live.destruction}%`);
      if (live.stars !== shown) {
        shown = live.stars;
        stars.forEach((g, i) => paintStar(g, starR, i < shown, s));
        // Новая звезда — короткий «прыжок».
        const g = stars[shown - 1];
        if (g) this.tweens.add({ targets: g, scale: { from: 1.8, to: 1 }, duration: 300, ease: 'Back.Out' });
      }
    });

    if (canEnd) {
      const bw = 104 * s;
      const bh = h - 12 * s;
      this.button(x + w - bw - 6 * s, y + 6 * s, bw, bh, s, t('battle.end'), palette.danger, () => {
        this.ctx.platform.haptic('medium');
        void this.ctrl.finish();
      });
    }
    return new Phaser.Geom.Rectangle(x, y, w, h);
  }

  private buildTroopBar(x: number, bottom: number, w: number, s: number): Phaser.Geom.Rectangle {
    const { palette } = this.ctx.ui;
    const h = BATTLE_BOTTOM_BAR * s;
    const y = bottom - h;
    this.panel(x, y, w, h, s);
    const left = this.ctrl.remaining();
    const types = TROOP_TYPES.filter((type) => left.has(type));
    const gap = 8 * s;
    const cw = Math.min(104 * s, (w - 20 * s - gap * Math.max(0, types.length - 1)) / Math.max(1, types.length));
    const ch = h - 20 * s;
    types.forEach((troop, i) => {
      const cx = x + 10 * s + i * (cw + gap);
      const cy = y + 10 * s;
      const count = left.get(troop) ?? 0;
      const selected = this.ctrl.selected === troop;
      const before = this.children.list.length;
      this.panel(cx, cy, cw, ch, s, selected ? palette.accent : palette.hudBg, selected ? palette.accent : palette.hudMuted, 1);
      addTroopIcon(this, troop, cx + cw / 2, cy + ch * 0.36, 24 * s);
      const color = selected ? 0xffffff : palette.hudText;
      this.text(cx + cw / 2, cy + ch * 0.68, t(`troop.${troop}` as TextKey), 12 * s, color, true).setOrigin(0.5);
      this.text(cx + cw - 6 * s, cy + 4 * s, `×${count}`, 14 * s, color, true).setOrigin(1, 0);
      if (count === 0) {
        for (const o of this.children.list.slice(before)) (o as unknown as Phaser.GameObjects.Components.Alpha).setAlpha(0.4);
      }
      this.add
        .zone(cx, cy, cw, ch)
        .setOrigin(0)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => {
          if (count === 0) {
            this.showToast(t('battle.noneLeft'));
            return;
          }
          this.ctx.platform.haptic('selection');
          this.ctrl.select(troop as TroopType);
        });
    });
    return new Phaser.Geom.Rectangle(x, y, w, h);
  }

  // ---------- Итог ----------

  private buildResult(width: number, height: number, s: number): void {
    const p = this.ctrl.phase;
    if (p.kind !== 'result') return;
    const { report } = p;
    const { palette } = this.ctx.ui;
    if (this.pose?.report !== report) {
      this.pose = { report, pose: pickResultPose(report, (troop, anim) => troopAnimations(this, troop)?.has(anim) ?? false) };
    }
    const pose = this.pose.pose;
    const poseH = pose ? RESULT_POSE_H : 0;
    this.add.rectangle(0, 0, width, height, 0x000000, 0.55).setOrigin(0);

    const w = Math.min(340 * s, width - 32 * s);
    const lossesLines = Math.max(1, report.troopsUsed.length);
    const capped = report.gained.gold < report.loot.gold || report.gained.food < report.loot.food;
    const h = (266 + poseH + lossesLines * 22 + (capped ? 20 : 0) + (report.reason === 'timeout' ? 20 : 0)) * s;
    const x = (width - w) / 2;
    let y = (height - h) / 2;
    this.panel(x, y, w, h, s, undefined, palette.accent);
    const cx = x + w / 2;

    y += 16 * s;
    const victory = report.stars > 0;
    this.text(cx, y, t(victory ? 'battle.victory' : 'battle.defeat'), 22 * s, victory ? palette.valid : palette.danger, true).setOrigin(0.5, 0);
    y += 34 * s;
    // Выживший празднует победу или погибший сердится из-за поражения.
    if (pose) {
      addTroopPose(this, pose.troop, pose.anim, cx, y + RESULT_POSE_H * s, (RESULT_POSE_H - 6) * s);
      y += (RESULT_POSE_H + 6) * s;
    } else {
      y += 6 * s;
    }
    for (let i = 0; i < 3; i++) {
      const g = this.star(cx + (i - 1) * 44 * s, y + 18 * s, 18 * s, i < report.stars, s).setScale(0.2).setAlpha(0);
      this.tweens.add({ targets: g, scale: 1, alpha: 1, delay: 150 + i * 200, duration: 250, ease: 'Back.Out' });
    }
    y += 48 * s;
    this.text(cx, y, t('battle.destruction', { percent: report.destruction }), 16 * s, palette.hudText, true).setOrigin(0.5, 0);
    if (report.reason === 'timeout') {
      y += 22 * s;
      this.text(cx, y, t('battle.timeout'), 12 * s, palette.hudMuted).setOrigin(0.5, 0);
    }
    y += 44 * s;
    this.text(x + 18 * s, y, t('battle.loot'), 14 * s, palette.hudMuted, true).setOrigin(0, 0.5);
    this.resources(x + w - 18 * s, y, report.gained, s, 16 * s, true);
    if (capped) {
      y += 20 * s;
      this.text(cx, y, t('battle.lootCapped'), 11 * s, palette.danger).setOrigin(0.5, 0.5);
    }
    y += 26 * s;
    this.text(x + 18 * s, y, t('battle.losses'), 14 * s, palette.hudMuted, true).setOrigin(0, 0.5);
    y += 22 * s;
    if (report.troopsUsed.length === 0) {
      this.text(x + 18 * s, y, t('battle.noLosses'), 14 * s, palette.hudText).setOrigin(0, 0.5);
    }
    for (const used of mergeLevels(report.troopsUsed)) {
      addTroopIcon(this, used.troop, x + 28 * s, y, 14 * s);
      this.text(x + 44 * s, y, `${t(`troop.${used.troop}` as TextKey)} ×${used.count}`, 14 * s, palette.hudText).setOrigin(0, 0.5);
      y += 22 * s;
    }

    const bh = 48 * s;
    this.button(x + 16 * s, (height + h) / 2 - bh - 14 * s, w - 32 * s, bh, s, t('battle.home'), palette.accent, () => {
      this.ctx.platform.haptic('selection');
      this.ctrl.exit();
    });
  }

  // ---------- Короткие сообщения ----------

  private showToast(message: string): void {
    this.toastObj?.destroy();
    const s = getDpr();
    // Выше подсказки над панелью войск.
    const toast = this.text(this.scale.width / 2, this.bottomTop - 48 * s, message, 14 * s, 0xffffff, true)
      .setOrigin(0.5, 1)
      .setBackgroundColor('#000000b3')
      .setPadding(10 * s, 6 * s, 10 * s, 6 * s)
      .setDepth(10);
    this.toastObj = toast;
    this.tweens.add({
      targets: toast,
      alpha: 0,
      delay: 1200,
      duration: 400,
      onComplete: () => {
        toast.destroy();
        if (this.toastObj === toast) this.toastObj = undefined;
      },
    });
  }
}

function paintStar(g: Phaser.GameObjects.Graphics, r: number, filled: boolean, s: number): void {
  const points: Phaser.Math.Vector2[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.45;
    points.push(new Phaser.Math.Vector2(Math.cos(a) * rr, Math.sin(a) * rr));
  }
  g.clear();
  g.fillStyle(filled ? STAR_COLOR : 0x000000, filled ? 1 : 0.25);
  g.fillPoints(points, true);
  g.lineStyle(Math.max(1, 1.5 * s), filled ? 0xb28704 : 0xffffff, filled ? 1 : 0.5);
  g.strokePoints(points, true);
}

/** Разрушение и звёзды на текущем тике (на экране; итог — от сервера). */
function liveScore(sim: NonNullable<BattleController['sim']>): { destruction: number; stars: number } {
  const destruction = sim.total === 0 ? 100 : Math.floor((sim.destroyed * 100) / sim.total);
  const stars = (destruction >= STAR_DESTRUCTION_PERCENT ? 1 : 0) + (sim.townhallDestroyed ? 1 : 0) + (destruction === 100 ? 1 : 0);
  return { destruction, stars };
}

/** Потери по войскам без деления на уровни. */
function mergeLevels(list: readonly TroopCount[]): { troop: TroopType; count: number }[] {
  return TROOP_TYPES.map((troop) => ({ troop, count: list.filter((u) => u.troop === troop).reduce((n, u) => n + u.count, 0) })).filter(
    (u) => u.count > 0,
  );
}
