import { getLocale, t } from '../i18n';

export function formatNumber(n: number): string {
  return Math.floor(n).toLocaleString(getLocale());
}

/** Длительность для цен: «10 с», «5 мин», «1 ч 30 мин». */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return t('time.instant');
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (h) parts.push(t('time.h', { n: h }));
  if (m) parts.push(t('time.m', { n: m }));
  if (s && !h) parts.push(t('time.s', { n: s }));
  return parts.join(' ');
}

/** Обратный отсчёт: «0:45», «12:05», «1:02:09». */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v: number) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
