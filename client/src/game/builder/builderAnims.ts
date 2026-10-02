import type Phaser from 'phaser';
import { UNIT_SCALE } from '../units/art';
import { preloadUnitAtlas, UnitAnimations } from '../units/unitAnims';
import type { BuilderAnim } from './Builder';
import type { Direction } from './grid';

const KEY = 'wolf_builder';

/** Строитель того же размера, что и юниты. */
export const BUILDER_SPRITE_SCALE = UNIT_SCALE;

/** Имена анимаций в атласе для каждого состояния: удар по зданию может называться work или attack. */
const ANIM_NAMES: Readonly<Record<BuilderAnim, readonly string[]>> = {
  idle: ['idle'],
  walk: ['walk'],
  work: ['work', 'attack'],
};

export function preloadBuilder(scene: Phaser.Scene): void {
  preloadUnitAtlas(scene, KEY);
}

/**
 * Анимации строителя из атласа: ключи вида wolf_builder_idle_se. Всё, что
 * описано в json, создаётся само — добавить walk и work в атлас и json
 * достаточно, код менять не нужно. Чего нет, заменяется на idle.
 */
export class BuilderAnimations {
  readonly texture = KEY;

  private constructor(private readonly unit: UnitAnimations) {}

  get anchor(): { x: number; y: number } {
    return this.unit.anchor;
  }

  /** null — атлас или json не загрузились: тогда рисуется заглушка. */
  static create(scene: Phaser.Scene): BuilderAnimations | null {
    const unit = UnitAnimations.get(scene, KEY);
    if (!unit) console.warn('Builder atlas is not loaded, using a stub');
    return unit ? new BuilderAnimations(unit) : null;
  }

  /** Ключ анимации для состояния и направления; fallback — играет idle вместо того, что просили. */
  resolve(anim: BuilderAnim, dir: Direction): { key: string; anim: BuilderAnim; fallback: boolean } | undefined {
    const r = this.unit.resolve(ANIM_NAMES[anim], dir);
    return r && { key: r.key, anim: r.fallback ? 'idle' : anim, fallback: r.fallback };
  }
}
