import Phaser from 'phaser';
import {
  accumulated,
  BUILDER_COUNT,
  BUILDING_TYPES,
  BUILDINGS,
  buildingLimit,
  checkBuild,
  checkUpgrade,
  levelConfig,
  producerLevel,
  RESOURCE_TYPES,
  townhallConfig,
  type BuildingType,
  type PlacedBuilding,
  type Resources,
} from '@forts/shared';
import { ApiError } from '../../api/ApiClient';
import { t, type TextKey } from '../../i18n';
import { polygon } from '../buildingView';
import { getGameContext, type GameContext } from '../context';
import { getDpr } from '../display';
import { formatCountdown, formatDuration, formatNumber } from '../format';
import { errorMessage, ruleMessage } from '../messages';
import { RESOURCE_COLORS, toCss } from '../theme';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
/** Здания в меню постройки; ратуша одна и ставится при создании базы. */
const MENU_TYPES = BUILDING_TYPES.filter((type) => type !== 'townhall');
const MENU_ROW_H = 58;

/**
 * Интерфейс поверх мира: ресурсы с заполнением хранилища, строители,
 * меню постройки, панель выбранного здания и подсказка режима.
 * Все размеры задаются в CSS-пикселях и умножаются на dpr.
 */
export class HudScene extends Phaser.Scene {
  private ctx!: GameContext;
  private rebuildPending = false;
  /** Показанные в счётчиках значения — плавно догоняют настоящие. */
  private shown: Resources = { gold: 0, food: 0 };
  /** Обновления текстов каждый кадр (счётчики, таймеры); пересобираются вместе с интерфейсом. */
  private tickers: (() => void)[] = [];
  private toastObj: Phaser.GameObjects.Text | undefined;
  private bottomTop = 0;

  constructor() {
    super({ key: 'hud', active: true });
  }

  create(): void {
    this.ctx = getGameContext();
    const { ui, base } = this.ctx;
    this.shown = { ...base.resources };
    // Перестраиваем на следующем кадре: события приходят из обработчиков
    // кнопок, которые нельзя уничтожать посреди их же события.
    const rebuild = () => {
      if (this.rebuildPending) return;
      this.rebuildPending = true;
      this.events.once(Phaser.Scenes.Events.UPDATE, () => {
        this.rebuildPending = false;
        this.build();
      });
    };
    const onBase = () => {
      this.tweens.killTweensOf(this.shown);
      this.tweens.add({ targets: this.shown, ...base.resources, duration: 450, ease: 'Cubic.Out' });
      rebuild();
    };
    const onToast = (key: TextKey, params?: Record<string, string | number>) => this.showToast(t(key, params));
    ui.on('palette', rebuild);
    ui.on('change', rebuild);
    ui.on('toast', onToast);
    base.on('change', onBase);
    base.on('pending', rebuild);
    this.scale.on(Phaser.Scale.Events.RESIZE, rebuild);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      ui.off('palette', rebuild);
      ui.off('change', rebuild);
      ui.off('toast', onToast);
      base.off('change', onBase);
      base.off('pending', rebuild);
      this.scale.off(Phaser.Scale.Events.RESIZE, rebuild);
    });
    this.build();
  }

  update(): void {
    for (const tick of this.tickers) tick();
  }

  private build(): void {
    this.children.removeAll(true);
    this.toastObj = undefined;
    this.tickers = [];
    const { width, height } = this.scale;
    this.cameras.main.setSize(width, height);

    const s = getDpr();
    const insets = this.ctx.platform.getSafeAreaInsets();
    const pad = 8 * s;
    const left = insets.left * s + pad;
    const right = width - insets.right * s - pad;
    const w = right - left;
    const bottom = height - insets.bottom * s - pad;

    const top = this.buildTopBar(left, insets.top * s + pad, w, s);
    const { ui, base } = this.ctx;
    const selected = ui.selectedId === null ? undefined : base.get(ui.selectedId);
    let panel: Phaser.Geom.Rectangle;
    if (ui.mode.kind !== 'none') panel = this.buildModeHint(left, bottom, w, s);
    else if (ui.menuOpen) panel = this.buildMenu(left, bottom, w, s);
    else if (selected) panel = this.buildBuildingPanel(selected, left, bottom, w, s);
    else panel = this.buildBottomBar(left, bottom, w, s);
    this.bottomTop = panel.y;
    this.ctx.ui.blockers = [top, panel];
  }

  // ---------- Примитивы ----------

  private text(x: number, y: number, value: string, size: number, color: number, bold = false) {
    return this.add.text(x, y, value, {
      fontFamily: FONT,
      fontSize: `${size}px`,
      fontStyle: bold ? 'bold' : 'normal',
      color: toCss(color),
    });
  }

  private panel(x: number, y: number, w: number, h: number, s: number, fill?: number, stroke?: number): Phaser.GameObjects.Graphics {
    const { palette } = this.ctx.ui;
    const g = this.add.graphics();
    g.fillStyle(fill ?? palette.hudBg, fill === undefined ? 0.94 : 1);
    g.fillRoundedRect(x, y, w, h, 12 * s);
    if (stroke !== undefined) {
      g.lineStyle(2 * s, stroke, 1);
      g.strokeRoundedRect(x, y, w, h, 12 * s);
    }
    return g;
  }

  /** Невидимая зона нажатия: срабатывает по отпусканию, как обычная кнопка. */
  private tapZone(x: number, y: number, w: number, h: number, onTap: () => void): Phaser.GameObjects.Zone {
    return this.add
      .zone(x, y, w, h)
      .setOrigin(0)
      .setInteractive({ useHandCursor: true })
      .on('pointerup', onTap);
  }

  private closeButton(x: number, y: number, s: number, onTap: () => void): void {
    const size = 40 * s;
    this.text(x + size / 2, y + size / 2, '✕', 18 * s, this.ctx.ui.palette.hudMuted, true).setOrigin(0.5);
    this.tapZone(x, y, size, size, onTap);
  }

  private resourceIcon(x: number, y: number, r: number, type: keyof Resources, s: number): void {
    this.add.circle(x, y, r, RESOURCE_COLORS[type]).setStrokeStyle(Math.max(1, 1.5 * s), 0x000000, 0.25);
  }

  /**
   * Цена: значок и число для каждого нужного ресурса; красным — чего не хватает.
   * Рисуется вправо от x (или влево, если alignRight). Возвращает ширину.
   */
  private cost(x: number, y: number, cost: Resources, s: number, size: number, alignRight = false, color?: number): number {
    const { palette } = this.ctx.ui;
    const parts = RESOURCE_TYPES.filter((r) => cost[r] > 0);
    const r = size * 0.42;
    const gap = 8 * s;
    const items = parts.map((type) => {
      const enough = this.ctx.base.resources[type] >= cost[type];
      const label = this.text(0, y, formatNumber(cost[type]), size, enough ? (color ?? palette.hudText) : palette.danger, true).setOrigin(0, 0.5);
      return { type, label, w: r * 2 + 4 * s + label.width };
    });
    const total = items.reduce((sum, it) => sum + it.w, 0) + gap * Math.max(0, items.length - 1);
    let cursor = alignRight ? x - total : x;
    for (const it of items) {
      this.resourceIcon(cursor + r, y, r, it.type, s);
      it.label.setX(cursor + r * 2 + 4 * s);
      cursor += it.w + gap;
    }
    return total;
  }

  private progressBar(x: number, y: number, w: number, h: number, color: number): (ratio: number) => void {
    const g = this.add.graphics();
    const bgColor = this.ctx.ui.palette.hudMuted;
    return (ratio) => {
      g.clear();
      g.fillStyle(bgColor, 0.3).fillRoundedRect(x, y, w, h, h / 2);
      const fw = Math.max(0, Math.min(1, ratio)) * w;
      if (fw > 0) g.fillStyle(color, 1).fillRoundedRect(x, y, Math.max(fw, h), h, h / 2);
    };
  }

  // ---------- Верхняя плашка: игрок и ресурсы ----------

  private buildTopBar(x: number, y: number, w: number, s: number): Phaser.Geom.Rectangle {
    const { palette } = this.ctx.ui;
    const { base } = this.ctx;
    const h = 48 * s;
    this.panel(x, y, w, h, s);

    // Ресурсы справа налево: еда, затем золото. Под числом — заполнение хранилища.
    let cursor = x + w - 12 * s;
    const barW = 64 * s;
    for (const type of ['food', 'gold'] as const) {
      const color = RESOURCE_COLORS[type];
      const value = this.text(cursor, y + h / 2 + 1 * s, '', 16 * s, palette.hudText, true).setOrigin(1, 1);
      const setBar = this.progressBar(cursor - barW, y + h / 2 + 5 * s, barW, 5 * s, color);
      this.tickers.push(() => {
        const cap = base.capacity()[type];
        value.setText(formatNumber(this.shown[type]));
        value.setColor(toCss(this.shown[type] >= cap ? palette.danger : palette.hudText));
        setBar(cap > 0 ? this.shown[type] / cap : 0);
      });
      const iconX = cursor - barW - 14 * s;
      this.resourceIcon(iconX, y + h / 2, 9 * s, type, s);
      cursor = iconX - 9 * s - 14 * s;
    }

    const nameX = x + 14 * s;
    const name = this.text(nameX, y + h / 2, base.player.name, 16 * s, palette.hudText, true).setOrigin(0, 0.5);
    const maxNameW = cursor - nameX;
    if (name.width > maxNameW) name.setCrop(0, 0, Math.max(0, maxNameW), name.height);

    return new Phaser.Geom.Rectangle(x, y, w, h);
  }

  // ---------- Нижняя панель: строители и кнопка «Строить» ----------

  private buildBottomBar(x: number, bottom: number, w: number, s: number): Phaser.Geom.Rectangle {
    const { palette } = this.ctx.ui;
    const { base, ui } = this.ctx;
    const h = 52 * s;
    const y = bottom - h;

    const chipW = 96 * s;
    this.panel(x, y, chipW, h, s);
    this.drawHammer(x + 22 * s, y + h / 2, s);
    const busy = base.busyBuilders();
    this.text(x + 40 * s, y + h / 2 + 2 * s, `${busy}/${BUILDER_COUNT}`, 17 * s, busy >= BUILDER_COUNT ? palette.danger : palette.hudText, true).setOrigin(0, 1);
    this.text(x + 40 * s, y + h / 2 + 2 * s, t('hud.builders'), 10 * s, palette.hudMuted).setOrigin(0, 0);
    // Число занятых меняется, когда стройка закончится, — сервер пришлёт новое состояние.

    const btnW = 140 * s;
    const bx = x + w - btnW;
    this.panel(bx, y, btnW, h, s, palette.accent);
    this.text(bx + btnW / 2, y + h / 2, t('menu.build'), 17 * s, 0xffffff, true).setOrigin(0.5);
    this.tapZone(bx, y, btnW, h, () => {
      this.ctx.platform.haptic('selection');
      ui.setMenuOpen(true);
    });

    // Блокирует только полосу снизу: между чипом и кнопкой касания идут в мир.
    return new Phaser.Geom.Rectangle(x, y, w, h);
  }

  private drawHammer(cx: number, cy: number, s: number): void {
    const g = this.add.graphics();
    g.fillStyle(0x8d6e63, 1);
    g.fillRect(cx - 2 * s, cy - 4 * s, 4 * s, 14 * s);
    g.fillStyle(this.ctx.ui.palette.hudMuted, 1);
    g.fillRoundedRect(cx - 8 * s, cy - 10 * s, 16 * s, 7 * s, 2 * s);
  }

  // ---------- Меню постройки ----------

  private buildMenu(x: number, bottom: number, w: number, s: number): Phaser.Geom.Rectangle {
    const { palette } = this.ctx.ui;
    const { base, ui } = this.ctx;
    const headerH = 44 * s;
    const rowH = MENU_ROW_H * s;
    const h = headerH + rowH * MENU_TYPES.length + 8 * s;
    const y = bottom - h;
    this.panel(x, y, w, h, s);
    this.text(x + 16 * s, y + headerH / 2, t('menu.title'), 17 * s, palette.hudText, true).setOrigin(0, 0.5);
    this.closeButton(x + w - 44 * s, y + 2 * s, s, () => ui.setMenuOpen(false));

    const now = base.now();
    const th = base.townhallLevel();
    MENU_TYPES.forEach((type, i) => {
      const ry = y + headerH + i * rowH;
      const check = checkBuild(base.resources, base.buildings, type, now);
      const locked = !check.ok && check.reason === 'townhall_level_too_low';
      const level1 = levelConfig(type, 1)!;
      const count = base.buildings.filter((b) => b.type === type).length;
      const before = this.children.list.length;

      this.add.graphics().lineStyle(1, palette.hudMuted, 0.2).lineBetween(x + 12 * s, ry, x + w - 12 * s, ry);
      this.drawSwatch(type, x + 34 * s, ry + rowH / 2, 36 * s);
      this.text(x + 62 * s, ry + rowH / 2 - 1 * s, t(`building.${type}`), 15 * s, palette.hudText, true).setOrigin(0, 1);
      const reason = check.ok ? undefined : ruleMessage(check);
      const info = reason
        ? t(reason.key, reason.params)
        : `${count}/${buildingLimit(type, th)} · ${formatDuration(level1.buildSeconds)}`;
      this.text(x + 62 * s, ry + rowH / 2 + 3 * s, info, 12 * s, reason ? palette.danger : palette.hudMuted).setOrigin(0, 0);

      const right = x + w - 16 * s;
      if (locked) this.drawLock(right - 8 * s, ry + rowH / 2, s);
      else this.cost(right, ry + rowH / 2, level1.cost, s, 14 * s, true);
      // Недоступное — приглушено; тап объясняет почему.
      if (reason) this.createdSince(before).forEach((o) => (o as unknown as Phaser.GameObjects.Components.Alpha).setAlpha(0.5));

      const zone = this.add.zone(x, ry, w, rowH).setOrigin(0).setInteractive({ useHandCursor: check.ok });
      if (check.ok) {
        zone.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
          this.ctx.platform.haptic('selection');
          ui.startDrag(type, pointer.id);
        });
      } else if (reason) {
        zone.on('pointerup', () => {
          this.ctx.platform.haptic('warning');
          this.showToast(t(reason.key, reason.params));
        });
      }
    });

    return new Phaser.Geom.Rectangle(x, y, w, h);
  }

  /** Объекты, добавленные на сцену после того, как в ней было count объектов. */
  private createdSince(count: number): Phaser.GameObjects.GameObject[] {
    return this.children.list.slice(count);
  }

  private drawLock(cx: number, cy: number, s: number): void {
    const g = this.add.graphics();
    const color = this.ctx.ui.palette.hudMuted;
    g.lineStyle(2.5 * s, color, 1);
    g.strokeCircle(cx, cy - 5 * s, 5 * s);
    g.fillStyle(color, 1);
    g.fillRoundedRect(cx - 8 * s, cy - 3 * s, 16 * s, 12 * s, 2 * s);
  }

  /** Маленький цветной ромб — превью здания. */
  private drawSwatch(type: BuildingType, cx: number, cy: number, w: number): void {
    const hw = w / 2;
    const hh = w / 4;
    const g = this.add.graphics();
    g.fillStyle(BUILDINGS[type].color, 1);
    g.lineStyle(1, 0x000000, 0.35);
    polygon(g, [
      { x: cx, y: cy - hh },
      { x: cx + hw, y: cy },
      { x: cx, y: cy + hh },
      { x: cx - hw, y: cy },
    ]);
    g.fillPath();
    g.strokePath();
  }

  // ---------- Панель здания ----------

  private buildBuildingPanel(b: PlacedBuilding, x: number, bottom: number, w: number, s: number): Phaser.Geom.Rectangle {
    const { palette } = this.ctx.ui;
    const { base, ui, platform } = this.ctx;
    const now = base.now();
    const lineH = 20 * s;
    const lines: (string | (() => string))[] = [];
    let progress: (() => number) | undefined;

    if (b.finishAt !== null) {
      const finishAt = b.finishAt;
      const total = (levelConfig(b.type, b.level + 1)?.buildSeconds ?? 0) * 1000;
      const left = () => Math.max(0, finishAt - base.now());
      lines.push(() =>
        b.level === 0
          ? t('panel.constructing', { time: formatCountdown(left()) })
          : t('panel.upgrading', { level: b.level + 1, time: formatCountdown(left()) }),
      );
      progress = () => (total > 0 ? 1 - left() / total : 1);
    }
    const prod = producerLevel(b.type, b.level);
    if (prod) {
      lines.push(t('panel.production', { rate: formatNumber(prod.perHour), capacity: formatNumber(prod.capacity) }));
      lines.push(() => t('panel.stored', { amount: formatNumber(accumulated(b, base.now())) }));
    }
    const thCfg = b.type === 'townhall' ? townhallConfig(b.level) : undefined;
    if (thCfg) lines.push(t('panel.storage', { amount: formatNumber(thCfg.storage.gold) }));
    const levelCfg = levelConfig(b.type, Math.max(1, b.level));
    if (levelCfg) lines.push(t('panel.hp', { hp: formatNumber(levelCfg.hp) }));

    const check = checkUpgrade(base.resources, base.buildings, b, now);
    const next = levelConfig(b.type, b.level + 1);
    const reason = check.ok || check.reason === 'max_level' || check.reason === 'under_construction' ? undefined : ruleMessage(check);

    const headerH = 44 * s;
    const btnH = 52 * s;
    const h = headerH + lines.length * lineH + (progress ? 12 * s : 0) + 10 * s + btnH + (reason ? 22 * s : 0) + 12 * s;
    const y = bottom - h;
    this.panel(x, y, w, h, s);

    const title = this.text(x + 16 * s, y + headerH / 2, t(`building.${b.type}`), 17 * s, palette.hudText, true).setOrigin(0, 0.5);
    if (b.level > 0) {
      this.text(title.x + title.width + 8 * s, y + headerH / 2 + 1 * s, t('panel.level', { level: b.level }), 14 * s, palette.hudMuted).setOrigin(0, 0.5);
    }
    this.closeButton(x + w - 44 * s, y + 2 * s, s, () => ui.select(null));

    let cy = y + headerH;
    for (const line of lines) {
      const text = this.text(x + 16 * s, cy, typeof line === 'string' ? line : line(), 13 * s, palette.hudMuted);
      if (typeof line === 'function') this.tickers.push(() => text.setText(line()));
      cy += lineH;
    }
    if (progress) {
      const setBar = this.progressBar(x + 16 * s, cy + 2 * s, w - 32 * s, 6 * s, palette.valid);
      const p = progress;
      this.tickers.push(() => setBar(p()));
      cy += 12 * s;
    }
    cy += 10 * s;

    // Кнопки: «Переместить» и «Улучшить» с ценой и временем.
    const gap = 8 * s;
    const moveW = Math.min(130 * s, (w - 32 * s - gap) * 0.4);
    const bx = x + 16 * s;
    this.panel(bx, cy, moveW, btnH, s, palette.hudBg, palette.accent);
    this.text(bx + moveW / 2, cy + btnH / 2, t('panel.move'), 15 * s, palette.accent, true).setOrigin(0.5);
    this.tapZone(bx, cy, moveW, btnH, () => {
      platform.haptic('selection');
      ui.setMode({ kind: 'move', id: b.id });
    });

    const ux = bx + moveW + gap;
    const uw = x + w - 16 * s - ux;
    const pending = base.isPending(`upgrade:${b.id}`);
    const enabled = check.ok && !pending;
    this.panel(ux, cy, uw, btnH, s, enabled ? palette.accent : palette.hudMuted).setAlpha(enabled ? 1 : 0.55);
    const busy = !check.ok && check.reason === 'under_construction';
    if (next && !busy) {
      this.text(ux + uw / 2, cy + btnH / 2, t('panel.upgrade'), 15 * s, 0xffffff, true).setOrigin(0.5, 1);
      const costY = cy + btnH / 2 + 10 * s;
      // Цена по центру кнопки: сначала рисуем, потом сдвигаем на половину ширины.
      const before = this.children.list.length;
      const cw = this.cost(0, costY, next.cost, s, 12 * s, false, 0xffffff);
      const time = this.text(cw + 6 * s, costY, `· ${formatDuration(next.buildSeconds)}`, 12 * s, 0xffffff).setOrigin(0, 0.5);
      const rowW = cw + 6 * s + time.width;
      const shift = ux + (uw - rowW) / 2;
      for (const o of this.createdSince(before)) (o as unknown as Phaser.GameObjects.Components.Transform).x += shift;
    } else {
      this.text(ux + uw / 2, cy + btnH / 2, t(busy ? 'reason.busy' : 'reason.maxLevel'), 14 * s, 0xffffff, true).setOrigin(0.5);
    }
    this.tapZone(ux, cy, uw, btnH, () => {
      if (!enabled) {
        platform.haptic('warning');
        if (!check.ok) {
          const msg = ruleMessage(check);
          this.showToast(t(msg.key, msg.params));
        }
        return;
      }
      platform.haptic('medium');
      base.upgrade(b.id).catch((err: unknown) => {
        console.warn('Upgrade rejected', err);
        platform.haptic('error');
        const msg = errorMessage(err instanceof ApiError ? err.code : 'network');
        this.showToast(t(msg.key, msg.params));
      });
    });

    if (reason) this.text(ux + uw / 2, cy + btnH + 6 * s, t(reason.key, reason.params), 12 * s, palette.danger).setOrigin(0.5, 0);

    return new Phaser.Geom.Rectangle(x, y, w, h);
  }

  // ---------- Режимы постановки и переноса ----------

  private buildModeHint(x: number, bottom: number, w: number, s: number): Phaser.Geom.Rectangle {
    const { palette } = this.ctx.ui;
    const { ui, base } = this.ctx;
    const { mode } = ui;
    const h = 52 * s;
    const y = bottom - h;
    this.panel(x, y, w, h, s, undefined, palette.accent);

    let type: BuildingType | undefined;
    if (mode.kind === 'place') type = mode.type;
    else if (mode.kind === 'move') type = base.get(mode.id)?.type;
    const name = type ? t(`building.${type}`) : '';
    const text = t(mode.kind === 'move' ? 'mode.move' : 'mode.place', { name });

    const btnW = 96 * s;
    const hint = this.text(x + 16 * s, y + h / 2, text, 14 * s, palette.hudText, true).setOrigin(0, 0.5);
    const maxW = w - btnW - 32 * s;
    if (hint.width > maxW) hint.setScale(maxW / hint.width);

    const bx = x + w - btnW - 6 * s;
    this.panel(bx, y + 6 * s, btnW, h - 12 * s, s, palette.hudMuted).setAlpha(0.35);
    this.text(bx + btnW / 2, y + h / 2, t('mode.cancel'), 14 * s, palette.hudText, true).setOrigin(0.5);
    this.tapZone(bx, y, btnW + 6 * s, h, () => {
      const id = mode.kind === 'move' ? mode.id : null;
      ui.setMode({ kind: 'none' });
      if (id !== null) ui.select(id);
    });

    return new Phaser.Geom.Rectangle(x, y, w, h);
  }

  // ---------- Короткие сообщения ----------

  private showToast(message: string): void {
    this.toastObj?.destroy();
    const s = getDpr();
    const { width } = this.scale;
    const toast = this.text(width / 2, this.bottomTop - 12 * s, message, 14 * s, 0xffffff, true)
      .setOrigin(0.5, 1)
      .setBackgroundColor('#000000b3')
      .setPadding(10 * s, 6 * s, 10 * s, 6 * s);
    this.toastObj = toast;
    this.tweens.add({
      targets: toast,
      alpha: 0,
      delay: 1400,
      duration: 400,
      onComplete: () => {
        toast.destroy();
        if (this.toastObj === toast) this.toastObj = undefined;
      },
    });
  }
}
