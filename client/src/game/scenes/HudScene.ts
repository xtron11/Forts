import Phaser from 'phaser';
import { BUILDING_TYPES, BUILDINGS, type BuildingType } from '@forts/shared';
import { getLocale, t } from '../../i18n';
import { polygon } from '../buildingView';
import { getGameContext, type GameContext } from '../context';
import { getDpr } from '../display';
import { toCss } from '../theme';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const GOLD_COLOR = 0xf5c518;
const FOOD_COLOR = 0xe57373;

/**
 * Интерфейс поверх мира: плашка игрока с ресурсами и панель выбора здания.
 * Все размеры задаются в CSS-пикселях и умножаются на dpr.
 */
export class HudScene extends Phaser.Scene {
  private ctx!: GameContext;
  private rebuildPending = false;

  constructor() {
    super({ key: 'hud', active: true });
  }

  create(): void {
    this.ctx = getGameContext();
    const { ui } = this.ctx;
    // Перестраиваем на следующем кадре: select приходит из обработчика кнопки,
    // которую нельзя уничтожать посреди её же события.
    const rebuild = () => {
      if (this.rebuildPending) return;
      this.rebuildPending = true;
      this.events.once(Phaser.Scenes.Events.UPDATE, () => {
        this.rebuildPending = false;
        this.build();
      });
    };
    ui.on('palette', rebuild);
    ui.on('select', rebuild);
    this.scale.on(Phaser.Scale.Events.RESIZE, rebuild);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      ui.off('palette', rebuild);
      ui.off('select', rebuild);
      this.scale.off(Phaser.Scale.Events.RESIZE, rebuild);
    });
    this.build();
  }

  private build(): void {
    this.children.removeAll(true);
    const { width, height } = this.scale;
    this.cameras.main.setSize(width, height);

    const s = getDpr();
    const insets = this.ctx.platform.getSafeAreaInsets();
    const pad = 8 * s;
    const left = insets.left * s + pad;
    const right = width - insets.right * s - pad;

    const top = this.buildTopBar(left, insets.top * s + pad, right - left, s);
    const bottom = this.buildBuildBar(left, height - insets.bottom * s - pad, right - left, s);
    this.ctx.ui.blockers = [top, bottom];
  }

  private text(x: number, y: number, value: string, size: number, color: number, bold = false) {
    return this.add.text(x, y, value, {
      fontFamily: FONT,
      fontSize: `${size}px`,
      fontStyle: bold ? 'bold' : 'normal',
      color: toCss(color),
    });
  }

  private panel(x: number, y: number, w: number, h: number, s: number, stroke?: number): void {
    const { palette } = this.ctx.ui;
    const g = this.add.graphics();
    g.fillStyle(palette.hudBg, 0.94);
    g.fillRoundedRect(x, y, w, h, 12 * s);
    if (stroke !== undefined) {
      g.lineStyle(2 * s, stroke, 1);
      g.strokeRoundedRect(x, y, w, h, 12 * s);
    }
  }

  private buildTopBar(x: number, y: number, w: number, s: number): Phaser.Geom.Rectangle {
    const { palette } = this.ctx.ui;
    const h = 48 * s;
    this.panel(x, y, w, h, s);

    // Ресурсы справа налево: еда, затем золото.
    let cursor = x + w - 12 * s;
    const { resources: amounts, name: playerName } = this.ctx.base.player;
    const resources: [string, number, number][] = [
      [t('hud.food'), amounts.food, FOOD_COLOR],
      [t('hud.gold'), amounts.gold, GOLD_COLOR],
    ];
    for (const [label, amount, color] of resources) {
      const value = this.text(cursor, y + h / 2 + 1 * s, amount.toLocaleString(getLocale()), 16 * s, palette.hudText, true).setOrigin(1, 0);
      const caption = this.text(cursor, y + h / 2 + 1 * s, label, 11 * s, palette.hudMuted).setOrigin(1, 1);
      const textW = Math.max(value.width, caption.width);
      const iconX = cursor - textW - 14 * s;
      this.add.circle(iconX, y + h / 2, 9 * s, color).setStrokeStyle(2 * s, 0x000000, 0.2);
      cursor = iconX - 9 * s - 16 * s;
    }

    const nameX = x + 14 * s;
    const name = this.text(nameX, y + h / 2, playerName, 16 * s, palette.hudText, true).setOrigin(0, 0.5);
    const maxNameW = cursor - nameX;
    if (name.width > maxNameW) {
      name.setCrop(0, 0, maxNameW, name.height);
    }

    return new Phaser.Geom.Rectangle(x, y, w, h);
  }

  private buildBuildBar(x: number, bottomY: number, w: number, s: number): Phaser.Geom.Rectangle {
    const { ui } = this.ctx;
    const gap = 6 * s;
    const h = 72 * s;
    const y = bottomY - h;
    const count = BUILDING_TYPES.length;
    const btnW = (w - gap * (count - 1)) / count;

    BUILDING_TYPES.forEach((type, i) => {
      const bx = x + i * (btnW + gap);
      const selected = type === ui.selected;
      this.panel(bx, y, btnW, h, s, selected ? ui.palette.accent : undefined);
      this.drawSwatch(type, bx + btnW / 2, y + 26 * s, Math.min(btnW * 0.55, 34 * s));

      const label = this.text(bx + btnW / 2, y + h - 8 * s, t(`building.${type}`), 11 * s, ui.palette.hudText, selected);
      label.setOrigin(0.5, 1);
      if (label.width > btnW - 4 * s) label.setScale((btnW - 4 * s) / label.width);

      this.add
        .zone(bx, y, btnW, h)
        .setOrigin(0)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', (pointer: Phaser.Input.Pointer) => this.startDrag(type, pointer));
    });

    return new Phaser.Geom.Rectangle(x, y, w, h);
  }

  /** Маленький цветной ромб — превью здания в кнопке. */
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

  /** Нажатие выбирает здание; если не отпускать и потянуть — оно переносится на поле. */
  private startDrag(type: BuildingType, pointer: Phaser.Input.Pointer): void {
    if (type !== this.ctx.ui.selected) this.ctx.platform.haptic('selection');
    this.ctx.ui.startDrag(type, pointer.id);
  }
}
