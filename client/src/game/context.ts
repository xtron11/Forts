import type { ApiClient } from '../api/ApiClient';
import type { Platform } from '../platform';
import type { BaseStore } from './BaseStore';
import type { UiState } from './UiState';

export interface GameContext {
  platform: Platform;
  api: ApiClient;
  base: BaseStore;
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
