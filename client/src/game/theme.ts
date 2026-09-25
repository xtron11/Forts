import type { ThemeInfo } from '../platform';

export interface Palette {
  background: number;
  tileA: number;
  tileB: number;
  tileLine: number;
  hudBg: number;
  hudText: number;
  hudMuted: number;
  accent: number;
  danger: number;
}

const LIGHT: Palette = {
  background: 0xe8eef2,
  tileA: 0x9ccc65,
  tileB: 0x8bc34a,
  tileLine: 0x689f38,
  hudBg: 0xffffff,
  hudText: 0x1f2933,
  hudMuted: 0x7b8794,
  accent: 0x2481cc,
  danger: 0xe53935,
};

const DARK: Palette = {
  background: 0x17212b,
  tileA: 0x4a6b35,
  tileB: 0x41602e,
  tileLine: 0x2f4721,
  hudBg: 0x232e3c,
  hudText: 0xf5f5f5,
  hudMuted: 0x8a9aa9,
  accent: 0x5eb5f7,
  danger: 0xef5350,
};

export function paletteFor(theme: ThemeInfo): Palette {
  const base = theme.scheme === 'dark' ? DARK : LIGHT;
  const bg = theme.bgColor && /^#[0-9a-f]{6}$/i.test(theme.bgColor) ? parseInt(theme.bgColor.slice(1), 16) : undefined;
  return bg === undefined ? base : { ...base, background: bg };
}

export function toCss(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/** Осветлить (amount > 0) или затемнить (amount < 0) цвет. */
export function shade(color: number, amount: number): number {
  const channel = (shift: number) => {
    const c = (color >> shift) & 0xff;
    const v = amount >= 0 ? c + (255 - c) * amount : c * (1 + amount);
    return Math.round(Math.min(255, Math.max(0, v))) << shift;
  };
  return channel(16) | channel(8) | channel(0);
}
