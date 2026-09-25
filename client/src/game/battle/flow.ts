import type Phaser from 'phaser';
import { ApiError } from '../../api/ApiClient';
import { getGameContext } from '../context';
import { errorMessage } from '../messages';
import { BattleController } from './BattleController';

/**
 * Переход с базы в бой: сцены базы засыпают (их состояние сохраняется),
 * поверх запускаются сцены боя; сразу ищется цель. По 'exit' — обратно.
 */
export function openBattle(scene: Phaser.Scene): void {
  const ctx = getGameContext();
  if (ctx.battle) return;
  const scenes = scene.game.scene;
  const battle = new BattleController(ctx.api, ctx.base);
  ctx.battle = battle;
  let lastError: unknown;
  battle.on('error', (err: unknown) => (lastError = err));
  // Выходим после того, как закончится обработка нажатия «Домой»/«Назад»:
  // иначе то же касание дойдёт до проснувшихся сцен базы.
  battle.once('exit', () => setTimeout(close, 0));
  const close = () => {
    scenes.stop('battleHud');
    scenes.stop('battle');
    scenes.wake('world');
    scenes.wake('hud');
    ctx.battle = null;
    battle.removeAllListeners();
    // Поиск не удался с первого раза — объясняем уже на базе.
    if (lastError && battle.phase.kind === 'searching') {
      const msg = errorMessage(lastError instanceof ApiError ? lastError.code : 'network');
      ctx.ui.toast(msg.key, msg.params);
    }
  };
  ctx.ui.setMode({ kind: 'none' });
  scenes.sleep('hud');
  scenes.sleep('world');
  scenes.start('battle');
  scenes.start('battleHud');
  void battle.search(false);
}
