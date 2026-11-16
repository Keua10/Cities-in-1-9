import { Graphics } from 'pixi.js';
import { CHUNK_SIZE, TILE_HH, TILE_HW } from '../core/constants';
import { tileToWorldX, tileToWorldY } from '../core/iso';
import { RESOURCE_COLORS } from '../sim/config/resources';
import { depositAt } from '../world/deposits';
import type { World } from '../world/world';

/**
 * 자원 매장지 지도 (지도 보기 → 자원 매장지, 광산을 고를 때 자동).
 *
 * 탐사한 청크만 보인다(시작 지점을 고를 때는 모른다). 색 = 자원(철 주황·석탄 검정·석유 노랑),
 * 진하기 = 남은 양, 테두리 굵기 = 난이도(얕음 가늘게 → 깊음 굵게). 다 캔 곳은 회색.
 */
export class ResourceLayer {
  readonly graphics = new Graphics();
  private stamp = '';
  /** 청크에 남은 매장량. 매크로가 없으면 처음 매장량. */
  remaining: ((cx: number, cy: number) => number) | null = null;
  /** 캔 양이 바뀔 때 오르는 값(다시 그리기 판단). */
  revision: () => number = () => 0;

  update(
    world: World,
    show: boolean,
    range: { cx0: number; cy0: number; cx1: number; cy1: number },
  ): void {
    this.graphics.visible = show;
    if (!show) return;
    const stamp = `${range.cx0},${range.cy0},${range.cx1},${range.cy1}:${world.exploredCount()}:${Math.floor(this.revision() / 500)}`;
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    const g = this.graphics;
    g.clear();
    const corner = (tx: number, ty: number, dx: number, dy: number): [number, number] => [
      tileToWorldX(tx, ty) + dx * TILE_HW,
      tileToWorldY(tx, ty, world.sampleHeight(tx, ty)) + dy * TILE_HH,
    ];
    for (let cy = range.cy0; cy <= range.cy1; cy++)
      for (let cx = range.cx0; cx <= range.cx1; cx++) {
        if (!world.isExplored(cx, cy)) continue;
        const d = depositAt(cx, cy);
        if (!d) continue;
        const left = this.remaining ? this.remaining(cx, cy) : d.reserve;
        const share = Math.max(0, Math.min(1, left / d.reserve));
        const color = left <= 0 ? 0x808996 : RESOURCE_COLORS[d.resource];
        const t0x = cx * CHUNK_SIZE;
        const t0y = cy * CHUNK_SIZE;
        const t1x = t0x + CHUNK_SIZE - 1;
        const t1y = t0y + CHUNK_SIZE - 1;
        const pts: number[] = [];
        const step = 4;
        for (let x = t0x; x <= t1x; x += step) pts.push(...corner(x, t0y, 0, -1));
        for (let y = t0y; y <= t1y; y += step) pts.push(...corner(t1x, y, 1, 0));
        for (let x = t1x; x >= t0x; x -= step) pts.push(...corner(x, t1y, 0, 1));
        for (let y = t1y; y >= t0y; y -= step) pts.push(...corner(t0x, y, -1, 0));
        g.poly(pts, true);
        g.fill({ color, alpha: 0.18 + 0.32 * share });
        g.poly(pts, true);
        g.stroke({ width: 2 + d.difficulty * 3, color, alpha: 0.9 });
      }
  }
}
