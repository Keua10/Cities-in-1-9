import {
  VEHICLE_BODY_LENGTH_TILES,
  VEHICLE_GUARD_MARGIN_TILES,
  VEHICLE_WIDTH_TILES,
} from '../simConstants';

/**
 * 차체 겹침 판정과 공간 해시.
 *
 * ── 왜 원이 아니라 사각형인가 ──────────────────────────────────────
 * 마주 오는 두 차는 차선 오프셋 0.25 씩, 즉 중심 간 거리가 0.5타일이다. 차체
 * 길이가 0.5 이므로 반지름 0.25 짜리 원으로 판정하면 스쳐 지나갈 때마다 "겹쳤다"
 * 가 되어 서로를 멈춰 세운다. 실제로 겹치는 건 **차체 사각형**이 겹칠 때뿐이다.
 * 폭 0.30 짜리 두 차가 0.5 떨어져 나란히 가면 옆으로 0.2 타일 여유가 있다.
 *
 * 그래서 진행방향을 축으로 하는 회전 사각형(OBB) 두 개를 분리축 정리(SAT)로
 * 판정한다. 축은 네 개뿐이라 비용이 거의 없다.
 */

export interface Body {
  x: number;
  y: number;
  /** 진행방향 단위벡터. */
  hx: number;
  hy: number;
}

const HALF_LEN = VEHICLE_BODY_LENGTH_TILES / 2 + VEHICLE_GUARD_MARGIN_TILES;
const HALF_WID = VEHICLE_WIDTH_TILES / 2 + VEHICLE_GUARD_MARGIN_TILES;

/** 두 차체가 겹치는가. */
export function bodiesOverlap(a: Body, b: Body): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // 굵은 거리로 먼저 걸러낸다.
  const reach = 2 * (HALF_LEN + HALF_WID);
  if (dx * dx + dy * dy > reach * reach) return false;
  return (
    !separated(dx, dy, a.hx, a.hy, a, b) &&
    !separated(dx, dy, -a.hy, a.hx, a, b) &&
    !separated(dx, dy, b.hx, b.hy, a, b) &&
    !separated(dx, dy, -b.hy, b.hx, a, b)
  );
}

/** 축 n 에 두 사각형을 투영해 분리되어 있는지 본다. */
function separated(
  dx: number,
  dy: number,
  nx: number,
  ny: number,
  a: Body,
  b: Body,
): boolean {
  const center = Math.abs(dx * nx + dy * ny);
  const ra = HALF_LEN * Math.abs(a.hx * nx + a.hy * ny) +
    HALF_WID * Math.abs(-a.hy * nx + a.hx * ny);
  const rb = HALF_LEN * Math.abs(b.hx * nx + b.hy * ny) +
    HALF_WID * Math.abs(-b.hy * nx + b.hx * ny);
  return center > ra + rb;
}

/** 타일 한 칸을 셀로 쓰는 공간 해시. 차량 1000대 기준 한 프레임 비용이 무시할 만하다. */
export class SpatialGrid {
  private cells = new Map<number, number[]>();

  clear(): void {
    this.cells.clear();
  }

  insert(index: number, x: number, y: number): void {
    const key = cellKey(Math.floor(x), Math.floor(y));
    const list = this.cells.get(key);
    if (list) list.push(index);
    else this.cells.set(key, [index]);
  }

  /** (x, y) 주변 3x3 셀의 항목을 훑는다. */
  forEachNear(x: number, y: number, fn: (index: number) => void): void {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = this.cells.get(cellKey(cx + dx, cy + dy));
        if (!list) continue;
        for (const index of list) fn(index);
      }
    }
  }

  /** 반경이 1타일보다 클 때 쓰는 확장 훑기. */
  forEachWithin(x: number, y: number, radius: number, fn: (index: number) => void): void {
    const r = Math.max(1, Math.ceil(radius));
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const list = this.cells.get(cellKey(cx + dx, cy + dy));
        if (!list) continue;
        for (const index of list) fn(index);
      }
    }
  }
}

function cellKey(cx: number, cy: number): number {
  // 좌표 범위가 넓지 않으므로 단순 혼합으로 충분하다.
  return (cx & 0xffff) * 65536 + (cy & 0xffff);
}
