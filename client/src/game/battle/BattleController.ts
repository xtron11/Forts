import Phaser from 'phaser';
import {
  addDeployment,
  armyUnits,
  BATTLE_MAX_TICKS,
  battleResult,
  canDeployAt,
  checkOrders,
  createBattle,
  remainingTroops,
  stepBattle,
  TROOP_TYPES,
  type ActiveBattleDto,
  type BattleBase,
  type BattleReport,
  type BattleState,
  type BattleTargetDto,
  type DeployOrder,
  type TroopType,
} from '@forts/shared';
import type { ApiClient } from '../../api/ApiClient';
import type { BaseStore } from '../BaseStore';

/** Как часто отправлять серверу высадки по ходу боя (после последней), мс. */
const SYNC_DELAY_MS = 1000;

export type BattlePhase =
  | { kind: 'searching' }
  | { kind: 'scout'; target: BattleTargetDto }
  | { kind: 'starting'; target: BattleTargetDto }
  | { kind: 'battle'; battle: ActiveBattleDto }
  | { kind: 'finishing'; battle: ActiveBattleDto }
  | { kind: 'result'; battle: ActiveBattleDto | null; report: BattleReport };

export type DeployRejection = 'forbidden_zone' | 'out_of_bounds' | 'none_left';

/**
 * Бой на клиенте: поиск цели, живой бой на том же движке, что и на
 * сервере (simulate из shared, пошагово), и итог — только от сервера.
 *
 * События: 'change' — сменилась фаза или то, что показывает интерфейс;
 * 'rejected' (причина, x, y) — высадка не удалась; 'exit' — вернуться на базу;
 * 'error' (код) — сетевая ошибка или отказ сервера.
 */
export class BattleController extends Phaser.Events.EventEmitter {
  phase: BattlePhase = { kind: 'searching' };
  /** Состояние живого боя (фаза battle/finishing/result). */
  sim: BattleState | null = null;
  /** Высадки игрока — то, что уйдёт на сервер. */
  orders: DeployOrder[] = [];
  selected: TroopType | null = null;
  /** Области экрана, занятые интерфейсом боя. */
  blockers: Phaser.Geom.Rectangle[] = [];
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;

  constructor(
    private readonly api: ApiClient,
    private readonly store: BaseStore,
  ) {
    super();
  }

  /** База, которую сейчас видно: цель поиска или база в бою. */
  get base(): BattleBase | null {
    const p = this.phase;
    if (p.kind === 'scout' || p.kind === 'starting') return p.target.base;
    if (p.kind === 'battle' || p.kind === 'finishing') return p.battle.base;
    if (p.kind === 'result') return p.battle?.base ?? null;
    return null;
  }

  private setPhase(phase: BattlePhase): void {
    this.phase = phase;
    this.emit('change');
  }

  /** Сколько юнитов каждого войска ещё можно высадить. */
  remaining(): Map<TroopType, number> {
    const p = this.phase;
    const army = p.kind === 'battle' || p.kind === 'finishing' ? p.battle.army : this.store.army.troops;
    return remainingTroops(army, this.orders);
  }

  async search(next: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const previous = this.phase;
    this.setPhase({ kind: 'searching' });
    try {
      const res = await this.api.searchBattle(next);
      this.store.apply(res);
      this.setPhase({ kind: 'scout', target: res.target });
    } catch (err) {
      this.emit('error', err);
      if (previous.kind === 'scout') this.setPhase(previous);
      else this.emit('exit');
    } finally {
      this.busy = false;
    }
  }

  async attack(): Promise<void> {
    const p = this.phase;
    if (p.kind !== 'scout' || this.busy) return;
    this.busy = true;
    this.setPhase({ kind: 'starting', target: p.target });
    try {
      const res = await this.api.startBattle();
      this.store.apply(res);
      const created = createBattle(res.battle.base, [], res.battle.seed, { log: true, endWhenNoTroops: false });
      if (!created.ok) throw new Error(`battle rejected: ${created.reason}`);
      this.sim = created.state;
      this.orders = [];
      // Сразу выбрано первое войско, которое есть в армии.
      const left = remainingTroops(res.battle.army, []);
      this.selected = TROOP_TYPES.find((t) => (left.get(t) ?? 0) > 0) ?? null;
      this.setPhase({ kind: 'battle', battle: res.battle });
    } catch (err) {
      this.emit('error', err);
      this.setPhase(p);
    } finally {
      this.busy = false;
    }
  }

  select(troop: TroopType): void {
    this.selected = troop;
    this.emit('change');
  }

  /**
   * Высадка выбранного войска на клетку (координаты базы) на текущем тике.
   * Возвращает причину отказа или null.
   */
  deploy(x: number, y: number): DeployRejection | null {
    const p = this.phase;
    const sim = this.sim;
    if (p.kind !== 'battle' || !sim || sim.finished) return null;
    const troop = this.selected;
    if (!troop || (this.remaining().get(troop) ?? 0) <= 0) return 'none_left';
    const zone = canDeployAt(p.battle.base, x, y);
    if (zone) return zone;

    const order: DeployOrder = { tick: sim.tick, troop, x, y };
    // Уровень — по тем же правилам, что на сервере (сначала старшие из армии на начало боя).
    const check = checkOrders(p.battle.base, p.battle.army, [...this.orders, order]);
    if (!check.ok) return 'none_left';
    const added = addDeployment(sim, check.deployments[check.deployments.length - 1]!);
    if (!added.ok) return added.reason === 'forbidden_zone' ? 'forbidden_zone' : 'out_of_bounds';
    this.orders.push(order);
    // Высажена вся армия — бой кончится, когда погибнут все юниты (как посчитает сервер).
    if (check.allTroopsUsed) sim.endWhenNoTroops = true;
    if ((this.remaining().get(troop) ?? 0) === 0) {
      const left = this.remaining();
      this.selected = TROOP_TYPES.find((t) => (left.get(t) ?? 0) > 0) ?? troop;
    }
    this.scheduleSync();
    this.emit('change');
    return null;
  }

  /** Один тик боя. Бой кончился сам — отправляем итог. */
  step(): void {
    const sim = this.sim;
    if (this.phase.kind !== 'battle' || !sim || sim.finished) return;
    stepBattle(sim);
    if (sim.finished) void this.finish();
  }

  /** Итог боя: высадки и тик конца уходят на сервер, показываем его ответ. */
  async finish(): Promise<void> {
    const p = this.phase;
    if (p.kind !== 'battle' || !this.sim) return;
    clearTimeout(this.syncTimer);
    const endTick = Math.min(this.sim.tick, BATTLE_MAX_TICKS);
    this.setPhase({ kind: 'finishing', battle: p.battle });
    const local = battleResult(this.sim);
    try {
      const res = await this.api.finishBattle(p.battle.id, this.orders, endTick);
      if (res.report.hash !== local.hash) console.warn('Battle result differs from the server', { local, server: res.report });
      this.store.apply(res);
      this.setPhase({ kind: 'result', battle: p.battle, report: res.report });
    } catch (err) {
      this.emit('error', err);
      // Не удалось — можно нажать ещё раз; бой на экране остановлен.
      this.setPhase({ kind: 'battle', battle: p.battle });
    }
  }

  exit(): void {
    clearTimeout(this.syncTimer);
    this.emit('exit');
  }

  /** Всего юнитов в армии, с которой можно идти в бой. */
  armySize(): number {
    return armyUnits(this.store.army.troops);
  }

  private scheduleSync(): void {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      const p = this.phase;
      if (p.kind !== 'battle') return;
      this.api.reportDeployments(p.battle.id, [...this.orders]).catch((err: unknown) => console.warn('Deployments sync failed', err));
    }, SYNC_DELAY_MS);
  }
}
