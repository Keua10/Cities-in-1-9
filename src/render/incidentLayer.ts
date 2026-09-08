import { Graphics } from 'pixi.js';
import { TILE_HH } from '../core/constants';
import { chunkIndexOf, tileToWorldX, tileToWorldY } from '../core/iso';
import { levelOfCode } from '../sim/buildings';
import type { DisasterSim } from '../sim/disasters';
import type { World } from '../world/world';

const INCIDENT_COLORS = [0xf26b38, 0xf5bd4f, 0xb999ff] as const;

/** 최대 128개 사건만 단일 Graphics에 표시. 건물 메시나 저장 타일은 건드리지 않는다. */
export class IncidentLayer {
  readonly graphics = new Graphics();
  draw(
    world: World,
    sim: DisasterSim,
    range: { cx0: number; cy0: number; cx1: number; cy1: number },
  ): void {
    const g = this.graphics;
    g.clear();
    for (const e of sim.active) {
      const cx = chunkIndexOf(e.tx),
        cy = chunkIndexOf(e.ty);
      if (
        cx < range.cx0 ||
        cx > range.cx1 ||
        cy < range.cy0 ||
        cy > range.cy1 ||
        !world.isExplored(cx, cy) ||
        !sim.at(e.tx, e.ty, world)
      )
        continue;
      const span = levelOfCode(e.code);
      const tx = e.tx + (span - 1) / 2,
        ty = e.ty + (span - 1) / 2;
      const x = tileToWorldX(tx, ty);
      const y = tileToWorldY(tx, ty, world.sampleHeight(e.tx, e.ty)) - TILE_HH * span * 1.8;
      const color = INCIDENT_COLORS[e.kind];
      g.moveTo(x, y + 12)
        .lineTo(x, y + 24)
        .stroke({ color, width: 2 });
      g.circle(x, y, 12).fill({ color: 0x17212d, alpha: 0.95 }).stroke({ color, width: 2 });
      if (e.kind === 0) {
        g.poly([x, y - 9, x + 7, y + 2, x + 3, y + 7, x - 4, y + 7, x - 7, y + 1]).fill(color);
        g.poly([x, y - 1, x + 3, y + 5, x - 3, y + 5]).fill(0xffef9d);
      } else if (e.kind === 1) {
        g.rect(x - 2, y - 7, 4, 9).fill(color);
        g.circle(x, y + 6, 2).fill(color);
      } else {
        g.rect(x - 2, y - 7, 4, 14).fill(color);
        g.rect(x - 7, y - 2, 14, 4).fill(color);
      }
    }
  }
}
