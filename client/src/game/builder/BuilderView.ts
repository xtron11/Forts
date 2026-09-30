import type Phaser from 'phaser';
import { cellToWorld } from '../iso';
import type { Builder, BuilderAnim } from './Builder';
import { BUILDER_SPRITE_SCALE, type BuilderAnimations } from './builderAnims';
import { DIRECTIONS, type Direction } from './grid';

/** Строитель на экране: объект для сортировки по глубине и покадровое обновление. */
export interface BuilderView {
  readonly obj: Phaser.GameObjects.Components.Depth;
  update(builder: Builder, time: number): void;
}

/**
 * Заглушка анимации, пока её нет в атласе: ходьба — подпрыгивание,
 * работа — «удары» (приседание). Для idle и настоящих анимаций — ничего.
 */
function placeholderPose(anim: BuilderAnim, time: number): { lift: number; squash: number } {
  if (anim === 'walk') return { lift: Math.abs(Math.sin(time / 90)) * 3, squash: 1 };
  if (anim === 'work') return { lift: 0, squash: 1 - 0.1 * Math.max(0, Math.sin((time / 550) * Math.PI * 2)) };
  return { lift: 0, squash: 1 };
}

/** Появление после перестановки без ходьбы. */
function flashOnTeleport(scene: Phaser.Scene, target: Phaser.GameObjects.GameObject, builder: Builder, seen: { teleports: number }): void {
  if (builder.teleports === seen.teleports) return;
  seen.teleports = builder.teleports;
  scene.tweens.add({ targets: target, alpha: { from: 0, to: 1 }, duration: 250 });
}

class SpriteBuilderView implements BuilderView {
  readonly obj: Phaser.GameObjects.Sprite;
  private seen = { teleports: 0 };
  private playing: BuilderAnim | undefined;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly anims: BuilderAnimations,
  ) {
    this.obj = scene.add.sprite(0, 0, anims.texture).setOrigin(anims.anchor.x, anims.anchor.y).setScale(BUILDER_SPRITE_SCALE);
  }

  update(builder: Builder, time: number): void {
    const resolved = this.anims.resolve(builder.anim, builder.dir);
    if (resolved && this.obj.anims.currentAnim?.key !== resolved.key) {
      // Поворот в той же анимации продолжает её с того же кадра, а не с начала.
      const progress = this.obj.anims.getProgress();
      this.obj.play(resolved.key);
      if (this.playing === resolved.anim) this.obj.anims.setProgress(progress);
      this.playing = resolved.anim;
    }
    const pose = resolved?.fallback ? placeholderPose(builder.anim, time) : placeholderPose('idle', time);
    const p = cellToWorld(builder.col, builder.row);
    this.obj.setPosition(p.x, p.y - pose.lift).setScale(BUILDER_SPRITE_SCALE, BUILDER_SPRITE_SCALE * pose.squash);
    flashOnTeleport(this.scene, this.obj, builder, this.seen);
  }
}

const STUB_COLORS: Readonly<Record<BuilderAnim, number>> = { idle: 0x8d6e63, walk: 0x42a5f5, work: 0xffa726 };

/** Заглушка из фигур: цвет — состояние, «нос» — направление взгляда. */
class StubBuilderView implements BuilderView {
  readonly obj: Phaser.GameObjects.Container;
  private readonly body: Phaser.GameObjects.Graphics;
  private drawn = '';
  private seen = { teleports: 0 };

  constructor(private readonly scene: Phaser.Scene) {
    const shadow = scene.add.graphics().fillStyle(0x000000, 0.25).fillEllipse(0, 0, 20, 9);
    this.body = scene.add.graphics();
    this.obj = scene.add.container(0, 0, [shadow, this.body]);
  }

  update(builder: Builder, time: number): void {
    const state = `${builder.anim}:${builder.dir}`;
    if (state !== this.drawn) {
      this.drawn = state;
      this.draw(builder.anim, builder.dir);
    }
    const pose = placeholderPose(builder.anim, time);
    const p = cellToWorld(builder.col, builder.row);
    this.obj.setPosition(p.x, p.y);
    this.body.setY(-pose.lift).setScale(1, pose.squash);
    flashOnTeleport(this.scene, this.obj, builder, this.seen);
  }

  private draw(anim: BuilderAnim, dir: Direction): void {
    // s — вниз по экрану, дальше по часовой через w; y сплющен, как у изометрии.
    const angle = Math.PI / 2 + (DIRECTIONS.indexOf(dir) * -Math.PI) / 4;
    const nose = { x: Math.cos(angle) * 9, y: -30 + Math.sin(angle) * 5 };
    this.body
      .clear()
      .fillStyle(STUB_COLORS[anim], 1)
      .fillRoundedRect(-7, -24, 14, 20, 4)
      .fillStyle(0x78909c, 1)
      .fillCircle(0, -30, 7)
      .lineStyle(3, 0x263238, 1)
      .lineBetween(0, -30, nose.x, nose.y)
      .lineStyle(1, 0x263238, 0.8)
      .strokeRoundedRect(-7, -24, 14, 20, 4)
      .strokeCircle(0, -30, 7);
  }
}

/** Спрайт из атласа, а если атлас не загрузился — заглушка. */
export function createBuilderView(scene: Phaser.Scene, anims: BuilderAnimations | null): BuilderView {
  return anims ? new SpriteBuilderView(scene, anims) : new StubBuilderView(scene);
}
