import type Phaser from 'phaser';
import { DIRECTIONS, type Direction } from '../builder/grid';

/** Формат {atlas}_anims.json. */
interface AnimsFile {
  fps: number;
  /** Точка, где стоят ноги, в долях кадра. */
  anchor: { x: number; y: number };
  /** Например "{anim}/{dir}/{frame:02d}". */
  frameName: string;
  animations: Record<string, { frames: number; loop: boolean; directions: string[]; fps?: number }>;
}

/** Анимация, которую нашёл resolve. */
export interface ResolvedAnim {
  /** Ключ анимации Phaser, например knight_warrior_run_se. */
  key: string;
  /** Имя анимации в атласе. */
  name: string;
  /** Играет не то, что просили (нет в атласе), — idle. */
  fallback: boolean;
  /** Один проход при timeScale 1, мс. */
  duration: number;
}

const folder = (atlas: string) => `assets/units/${atlas}`;
const jsonKey = (atlas: string) => `${atlas}_anims`;

/**
 * Загрузка атласа юнита: assets/units/{atlas}/{atlas}.json (multiatlas)
 * и {atlas}_anims.json. Повторный вызов ничего не грузит.
 */
export function preloadUnitAtlas(scene: Phaser.Scene, atlas: string): void {
  const dir = folder(atlas);
  if (!scene.textures.exists(atlas)) scene.load.multiatlas(atlas, `${dir}/${atlas}.json`, dir);
  if (!scene.cache.json.exists(jsonKey(atlas))) scene.load.json(jsonKey(atlas), `${dir}/${atlas}_anims.json`);
}

function frameName(pattern: string, anim: string, dir: string, frame: number): string {
  return pattern
    .replace('{anim}', anim)
    .replace('{dir}', dir)
    .replace(/\{frame(?::0?(\d+)d)?\}/, (_, width?: string) => String(frame).padStart(Number(width ?? 0), '0'));
}

/** Готовые анимации по атласам; анимации Phaser общие на всю игру. */
const created = new WeakMap<Phaser.Game, Map<string, UnitAnimations>>();

/**
 * Анимации юнита из атласа: ключи вида {atlas}_{anim}_{dir}. Всё, что
 * описано в json, создаётся само — новые анимации (death, victory…)
 * подхватываются без изменений кода. Создаются один раз на игру.
 */
export class UnitAnimations {
  private constructor(
    readonly texture: string,
    readonly anchor: { x: number; y: number },
    private readonly scene: Phaser.Scene,
  ) {}

  /**
   * null — атлас или json не загружены (ещё или из-за ошибки): тогда
   * рисуется заглушка. Как только загрузятся, следующий вызов создаст анимации.
   */
  static get(scene: Phaser.Scene, atlas: string): UnitAnimations | null {
    let byAtlas = created.get(scene.game);
    if (!byAtlas) created.set(scene.game, (byAtlas = new Map()));
    let result = byAtlas.get(atlas);
    if (!result) {
      result = UnitAnimations.create(scene, atlas) ?? undefined;
      if (result) byAtlas.set(atlas, result);
    }
    return result ?? null;
  }

  private static create(scene: Phaser.Scene, atlas: string): UnitAnimations | null {
    const file = scene.cache.json.get(jsonKey(atlas)) as AnimsFile | undefined;
    if (!file || !scene.textures.exists(atlas)) return null;
    const texture = scene.textures.get(atlas);
    for (const [anim, def] of Object.entries(file.animations)) {
      for (const dir of def.directions) {
        const key = `${atlas}_${anim}_${dir}`;
        if (scene.anims.exists(key)) continue;
        const frames = Array.from({ length: def.frames }, (_, i) => ({ key: atlas, frame: frameName(file.frameName, anim, dir, i) })).filter((f) =>
          texture.has(f.frame),
        );
        if (frames.length === 0) continue;
        scene.anims.create({ key, frames, frameRate: def.fps ?? file.fps, repeat: def.loop ? -1 : 0 });
      }
    }
    const result = new UnitAnimations(atlas, file.anchor, scene);
    return result.resolve(['idle'], 's') ? result : null;
  }

  /**
   * Анимация для направления; names — допустимые имена в атласе по порядку.
   * Нет в этом направлении — та же анимация в другом (victory бывает только
   * в s), нет совсем — idle.
   */
  resolve(names: readonly string[], dir: Direction): ResolvedAnim | undefined {
    const dirs = [dir, ...DIRECTIONS];
    for (const [list, fallback] of [
      [names, false],
      [['idle'], !names.includes('idle')],
    ] as const) {
      for (const name of list) {
        for (const d of dirs) {
          const key = `${this.texture}_${name}_${d}`;
          const anim = this.scene.anims.get(key);
          if (anim) return { key, name, fallback, duration: anim.duration };
        }
      }
    }
    return undefined;
  }

  /** Есть ли анимация name хотя бы в одном направлении. */
  has(name: string): boolean {
    return DIRECTIONS.some((d) => this.scene.anims.exists(`${this.texture}_${name}_${d}`));
  }

  /** Первый кадр idle лицом к зрителю — для иконок. */
  get portraitFrame(): string {
    const anim = this.scene.anims.get(this.resolve(['idle'], 's')!.key)!;
    return String(anim.frames[0]!.textureFrame);
  }
}
