import { Graphics } from 'pixi.js';
import { CHUNK_SIZE } from '../core/constants';
import { tileToWorldX, tileToWorldY } from '../core/iso';
import type { WaterField } from '../sim/water';
import type { World } from '../world/world';

/** 지하 보기에서만 사용하는 단일 배치 오버레이. 기존 청크 메시에는 손대지 않는다. */
export class WaterLayer {
  readonly graphics = new Graphics();
  private stamp = '';

  update(
    world: World,
    field: WaterField | null,
    visible: boolean,
    range: { cx0: number; cy0: number; cx1: number; cy1: number },
  ): void {
    this.graphics.visible = visible;
    if (!visible || !field) return;
    const stamp = `${field.revision}:${range.cx0},${range.cy0},${range.cx1},${range.cy1}`;
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    const g = this.graphics;
    g.clear();
    for (const n of field.nodes.values()) {
      if (
        n.x < range.cx0 * CHUNK_SIZE ||
        n.x >= (range.cx1 + 1) * CHUNK_SIZE ||
        n.y < range.cy0 * CHUNK_SIZE ||
        n.y >= (range.cy1 + 1) * CHUNK_SIZE
      )
        continue;
      if (!world.isExplored(Math.floor(n.x / CHUNK_SIZE), Math.floor(n.y / CHUNK_SIZE))) continue;
      const px = tileToWorldX(n.x, n.y),
        py = tileToWorldY(n.x, n.y, world.sampleHeight(n.x, n.y));
      const color =
        field.pipePollution(n.x, n.y) > 0 ? 0xff6464 : n.mask === 1 ? 0x60d9ff : 0xbd9568;
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
      ]) {
        const next = field.nodes.get(`${n.x + dx},${n.y + dy}`);
        if (!next) continue;
        // 모든 인접 관은 물리적으로 접촉한다. 종류가 다른 접점도 빨강으로 표시한다.
        const mixed = n.mask !== next.mask || n.mask === 3;
        g.moveTo(px, py)
          .lineTo(
            tileToWorldX(next.x, next.y),
            tileToWorldY(next.x, next.y, world.sampleHeight(next.x, next.y)),
          )
          .stroke({ color: mixed ? 0xff6464 : color, width: 5, alpha: 0.95 });
      }
      g.circle(px, py, n.mask === 3 ? 5 : 3).fill(color);
    }
  }
}
