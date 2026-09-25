import type { Platform, PlayerInfo } from '../platform';
import type { UiState } from './UiState';

export interface GameContext {
  platform: Platform;
  player: PlayerInfo;
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
