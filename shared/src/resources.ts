export const RESOURCE_TYPES = ['gold', 'food'] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

export type Resources = Record<ResourceType, number>;

/** Стартовый запас нового игрока. */
export const STARTING_RESOURCES: Readonly<Resources> = { gold: 1000, food: 1000 };
