import type { BattleReport, TroopType } from '@forts/shared';

/** Кто и что играет в окне итога. */
export interface ResultPose {
  troop: TroopType;
  anim: 'victory' | 'defeat';
}

/**
 * Персонаж для окна итога. Победа — случайное войско из выживших,
 * поражение — из погибших. Берутся только войска, у которых эта анимация
 * есть в атласе; таких нет — null, персонаж не показывается.
 */
export function pickResultPose(
  report: Pick<BattleReport, 'stars' | 'troopsUsed' | 'troopsSurvived'>,
  hasAnim: (troop: TroopType, anim: string) => boolean,
  random: () => number = Math.random,
): ResultPose | null {
  const anim = report.stars > 0 ? 'victory' : 'defeat';
  const count = new Map<TroopType, number>();
  const add = (list: BattleReport['troopsUsed'], sign: number) => {
    for (const t of list) count.set(t.troop, (count.get(t.troop) ?? 0) + sign * t.count);
  };
  if (anim === 'victory') {
    add(report.troopsSurvived, 1);
  } else {
    // Погибшие = высаженные − выжившие.
    add(report.troopsUsed, 1);
    add(report.troopsSurvived, -1);
  }
  const candidates = [...count].filter(([troop, n]) => n > 0 && hasAnim(troop, anim)).map(([troop]) => troop);
  if (candidates.length === 0) return null;
  return { troop: candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))]!, anim };
}
