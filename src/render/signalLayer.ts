import { Graphics } from 'pixi.js';
import { CHUNK_SIZE } from '../core/constants';
import { chunkIndexOf, tileToWorldX, tileToWorldY } from '../core/iso';
import { SignalState, signalState } from '../sim/traffic/signals';
import type { TrafficSim } from '../sim/traffic/trafficSim';
import { DIRS } from '../world/build';
import type { World } from '../world/world';
import { surfaceHeightAt } from '../world/slope';
import type { Junction } from '../sim/traffic/junctions';

export function signalMount(j: Junction, enterDir: number) {
  const dir = DIRS[enterDir],
    right = DIRS[(enterDir + 1) & 3];
  const cx = (j.minX + j.maxX) / 2,
    cy = (j.minY + j.maxY) / 2;
  const halfAlong = (enterDir & 1 ? j.maxY - j.minY + 1 : j.maxX - j.minX + 1) / 2;
  const halfAcross = (enterDir & 1 ? j.maxX - j.minX + 1 : j.maxY - j.minY + 1) / 2;
  // Driver's right verge, just before the stop line; arm reaches inward over the lane.
  const tx = cx - dir[0] * (halfAlong + 0.2) + right[0] * (halfAcross - 0.08);
  const ty = cy - dir[1] * (halfAlong + 0.2) + right[1] * (halfAcross - 0.08);
  return { tx, ty, hx: tx - right[0] * 0.32, hy: ty - right[1] * 0.32 };
}

export class SignalLayer {
  readonly graphics = new Graphics();
  draw(
    world: World,
    traffic: TrafficSim | null,
    showFog: boolean,
    range: { cx0: number; cy0: number; cx1: number; cy1: number },
    maskFor: (
      tx: number,
      ty: number,
      x: number,
      y: number,
    ) => (x: number, y: number) => boolean = () => () => false,
  ): void {
    this.graphics.clear();
    if (!traffic) return;
    const signalTime = traffic.signalTimeMs;
    const tx0 = range.cx0 * CHUNK_SIZE;
    const ty0 = range.cy0 * CHUNK_SIZE;
    const tx1 = (range.cx1 + 1) * CHUNK_SIZE - 1;
    const ty1 = (range.cy1 + 1) * CHUNK_SIZE - 1;

    for (const junction of traffic.junctions.junctions) {
      if (!junction.signalized) continue;
      if (junction.maxX < tx0 || junction.minX > tx1) continue;
      if (junction.maxY < ty0 || junction.minY > ty1) continue;
      if (showFog && !world.isExplored(chunkIndexOf(junction.minX), chunkIndexOf(junction.minY))) {
        continue;
      }
      for (const leg of junction.legs.length
        ? junction.legs
        : [{ enterDir: 0, length: 1, width: 1 }]) {
        if (leg.length < 1) continue;
        const m = signalMount(junction, leg.enterDir);
        const height = surfaceHeightAt(world, m.tx, m.ty);
        const x = Math.round(tileToWorldX(m.tx, m.ty)),
          y = Math.round(tileToWorldY(m.tx, m.ty, height));
        const hx = Math.round(tileToWorldX(m.hx, m.hy)),
          hy = Math.round(tileToWorldY(m.hx, m.hy, height)) - 23;
        const hidden = maskFor(m.tx, m.ty, x, y);
        const pixels = new Map<string, number>();
        const rect = (rx: number, ry: number, w: number, h: number, color: number) => {
          for (let py = ry; py < ry + h; py++)
            for (let px = rx; px < rx + w; px++) pixels.set(`${px},${py}`, color);
        };
        rect(x - 1, y - 1, 4, 2, 0x283337);
        rect(x, y - 27, 2, 27, 0x526267);
        rect(x, y - 26, 1, 25, 0xa8ada1);
        const steps = Math.max(Math.abs(hx - x), Math.abs(hy - 4 - (y - 26)), 1);
        for (let i = 0; i <= steps; i++)
          rect(
            Math.round(x + ((hx - x) * i) / steps),
            Math.round(y - 26 + ((hy - 4 - y + 26) * i) / steps),
            2,
            2,
            0x8c9994,
          );
        const state = signalState(junction, leg.enterDir, signalTime);
        const painter = {
          rect(rx: number, ry: number, w: number, h: number) {
            return {
              fill(color: number) {
                rect(rx, ry, w, h, color);
              },
            };
          },
        };
        drawSignalHead(painter, hx, hy, state);
        for (const [key, color] of pixels) {
          const [px, py] = key.split(',').map(Number);
          if (!hidden(px, py)) this.graphics.rect(px, py, 1, 1).fill(color);
        }
      }
    }
  }
}

/** Three fixed lamp positions make state readable without relying on color alone. */
export function drawSignalHead(
  g: { rect(x: number, y: number, w: number, h: number): { fill(color: number): unknown } },
  x: number,
  y: number,
  state: SignalState,
): void {
  g.rect(x - 2, y - 4, 6, 12).fill(0x1e292e);
  const lamps = [SignalState.Red, SignalState.Yellow, SignalState.Green];
  const lit = [0xe77c69, 0xe9c678, 0x82c893];
  const unlit = [0x583c38, 0x514b36, 0x314a3e];
  for (let i = 0; i < 3; i++) {
    g.rect(x, y - 3 + i * 4, 2, 2).fill(state === lamps[i] ? lit[i] : unlit[i]);
  }
}
