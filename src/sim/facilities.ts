import { chunkIndexOf } from '../core/iso';
import { Build, type PlaceResult } from '../world/build';
import { isWater } from '../world/terrain';
import type { World } from '../world/world';
import { BLD_NONE, FACILITY_COUNT, isWelfareKind } from './buildings';
import { edgeNeighbors } from './roadGraph';
import { FACILITY_UNLOCK_LEVEL } from './progression';
import { WATER_SPECS } from './config/water';
import { SPECIAL_SPECS } from './config/special';
import {
  FACILITY_CAPACITY,
  FACILITY_CAPACITY_IS_BUILDINGS,
  FACILITY_COST,
  FACILITY_NAMES,
  FACILITY_NEEDS_ROAD,
  FACILITY_RANGE,
  FACILITY_SPAN,
  FACILITY_STRENGTH,
  FACILITY_UPKEEP_PER_DAY,
} from './simConstants';

export const FAC_FIRE = 0;
export const FAC_POLICE = 1;
export const FAC_HOSPITAL = 2;
export const FAC_SCHOOL = 3;
export const FAC_MINIPARK = 4;
export const FAC_PARK = 5;
export const FAC_SPORTS = 6;

export interface FacilitySpec {
  unlockLevel: number;
  kind: number;
  name: string;
  span: number;
  cost: number;
  upkeepPerDay: number;
  welfare: boolean;
  range: number;
  capacity: number;
  capacityIsBuildings: boolean;
  strength: number;
  needsRoad: boolean;
}

function buildSpecs(): readonly FacilitySpec[] {
  const out: FacilitySpec[] = [];
  for (let kind = 0; kind < FACILITY_COUNT; kind++) {
    out.push({
      unlockLevel: FACILITY_UNLOCK_LEVEL[kind],
      kind,
      name: FACILITY_NAMES[kind],
      span: FACILITY_SPAN[kind],
      cost: FACILITY_COST[kind],
      upkeepPerDay: FACILITY_UPKEEP_PER_DAY[kind],
      welfare: isWelfareKind(kind),
      range: FACILITY_RANGE[kind],
      capacity: FACILITY_CAPACITY[kind],
      capacityIsBuildings: FACILITY_CAPACITY_IS_BUILDINGS[kind] ?? false,
      strength: FACILITY_STRENGTH[kind],
      needsRoad: FACILITY_NEEDS_ROAD[kind],
    });
  }
  return out;
}

export const FACILITY_SPECS: readonly FacilitySpec[] = buildSpecs();

export function isFacilityKind(kind: number): boolean {
  return Number.isInteger(kind) && kind >= 0 && kind < FACILITY_COUNT;
}

export function facilitySpan(kind: number): number {
  return isFacilityKind(kind) ? FACILITY_SPECS[kind].span : 1;
}

const OK: PlaceResult = { ok: true, reason: '' };

/** Common placement rules for every civic facility, including STEP 4.6. */
export function canPlaceFacility(
  world: World,
  tx: number,
  ty: number,
  kind: number,
  cityLevel = 1,
): PlaceResult {
  if (!isFacilityKind(kind)) return { ok: false, reason: '없는 시설입니다' };
  const spec = FACILITY_SPECS[kind];
  if (cityLevel < spec.unlockLevel)
    return { ok: false, reason: `도시 레벨 ${spec.unlockLevel}에서 잠금해제됩니다` };

  const span = spec.span;
  const h = world.sampleHeight(tx, ty);
  for (let dy = 0; dy < span; dy++) {
    for (let dx = 0; dx < span; dx++) {
      const x = tx + dx;
      const y = ty + dy;
      if (!world.isExplored(chunkIndexOf(x), chunkIndexOf(y))) {
        return { ok: false, reason: '아직 개척하지 않은 땅입니다' };
      }
      if (isWater(world.getTile(x, y))) {
        return { ok: false, reason: '물 위에는 지을 수 없습니다' };
      }
      if (world.sampleHeight(x, y) !== h) {
        return { ok: false, reason: '평평한 땅에만 지을 수 있습니다' };
      }
      if (world.getBuild(x, y) !== Build.None || world.getBld(x, y) !== BLD_NONE) {
        return { ok: false, reason: '먼저 철거해야 합니다' };
      }
    }
  }

  if (spec.needsRoad && !touchesRoadTiles(world, tx, ty, span)) {
    return { ok: false, reason: '도로에 닿아야 합니다' };
  }

  if (WATER_SPECS[kind]?.needsWater && !touchesWater(world, tx, ty, span)) {
    return { ok: false, reason: '하천에 바로 닿은 평평한 육지에 지어야 합니다' };
  }

  if (SPECIAL_SPECS[kind]?.needsWater && !touchesWater(world, tx, ty, span)) {
    return { ok: false, reason: '항구는 수역에 바로 닿은 평평한 육지에 지어야 합니다' };
  }

  return OK;
}

export function touchesRoadTiles(world: World, tx: number, ty: number, span: number): boolean {
  for (const [rx, ry] of edgeNeighbors(tx, ty, span)) {
    if (world.getBuild(rx, ry) === Build.Road) return true;
  }
  return false;
}

export function touchesWater(world: World, tx: number, ty: number, span: number): boolean {
  for (const [x, y] of edgeNeighbors(tx, ty, span)) {
    if (isWater(world.getTile(x, y))) return true;
  }
  return false;
}
