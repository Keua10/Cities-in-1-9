import { CHUNK_SIZE } from '../../core/constants';
import { PLAN_CELLS, type PlanChunks } from '../../net/cityPlans';
import { generateContinentChunk } from '../../world/continent';
import { TERRAIN_COLORS } from '../../world/terrain';
import type { MapView } from './mapView';

/** 청크 한 칸이 이만큼(px) 이상으로 보이면 자세히 그린다. */
export const DETAIL_MIN_S = 40;
/** 지형 그림 캐시(청크 수). 넘치면 오래된 것부터 버린다. */
const CACHE_MAX = 600;
/** 한 프레임에 새로 만드는 지형 그림 수(확대 순간 멈추지 않게). */
const BUILD_PER_FRAME = 24;

/** 칸 글자 → 색(도시 화면 구역 색과 맞춤). */
const PLAN_COLORS: Record<string, string> = {
  '1': '#6b6b66',
  '2': '#6fbf63',
  '3': '#5b9fe0',
  '4': '#e0b24c',
  '5': '#b48ee6',
  '6': '#9aa3ab',
};

/**
 * 밝혀진 청크를 크게 확대하면: 실제 지형(타일 하나 = 점 하나, 고도 음영) +
 * 그 청크 주인의 배치 요약(도로·구역·시설). 모르는 청크는 그리지 않는다.
 */
export class DetailPainter {
  private terrain = new Map<string, HTMLCanvasElement>();

  /**
   * known = null 이면 전부(관리자). planOf(key) = 그 청크의 배치 요약 64글자(없으면 '').
   * 아직 못 만든 지형이 남았으면 true(다음 프레임에 이어서).
   */
  paint(
    ctx: CanvasRenderingContext2D,
    view: MapView,
    known: ReadonlySet<string> | null,
    planOf: (key: string) => string,
  ): boolean {
    const { s, X, Y } = view;
    if (s < DETAIL_MIN_S) return false;
    const cx0 = Math.floor(view.chunkAt(0, 0).cx);
    const cy0 = Math.floor(view.chunkAt(0, 0).cy);
    const { cx: cx1, cy: cy1 } = view.chunkAt(view.width, view.height);
    let built = 0;
    let more = false;
    ctx.imageSmoothingEnabled = false;
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = `${cx},${cy}`;
        if (known && !known.has(key)) continue;
        let img = this.terrain.get(key);
        if (!img) {
          if (built >= BUILD_PER_FRAME) {
            more = true;
            continue;
          }
          img = terrainImage(cx, cy);
          built++;
          this.terrain.set(key, img);
          if (this.terrain.size > CACHE_MAX) this.terrain.delete(this.terrain.keys().next().value!);
        }
        const x = X(cx);
        const y = Y(cy);
        ctx.drawImage(img, x, y, s + 0.5, s + 0.5);
        const plan = planOf(key);
        if (plan) paintPlan(ctx, plan, x, y, s);
      }
    return more;
  }
}

/** 지형 32×32 그림: 지형 색 + 고도가 높을수록 밝게. */
function terrainImage(cx: number, cy: number): HTMLCanvasElement {
  const { tiles, heights } = generateContinentChunk(cx, cy);
  const c = document.createElement('canvas');
  c.width = CHUNK_SIZE;
  c.height = CHUNK_SIZE;
  const g = c.getContext('2d')!;
  const img = g.createImageData(CHUNK_SIZE, CHUNK_SIZE);
  for (let i = 0; i < tiles.length; i++) {
    const hex = TERRAIN_COLORS[tiles[i]] ?? '#5d9a4e';
    const k = 0.85 + Math.min(10, heights[i]) * 0.03;
    img.data[i * 4] = Math.min(255, parseInt(hex.slice(1, 3), 16) * k);
    img.data[i * 4 + 1] = Math.min(255, parseInt(hex.slice(3, 5), 16) * k);
    img.data[i * 4 + 2] = Math.min(255, parseInt(hex.slice(5, 7), 16) * k);
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** 배치 요약 8×8칸. 도로는 가늘게, 구역·시설은 칸을 거의 채워서. */
function paintPlan(ctx: CanvasRenderingContext2D, plan: string, x: number, y: number, s: number) {
  const cell = s / PLAN_CELLS;
  for (let i = 0; i < plan.length; i++) {
    const v = plan[i];
    if (v === '0') continue;
    const px = x + (i % PLAN_CELLS) * cell;
    const py = y + Math.floor(i / PLAN_CELLS) * cell;
    ctx.fillStyle = PLAN_COLORS[v];
    if (v === '1') {
      const w = Math.max(1, cell * 0.3);
      ctx.fillRect(px + (cell - w) / 2, py, w, cell);
      ctx.fillRect(px, py + (cell - w) / 2, cell, w);
    } else {
      ctx.globalAlpha = 0.85;
      ctx.fillRect(px + cell * 0.1, py + cell * 0.1, cell * 0.8, cell * 0.8);
      ctx.globalAlpha = 1;
    }
  }
}

/** 여러 도시 요약을 청크 키 하나로 찾는 함수로. */
export function planLookup(plans: ReadonlyArray<PlanChunks>): (key: string) => string {
  return (key) => {
    for (const p of plans) if (p[key]) return p[key];
    return '';
  };
}
