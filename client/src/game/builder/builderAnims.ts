import type Phaser from 'phaser';
import type { BuilderAnim } from './Builder';
import { DIRECTIONS, type Direction } from './grid';

const KEY = 'wolf_builder';
const ANIMS_KEY = `${KEY}_anims`;
const DIR = `assets/units/${KEY}`;

/** Масштаб кадра 128×128 относительно клетки 64×32 — чисто визуальный. */
export const BUILDER_SPRITE_SCALE = 0.55;

/** Имена анимаций в атласе для каждого состояния: удар по зданию может называться work или attack. */
const ANIM_NAMES: Readonly<Record<BuilderAnim, readonly string[]>> = {
  idle: ['idle'],
  walk: ['walk'],
  work: ['work', 'attack'],
};

/** Формат wolf_builder_anims.json. */
interface AnimsFile {
  fps: number;
  anchor: { x: number; y: number };
  /** Например "{anim}/{dir}/{frame:02d}". */
  frameName: string;
  animations: Record<string, { frames: number; loop: boolean; directions: string[]; fps?: number }>;
}

export function preloadBuilder(scene: Phaser.Scene): void {
  if (!scene.textures.exists(KEY)) scene.load.multiatlas(KEY, `${DIR}/${KEY}.json`, DIR);
  if (!scene.cache.json.exists(ANIMS_KEY)) scene.load.json(ANIMS_KEY, `${DIR}/${KEY}_anims.json`);
}

function frameName(pattern: string, anim: string, dir: string, frame: number): string {
  return pattern
    .replace('{anim}', anim)
    .replace('{dir}', dir)
    .replace(/\{frame(?::0?(\d+)d)?\}/, (_, width?: string) => String(frame).padStart(Number(width ?? 0), '0'));
}

/**
 * Анимации строителя из атласа: ключи вида wolf_builder_idle_se. Всё, что
 * описано в json, создаётся само — добавить walk и work в атлас и json
 * достаточно, код менять не нужно. Чего нет, заменяется на idle.
 */
export class BuilderAnimations {
  readonly texture = KEY;

  private constructor(
    readonly anchor: { x: number; y: number },
    private readonly scene: Phaser.Scene,
  ) {}

  /** null — атлас или json не загрузились: тогда рисуется заглушка. */
  static create(scene: Phaser.Scene): BuilderAnimations | null {
    const file = scene.cache.json.get(ANIMS_KEY) as AnimsFile | undefined;
    if (!file || !scene.textures.exists(KEY)) {
      console.warn('Builder atlas is not loaded, using a stub');
      return null;
    }
    const texture = scene.textures.get(KEY);
    for (const [anim, def] of Object.entries(file.animations)) {
      for (const dir of def.directions) {
        const key = `${KEY}_${anim}_${dir}`;
        if (scene.anims.exists(key)) continue;
        const frames = Array.from({ length: def.frames }, (_, i) => ({ key: KEY, frame: frameName(file.frameName, anim, dir, i) })).filter((f) =>
          texture.has(f.frame),
        );
        if (frames.length === 0) continue;
        scene.anims.create({ key, frames, frameRate: def.fps ?? file.fps, repeat: def.loop ? -1 : 0 });
      }
    }
    const result = new BuilderAnimations(file.anchor, scene);
    return result.resolve('idle', 's') ? result : null;
  }

  /**
   * Ключ анимации для состояния и направления. Нет нужной — idle в том же
   * направлении, затем idle в любом. fallback — играет не то, что просили.
   */
  resolve(anim: BuilderAnim, dir: Direction): { key: string; anim: BuilderAnim; fallback: boolean } | undefined {
    const own = ANIM_NAMES[anim].map((name): [string, BuilderAnim, Direction] => [name, anim, dir]);
    const idle = [dir, ...DIRECTIONS].map((d): [string, BuilderAnim, Direction] => ['idle', 'idle', d]);
    for (const [name, a, d] of [...own, ...idle]) {
      const key = `${KEY}_${name}_${d}`;
      if (this.scene.anims.exists(key)) return { key, anim: a, fallback: a !== anim };
    }
    return undefined;
  }
}
