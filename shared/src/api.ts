/**
 * Контракт HTTP API между клиентом и сервером: пути, тела запросов,
 * ответы и коды ошибок.
 */
import type { PlacedBuilding, PlacementError } from './base';
import type { BuildingType } from './buildings';
import type { Resources } from './resources';

export const API_ROUTES = {
  authTelegram: '/auth/telegram',
  /** Вход тестового игрока; сервер регистрирует его только при NODE_ENV=development. */
  authDev: '/auth/dev',
  me: '/me',
  buildings: '/buildings',
} as const;

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

export interface MeResponse {
  player: PlayerDto;
  buildings: PlacedBuilding[];
}

export interface PlaceBuildingRequest {
  type: BuildingType;
  x: number;
  y: number;
}

export interface PlaceBuildingResponse {
  building: PlacedBuilding;
}

// ---------- Ошибки ----------

export type ApiErrorCode =
  | 'validation'
  | 'unauthorized'
  | 'invalid_init_data'
  | 'init_data_expired'
  | 'not_found'
  | 'internal'
  | PlacementError;

export interface ApiErrorResponse {
  error: ApiErrorCode;
  /** Пояснение для разработчика; игроку показываем текст по коду ошибки. */
  message: string;
}
