import { footprintSize, type PlacedBuilding } from '@forts/shared';

/** a целиком «за» b хотя бы по одной оси поля — значит, рисуется раньше. */
function isBehind(a: PlacedBuilding, b: PlacedBuilding): boolean {
  return a.col + footprintSize(a.type) <= b.col || a.row + footprintSize(a.type) <= b.row;
}

function frontKey(b: PlacedBuilding): number {
  const s = footprintSize(b.type);
  return b.col + b.row + 2 * s;
}

/**
 * Порядок отрисовки зданий с разным размером основания. Простая сортировка
 * по col+row ошибается для больших зданий, поэтому строим граф «кто за кем»
 * и сортируем топологически. Если оба здания «за» друг другом (стоят по
 * диагонали), на экране они не пересекаются и порядок не важен.
 */
export function sortByDepth(buildings: readonly PlacedBuilding[]): PlacedBuilding[] {
  const n = buildings.length;
  const inDegree = new Array<number>(n).fill(0);
  const edges: number[][] = buildings.map(() => []);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const a = buildings[i]!;
      const b = buildings[j]!;
      if (isBehind(a, b) && !isBehind(b, a)) {
        edges[i]!.push(j);
        inDegree[j]!++;
      }
    }
  }

  const result: PlacedBuilding[] = [];
  const done = new Array<boolean>(n).fill(false);
  for (let step = 0; step < n; step++) {
    // Из доступных берём самое «дальнее»; при цикле (не должен случаться) — любое оставшееся.
    const pickFrom = (ready: boolean) => {
      let pick = -1;
      for (let i = 0; i < n; i++) {
        if (done[i] || (ready && inDegree[i] !== 0)) continue;
        if (pick === -1 || frontKey(buildings[i]!) < frontKey(buildings[pick]!)) pick = i;
      }
      return pick;
    };
    let pick = pickFrom(true);
    if (pick === -1) pick = pickFrom(false);
    done[pick] = true;
    result.push(buildings[pick]!);
    for (const j of edges[pick]!) inDegree[j]!--;
  }
  return result;
}
