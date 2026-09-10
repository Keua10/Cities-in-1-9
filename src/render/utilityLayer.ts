import { Graphics } from 'pixi.js';
import { CHUNK_SIZE, TILE_HW, TILE_HH } from '../core/constants';
import { tileToWorldX, tileToWorldY } from '../core/iso';
import type { WaterField } from '../sim/water';
import type { PowerField } from '../sim/power';
import type { World } from '../world/world';
export type UtilityMode = 'off' | 'water' | 'sewer' | 'power';
const COLORS = {
  water: 0x52cbff,
  sewer: 0xbc9164,
  power: 0xffdf55,
  shortage: 0xff9c45,
  polluted: 0xff5656,
  dead: 0x808996,
};

/** Coverage comes from simulation fields, not a separate visual approximation. */
export class UtilityLayer {
  readonly graphics = new Graphics();
  private stamp = '';
  update(
    world: World,
    water: WaterField | null,
    power: PowerField | null,
    mode: UtilityMode,
    range: { cx0: number; cy0: number; cx1: number; cy1: number },
  ): void {
    this.graphics.visible = mode !== 'off';
    if (mode === 'off' || !water || !power) return;
    const stamp = `${mode}:${world.utilityRevision}:${water.revision}:${power.revision}:${range.cx0},${range.cy0},${range.cx1},${range.cy1}`;
    if (this.stamp === stamp) return;
    this.stamp = stamp;
    const g = this.graphics;
    g.clear();
    const visible = (x: number, y: number) =>
      x >= range.cx0 * CHUNK_SIZE &&
      x < (range.cx1 + 1) * CHUNK_SIZE &&
      y >= range.cy0 * CHUNK_SIZE &&
      y < (range.cy1 + 1) * CHUNK_SIZE &&
      world.isExplored(Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE));
    const point = (x: number, y: number): [number, number] => [
      tileToWorldX(x, y),
      tileToWorldY(x, y, world.sampleHeight(x, y)),
    ];
    // Group equal styles into paths to keep the overlay batched.
    const fills = new Map<number, Array<[number, number]>>();
    const covered = mode === 'power' ? power.coverage : water.coverage;
    for (const [key, value] of covered) {
      const [x, y] = key.split(',').map(Number);
      if (!visible(x, y)) continue;
      const status = typeof value === 'number' ? null : value;
      const supply =
        typeof value === 'number' ? value : mode === 'sewer' ? value.drainage : value.supply;
      if (supply <= 0) continue;
      const color =
        mode === 'water' && status && status.contamination > 0
          ? COLORS.polluted
          : supply < 0.999
            ? COLORS.shortage
            : COLORS[mode];
      const points = fills.get(color) ?? [];
      points.push(point(x, y));
      fills.set(color, points);
    }
    for (const [color, points] of fills) {
      for (const [x, y] of points)
        g.poly([x, y - TILE_HH, x + TILE_HW, y, x, y + TILE_HH, x - TILE_HW, y]);
      g.fill({ color, alpha: 0.28 });
    }
    const lines = new Map<number, Array<[number, number, number, number]>>();
    const line = (ax: number, ay: number, bx: number, by: number, color: number) => {
      if (!visible(ax, ay) && !visible(bx, by)) return;
      const [a, b] = point(ax, ay),
        [c, d] = point(bx, by),
        rows = lines.get(color) ?? [];
      rows.push([a, b, c, d]);
      lines.set(color, rows);
    };
    if (mode === 'power') {
      for (const l of power.links) {
        if (!visible(l.ax, l.ay) && !visible(l.bx, l.by)) continue;
        const [ax, ay] = point(l.ax, l.ay),
          [bx, by] = point(l.bx, l.by);
        g.moveTo(ax, ay).lineTo(bx, by);
      }
      g.stroke({ color: 0xffedb0, width: 1.2, alpha: 0.55 });
      for (const n of power.wires.values()) {
        for (const [dx, dy] of [
          [1, 0],
          [0, 1],
        ])
          if (power.wires.has(`${n.x + dx},${n.y + dy}`)) {
            line(
              n.x,
              n.y,
              n.x + dx,
              n.y + dy,
              n.supply <= 0 ? COLORS.dead : n.supply < 0.999 ? COLORS.shortage : COLORS.power,
            );
          }
        if (!visible(n.x, n.y)) continue;
        const [x, y] = point(n.x, n.y);
        g.circle(x, y, 4).fill(n.supply > 0 ? COLORS.power : COLORS.dead);
      }
    } else {
      for (const n of water.nodes.values()) {
        const selected = !!(n.mask & (mode === 'water' ? 1 : 2));
        const color =
          water.pipePollution(n.x, n.y) > 0 && n.mask & 1
            ? COLORS.polluted
            : selected
              ? COLORS[mode]
              : COLORS.dead;
        for (const [dx, dy] of [
          [1, 0],
          [0, 1],
        ])
          if (water.nodes.has(`${n.x + dx},${n.y + dy}`)) line(n.x, n.y, n.x + dx, n.y + dy, color);
        if (visible(n.x, n.y)) {
          const [x, y] = point(n.x, n.y);
          g.circle(x, y, n.mask === 3 ? 5 : 3).fill(color);
        }
      }
    }
    for (const [color, segments] of lines) {
      for (const [ax, ay, bx, by] of segments) g.moveTo(ax, ay).lineTo(bx, by);
      g.stroke({ color: 0x14202b, width: 7, alpha: 0.9 });
      for (const [ax, ay, bx, by] of segments) g.moveTo(ax, ay).lineTo(bx, by);
      g.stroke({ color, width: mode === 'power' ? 3 : 4, alpha: 1 });
    }
  }
}
