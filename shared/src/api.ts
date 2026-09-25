/**
 * Контракт HTTP API между клиентом и сервером: пути, тела запросов,
 * ответы и коды ошибок.
 */
import type { PlacedBuilding, PlacementError } from './base';
import type { BuildingType } from './buildings';
import type { RuleError } from './economy';
import type { Resources, ResourceType } from './resources';

export const API_ROUTES = {
  authTelegram: '/auth/telegram',
  /** Вход тестового игрока; сервер регистрирует его только при NODE_ENV=development. */
  authDev: '/auth/dev',
  me: '/me',
  buildings: '/buildings',
  upgradeBuilding: '/buildings/:id/upgrade',
  collectBuilding: '/buildings/:id/collect',
  moveBuilding: '/buildings/:id/move',
} as const;

/** Путь с подставленным id здания, например /buildings/7/upgrade. */
export function buildingPath(route: string, id: number): string {
  return route.replace(':id', String(id));
}

// ---------- Вход ----------

export interface AuthTelegramRequest {
  /** Строка Telegram.WebApp.initData как есть. */
  initData: string;
}

export interface AuthDevRequest {
  /** Номер тестового игрока (положительное целое). */
  devId: number;
  name: string;
  languageCode: string;
}

/** Чем клиент подтверждает личность; выдаёт платформенный слой. */
export type LoginCredentials = ({ kind: 'telegram' } & AuthTelegramRequest) | ({ kind: 'dev' } & AuthDevRequest);

export interface AuthResponse {
  /** JWT для заголовка Authorization: Bearer. */
  token: string;
  /** Срок жизни токена в секундах. */
  expiresIn: number;
}

// ---------- Игрок и база ----------

export interface PlayerDto {
  id: number;
  name: string;
  languageCode: string;
  resources: Resources;
}

/**
 * Состояние базы на момент serverTime. Его возвращают все игровые запросы,
 * клиент просто заменяет им своё.
 */
export interface BaseSnapshot {
  /** Время сервера (мс Unix), на которое посчитано состояние; по нему клиент поправляет свои часы. */
  serverTime: number;
  player: PlayerDto;
  buildings: PlacedBuilding[];
}

export type MeResponse = BaseSnapshot;

export interface PlaceBuildingRequest {
  type: BuildingType;
  x: number;
  y: number;
}

export interface PlaceBuildingResponse extends BaseSnapshot {
  building: PlacedBuilding;
}

export type UpgradeBuildingResponse = BaseSnapshot;

export interface CollectResponse extends BaseSnapshot {
  collected: { resource: ResourceType; amount: number };
}

export interface MoveBuildingRequest {
  x: number;
  y: number;
}

export type MoveBuildingResponse = BaseSnapshot;

// ---------- Ошибки ----------

export type ApiErrorCode =
  | 'validation'
  | 'unauthorized'
  | 'invalid_init_data'
  | 'init_data_expired'
  | 'not_found'
  | 'internal'
  | 'not_producer'
  | 'nothing_to_collect'
  | 'storage_full'
  | PlacementError
  | RuleError;

export interface ApiErrorResponse {
  error: ApiErrorCode;
  /** Пояснение для разработчика; игроку показываем текст по коду ошибки. */
  message: string;
}
