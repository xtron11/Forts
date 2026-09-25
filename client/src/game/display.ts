/** Сколько пикселей канваса приходится на CSS-пиксель (ограничено ради производительности). */
export function getDpr(): number {
  return Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
}
