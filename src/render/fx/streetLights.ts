import { Graphics } from 'pixi.js';
import { CHUNK_SIZE } from '../../core/constants';
import { tileToWorldX, tileToWorldY } from '../../core/iso';
import { isRoad } from '../../world/build';
import type { World } from '../../world/world';

/** 한 화면 가로등 최대 수 — '적당히'. */
const MAX_LIGHTS = 220;
/** 도로 칸 다섯에 하나꼴(번호로 정해 늘 같은 자리). */
const EVERY = 5;
/** 이보다 멀리 보면 끈다(점이 너무 촘촘해져 지저분하다). */
const MIN_ZOOM = 0.45;
const WARM = 0xffd38a;

type Range = { cx0: number; cy0: number; cx1: number; cy1: number };

/**
 * 밤 가로등(월드 좌표): 도로 칸 몇 곳에 따뜻한 빛 번짐 + 작은 불빛.
 * 자리는 화면 범위·도로가 바뀔 때만 다시 그리고, 밤의 깊이는 투명도로만 바꾼다
 * (매 프레임 다시 그리지 않는다). 낮에는 숨긴다.
 */
export class StreetLightLayer {
  readonly graphics = new Graphics();
  private stamp = '';

  constructor() {
    this.graphics.eventMode = 'none';
    this.graphics.blendMode = 'add';
  }

  /** night = 0(낮)~1(한밤). */
  draw(world: World, range: Range, zoom: number, night: number): void {
    const g = this.graphics;
    const on = night > 0.05 && zoom >= MIN_ZOOM;
    g.visible = on;
    if (!on) return;
    g.alpha = Math.min(1, night * 1.1);
    const stamp = `${range.cx0},${range.cy0},${range.cx1},${range.cy1}|${world.walkRevision}`;
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    g.clear();
    let n = 0;
    for (let cy = range.cy0; cy <= range.cy1 && n < MAX_LIGHTS; cy++)
      for (let cx = range.cx0; cx <= range.cx1 && n < MAX_LIGHTS; cx++) {
        if (!world.isExplored(cx, cy)) continue;
        for (let ly = 0; ly < CHUNK_SIZE && n < MAX_LIGHTS; ly++)
          for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            const tx = cx * CHUNK_SIZE + lx;
            const ty = cy * CHUNK_SIZE + ly;
            if ((((tx * 7 + ty * 13) % EVERY) + EVERY) % EVERY !== 0) continue;
            if (!isRoad(world.getBuild(tx, ty))) continue;
            const x = tileToWorldX(tx, ty);
            const y = tileToWorldY(tx, ty, world.sampleHeight(tx, ty));
            g.ellipse(x, y, 22, 11).fill({ color: WARM, alpha: 0.14 });
            g.ellipse(x, y, 10, 5).fill({ color: WARM, alpha: 0.18 });
            g.circle(x, y - 14, 2.2).fill({ color: 0xfff2c8, alpha: 0.95 });
            if (++n >= MAX_LIGHTS) break;
          }
      }
  }
}
