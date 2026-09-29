import { Graphics } from 'pixi.js';
import type { Camera } from '../core/camera';
import { tileToWorldX, tileToWorldY } from '../core/iso';
import type { MacroSim } from '../sim/macro';
import type { World } from '../world/world';

/** Static stage-one world feedback: reserved sites, snow cover, flood extent, storm track. */
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
    const bounds = camera.viewBounds(80);
    const visible = (x: number, y: number) =>
      x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
    for (const [field, color] of [
      [this.sim.nature.state.water, 0x5baaca],
      [this.sim.nature.state.snow, 0xe4f1f5],
    ] as const) {
      for (const [key, depth] of Object.entries(field)) {
        const [tx, ty] = key.split(',').map(Number),
          x = tileToWorldX(tx, ty),
          y = tileToWorldY(tx, ty, this.world.sampleHeight(tx, ty));
        if (!visible(x, y) || depth < 0.01) continue;
        g.poly([x, y - 16, x + 32, y, x, y + 16, x - 32, y]).fill({
          color,
          alpha: Math.min(0.6, depth * 2),
        });
      }
    }
    for (const j of this.sim.construction.jobs) {
      const x = tileToWorldX(j.tx, j.ty),
        y = tileToWorldY(j.tx, j.ty, this.world.sampleHeight(j.tx, j.ty));
      if (!visible(x, y)) continue;
      const s = j.span;
      g.poly([
        x,
        y - 16,
        x + 32 * s,
        y + 16 * (s - 1),
        x,
        y + 32 * s - 16,
        x - 32 * s,
        y + 16 * (s - 1),
      ])
        .fill({ color: 0x9e754a, alpha: 0.8 })
        .stroke({ color: 0xffd16a, width: 2 });
      for (let n = 0; n < s; n++)
        g.moveTo(x - 24 * n, y + 12 * n)
          .lineTo(x + 24 * (s - n), y + 12 * (s + n))
          .stroke({ color: 0x594535, width: 2 });
      g.rect(x - 20, y - 18, 40, 5).fill(0x253a41);
      g.rect(
        x - 20,
        y - 18,
        40 * Math.min(1, (this.sim.lifeElapsedMs - j.started) / (j.finishes - j.started)),
        5,
      ).fill(0xffd16a);
    }
    const c = this.sim.nature.center(),
      h = this.sim.nature.state.hazard;
    if (c && h) {
      const x = tileToWorldX(c.x, c.y),
        y = tileToWorldY(c.x, c.y);
      if (visible(x, y)) {
        g.circle(x, y, 24).stroke({ color: 0xff936e, width: 2 });
        const r = (h.direction * Math.PI) / 180;
        const ex = tileToWorldX(c.x + Math.sin(r) * 8, c.y - Math.cos(r) * 8),
          ey = tileToWorldY(c.x + Math.sin(r) * 8, c.y - Math.cos(r) * 8);
        g.moveTo(x, y).lineTo(ex, ey).stroke({ color: 0xff936e, width: 2 });
      }
    }
  }
}
