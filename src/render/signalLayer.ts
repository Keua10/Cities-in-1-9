import { Graphics } from 'pixi.js';
import { CHUNK_SIZE } from '../core/constants';
import { chunkIndexOf, tileToWorldX, tileToWorldY } from '../core/iso';
import { JUNCTION_LEG_MIN_TILES } from '../sim/simConstants';
import { SignalState, signalState } from '../sim/traffic/signals';
import type { TrafficSim } from '../sim/traffic/trafficSim';
import { DIRS } from '../world/build';
import type { World } from '../world/world';

export class SignalLayer {
  readonly graphics = new Graphics();
  draw(
    world: World,
    traffic: TrafficSim | null,
    showFog: boolean,
    range: { cx0: number; cy0: number; cx1: number; cy1: number },
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
      const cx = (junction.minX + junction.maxX) / 2;
      const cy = (junction.minY + junction.maxY) / 2;
      for (const leg of junction.legs) {
        if (leg.length < JUNCTION_LEG_MIN_TILES) continue;
        const dir = DIRS[leg.enterDir];
        // 진입 방향의 반대쪽(=운전자가 보는 맞은편)에 등을 세운다.
        const spanX = (junction.maxX - junction.minX + 1) / 2 + 0.55;
        const spanY = (junction.maxY - junction.minY + 1) / 2 + 0.55;
        const lx = cx + dir[0] * spanX;
        const ly = cy + dir[1] * spanY;
        const x = Math.round(tileToWorldX(lx, ly));
        const y = Math.round(
          tileToWorldY(lx, ly, world.sampleHeight(junction.minX, junction.minY)),
        );
        const state = signalState(junction, leg.enterDir, signalTime);
        drawSignalHead(this.graphics, x, y, state);
      }
    }
  }
}

/** Three fixed lamp positions make state readable without relying on color alone. */
export function drawSignalHead(g: Graphics, x: number, y: number, state: SignalState): void {
  g.rect(x - 2, y - 1, 5, 2).fill(0x283337);
  g.rect(x, y - 10, 2, 10).fill(0x39494b);
  g.rect(x, y - 9, 1, 8).fill(0x9ca9a3);
  g.rect(x - 2, y - 22, 6, 14).fill(0x1e292e);
  g.rect(x - 1, y - 21, 1, 12).fill(0x526267);
  const lamps = [SignalState.Red, SignalState.Yellow, SignalState.Green];
  const lit = [0xe77c69, 0xe9c678, 0x82c893];
  const unlit = [0x583c38, 0x514b36, 0x314a3e];
  for (let i = 0; i < 3; i++) {
    g.rect(x, y - 20 + i * 4, 2, 2).fill(state === lamps[i] ? lit[i] : unlit[i]);
  }
}
