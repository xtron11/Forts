import Phaser from 'phaser';
import type { Platform } from '../platform';
import { setGameContext } from './context';
import { getDpr } from './display';
import { HudScene } from './scenes/HudScene';
import { WorldScene } from './scenes/WorldScene';
import { paletteFor, toCss } from './theme';
import { UiState } from './UiState';

/**
 * Канвас рендерится в физических пикселях (CSS-размер × dpr) и ужимается
 * обратно через zoom — так графика и текст чёткие на ретина-экранах.
 * Поэтому Scale.NONE и ручной ресайз по размеру контейнера.
 */
export function createGame(parent: HTMLElement, platform: Platform): Phaser.Game {
  const ui = new UiState(paletteFor(platform.getTheme()));
  setGameContext({ platform, player: platform.getPlayer(), ui });

  const dpr = getDpr();
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: Math.max(1, parent.clientWidth * dpr),
    height: Math.max(1, parent.clientHeight * dpr),
    backgroundColor: ui.palette.background,
    antialias: true,
    scale: { mode: Phaser.Scale.NONE, zoom: 1 / dpr },
    input: { activePointers: 2 },
    scene: [WorldScene, HudScene],
  });

  const fit = () => {
    const d = getDpr();
    const cssW = Math.max(1, parent.clientWidth);
    const cssH = Math.max(1, parent.clientHeight);
    const w = Math.round(cssW * d);
    const h = Math.round(cssH * d);
    if (game.scale.zoom !== 1 / d) game.scale.setZoom(1 / d);
    if (game.scale.width !== w || game.scale.height !== h) game.scale.resize(w, h);
    // ScaleManager не выставляет CSS-размер, если он совпал с размером канваса.
    game.canvas.style.width = `${cssW}px`;
    game.canvas.style.height = `${cssH}px`;
  };
  game.events.once(Phaser.Core.Events.READY, fit);
  new ResizeObserver(fit).observe(parent);
  window.addEventListener('resize', fit);
  platform.onViewportChange(fit);

  platform.onThemeChange((theme) => {
    const palette = paletteFor(theme);
    document.body.style.backgroundColor = toCss(palette.background);
    ui.setPalette(palette);
  });

  return game;
}
