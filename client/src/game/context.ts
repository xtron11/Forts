import type { PlacedBuilding, PlayerDto } from '@forts/shared';
import type { ApiClient } from '../api/ApiClient';
import type { Platform } from '../platform';
import type { UiState } from './UiState';

/** База игрока в том виде, в каком её подтвердил сервер. */
export interface BaseState {
  player: PlayerDto;
  buildings: PlacedBuilding[];
}

export interface GameContext {
  platform: Platform;
  api: ApiClient;
  base: BaseState;
  ui: UiState;
}

let current: GameContext | undefined;

export function setGameContext(ctx: GameContext): void {
  current = ctx;
}

export function getGameContext(): GameContext {
  if (!current) throw new Error('Game context is not initialized');
  return current;
}
