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
        const x = tileToWorldX(lx, ly);
        const y = tileToWorldY(lx, ly, world.sampleHeight(junction.minX, junction.minY));
        const state = signalState(junction, leg.enterDir, signalTime);
        const color =
          state === SignalState.Green
            ? 0x6fe27e
            : state === SignalState.Yellow
              ? 0xe8c15a
              : 0xe25f5f;
        this.graphics.rect(x - 2.5, y - 15, 5, 5).fill({ color, alpha: 0.95 });
      }
    }
  }
}
