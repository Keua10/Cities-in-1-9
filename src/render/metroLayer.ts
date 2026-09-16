import { Graphics } from 'pixi.js';
import { CHUNK_SIZE } from '../core/constants';
import { tileToWorldX, tileToWorldY } from '../core/iso';
import type { World } from '../world/world';
import type { MetroNetwork } from '../sim/metro';

/** Underground plan projected on the corresponding surface tile, so picking stays terrain-correct. */
export class MetroLayer {
  readonly graphics = new Graphics();
  private stamp = '';
  draw(
    world: World,
    metro: MetroNetwork | null,
    visible: boolean,
    range: { cx0: number; cy0: number; cx1: number; cy1: number },
    selection: string | null,
  ): void {
    this.graphics.visible = visible;
    if (!visible || !metro) return;
    const stamp = `${metro.revision}:${world.walkRevision}:${selection}:${range.cx0},${range.cy0},${range.cx1},${range.cy1}`;
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    const g = this.graphics;
    g.clear();
    const point = (x: number, y: number): [number, number] => [
      Math.round(tileToWorldX(x, y)),
      Math.round(tileToWorldY(x, y, world.sampleHeight(x, y))),
    ];
    // Integer pixel steps preserve the same native pixel size as buildings and walkers.
    const line = (a: [number, number], b: [number, number], width: number, color: number) => {
      const steps = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), 1);
      for (let i = 0; i <= steps; i++)
        g.rect(
          Math.round(a[0] + ((b[0] - a[0]) * i) / steps) - Math.floor(width / 2),
          Math.round(a[1] + ((b[1] - a[1]) * i) / steps) - Math.floor(width / 2),
          width,
          width,
        ).fill(color);
    };
    for (const key of Object.keys(metro.state.tunnels)) {
      const [x, y] = key.split(',').map(Number);
      if (
        x < range.cx0 * CHUNK_SIZE - 1 ||
        x > (range.cx1 + 1) * CHUNK_SIZE ||
        y < range.cy0 * CHUNK_SIZE - 1 ||
        y > (range.cy1 + 1) * CHUNK_SIZE ||
        !world.isExplored(Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE))
      )
        continue;
      const p = point(x, y);
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
      ])
        if (metro.state.tunnels[`${x + dx},${y + dy}`]) {
          const end = point(x + dx, y + dy);
          line(p, end, 9, 0x14262e);
          line(p, end, 5, 0x729a9b);
          line(p, end, 1, 0xc0cec0);
        }
      g.rect(p[0] - 3, p[1] - 3, 6, 6).fill(0x729a9b);
      if (metro.state.stations[key]) {
        const connected = metro.connectedStations(key).length > 0;
        g.rect(p[0] - 11, p[1] - 9, 22, 18).fill(0x152731);
        g.rect(p[0] - 10, p[1] - 8, 20, 3).fill(connected ? 0x82bda3 : 0xdfb572);
        g.rect(p[0] - 8, p[1] - 3, 16, 9).fill(0x506772);
        for (const ox of [-6, 3]) g.rect(p[0] + ox, p[1] - 2, 4, 4).fill(0xc9ded7);
        g.rect(p[0] - 10, p[1] + 6, 20, 2).fill(0xdfb572);
      }
      if (key === selection) {
        g.rect(p[0] - 14, p[1] - 12, 28, 2).fill(0xf0d397);
        g.rect(p[0] - 14, p[1] + 10, 28, 2).fill(0xf0d397);
      }
    }
  }
}
