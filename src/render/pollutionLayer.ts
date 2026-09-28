import { Graphics } from 'pixi.js';
import { CHUNK_SIZE, TILE_HW, TILE_HH } from '../core/constants';
import { tileToWorldX, tileToWorldY } from '../core/iso';
import { groundPollutionFor } from '../sim/groundPollution';
import { DISCHARGE_RADIUS } from '../sim/config/water';
import type { WaterField } from '../sim/water';
import { isWater } from '../world/terrain';
import type { World } from '../world/world';

/** Soot-purple soil and murky green water stay distinct from yellow zoning/sand.
 * Pattern marks communicate contamination even when underlying colors are similar. */
const WATER_TINT = 0x365333;
const GROUND_TINT = 0x503f58;
const MIN_VISIBLE = 0.08;

export class PollutionLayer {
  readonly graphics = new Graphics();
  private stamp = '';

  update(
    world: World,
    water: WaterField | null,
    range: { cx0: number; cy0: number; cx1: number; cy1: number },
    enabled: boolean,
  ): void {
    this.graphics.visible = enabled;
    if (!enabled) return;
    const ground = groundPollutionFor(world);
    const stamp = `${world.walkRevision}:${world.utilityRevision}:${water?.revision ?? 0}:${ground.revision}:${range.cx0},${range.cy0},${range.cx1},${range.cy1}`;
    if (this.stamp === stamp) return;
    this.stamp = stamp;

    const g = this.graphics;
    g.clear();
    const x0 = range.cx0 * CHUNK_SIZE;
    const x1 = (range.cx1 + 1) * CHUNK_SIZE;
    const y0 = range.cy0 * CHUNK_SIZE;
    const y1 = (range.cy1 + 1) * CHUNK_SIZE;

    /** 타일 -> 0~1 오염. 물과 땅을 따로 모은다(색이 다르다). */
    const waterTiles = new Map<number, number>();
    const groundTiles = new Map<number, number>();
    const idx = (x: number, y: number) => (y - y0) * (x1 - x0) + (x - x0);
    const bump = (map: Map<number, number>, x: number, y: number, v: number) => {
      if (x < x0 || x >= x1 || y < y0 || y >= y1) return;
      const k = idx(x, y);
      const prev = map.get(k) ?? 0;
      if (v > prev) map.set(k, v);
    };

    // 1) 하천 오염: 방류 지점에서 거리에 따라 옅어진다. 시뮬레이션의
    //    DISCHARGE_RADIUS 와 같은 반경·같은 감쇠를 쓴다.
    for (const d of water?.dischargePoints() ?? []) {
      const cx = d.x + (d.span - 1) / 2;
      const cy = d.y + (d.span - 1) / 2;
      const r = Math.ceil(DISCHARGE_RADIUS);
      for (let ty = Math.floor(cy) - r; ty <= Math.ceil(cy) + r; ty++) {
        for (let tx = Math.floor(cx) - r; tx <= Math.ceil(cx) + r; tx++) {
          if (!isWater(world.getTile(tx, ty))) continue;
          const fall = 1 - Math.hypot(tx - cx, ty - cy) / DISCHARGE_RADIUS;
          if (fall <= 0) continue;
          bump(waterTiles, tx, ty, Math.min(1, d.strength * fall));
        }
      }
    }

    // Includes sources outside the visible chunk range whose plumes reach into it.
    for (const tile of ground.tiles.values()) bump(groundTiles, tile.tx, tile.ty, tile.value);

    // 알파를 4단계로 양자화해 같은 색끼리 한 번에 칠한다. 오버레이가
    // 타일마다 fill 을 부르면 큰 도시에서 draw call 이 폭발한다.
    const draw = (
      tiles: Map<number, number>,
      color: number,
      maxAlpha: number,
      waterSurface: boolean,
    ) => {
      const buckets = new Map<number, Array<[number, number]>>();
      for (const [k, v] of tiles) {
        if (v < MIN_VISIBLE) continue;
        const step = Math.min(4, Math.max(1, Math.ceil(v * 4)));
        const tx = x0 + (k % (x1 - x0));
        const ty = y0 + Math.floor(k / (x1 - x0));
        if (!world.isExplored(cxOf(tx), cxOf(ty))) continue;
        const rows = buckets.get(step) ?? [];
        rows.push([tx, ty]);
        buckets.set(step, rows);
      }
      for (const [step, rows] of buckets) {
        for (const [tx, ty] of rows) {
          const px = tileToWorldX(tx, ty);
          const py = tileToWorldY(tx, ty, world.sampleHeight(tx, ty));
          g.poly([px, py - TILE_HH, px + TILE_HW, py, px, py + TILE_HH, px - TILE_HW, py]);
        }
        g.fill({ color, alpha: 0.12 + (maxAlpha * step) / 4 });
        // Small deterministic surface marks, batched per intensity (no per-tile sprites).
        let marks = 0;
        for (const [tx, ty] of rows) {
          if ((tx + ty) % 2 !== 0 || step < 2) continue;
          marks++;
          const px = tileToWorldX(tx, ty);
          const py = tileToWorldY(tx, ty, world.sampleHeight(tx, ty));
          if (waterSurface) {
            g.ellipse(px - 5, py, 10, 2);
            g.ellipse(px + 9, py + 4, 5, 1.5);
          } else {
            g.rect(px - 10, py - 3, 6, 2);
            g.rect(px + 3, py + 2, 8, 3);
          }
        }
        if (marks) g.fill({ color: waterSurface ? 0xb5bd62 : 0x211c2b, alpha: 0.2 + step * 0.1 });
      }
    };
    draw(waterTiles, WATER_TINT, 0.58, true);
    draw(groundTiles, GROUND_TINT, 0.48, false);
  }
}

const cxOf = (v: number) => Math.floor(v / CHUNK_SIZE);
