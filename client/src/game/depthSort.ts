import { footprintSize, type BuildingPlacement } from '@forts/shared';

/**
 * Квадрат клеток на поле, по которому считается порядок отрисовки: основание
 * здания или клетка под ногами юнита (координаты могут быть дробными).
 */
export interface DepthBox {
  x: number;
  y: number;
  size: number;
}

export function buildingBox(b: BuildingPlacement): DepthBox {
  return { x: b.x, y: b.y, size: footprintSize(b.type) };
}

/** a целиком «за» b хотя бы по одной оси поля — значит, рисуется раньше. */
function isBehind(a: DepthBox, b: DepthBox): boolean {
  return a.x + a.size <= b.x || a.y + a.size <= b.y;
}

/** Ближний к зрителю угол: для юнита растёт вместе с Y ног на экране. */
function frontKey(b: DepthBox): number {
  return b.x + b.y + 2 * b.size;
}

/**
 * Порядок отрисовки объектов с разным размером основания. Простая сортировка
 * по x+y ошибается для больших зданий, поэтому строим граф «кто за кем»
 * и сортируем топологически. Если оба объекта «за» друг другом (стоят по
 * диагонали), на экране они не пересекаются и порядок не важен.
 */
export function sortByDepth<T>(items: readonly T[], boxOf: (item: T) => DepthBox): T[] {
  const boxes = items.map(boxOf);
  const n = items.length;
  const inDegree = new Array<number>(n).fill(0);
  const edges: number[][] = items.map(() => []);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (isBehind(a, b) && !isBehind(b, a)) {
        edges[i]!.push(j);
        inDegree[j]!++;
      }
    }
  }

  const result: T[] = [];
  const done = new Array<boolean>(n).fill(false);
  for (let step = 0; step < n; step++) {
    // Из доступных берём самое «дальнее»; при цикле (не должен случаться) — любое оставшееся.
    const pickFrom = (ready: boolean) => {
      let pick = -1;
      for (let i = 0; i < n; i++) {
        if (done[i] || (ready && inDegree[i] !== 0)) continue;
        if (pick === -1 || frontKey(boxes[i]!) < frontKey(boxes[pick]!)) pick = i;
      }
      return pick;
    };
    let pick = pickFrom(true);
    if (pick === -1) pick = pickFrom(false);
    done[pick] = true;
    result.push(items[pick]!);
    for (const j of edges[pick]!) inDegree[j]!--;
  }
  return result;
}
