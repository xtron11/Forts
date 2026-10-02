import type Phaser from 'phaser';
import type { TroopType } from '@forts/shared';
import { preloadUnitAtlas, UnitAnimations } from './unitAnims';

/**
 * Масштаб спрайта юнита (кадр 128×128 к клетке 64×32) — один на всех
 * юнитов и строителя. Герои будут примерно вдвое крупнее: 2 × UNIT_SCALE.
 */
export const UNIT_SCALE = 0.55;

/** Как выглядит войско. */
export interface UnitArt {
  /** Имя атласа в assets/units/. */
  atlas: string;
  /**
   * Сколько клеток проходит юнит за один цикл run при обычной скорости
   * анимации — по нему скорость анимации подгоняется под скорость движения,
   * чтобы ноги не скользили по земле.
   */
  runCycleTiles: number;
  /** То же для walk — шаг в лагере. */
  walkCycleTiles: number;
}

/** Войска со спрайтами; остальные пока рисуются фигурами-заглушками. Новому юниту достаточно строки здесь. */
export const TROOP_ART: Readonly<Partial<Record<TroopType, UnitArt>>> = {
  warrior: { atlas: 'knight_warrior', runCycleTiles: 0.9, walkCycleTiles: 0.45 },
};

/** Скорость бега заглушки (и спрайта без run), клеток в секунду. */
const STUB_RUN_SPEED = 1.3;

export function preloadTroopArt(scene: Phaser.Scene): void {
  for (const art of Object.values(TROOP_ART)) preloadUnitAtlas(scene, art.atlas);
}

/** Анимации войска; null — у войска нет спрайта или атлас не загрузился. */
export function troopAnimations(scene: Phaser.Scene, troop: TroopType): UnitAnimations | null {
  const art = TROOP_ART[troop];
  return art ? UnitAnimations.get(scene, art.atlas) : null;
}

/**
 * Скорость (клеток в секунду), при которой run с timeScale 1 не скользит.
 * Чтобы ноги не скользили при скорости v, timeScale = v / naturalRunSpeed.
 */
export function naturalRunSpeed(scene: Phaser.Scene, troop: TroopType): number {
  const art = TROOP_ART[troop];
  const run = troopAnimations(scene, troop)?.resolve(['run'], 's');
  if (!art || !run || run.fallback || run.duration <= 0) return STUB_RUN_SPEED;
  return art.runCycleTiles / (run.duration / 1000);
}

/** Без walk в атласе юнит идёт шагом через run, замедленный до этой доли. */
const SLOW_RUN_PACE = 0.6;

/** Как юнит ходит в лагере: анимация, её скорость и скорость движения (клеток в секунду) — ноги не скользят. */
export interface Gait {
  anim: 'walk' | 'run';
  timeScale: number;
  speed: number;
}

export function walkGait(scene: Phaser.Scene, troop: TroopType): Gait {
  const art = TROOP_ART[troop];
  const walk = troopAnimations(scene, troop)?.resolve(['walk'], 's');
  if (art && walk && !walk.fallback && walk.duration > 0) {
    return { anim: 'walk', timeScale: 1, speed: art.walkCycleTiles / (walk.duration / 1000) };
  }
  return { anim: 'run', timeScale: SLOW_RUN_PACE, speed: naturalRunSpeed(scene, troop) * SLOW_RUN_PACE };
}
