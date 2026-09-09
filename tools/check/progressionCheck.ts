import { strict as assert } from 'node:assert';
import { CHUNK_SIZE } from '../../src/core/constants';
import type { MacroState } from '../../src/net/types';
import { ZONE_C, ZONE_R } from '../../src/sim/buildings';
import { canPlaceFacility, FAC_PARK } from '../../src/sim/facilities';
import { growParcel, pickLevel } from '../../src/sim/growth';
import { MacroSim } from '../../src/sim/macro';
import { cityLevelFor, dailyProsperity, initializeProsperity } from '../../src/sim/progression';
import { RoadField } from '../../src/sim/roadGraph';
import { MS_PER_TICK, TICKS_PER_DAY } from '../../src/sim/simConstants';
import { Build } from '../../src/world/build';
import { Terrain } from '../../src/world/terrain';
import { World } from '../../src/world/world';

const macro = (): MacroState => ({ money: 100000, population: 0, tick: 0, tickedAt: 1000 });
assert.deepEqual(
  [0, 99, 100, 499, 500, 1499, 1500, 4000].map(cityLevelFor),
  [1, 1, 2, 2, 3, 3, 4, 5],
);
assert.equal(dailyProsperity(0, 1, 100), 0);
assert.ok(dailyProsperity(100, 1, 100) > dailyProsperity(100, 0, -100));
assert.equal(pickLevel([0.1, 1, 1], 0.99, 1), 1);
assert.equal(pickLevel([0, 1, 1], 0.99, 1), 0);

const world = new World(0);
const x = world.baseCx * CHUNK_SIZE + 8,
  y = world.baseCy * CHUNK_SIZE + 8;
for (let dy = -2; dy < 10; dy++)
  for (let dx = -2; dx < 10; dx++) {
    world.setHeight(x + dx, y + dy, 0);
    world.setTile(x + dx, y + dy, Terrain.Grass);
  }
world.setBuild(x, y - 1, Build.Road, false);
assert.equal(canPlaceFacility(world, x, y, FAC_PARK, 1).ok, false);
assert.equal(canPlaceFacility(world, x, y, FAC_PARK, 2).ok, true);

// 실제 성장 경로에서도 상위 계층에만 수요가 있을 때 잠금을 우회하지 않는다.
for (let dy = 0; dy < 3; dy++)
  for (let dx = 0; dx < 3; dx++) world.setBuild(x + dx, y + dy, Build.ZoneR, false);
const parcel = world.peekParcel(world.baseCx, world.baseCy)!;
const ctx = {
  demand: [
    [0, 1, 1],
    [0, 0, 0],
    [0, 0, 0],
  ],
  field: new RoadField(),
  today: 0,
  tick: 0,
  money: 10000,
  maxBuildingTier: 1,
};
for (let i = 0; i < 32; i++) assert.equal(growParcel(world, parcel, ctx).built, 0);

world.placeBuilding(x, y, ZONE_R, 3, 0);
const old = macro();
initializeProsperity(old, world);
assert.equal(cityLevelFor(old.prosperity!), 4);
old.prosperity = 1512;
initializeProsperity(old, world);
assert.equal(old.prosperity, 1512);
assert.equal(world.buildingCovering(x, y)?.level, 3);

const fresh = macro();
const emptyWorld = new World(1);
initializeProsperity(fresh, emptyWorld);
assert.equal(fresh.prosperity, 0);
const sim = new MacroSim(world, old);
// 통근 가능한 소도시로 일일 적립을 확인한다. 일자리 없는 공실 도시는 적립하지 않는다.
world.demolishAt(x, y);
world.placeBuilding(x, y, ZONE_R, 1, 0);
world.setBuild(x + 1, y - 1, Build.Road, false);
world.setBuild(x + 1, y, Build.ZoneC, false);
world.placeBuilding(x + 1, y, ZONE_C, 1, 0);
let saves = 0;
sim.onMacroChange = () => saves++;
sim.primeCatchup(1000);
const initial = sim.prosperity;
for (let i = 0; i < TICKS_PER_DAY; i++) sim.update(MS_PER_TICK, 1);
assert.ok(sim.prosperity > initial);
assert.ok(saves > 0);
const loaded = JSON.parse(JSON.stringify(old)) as MacroState;
const reloaded = new MacroSim(world, loaded);
reloaded.primeCatchup(loaded.tickedAt);
assert.equal(reloaded.prosperity, sim.prosperity);
assert.equal(reloaded.cityLevel, sim.cityLevel);
reloaded.resetState(100000, 1000);
assert.equal(reloaded.prosperity, 0);
console.log(
  'STEP 4.1 smoke passed: thresholds, daily accrual, growth/facility locks, legacy migration, save/reload, reset.',
);
