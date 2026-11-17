import { Graphics } from 'pixi.js';
import type { Camera } from '../core/camera';
import { TILE_HH, TILE_HW } from '../core/constants';
import { tileToWorldX, tileToWorldY } from '../core/iso';
import type { MacroSim } from '../sim/macro';
import type { World } from '../world/world';

const FLOOD_COLOR = 0x5baaca;
const SNOW_COLOR = 0xe4f1f5;
const SITE_FILL = 0x9e754a;
const SITE_EDGE = 0xffd16a;
const SITE_PLANK = 0x594535;
const BAR_BG = 0x253a41;
const HAZARD_COLOR = 0xff936e;

/**
 * 도시 화면 바닥 위 표시 하나(Graphics 한 장, 매 프레임 다시 그림):
 *   - 침수·눈 쌓임 칸(깊이만큼 진하게)
 *   - 공사 중인 자리(흙바닥 + 판자 + 진행 막대)
 *   - 태풍 같은 재해의 중심과 진행 방향
 * 화면 밖은 건너뛴다.
 */
export class NatureLayer {
  readonly graphics = new Graphics();
  constructor(
    private world: World,
    private sim: MacroSim,
  ) {
    this.graphics.eventMode = 'none';
  }

  draw(camera: Camera): void {
    const g = this.graphics;
    g.clear();
    const b = camera.viewBounds(80);
    const visible = (x: number, y: number) =>
      x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
    this.drawFields(g, visible);
    this.drawSites(g, visible);
    this.drawHazard(g, visible);
  }

  /** 바닥 마름모 한 칸의 화면 위치. */
  private at(tx: number, ty: number): { x: number; y: number } {
    return {
      x: tileToWorldX(tx, ty),
      y: tileToWorldY(tx, ty, this.world.sampleHeight(tx, ty)),
    };
  }

  private drawFields(g: Graphics, visible: (x: number, y: number) => boolean): void {
    const { water, snow } = this.sim.nature.state;
    for (const [field, color] of [
      [water, FLOOD_COLOR],
      [snow, SNOW_COLOR],
    ] as const) {
      for (const [key, depth] of Object.entries(field)) {
        if (depth < 0.01) continue;
        const [tx, ty] = key.split(',').map(Number);
        const { x, y } = this.at(tx, ty);
        if (!visible(x, y)) continue;
        g.poly([x, y - TILE_HH, x + TILE_HW, y, x, y + TILE_HH, x - TILE_HW, y]).fill({
          color,
          alpha: Math.min(0.6, depth * 2),
        });
      }
    }
  }

  private drawSites(g: Graphics, visible: (x: number, y: number) => boolean): void {
    const construction = this.sim.construction;
    for (const j of construction.jobs) {
      const { x, y } = this.at(j.tx, j.ty);
      if (!visible(x, y)) continue;
      const s = j.span;
      // 부지 전체 마름모(위 꼭짓점 = 첫 칸 위 꼭짓점).
      g.poly([
        x,
        y - TILE_HH,
        x + TILE_HW * s,
        y + TILE_HH * (s - 1),
        x,
        y + TILE_HW * s - TILE_HH,
        x - TILE_HW * s,
        y + TILE_HH * (s - 1),
      ])
        .fill({ color: SITE_FILL, alpha: 0.8 })
        .stroke({ color: SITE_EDGE, width: 2 });
      for (let n = 0; n < s; n++)
        g.moveTo(x - 24 * n, y + 12 * n)
          .lineTo(x + 24 * (s - n), y + 12 * (s + n))
          .stroke({ color: SITE_PLANK, width: 2 });
      g.rect(x - 20, y - 18, 40, 5).fill(BAR_BG);
      g.rect(x - 20, y - 18, 40 * construction.progress(j), 5).fill(SITE_EDGE);
    }
  }

  private drawHazard(g: Graphics, visible: (x: number, y: number) => boolean): void {
    const c = this.sim.nature.center();
    const h = this.sim.nature.state.hazard;
    if (!c || !h) return;
    const x = tileToWorldX(c.x, c.y);
    const y = tileToWorldY(c.x, c.y);
    if (!visible(x, y)) return;
    g.circle(x, y, 24).stroke({ color: HAZARD_COLOR, width: 2 });
    const r = (h.direction * Math.PI) / 180;
    const ex = tileToWorldX(c.x + Math.sin(r) * 8, c.y - Math.cos(r) * 8);
    const ey = tileToWorldY(c.x + Math.sin(r) * 8, c.y - Math.cos(r) * 8);
    g.moveTo(x, y).lineTo(ex, ey).stroke({ color: HAZARD_COLOR, width: 2 });
  }
}
