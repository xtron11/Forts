/**
 * Контракт HTTP API между клиентом и сервером: пути, тела запросов,
 * ответы и коды ошибок.
 */
import type { ArmyStack, TrainError, TrainingItem } from './army';
import type { PlacedBuilding, PlacementError } from './base';
import type { BuildingType } from './buildings';
import type { RuleError } from './economy';
import type { Resources, ResourceType } from './resources';
import type { TroopType } from './troops';

export const API_ROUTES = {
  authTelegram: '/auth/telegram',
  /** Вход тестового игрока; сервер регистрирует его только при NODE_ENV=development. */
  authDev: '/auth/dev',
  me: '/me',
  buildings: '/buildings',
  upgradeBuilding: '/buildings/:id/upgrade',
  collectBuilding: '/buildings/:id/collect',
  moveBuilding: '/buildings/:id/move',
  /** Заказать юниты в казарме. */
  trainTroops: '/army/train',
  /** Отменить юнит из очереди тренировки (еда возвращается). */
  cancelTraining: '/army/queue/:id/cancel',
  /** Ответ игрока на предложение присылать уведомления. */
  writeAccess: '/notifications/write-access',
} as const;

/** Путь с подставленным id здания или юнита в очереди, например /buildings/7/upgrade. */
export function buildingPath(route: string, id: number): string {
  return route.replace(':id', String(id));
}

// ---------- Вход ----------

/** Необязательные сведения о входе — общие для всех площадок. */
export interface LoginExtras {
  /** Часовой пояс устройства (IANA, например "Europe/Moscow") — для тихих часов уведомлений. */
  timezone?: string;
  /**
   * Параметр запуска (startapp): откуда пришёл игрок или по какому
   * уведомлению вошёл (notif_<тип>). Подписанный start_param из initData важнее.
   */
  startParam?: string;
}

export interface AuthTelegramRequest extends LoginExtras {
  /** Строка Telegram.WebApp.initData как есть. */
  initData: string;
}

export interface AuthDevRequest extends LoginExtras {
  /** Номер тестового игрока (положительное целое). */
  devId: number;
  name: string;
  languageCode: string;
  /**
   * Войти игроком с настоящим Telegram id — чтобы в режиме разработки
   * получать уведомления бота, открывая игру в браузере.
   */
  telegramId?: number;
}

/** Параметр запуска из кнопки уведомления: notif_build_done и т. п. */
export const NOTIFICATION_START_PREFIX = 'notif_';

/** Допустимый параметр запуска Telegram: до 64 символов A-Z a-z 0-9 _ -. */
export const START_PARAM_PATTERN = '^[A-Za-z0-9_-]{1,64}$';

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
  /**
   * Бот пока не может писать игроку, и пора (снова) предложить
   * уведомления — клиент показывает предложение после постройки.
   */
  askWriteAccess: boolean;
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
  army: ArmyDto;
}

/** Армия игрока: готовые юниты и очередь тренировки (по порядку готовности). */
export interface ArmyDto {
  /** Место в армии — сумма по казармам. */
  capacity: number;
  /** Занято готовыми юнитами и очередью. */
  used: number;
  troops: ArmyStack[];
  queue: TrainingItem[];
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

// ---------- Армия ----------

export interface TrainTroopsRequest {
  troop: TroopType;
  /** Сколько юнитов, 1..MAX_TRAIN_BATCH. */
  count: number;
}

export type TrainTroopsResponse = BaseSnapshot;

export type CancelTrainingResponse = BaseSnapshot;

// ---------- Уведомления ----------

export interface WriteAccessRequest {
  /** Разрешил ли игрок боту писать ему. */
  granted: boolean;
}

export type WriteAccessResponse = BaseSnapshot;

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
  | RuleError
  | TrainError;

export interface ApiErrorResponse {
  error: ApiErrorCode;
  /** Пояснение для разработчика; игроку показываем текст по коду ошибки. */
  message: string;
}
