import Phaser from 'phaser';
import type { TroopType } from '@forts/shared';
import { drawTroop } from '../battle/troopView';
import type { Direction } from '../builder/grid';
import { troopAnimations, UNIT_SCALE } from './art';
import type { UnitAnimations } from './unitAnims';

/** Сколько мёртвый юнит лежит после анимации death, прежде чем исчезнуть, мс. */
const DEATH_LINGER_MS = 1000;
const DEATH_FADE_MS = 250;

export interface PlayOptions {
  /** Скорость анимации, 1 — как в атласе. */
  timeScale?: number;
  /** С какой доли цикла (0..1) начать, если анимация меняется. Без него idle начинается со случайного кадра. */
  start?: number;
}

/**
 * Юнит на экране — спрайт из атласа или фигура-заглушка. Положение —
 * точка ног в мировых координатах; что играть, решает тот, кто двигает.
 */
export interface UnitView {
  /** От ног до макушки при обычном размере, мировые единицы. */
  readonly height: number;
  /** Анимация в направлении; повторный вызов с той же — только меняет скорость. Чего нет в атласе — idle. */
  play(name: string, dir: Direction, opts?: PlayOptions): void;
  /** Длительность цикла при timeScale 1, мс; 0 — такой анимации нет (играется заменитель). */
  cycleMs(name: string): number;
  /** Перемотать текущую анимацию на долю цикла 0..1. */
  setProgress(progress: number): void;
  setPosition(x: number, y: number): void;
  /** Множитель к обычному размеру: в бою юниты крупнее при сильном отдалении камеры. */
  setSize(k: number): void;
  setDepth(depth: number): void;
  /** Пауза анимации — для юнитов за пределами экрана. */
  setPaused(paused: boolean): void;
  /** death один раз (или угасание, если её нет), через секунду исчезает; затем onDone. */
  die(dir: Direction, onDone: () => void): void;
  destroy(): void;
}

class SpriteUnitView implements UnitView {
  readonly height: number;
  private readonly sprite: Phaser.GameObjects.Sprite;
  private playing: string | undefined;
  private paused = false;
  private dying = false;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly anims: UnitAnimations,
  ) {
    this.sprite = scene.add.sprite(0, 0, anims.texture, anims.portraitFrame).setOrigin(anims.anchor.x, anims.anchor.y).setScale(UNIT_SCALE);
    // Фигура занимает примерно верхнюю половину кадра над ногами.
    this.height = this.sprite.frame.realHeight * 0.45 * UNIT_SCALE;
  }

  play(name: string, dir: Direction, opts: PlayOptions = {}): void {
    if (this.dying) return;
    const resolved = this.anims.resolve([name], dir);
    if (!resolved) return;
    const state = this.sprite.anims;
    if (state.currentAnim?.key !== resolved.key) {
      const progress = state.getProgress();
      this.sprite.play(resolved.key);
      // Поворот в той же анимации продолжает её с того же кадра.
      if (opts.start !== undefined) state.setProgress(opts.start);
      else if (this.playing === resolved.name) state.setProgress(progress);
      else if (resolved.name === 'idle') state.setProgress(Math.random());
      this.playing = resolved.name;
      if (this.paused) state.pause();
    }
    state.timeScale = opts.timeScale ?? 1;
  }

  cycleMs(name: string): number {
    const resolved = this.anims.resolve([name], 's');
    return resolved && !resolved.fallback ? resolved.duration : 0;
  }

  setProgress(progress: number): void {
    this.sprite.anims.setProgress(Phaser.Math.Clamp(progress, 0, 1));
  }

  setPosition(x: number, y: number): void {
    this.sprite.setPosition(x, y);
  }

  setSize(k: number): void {
    this.sprite.setScale(UNIT_SCALE * k);
  }

  setDepth(depth: number): void {
    this.sprite.setDepth(depth);
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused || this.dying) return;
    this.paused = paused;
    if (paused) this.sprite.anims.pause();
    else this.sprite.anims.resume();
  }

  die(dir: Direction, onDone: () => void): void {
    if (this.dying) return;
    this.dying = true;
    const death = this.anims.resolve(['death'], dir);
    if (!death || death.fallback) {
      shrinkAway(this.scene, [this.sprite], onDone);
      return;
    }
    this.sprite.anims.resume();
    this.sprite.anims.timeScale = 1;
    this.sprite.play({ key: death.key, repeat: 0 });
    this.sprite.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => {
      this.scene.tweens.add({ targets: this.sprite, alpha: 0, delay: DEATH_LINGER_MS, duration: DEATH_FADE_MS, onComplete: onDone });
    });
  }

  destroy(): void {
    this.scene.tweens.killTweensOf(this.sprite);
    this.sprite.destroy();
  }
}

/** Размер заглушки (примерный диаметр) — чтобы рядом со спрайтами она не терялась. */
const STUB_SIZE: Readonly<Record<TroopType, number>> = { warrior: 18, archer: 18, ram: 24 };

/** Фигура из troopView: run и walk — подпрыгивание, остальное — без движения. */
class StubUnitView implements UnitView {
  readonly height: number;
  private readonly obj: Phaser.GameObjects.Container;
  private readonly body: Phaser.GameObjects.Graphics;
  private anim = 'idle';
  private paused = false;
  private dying = false;

  constructor(
    private readonly scene: Phaser.Scene,
    troop: TroopType,
  ) {
    const size = STUB_SIZE[troop];
    const shadow = scene.add.ellipse(0, 0, size * 1.2, size * 0.5, 0x000000, 0.25);
    this.body = scene.add.graphics();
    drawTroop(this.body, troop, size);
    this.body.setY(-size * 0.6);
    this.obj = scene.add.container(0, 0, [shadow, this.body]);
    this.height = size * 1.1;
  }

  play(name: string): void {
    this.anim = name;
  }

  cycleMs(): number {
    return 0;
  }

  setProgress(): void {}

  setPosition(x: number, y: number): void {
    const lift = (this.anim === 'run' || this.anim === 'walk') && !this.paused && !this.dying ? Math.abs(Math.sin(this.scene.time.now / 90)) * 3 : 0;
    this.obj.setPosition(x, y);
    this.body.setY(-this.height * 0.55 - lift);
  }

  setSize(k: number): void {
    if (!this.dying) this.obj.setScale(k);
  }

  setDepth(depth: number): void {
    this.obj.setDepth(depth);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  die(_dir: Direction, onDone: () => void): void {
    if (this.dying) return;
    this.dying = true;
    shrinkAway(this.scene, [this.obj], onDone);
  }

  destroy(): void {
    this.scene.tweens.killTweensOf(this.obj);
    this.obj.destroy();
  }
}

function shrinkAway(scene: Phaser.Scene, targets: Phaser.GameObjects.GameObject[], onDone: () => void): void {
  const obj = targets[0] as unknown as Phaser.GameObjects.Components.Transform;
  scene.tweens.add({ targets, alpha: 0, scale: obj.scaleX * 0.4, duration: 350, onComplete: onDone });
}

/** Спрайт войска, а если спрайта нет или атлас не загрузился — заглушка. */
export function createUnitView(scene: Phaser.Scene, troop: TroopType): UnitView {
  const anims = troopAnimations(scene, troop);
  return anims ? new SpriteUnitView(scene, anims) : new StubUnitView(scene, troop);
}

/** Точка мира видна камере (с запасом margin) — иначе юнит не анимируется. */
export function isOnCamera(camera: Phaser.Cameras.Scene2D.Camera, x: number, y: number, margin: number): boolean {
  const v = camera.worldView;
  return x >= v.x - margin && x <= v.right + margin && y >= v.y - margin && y <= v.bottom + margin;
}
