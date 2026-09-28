import { CHUNK_SIZE } from '../core/constants';
import type { World } from '../world/world';
import { isWater } from '../world/terrain';
import {
  isAnchor,
  isFacilityAnchor,
  facilityKindOfCode,
  levelOfCode,
  zoneOfCode,
  ZONE_I,
} from './buildings';
import { FACILITY_SPAN } from './config/facilities';
import { FAC_GAS } from './config/power';
import { FAC_INCINERATOR, FAC_CREMATORIUM } from './config/sanitation';
import { INDUSTRY_NUISANCE_RADIUS } from './simConstants';

/** Local land-use emissions, shared by the map and environmental simulation.
 * Values are game balance, not real-world emission measurements. */
export const FACILITY_EMISSIONS: Readonly<Record<number, { radius: number; peak: number }>> = {
  [FAC_INCINERATOR]: { radius: 9, peak: 0.95 },
  [FAC_CREMATORIUM]: { radius: 5, peak: 0.5 },
  [FAC_GAS]: { radius: 7, peak: 0.65 },
};
export interface PollutedTile {
  tx: number;
  ty: number;
  value: number;
  facility: number;
}
export class GroundPollution {
  revision = 0;
  readonly tiles = new Map<string, PollutedTile>();
  private stamp = '';
  update(world: World): void {
    const parcels = world.developedParcels();
    const stamp =
      `${world.walkRevision}:${world.utilityRevision}:` +
      parcels.map((p) => `${p.key}:${p.bldRevision}`).join(';');
    if (this.stamp === stamp) return;
    this.stamp = stamp;
    this.revision++;
    this.tiles.clear();
    for (const p of parcels) {
      if (!p.bld) continue;
      for (let i = 0; i < p.bld.length; i++) {
        const code = p.bld[i];
        const facility = isFacilityAnchor(code);
        const spec = facility ? FACILITY_EMISSIONS[facilityKindOfCode(code)] : undefined;
        if (!spec && (!isAnchor(code) || zoneOfCode(code) !== ZONE_I)) continue;
        const span = facility ? FACILITY_SPAN[facilityKindOfCode(code)] : levelOfCode(code);
        const radius = spec?.radius ?? INDUSTRY_NUISANCE_RADIUS;
        const peak = spec?.peak ?? 0.25 + 0.25 * span;
        const ax = p.cx * CHUNK_SIZE + (i % CHUNK_SIZE);
        const ay = p.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
        for (let ty = ay - radius; ty < ay + span + radius; ty++) {
          for (let tx = ax - radius; tx < ax + span + radius; tx++) {
            // Distance from footprint, symmetric around multi-tile facilities.
            const dx = Math.max(ax - tx, 0, tx - (ax + span - 1));
            const dy = Math.max(ay - ty, 0, ty - (ay + span - 1));
            const distance = Math.hypot(dx, dy);
            if (distance > radius || isWater(world.getTile(tx, ty))) continue;
            const value = peak * (1 - distance / (radius + 1));
            const key = `${tx},${ty}`;
            const tile = this.tiles.get(key) ?? { tx, ty, value: 0, facility: 0 };
            tile.value = Math.max(tile.value, value);
            if (facility) tile.facility = Math.max(tile.facility, value);
            this.tiles.set(key, tile);
          }
        }
      }
    }
  }
  at(tx: number, ty: number): PollutedTile | undefined {
    return this.tiles.get(`${tx},${ty}`);
  }
}
const fields = new WeakMap<World, GroundPollution>();
export function groundPollutionFor(world: World): GroundPollution {
  let field = fields.get(world);
  if (!field) {
    field = new GroundPollution();
    fields.set(world, field);
  }
  field.update(world);
  return field;
}
