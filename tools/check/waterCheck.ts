import { strict as assert } from 'node:assert';
import { CHUNK_SIZE, CHUNK_TILES, WORLD_SEED } from '../../src/core/constants';
import { decodeOverride, encodeOverride } from '../../src/net/codec';
import { ZONE_R, simRandom, isWelfareKind } from '../../src/sim/buildings';
import {
  FAC_GROUNDWATER,
  FAC_RIVER_PUMP,
  FAC_OUTFALL,
  FAC_TREATMENT,
  WATER_SPECS,
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
/** 도로처럼 그은 배관: 놓고 앞 칸과 잇는다(피드백 2차 — 옆에 닿기만 하면 안 이어진다). */
const run = (w: World, pts: Array<[number, number]>, type: 1 | 2) => {
  pts.forEach(([px, py], i) => {
    w.setPipe(px, py, w.getPipe(px, py) | type);
    if (i > 0) w.connectPipes(pts[i - 1][0], pts[i - 1][1], px, py, type);
  });
};
const hline = (x0: number, x1: number, yy: number) =>
  Array.from({ length: x1 - x0 + 1 }, (_, i) => [x + x0 + i, y + yy] as [number, number]);
const vline = (xx: number, y0: number, y1: number) =>
  Array.from({ length: y1 - y0 + 1 }, (_, i) => [x + xx, y + y0 + i] as [number, number]);
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
run(world, hline(0, 6, 2), 1);
run(world, vline(6, 4, 6), 2);
const field = new WaterField();
field.ensure(world);
assert.deepEqual(field.statusAt(x + 6, y + 3), {
  supply: 1,
  drainage: 1,
  contamination: 0,
  inWater: true,
  inSewer: true,
});
assert.equal(field.summary.waterCapacity, WATER_SPECS[FAC_GROUNDWATER].capacity);
assert.equal(field.summary.sewerCapacity, WATER_SPECS[FAC_OUTFALL].capacity);
assert.ok(!isWelfareKind(FAC_TREATMENT));

// 상·하수도는 옆에 닿거나 한 칸에서 엇갈려도 섞이지 않는다(깊이가 다르다).
pipe(4, 3, 2);
field.ensure(world);
assert.equal(field.contaminationAt(x + 6, y + 3), 0, '옆에 닿은 하수관: 오염 없음');
pipe(4, 3, 0);
pipe(4, 2, 3);
field.ensure(world);
assert.equal(field.contaminationAt(x + 6, y + 3), 0, '한 칸 교차: 오염 없음');
pipe(4, 2, 1);
// 같은 종류도 옆에 닿기만 해서는 이어지지 않는다(도로처럼).
const sideWorld = new World(0);
run(
  sideWorld,
  [
    [x, y + 30],
    [x + 1, y + 30],
  ],
  1,
);
run(
  sideWorld,
  [
    [x, y + 31],
    [x + 1, y + 31],
  ],
  1,
);
const sideField = new WaterField();
sideField.ensure(sideWorld);
assert.notEqual(
  sideField.nodes.get(`${x},${y + 30}`)?.water,
  sideField.nodes.get(`${x},${y + 31}`)?.water,
  '나란히 닿은 상수관은 따로',
);
// 가로질러 놓으면 지나간 칸에서 이어진다.
run(
  sideWorld,
  [
    [x + 1, y + 29],
    [x + 1, y + 30],
    [x + 1, y + 31],
    [x + 1, y + 32],
  ],
  1,
);
sideField.ensure(sideWorld);
assert.equal(
  sideField.nodes.get(`${x},${y + 30}`)?.water,
  sideField.nodes.get(`${x},${y + 31}`)?.water,
  '가로지른 관으로 이어짐',
);
for (let dx = 1; dx <= 5; dx++) pipe(dx, 2, 0);
field.ensure(world);
assert.equal(field.statusAt(x + 6, y + 3).supply, 0);
// 범위 표시: 끊긴 관 근처도 반경 안(회색)으로 알려 준다.
assert.equal(field.coverage.get(`${x + 6},${y + 4}`)?.inWater, true);
run(world, hline(0, 6, 2), 1);
world.setBuild(x, y - 1, Build.None);
field.ensure(world);
assert.equal(field.statusAt(x + 6, y + 3).supply, 0, 'roadless pump stops');
// 수정사항 12: 꺼진 이유가 한 가지로 좁혀져 나온다. 네 가지를 늘어놓지 않는다.
assert.match(field.facilityStatus(x, y), /가동 중지: 도로 미접/);
world.setBuild(x, y - 1, Build.Road, false);
field.ensure(world);
assert.match(field.facilityStatus(x, y), /^가동 ·/);

// 하천 취수와 방류의 근접 오염. 처리장으로 교체하면 줄어든다.
world.setBuild(x + 10, y + 5, Build.Road, false);
world.setTile(x + 10, y + 8, Terrain.WaterShallow);
world.placeFacility(x + 10, y + 6, FAC_RIVER_PUMP, 0);
run(world, [...hline(6, 10, 2), ...vline(10, 3, 6)], 1);
field.ensure(world);
const untreated = field.contaminationAt(x + 6, y + 3);
assert.ok(untreated > 0);
world.removeFacilityAt(x + 6, y + 6);
world.setTile(x + 6, y + 8, Terrain.Grass);
world.setTile(x + 6, y + 9, Terrain.WaterShallow);
assert.ok(!canPlaceFacility(world, x + 6, y + 6, FAC_TREATMENT, 3).ok);
assert.ok(canPlaceFacility(world, x + 6, y + 6, FAC_TREATMENT, 4).ok);
world.placeFacility(x + 6, y + 6, FAC_TREATMENT, 0);
field.ensure(world);
assert.ok(field.contaminationAt(x + 6, y + 3) < untreated * 0.2);
assert.equal(field.summary.sewerCapacity, WATER_SPECS[FAC_TREATMENT].capacity);

// Two chunks containing only pipes must survive codec, snapshots, unload and reload.
const bx = (world.baseCx + 1) * CHUNK_SIZE;
run(
  world,
  [
    [bx - 1, y + 18],
    [bx, y + 18],
  ],
  1,
);
const snapshots = world.takeDirty().chunks;
const saved = new Map<string, ChunkOverride>();
for (const s of snapshots)
  saved.set(`${s.cx},${s.cy}`, {
    ...s,
    pipes: decodeOverride(encodeOverride(s.pipes), CHUNK_TILES),
    pipeLinks: decodeOverride(encodeOverride(s.pipeLinks ?? null), CHUNK_TILES),
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
run(loadedWorld, hline(0, 38, 2), 1);
for (let i = 0; i < 8; i++) {
  loadedWorld.setBuild(x + i * 4, y + 3, Build.ZoneR, false);
  loadedWorld.placeBuilding(x + i * 4, y + 3, ZONE_R, 3, 0);
}
const loadedField = new WaterField();
loadedField.ensure(loadedWorld);
assert.equal(loadedField.summary.demand, 1080);
assert.equal(
  loadedField.statusAt(x, y + 3).supply,
  Math.min(1, WATER_SPECS[FAC_GROUNDWATER].capacity / 1080),
);
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
