import Phaser from 'phaser';
import {
  busyBuilders,
  storageCapacity,
  townhallLevel,
  type ArmyDto,
  type BaseSnapshot,
  type BuildingType,
  type CollectResponse,
  type PlacedBuilding,
  type PlayerDto,
  type Resources,
  type TroopType,
} from '@forts/shared';
import type { ApiClient } from '../api/ApiClient';

/** Запас после finishAt перед запросом к серверу — на неточность оценки его часов. */
const REFRESH_MARGIN_MS = 300;
const RETRY_MS = 5000;
/**
 * Пока игра на экране, база обновляется хотя бы раз в минуту: сервер
 * видит, что игрок в игре, и не шлёт уведомлений о том, что тот и так видит.
 */
const HEARTBEAT_MS = 60_000;

/**
 * База игрока в том виде, в каком её подтвердил сервер, плюс оценка
 * времени сервера. Все изменения — только ответами сервера (apply);
 * событие 'change' — состояние заменено.
 *
 * Когда наступает ближайший finishAt, база перезапрашивается: сервер
 * завершает стройку, клиент получает новый уровень.
 */
export class BaseStore extends Phaser.Events.EventEmitter {
  player: PlayerDto;
  buildings: PlacedBuilding[];
  army: ArmyDto;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshing: Promise<void> | undefined;
  /** Действия, ждущие ответа сервера: повторный тап по тому же не отправляет второй запрос. */
  private inFlight = new Set<string>();

  constructor(
    private readonly api: ApiClient,
    snapshot: BaseSnapshot,
  ) {
    super();
    this.player = snapshot.player;
    this.buildings = snapshot.buildings;
    this.army = snapshot.army;
    this.scheduleRefresh();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.refresh();
    });
    setInterval(() => {
      if (document.visibilityState === 'visible') void this.refresh();
    }, HEARTBEAT_MS);
  }

  /** Оценка текущего времени сервера, мс. */
  now(): number {
    return this.api.serverNow();
  }

  get resources(): Resources {
    return this.player.resources;
  }

  capacity(): Resources {
    return storageCapacity(this.buildings, this.now());
  }

  townhallLevel(): number {
    return townhallLevel(this.buildings, this.now());
  }

  busyBuilders(): number {
    return busyBuilders(this.buildings, this.now());
  }

  get(id: number): PlacedBuilding | undefined {
    return this.buildings.find((b) => b.id === id);
  }

  isPending(key: string): boolean {
    return this.inFlight.has(key);
  }

  apply(snapshot: BaseSnapshot): void {
    this.player = snapshot.player;
    this.buildings = snapshot.buildings;
    this.army = snapshot.army;
    this.scheduleRefresh();
    this.emit('change');
  }

  refresh(): Promise<void> {
    this.refreshing ??= this.api
      .getMe()
      .then((snapshot) => this.apply(snapshot))
      .catch((err: unknown) => {
        console.warn('Refresh failed', err);
        this.setRefreshTimer(RETRY_MS);
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }

  // Действия. undefined — такой же запрос уже в пути; ошибки сервера — ApiError.

  place(type: BuildingType, x: number, y: number) {
    return this.run(`place:${x}:${y}`, () => this.api.placeBuilding({ type, x, y }));
  }

  upgrade(id: number) {
    return this.run(`upgrade:${id}`, () => this.api.upgradeBuilding(id));
  }

  collect(id: number): Promise<CollectResponse | undefined> {
    return this.run(`collect:${id}`, () => this.api.collect(id));
  }

  move(id: number, x: number, y: number) {
    return this.run(`move:${id}`, () => this.api.moveBuilding(id, { x, y }));
  }

  train(troop: TroopType) {
    return this.run(`train:${troop}`, () => this.api.trainTroops(troop, 1));
  }

  cancelTraining(id: number) {
    return this.run(`cancelTraining:${id}`, () => this.api.cancelTraining(id));
  }

  answerWriteAccess(granted: boolean) {
    return this.run('writeAccess', () => this.api.reportWriteAccess(granted));
  }

  private async run<T extends BaseSnapshot>(key: string, request: () => Promise<T>): Promise<T | undefined> {
    if (this.inFlight.has(key)) return undefined;
    this.inFlight.add(key);
    this.emit('pending');
    try {
      const result = await request();
      this.apply(result);
      return result;
    } finally {
      this.inFlight.delete(key);
      this.emit('pending');
    }
  }

  private scheduleRefresh(): void {
    const now = this.now();
    // Ближайшее событие: конец стройки или готовность юнита в казарме.
    const times = [...this.buildings.map((b) => b.finishAt), ...this.army.queue.map((q) => q.finishAt)];
    const next = Math.min(...times.map((at) => (at !== null && at > now - RETRY_MS ? at : Infinity)));
    if (next === Infinity) {
      clearTimeout(this.refreshTimer);
      return;
    }
    // Если стройка по нашим часам уже должна была закончиться, а сервер её не завершил — не чаще раза в секунду.
    this.setRefreshTimer(Math.max(1000, next - now + REFRESH_MARGIN_MS));
  }

  private setRefreshTimer(ms: number): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), ms);
  }
}
