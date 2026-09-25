import { en } from './en';
import { ru } from './ru';

/** Русский словарь — эталон: в остальных должны быть те же ключи. */
export type TextKey = keyof typeof ru;
export type Dictionary = Record<TextKey, string>;
export type Locale = 'ru' | 'en';

const dictionaries: Record<Locale, Dictionary> = { ru, en };

let locale: Locale = 'en';

export function initI18n(languageCode: string): Locale {
  locale = languageCode.toLowerCase().startsWith('ru') ? 'ru' : 'en';
  document.documentElement.lang = locale;
  return locale;
}

export function getLocale(): Locale {
  return locale;
}

/** Перевод по ключу; {name} в строке заменяется на params.name. */
export function t(key: TextKey, params?: Record<string, string | number>): string {
  const text = dictionaries[locale][key];
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match));
}
