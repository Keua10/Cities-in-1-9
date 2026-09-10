import { strict as assert } from 'node:assert';
import { CHUNK_SIZE } from '../../src/core/constants';
import { FACILITY_COUNT, FAC_BASE, facCode, isFacilityAnchor } from '../../src/sim/buildings';
import { facilityPowerDemand } from '../../src/sim/config/power';
import {
  FAC_AIRPORT,
  FAC_AIRPORT_L2,
  FAC_AIRPORT_L3,
  FAC_COMM_TOWER,
  FAC_HARBOR,
  FAC_HARBOR_CARGO,
  FAC_HARBOR_HYBRID_L2,
  FAC_HARBOR_HYBRID_L3,
  FAC_PRISON,
  SPECIAL_SPECS,
  isAirportFacility,
  isHarborFacility,
  isHybridHarbor,
} from '../../src/sim/config/special';
import { canPlaceFacility, FACILITY_SPECS } from '../../src/sim/facilities';
import { FACILITY_UNLOCK_LEVEL } from '../../src/sim/progression';
import { Build } from '../../src/world/build';
import { Terrain } from '../../src/world/terrain';
import { World } from '../../src/world/world';

assert.equal(FACILITY_COUNT, 26);
assert.deepEqual(
  [FAC_COMM_TOWER, FAC_AIRPORT, FAC_HARBOR, FAC_PRISON],
  [17, 18, 19, 20],
  'STEP 4.6 기존 특수시설 ID는 절대 바뀌지 않는다',
);
assert.deepEqual(
  [FAC_HARBOR_CARGO, FAC_HARBOR_HYBRID_L2, FAC_HARBOR_HYBRID_L3, FAC_AIRPORT_L2, FAC_AIRPORT_L3],
  [21, 22, 23, 24, 25],
  '교통 확장은 기존 ID 뒤에만 붙는다',
);
for (let kind = 17; kind < FACILITY_COUNT; kind++) {
  assert.equal(facCode(kind), FAC_BASE + kind);
  assert.equal(isFacilityAnchor(facCode(kind)), true);
  assert.equal(FACILITY_SPECS[kind].kind, kind);
}
assert.deepEqual(FACILITY_UNLOCK_LEVEL.slice(17), [2, 3, 3, 3, 3, 4, 5, 4, 5]);
assert.deepEqual(
  [FACILITY_SPECS[FAC_HARBOR].span, FACILITY_SPECS[FAC_HARBOR_HYBRID_L2].span, FACILITY_SPECS[FAC_HARBOR_HYBRID_L3].span],
  [3, 5, 7],
);
assert.deepEqual(
  [FACILITY_SPECS[FAC_AIRPORT].span, FACILITY_SPECS[FAC_AIRPORT_L2].span, FACILITY_SPECS[FAC_AIRPORT_L3].span],
  [3, 5, 7],
);
assert.equal(FACILITY_SPECS[FAC_COMM_TOWER].upkeepPerDay, 0);
assert.equal(FACILITY_SPECS[FAC_COMM_TOWER].needsRoad, false);
assert.equal(facilityPowerDemand(FAC_COMM_TOWER), 0);
assert.equal(SPECIAL_SPECS[FAC_HARBOR].needsWater, true);
assert.equal(SPECIAL_SPECS[FAC_HARBOR_CARGO].needsWater, true);
assert.equal(isHarborFacility(FAC_HARBOR_HYBRID_L3), true);
assert.equal(isHybridHarbor(FAC_HARBOR), false);
assert.equal(isHybridHarbor(FAC_HARBOR_HYBRID_L2), true);
assert.equal(isAirportFacility(FAC_AIRPORT_L3), true);
for (const kind of [FAC_AIRPORT, FAC_AIRPORT_L2, FAC_AIRPORT_L3, FAC_HARBOR, FAC_HARBOR_CARGO, FAC_HARBOR_HYBRID_L2, FAC_HARBOR_HYBRID_L3, FAC_PRISON]) {
  assert.ok(facilityPowerDemand(kind) > 0, `kind ${kind} power demand`);
}
assert.ok(FACILITY_SPECS[FAC_PRISON].capacity > 0);

const world = new World(0);
const x = world.baseCx * CHUNK_SIZE + 16;
const y = world.baseCy * CHUNK_SIZE + 16;
for (let dy = -4; dy < 30; dy++)
  for (let dx = -4; dx < 36; dx++) {
    world.setTile(x + dx, y + dy, Terrain.Grass);
    world.setHeight(x + dx, y + dy, 0);
  }

assert.equal(canPlaceFacility(world, x, y, FAC_COMM_TOWER, 1).ok, false);
assert.equal(canPlaceFacility(world, x, y, FAC_COMM_TOWER, 2).ok, true);

world.setBuild(x + 8, y - 1, Build.Road, false);
assert.equal(canPlaceFacility(world, x + 8, y, FAC_AIRPORT, 2).ok, false);
assert.equal(canPlaceFacility(world, x + 8, y, FAC_AIRPORT, 3).ok, true);
assert.equal(canPlaceFacility(world, x + 8, y, FAC_AIRPORT_L2, 3).ok, false);
assert.equal(canPlaceFacility(world, x + 8, y, FAC_AIRPORT_L2, 4).ok, true);
assert.equal(canPlaceFacility(world, x + 8, y, FAC_AIRPORT_L3, 4).ok, false);
assert.equal(canPlaceFacility(world, x + 8, y, FAC_AIRPORT_L3, 5).ok, true);

const hx = x;
const hy = y + 12;
world.setBuild(hx, hy - 1, Build.Road, false);
const dryHarbor = canPlaceFacility(world, hx, hy, FAC_HARBOR, 3);
assert.equal(dryHarbor.ok, false);
assert.match(dryHarbor.reason, /수역/);
world.setTile(hx + 3, hy + 1, Terrain.WaterShallow);
assert.equal(canPlaceFacility(world, hx, hy, FAC_HARBOR, 3).ok, true);

world.placeFacility(x, y, FAC_COMM_TOWER, 0);
assert.equal(world.buildingCovering(x, y)?.kind, FAC_COMM_TOWER);
console.log('STEP 4.6+ 특수시설: 기존 ID 보존, 3단계 항구/공항 ID·해금·크기·전력·수역 규칙 통과');
