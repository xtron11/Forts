import type Phaser from 'phaser';
import { TROOPS, type TroopType } from '@forts/shared';
import { shade } from '../theme';
import { troopAnimations } from '../units/art';

/**
 * Юнит-заглушка с центром в (0, 0): у каждого войска своя фигура, чтобы
 * их было легко различить на поле. size — примерный диаметр.
 */
export function drawTroop(g: Phaser.GameObjects.Graphics, troop: TroopType, size: number): void {
  const color = TROOPS[troop].color;
  const r = size / 2;
  g.lineStyle(Math.max(1, size / 8), shade(color, -0.55), 1);
  g.fillStyle(color, 1);
  switch (troop) {
    case 'warrior':
      g.fillCircle(0, 0, r);
      g.strokeCircle(0, 0, r);
      // Меч.
      g.lineStyle(Math.max(1, size / 7), 0xeceff1, 1).lineBetween(r * 0.1, r * 0.35, r * 0.9, -r * 0.6);
      break;
    case 'archer':
      g.fillTriangle(0, -r * 1.1, r, r * 0.8, -r, r * 0.8);
      g.strokeTriangle(0, -r * 1.1, r, r * 0.8, -r, r * 0.8);
      break;
    case 'ram':
      g.fillRoundedRect(-r * 1.3, -r * 0.7, r * 2.6, r * 1.4, r * 0.3);
      g.strokeRoundedRect(-r * 1.3, -r * 0.7, r * 2.6, r * 1.4, r * 0.3);
      g.fillStyle(shade(color, -0.4), 1).fillCircle(-r * 0.7, r * 0.7, r * 0.35).fillCircle(r * 0.7, r * 0.7, r * 0.35);
      break;
  }
}

/**
 * Иконка войска с центром в (x, y): первый кадр idle из атласа, а если
 * спрайта нет (или атлас ещё не загружен) — фигура-заглушка. size — как у drawTroop.
 */
export function addTroopIcon(scene: Phaser.Scene, troop: TroopType, x: number, y: number, size: number): Phaser.GameObjects.Image | Phaser.GameObjects.Graphics {
  const anims = troopAnimations(scene, troop);
  if (!anims) {
    const g = scene.add.graphics().setPosition(x, y);
    drawTroop(g, troop, size);
    return g;
  }
  // Фигура — примерно половина высоты кадра над ногами; вписываем её в 1.6 × size.
  const image = scene.add.image(0, 0, anims.texture, anims.portraitFrame).setOrigin(anims.anchor.x, anims.anchor.y);
  const body = image.frame.realHeight * 0.45;
  const scale = (size * 1.6) / body;
  return image.setScale(scale).setPosition(x, y + (body * scale) / 2);
}

/**
 * Юнит во весь рост лицом к зрителю, играет anim (victory/defeat в окне итога;
 * нет в атласе — idle). (x, y) — точка ног, height — место над ногами.
 * Если спрайта нет — иконка-заглушка.
 */
export function addTroopPose(
  scene: Phaser.Scene,
  troop: TroopType,
  anim: string,
  x: number,
  y: number,
  height: number,
): Phaser.GameObjects.Sprite | Phaser.GameObjects.Image | Phaser.GameObjects.Graphics {
  const anims = troopAnimations(scene, troop);
  const resolved = anims?.resolve([anim], 's');
  if (!anims || !resolved) return addTroopIcon(scene, troop, x, y - height / 2, height / 2);
  const sprite = scene.add.sprite(x, y, anims.texture, anims.portraitFrame).setOrigin(anims.anchor.x, anims.anchor.y);
  // С поднятым оружием фигура занимает до ~55% кадра над ногами.
  sprite.setScale(height / (sprite.frame.realHeight * 0.55));
  sprite.play(resolved.key);
  return sprite;
}
