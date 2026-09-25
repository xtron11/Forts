export type ResourceType = 'gold' | 'food';

export type Resources = Record<ResourceType, number>;

/** Стартовый запас нового игрока (пока просто отображается в HUD). */
export const STARTING_RESOURCES: Readonly<Resources> = { gold: 1000, food: 1000 };
