import { strict as assert } from 'node:assert';
import { CHUNK_SIZE, CHUNK_TILES, WORLD_SEED } from '../../src/core/constants';
import { decodeOverride, encodeOverride } from '../../src/net/codec';
import { ZONE_R, simRandom, isWelfareKind } from '../../src/sim/buildings';
import {
  FAC_GROUNDWATER,
  FAC_RIVER_PUMP,
  FAC_OUTFALL,
  FAC_TREATMENT,
} from '../../src/sim/config/water';
import { canPlaceFacility } from '../../src/sim/facilities';
import { WaterField } from '../../src/sim/water';
import { DisasterSim } from '../../src/sim/disasters';
import { MacroSim } from '../../src/sim/macro';
import { Build } from '../../src/world/build';
import { Terrain } from '../../src/world/terrain';
import { World, type ChunkOverride } from '../../src/world/world';

const world = new World(0),
  x = world.baseCx * CHUNK_SIZE + 8,
  y = world.baseCy * CHUNK_SIZE + 8;
for (let dy = -3; dy < 22; dy++)
  for (let dx = -3; dx < 22; dx++) {
    world.setTile(x + dx, y + dy, Terrain.Grass);
    world.setHeight(x + dx, y + dy, 0);
  }
const pipe = (px: number, py: number, mask: number) => world.setPipe(x + px, y + py, mask);
world.setBuild(x, y - 1, Build.Road, false);
assert.ok(canPlaceFacility(world, x, y, FAC_GROUNDWATER, 1).ok);
assert.ok(!canPlaceFacility(world, x, y, FAC_RIVER_PUMP, 1).ok);
assert.ok(!canPlaceFacility(world, x, y, FAC_RIVER_PUMP, 2).ok, 'river pump needs water');
world.placeFacility(x, y, FAC_GROUNDWATER, 0);
world.setBuild(x + 6, y + 5, Build.Road, false);
world.setTile(x + 6, y + 8, Terrain.WaterShallow);
assert.ok(canPlaceFacility(world, x + 6, y + 6, FAC_OUTFALL, 1).ok);
world.placeFacility(x + 6, y + 6, FAC_OUTFALL, 0);
world.setBuild(x + 6, y + 3, Build.ZoneR, false);
world.placeBuilding(x + 6, y + 3, ZONE_R, 1, 0);
for (let dx = 0; dx <= 6; dx++) pipe(dx, 2, 1);
for (let dy = 4; dy <= 6; dy++) pipe(6, dy, 2);
const field = new WaterField();
field.ensure(world);
assert.deepEqual(field.statusAt(x + 6, y + 3), { supply: 1, drainage: 1, contamination: 0 });
assert.equal(field.summary.waterCapacity, 1000);
assert.equal(field.summary.sewerCapacity, 1500);
assert.ok(!isWelfareKind(FAC_TREATMENT));

pipe(4, 3, 2); // adjacent, different pipe
field.ensure(world);
assert.equal(field.contaminationAt(x + 6, y + 3), 1);
pipe(4, 3, 0);
pipe(4, 2, 3); // same-cell crossing
field.ensure(world);
assert.equal(field.contaminationAt(x + 6, y + 3), 1);
pipe(4, 2, 1);
field.ensure(world);
assert.equal(field.contaminationAt(x + 6, y + 3), 0);
pipe(3, 2, 0);
field.ensure(world);
assert.equal(field.statusAt(x + 6, y + 3).supply, 0);
pipe(3, 2, 1);
world.setBuild(x, y - 1, Build.None);
field.ensure(world);
assert.equal(field.statusAt(x + 6, y + 3).supply, 0, 'roadless pump stops');
world.setBuild(x, y - 1, Build.Road, false);

// 하천 취수와 방류의 근접 오염. 처리장으로 교체하면 줄어든다.
world.setBuild(x + 10, y + 5, Build.Road, false);
world.setTile(x + 10, y + 8, Terrain.WaterShallow);
world.placeFacility(x + 10, y + 6, FAC_RIVER_PUMP, 0);
for (let dy = 2; dy <= 6; dy++) pipe(10, dy, 1);
for (let dx = 6; dx <= 10; dx++) pipe(dx, 2, 1);
field.ensure(world);
const untreated = field.contaminationAt(x + 6, y + 3);
assert.ok(untreated > 0);
world.removeFacilityAt(x + 6, y + 6);
world.setTile(x + 6, y + 8, Terrain.Grass);
world.setTile(x + 6, y + 9, Terrain.WaterShallow);
assert.ok(!canPlaceFacility(world, x + 6, y + 6, FAC_TREATMENT, 2).ok);
assert.ok(canPlaceFacility(world, x + 6, y + 6, FAC_TREATMENT, 3).ok);
world.placeFacility(x + 6, y + 6, FAC_TREATMENT, 0);
field.ensure(world);
assert.ok(field.contaminationAt(x + 6, y + 3) < untreated * 0.2);
assert.equal(field.summary.sewerCapacity, 5000);

// Two chunks containing only pipes must survive codec, snapshots, unload and reload.
const bx = (world.baseCx + 1) * CHUNK_SIZE;
world.setPipe(bx - 1, y + 18, 1);
world.setPipe(bx, y + 18, 1);
const snapshots = world.takeDirty().chunks;
const saved = new Map<string, ChunkOverride>();
for (const s of snapshots)
  saved.set(`${s.cx},${s.cy}`, {
    ...s,
    pipes: decodeOverride(encodeOverride(s.pipes), CHUNK_TILES),
  });
const clone = new World(0);
clone.setPersistedOverrides(saved);
clone.unloadChunk(world.baseCx + 1, world.baseCy);
assert.equal(clone.getPipe(bx, y + 18), 1);
const cloneField = new WaterField();
cloneField.ensure(clone);
assert.equal(
  cloneField.nodes.get(`${bx - 1},${y + 18}`)?.water,
  cloneField.nodes.get(`${bx},${y + 18}`)?.water,
);
field.ensure(world);
assert.deepEqual(cloneField.summary, field.summary);
clone.setPipe(bx, y + 18, 0);
assert.equal(clone.getPipe(bx, y + 18), 0);
assert.equal(
  world.getBld(x + 6, y + 3),
  clone.getBld(x + 6, y + 3),
  'pipe demolition preserves buildings',
);

// A single deterministic illness roll proves contaminated water affects the actual disaster path.
let illnessTick = 0;
for (let tick = 1; tick < 100000; tick++) {
  const r = (kind: number) =>
    simRandom(WORLD_SEED ^ (0x51ed270b + kind * 0x9e3779b9), tick, x + 6, y + 3);
  if (r(2) >= 0.000025 && r(2) < 0.000125 && r(0) >= 0.000012 && r(1) >= 0.00003) {
    illnessTick = tick;
    break;
  }
}
assert.ok(illnessTick > 0);
const clean = new DisasterSim(),
  dirty = new DisasterSim();
const services = { serviceQualityAt: () => 0 };
clean.step(world, services, illnessTick, 1, { contaminationAt: () => 0 });
dirty.step(world, services, illnessTick, 1, { contaminationAt: () => 1 });
assert.equal(clean.counts[2], 0);
assert.equal(dirty.counts[2], 1);
// 용량 부족은 관망 전체에 비례 적용되고 펌프 증설로 해소된다.
const loadedWorld = new World(0);
loadedWorld.setBuild(x, y - 1, Build.Road, false);
loadedWorld.placeFacility(x, y, FAC_GROUNDWATER, 0);
for (let dx = 0; dx < 39; dx++) loadedWorld.setPipe(x + dx, y + 2, 1);
for (let i = 0; i < 8; i++) {
  loadedWorld.setBuild(x + i * 4, y + 3, Build.ZoneR, false);
  loadedWorld.placeBuilding(x + i * 4, y + 3, ZONE_R, 3, 0);
}
const loadedField = new WaterField();
loadedField.ensure(loadedWorld);
assert.equal(loadedField.summary.demand, 1080);
assert.equal(loadedField.statusAt(x, y + 3).supply, 1000 / 1080);
loadedWorld.setBuild(x + 36, y - 1, Build.Road, false);
loadedWorld.placeFacility(x + 36, y, FAC_GROUNDWATER, 0);
loadedField.ensure(loadedWorld);
assert.equal(loadedField.statusAt(x, y + 3).supply, 1);
const macro = { money: 100000, population: 0, tick: 2400, tickedAt: 1000, waterStartTick: 2000 };
const sim = new MacroSim(world, macro);
sim.primeCatchup(1000);
assert.equal(macro.waterStartTick, 2000, 'reconnect does not reset grace');
clone.clearBuilt();
assert.equal(clone.getPipe(bx - 1, y + 18), 0);
console.log(
  'STEP 4.2 smoke passed: supply/sewer, placement, mixing, disconnection, road loss, discharge/treatment, cross-chunk persistence, demolition, illness, grace.',
);
