import { strict as assert } from 'node:assert';
import { CHUNK_SIZE } from '../../src/core/constants';
import { FACILITY_COUNT, FAC_BASE, facCode, isFacilityAnchor } from '../../src/sim/buildings';
import { facilityPowerDemand } from '../../src/sim/config/power';
import {
  FAC_AIRPORT,
  FAC_COMM_TOWER,
  FAC_HARBOR,
  FAC_PRISON,
  SPECIAL_SPECS,
} from '../../src/sim/config/special';
import { canPlaceFacility, FACILITY_SPECS } from '../../src/sim/facilities';
import { FACILITY_UNLOCK_LEVEL } from '../../src/sim/progression';
import { Build } from '../../src/world/build';
import { Terrain } from '../../src/world/terrain';
import { World } from '../../src/world/world';

assert.equal(FACILITY_COUNT, 21);
assert.deepEqual([FAC_COMM_TOWER, FAC_AIRPORT, FAC_HARBOR, FAC_PRISON], [17, 18, 19, 20]);
for (let kind = 17; kind <= 20; kind++) {
  assert.equal(facCode(kind), FAC_BASE + kind);
  assert.equal(isFacilityAnchor(facCode(kind)), true);
  assert.equal(FACILITY_SPECS[kind].kind, kind);
}
assert.deepEqual(FACILITY_UNLOCK_LEVEL.slice(17), [2, 5, 3, 3]);
assert.equal(FACILITY_SPECS[FAC_COMM_TOWER].upkeepPerDay, 0);
assert.equal(FACILITY_SPECS[FAC_COMM_TOWER].needsRoad, false);
assert.equal(facilityPowerDemand(FAC_COMM_TOWER), 0);
assert.equal(SPECIAL_SPECS[FAC_HARBOR].needsWater, true);
assert.ok(facilityPowerDemand(FAC_AIRPORT) > 0);
assert.ok(facilityPowerDemand(FAC_HARBOR) > 0);
assert.ok(facilityPowerDemand(FAC_PRISON) > 0);
assert.ok(FACILITY_SPECS[FAC_PRISON].capacity > 0);

const world = new World(0);
const x = world.baseCx * CHUNK_SIZE + 12;
const y = world.baseCy * CHUNK_SIZE + 12;
for (let dy = -4; dy < 12; dy++)
  for (let dx = -4; dx < 20; dx++) {
    world.setTile(x + dx, y + dy, Terrain.Grass);
    world.setHeight(x + dx, y + dy, 0);
  }

assert.equal(canPlaceFacility(world, x, y, FAC_COMM_TOWER, 1).ok, false);
assert.equal(canPlaceFacility(world, x, y, FAC_COMM_TOWER, 2).ok, true);

world.setBuild(x + 6, y - 1, Build.Road, false);
assert.equal(canPlaceFacility(world, x + 6, y, FAC_PRISON, 2).ok, false);
assert.equal(canPlaceFacility(world, x + 6, y, FAC_PRISON, 3).ok, true);
assert.equal(canPlaceFacility(world, x + 6, y, FAC_AIRPORT, 4).ok, false);
assert.equal(canPlaceFacility(world, x + 6, y, FAC_AIRPORT, 5).ok, true);

world.setBuild(x, y + 6, Build.Road, false);
const dryHarbor = canPlaceFacility(world, x, y + 7, FAC_HARBOR, 3);
assert.equal(dryHarbor.ok, false);
assert.match(dryHarbor.reason, /수역/);
world.setTile(x + 3, y + 8, Terrain.WaterShallow);
assert.equal(canPlaceFacility(world, x, y + 7, FAC_HARBOR, 3).ok, true);

world.placeFacility(x, y, FAC_COMM_TOWER, 0);
assert.equal(world.buildingCovering(x, y)?.kind, FAC_COMM_TOWER);
console.log('STEP 4.6 special facilities: IDs, unlocks, tower no-effect constraints, harbor water rule, placement/save layer smoke passed.');
