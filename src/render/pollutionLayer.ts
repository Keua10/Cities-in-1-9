import { Graphics } from 'pixi.js';
import { CHUNK_SIZE, TILE_HW, TILE_HH } from '../core/constants';
import { tileToWorldX, tileToWorldY } from '../core/iso';
import { isAnchor, levelOfCode, zoneOfCode, ZONE_I } from '../sim/buildings';
import { DISCHARGE_RADIUS } from '../sim/config/water';
import { INDUSTRY_NUISANCE_RADIUS } from '../sim/simConstants';
import type { WaterField } from '../sim/water';
import { isWater } from '../world/terrain';
import type { World } from '../world/world';

/**
 * 오염 범위를 **항상 보이게** 덧대는 반투명 레이어 (수정사항 11).
 *
 * 오염은 이미 시뮬레이션 안에서 돌고 있었지만 화면에는 아무것도 없었다. 직접
 * 방류구 옆에 하천 취수장을 놓아도 물빛은 그대로고, 공업단지 주변 땅이 더러워져도
 * 보이지 않는다. 그래서 플레이어는 "왜 인구가 빠지지" 만 겪고 원인을 못 찾는다.
 *
 * 급수 범위 오버레이와 같은 방식(반투명 덧칠)을 쓴다. 지형 아틀라스를 건드리지
 * 않으므로 청크 draw call 구조가 그대로다 — 청크 메시 구조는 절대 바꾸지 않는다.
 *
 *   붉은 물   방류구에서 퍼진 하천 오염. 이 범위 안에 하천 취수장이 있으면
 *             그 물이 그대로 수돗물이 된다.
 *   누런 땅   공업 건물이 만드는 토양·대기 오염. 등급이 높을수록 진하다.
 *
 * 값은 전부 시뮬레이션에서 읽는다. 화면용 근사치를 따로 만들지 않는다 —
 * 보이는 것과 실제가 어긋나면 안 보이는 것만 못하다.
 */
const WATER_TINT = 0xd0442c;
const GROUND_TINT = 0xb08a2a;
/** 아주 옅은 오염까지 칠하면 화면이 늘 누렇다. 이 아래는 그리지 않는다. */
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
    if (!enabled || !water) return;
    const stamp = `${world.utilityRevision}:${water.revision}:${range.cx0},${range.cy0},${range.cx1},${range.cy1}`;
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
    for (const d of water.dischargePoints()) {
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

    // 2) 토양 오염: 공업 건물에서 INDUSTRY_NUISANCE_RADIUS 만큼 퍼진다.
    //    만족도가 쓰는 공업 혐오와 같은 반경이라 화면과 규칙이 어긋나지 않는다.
    const r = INDUSTRY_NUISANCE_RADIUS;
    for (let cy = range.cy0; cy <= range.cy1; cy++) {
      for (let cx = range.cx0; cx <= range.cx1; cx++) {
        const p = world.peekParcel(cx, cy);
        if (!p?.bld) continue;
        for (let i = 0; i < p.bld.length; i++) {
          const code = p.bld[i];
          if (!isAnchor(code) || zoneOfCode(code) !== ZONE_I) continue;
          const level = levelOfCode(code);
          const ax = cx * CHUNK_SIZE + (i % CHUNK_SIZE);
          const ay = cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
          const peak = 0.25 + 0.25 * level;
          for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              const dist = Math.abs(dx) + Math.abs(dy);
              if (dist > r) continue;
              const tx = ax + dx;
              const ty = ay + dy;
              if (isWater(world.getTile(tx, ty))) continue;
              bump(groundTiles, tx, ty, peak * (1 - dist / (r + 1)));
            }
          }
        }
      }
    }

    // 알파를 4단계로 양자화해 같은 색끼리 한 번에 칠한다. 오버레이가
    // 타일마다 fill 을 부르면 큰 도시에서 draw call 이 폭발한다.
    const draw = (tiles: Map<number, number>, color: number, maxAlpha: number) => {
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
        g.fill({ color, alpha: (maxAlpha * step) / 4 });
      }
    };
    draw(waterTiles, WATER_TINT, 0.55);
    draw(groundTiles, GROUND_TINT, 0.34);
  }
}

const cxOf = (v: number) => Math.floor(v / CHUNK_SIZE);
