export type ResourceType = 'gold' | 'food';

export type Resources = Record<ResourceType, number>;

/** Стартовый запас нового игрока. */
export const STARTING_RESOURCES: Readonly<Resources> = { gold: 1000, food: 1000 };
