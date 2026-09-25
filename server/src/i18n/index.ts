import { en } from './en';
import { ru } from './ru';

/** Русский словарь — эталон: в остальных должны быть те же ключи. */
export type TextKey = keyof typeof ru;
export type Dictionary = { [K in TextKey]: (typeof ru)[K] extends string ? string : readonly string[] };
export type Locale = 'ru' | 'en';

const dictionaries: Record<Locale, Dictionary> = { ru, en };

export function localeFor(languageCode: string | undefined | null): Locale {
  return languageCode?.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

/**
 * Перевод по ключу; {name} заменяется на params.name. Для фраз с
 * вариантами variant выбирает вариант по кругу.
 */
export function t(locale: Locale, key: TextKey, params?: Record<string, string | number>, variant = 0): string {
  const value = dictionaries[locale][key];
  const text = typeof value === 'string' ? value : value[((variant % value.length) + value.length) % value.length]!;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match));
}
