/**
 * Базы-боты: шаблоны для разных уровней ратуши и генератор, который
 * слегка варьирует шаблон по seed (поворот/отражение, уровни, ресурсы).
 * Результат — обычный BattleBase, как у реального игрока.
 */
import { levelConfig, producerLevel } from '../balance';
import { BASE_GRID_SIZE, BUILDINGS, type BuildingType } from '../buildings';
import type { Resources } from '../resources';
import { MATCH_TOWNHALL_RANGE } from './config';
import { idiv, Rng } from './math';
import type { BattleBase, BattleBuilding } from './types';

export interface BotTemplate {
  id: string;
  townhallLevel: number;
  /**
   * Карта 12×12, строка — ряд y. Буква заполняет всё основание здания:
   * T ратуша (3×3), G шахта, F ферма, B казарма (2×2), D башня, W стена, . пусто.
   */
  layout: readonly string[];
}

const LETTERS: Readonly<Record<string, BuildingType>> = {
  T: 'townhall',
  G: 'goldmine',
  F: 'farm',
  B: 'barracks',
  D: 'tower',
  W: 'wall',
};

/** Уровни зданий бота по уровню ратуши 1..5. */
// prettier-ignore
const LEVELS_BY_TOWNHALL: Readonly<Record<BuildingType, readonly number[]>> = {
  townhall: [1, 2, 3, 4, 5],
  goldmine: [1, 2, 3, 4, 5],
  farm:     [1, 2, 3, 4, 5],
  barracks: [1, 1, 2, 3, 4],
  tower:    [1, 1, 2, 3, 4],
  wall:     [1, 1, 2, 3, 4],
};

/** Ресурсы в хранилище бота (золото и еда, до разброса) по уровню ратуши. */
const BOT_STORAGE: readonly number[] = [1200, 3000, 8000, 20000, 50000];

/** Разброс генератора. */
const RESOURCE_SPREAD_PERCENT = 15;
const STORED_MIN_PERCENT = 20;
const STORED_MAX_PERCENT = 90;
/** Шанс, что здание (кроме ратуши) на уровень ниже шаблона, %. */
const LEVEL_DROP_PERCENT = 20;

// prettier-ignore
export const BOT_TEMPLATES: readonly BotTemplate[] = [
  { id: 'th1-farmstead', townhallLevel: 1, layout: [
    '............',
    '.GG......FF.',
    '.GG......FF.',
    '............',
    '............',
    '....TTT.....',
    '....TTT.....',
    '....TTT.....',
    '............',
    '.FF...BB.GG.',
    '.FF...BB.GG.',
    '............',
  ] },
  { id: 'th1-corner', townhallLevel: 1, layout: [
    '............',
    '............',
    '..TTT.GG....',
    '..TTT.GG....',
    '..TTT.......',
    '........FF..',
    '..BB....FF..',
    '..BB........',
    '.....GG.....',
    '.....GG..FF.',
    '.........FF.',
    '............',
  ] },
  { id: 'th2-fence', townhallLevel: 2, layout: [
    '............',
    '.GG......FF.',
    '.GG......FF.',
    '............',
    '...WWWWWW...',
    '....TTT.....',
    '....TTT.D...',
    '....TTT.....',
    '.W........W.',
    '.GG..BB..FF.',
    '.GG..BB..FF.',
    '............',
  ] },
  { id: 'th2-line', townhallLevel: 2, layout: [
    '............',
    '..FF..GG....',
    '..FF..GG....',
    '............',
    '.GG.......D.',
    '.GG.TTT.....',
    '....TTT.FF..',
    '....TTT.FF..',
    '..WWWWWWWW..',
    '............',
    '....BB..GG..',
    '....BB..GG..',
  ] },
  { id: 'th2-sides', townhallLevel: 2, layout: [
    '............',
    '.FF.GG.FF...',
    '.FF.GG.FF...',
    '............',
    '...W.....W..',
    '...W.TTT.W..',
    '...W.TTT.W..',
    '...W.TTTDW..',
    '............',
    '..BB...GG...',
    '..BB...GG...',
    '............',
  ] },
  { id: 'th3-keep', townhallLevel: 3, layout: [
    '.GG..FF..GG.',
    '.GG..FF..GG.',
    '............',
    '...WWWWW....',
    '...WTTTW..D.',
    '...WTTTW....',
    '...WTTTW....',
    '...WWWWW....',
    '.D..........',
    '.FF..BB..FF.',
    '.FF..BB..FF.',
    '............',
  ] },
  { id: 'th3-rampart', townhallLevel: 3, layout: [
    '............',
    '.GG.GG.FF...',
    '.GG.GG.FF...',
    '............',
    'WWWWWWWWWWWW',
    '....TTT..D..',
    '..D.TTT.....',
    '....TTT.....',
    'WWWW........',
    '.BB..BB.FF..',
    '.BB..BB.FF..',
    '............',
  ] },
  { id: 'th3-posts', townhallLevel: 3, layout: [
    '..FF....GG..',
    '..FF....GG..',
    '............',
    '.W.W.W.W.W..',
    '............',
    '..GG.TTT.FF.',
    '..GG.TTT.FF.',
    '...D.TTT.D..',
    '............',
    '.W.W.W.W.W..',
    '..BB....GG..',
    '..BB....GG..',
  ] },
  { id: 'th4-ring', townhallLevel: 4, layout: [
    'GG.FF.GG.FF.',
    'GG.FF.GG.FF.',
    '..WWWWWWW...',
    '..WD....W...',
    '..W.TTT.W.D.',
    '..W.TTT.W...',
    '..W.TTT.W.BB',
    '..W....DW.BB',
    '..WWWWWWW...',
    '............',
    'GG.FF..BB.FF',
    'GG.FF..BB.FF',
  ] },
  { id: 'th4-bands', townhallLevel: 4, layout: [
    '............',
    '.GG.GG.GG...',
    '.GG.GG.GG...',
    'WWWWWWWWWWWW',
    '.D..TTT..D..',
    '....TTT.....',
    '....TTT...D.',
    'WWWWWWWWWWWW',
    '............',
    '.FF.FF.FF.BB',
    '.FF.FF.FF.BB',
    '............',
  ] },
  { id: 'th5-citadel', townhallLevel: 5, layout: [
    'GG.FF.GG.FF.',
    'GG.FF.GG.FF.',
    '..WWWWWWW.D.',
    '..WD...DW...',
    '..W.TTT.W.BB',
    '..W.TTT.W.BB',
    '..W.TTT.W...',
    '..W.....W.D.',
    '..WWWWWWW...',
    'WWWW....WWWW',
    'GG.FF.BB.FF.',
    'GG.FF.BB.FF.',
  ] },
  { id: 'th5-bastion', townhallLevel: 5, layout: [
    '.GG.FF.GG.FF',
    '.GG.FF.GG.FF',
    '............',
    '.WWWWWWWWWW.',
    '.W.D....D.W.',
    '.W..TTT...W.',
    '.W..TTT...W.',
    '.W..TTT...W.',
    '.W.D....D.W.',
    '.WWWWWWWWWW.',
    'GG.BB.BB.FF.',
    'GG.BB.BB.FF.',
  ] },
];

export interface LayoutBuilding {
  type: BuildingType;
  x: number;
  y: number;
}

/** Здания из карты шаблона: верхний левый угол каждого основания, по порядку обхода строк. */
export function parseLayout(layout: readonly string[]): LayoutBuilding[] {
  const n = layout.length;
  const claimed = layout.map((row) => row.split('').map((c) => c === '.'));
  const result: LayoutBuilding[] = [];
  for (let y = 0; y < n; y++) {
    const row = layout[y]!;
    if (row.length !== n) throw new Error(`bot layout: row ${y} has ${row.length} cells, expected ${n}`);
    for (let x = 0; x < n; x++) {
      if (claimed[y]![x]) continue;
      const letter = row[x]!;
      const type = LETTERS[letter];
      if (!type) throw new Error(`bot layout: unknown cell "${letter}" at (${x}, ${y})`);
      const size = BUILDINGS[type].size;
      for (let dy = 0; dy < size; dy++) {
        for (let dx = 0; dx < size; dx++) {
          if (layout[y + dy]?.[x + dx] !== letter || claimed[y + dy]![x + dx]) {
            throw new Error(`bot layout: ${type} at (${x}, ${y}) is not a full ${size}×${size} block`);
          }
          claimed[y + dy]![x + dx] = true;
        }
      }
      result.push({ type, x, y });
    }
  }
  return result;
}

/**
 * Поворот/отражение основания size×size на поле n×n; variant 0..7
 * (бит 0 — транспонирование, бит 1 — отражение по x, бит 2 — по y).
 */
function transform(variant: number, x: number, y: number, size: number, n: number): { x: number; y: number } {
  let px = x;
  let py = y;
  if (variant & 1) [px, py] = [py, px];
  if (variant & 2) px = n - px - size;
  if (variant & 4) py = n - py - size;
  return { x: px, y: py };
}

export function botTemplate(id: string): BotTemplate | undefined {
  return BOT_TEMPLATES.find((t) => t.id === id);
}

/** Шаблоны для атакующего с ратушей townhallLevel: ратуша бота в пределах ±MATCH_TOWNHALL_RANGE. */
export function botTemplatesFor(townhallLevel: number): BotTemplate[] {
  return BOT_TEMPLATES.filter((t) => Math.abs(t.townhallLevel - townhallLevel) <= MATCH_TOWNHALL_RANGE);
}

/** База-бот из шаблона; один и тот же seed — одна и та же база. */
export function generateBotBase(template: BotTemplate, seed: number): BattleBase {
  const rng = new Rng(seed);
  const n = BASE_GRID_SIZE;
  const th = template.townhallLevel;
  const variant = rng.int(8);
  const buildings: BattleBuilding[] = parseLayout(template.layout).map((b, i) => {
    const size = BUILDINGS[b.type].size;
    const { x, y } = transform(variant, b.x, b.y, size, n);
    let level = LEVELS_BY_TOWNHALL[b.type][th - 1]!;
    if (b.type !== 'townhall' && level > 1 && rng.int(100) < LEVEL_DROP_PERCENT) level--;
    if (!levelConfig(b.type, level)) throw new Error(`bot ${template.id}: no level ${level} for ${b.type}`);
    const prod = producerLevel(b.type, level);
    const stored = prod ? idiv(prod.capacity * (STORED_MIN_PERCENT + rng.int(STORED_MAX_PERCENT - STORED_MIN_PERCENT + 1)), 100) : 0;
    return { id: i + 1, type: b.type, level, x, y, stored };
  });
  const storage = BOT_STORAGE[th - 1]!;
  const spread = () => idiv(storage * (100 - RESOURCE_SPREAD_PERCENT + rng.int(2 * RESOURCE_SPREAD_PERCENT + 1)), 100);
  const resources: Resources = { gold: spread(), food: spread() };
  return { gridSize: n, resources, buildings };
}
