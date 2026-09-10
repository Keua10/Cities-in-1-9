import { strict as assert } from 'node:assert';
import { CHUNK_SIZE, CHUNK_TILES } from '../../src/core/constants';
import { World, type ChunkOverride } from '../../src/world/world';
import { Build } from '../../src/world/build';
import { ZONE_R } from '../../src/sim/buildings';
import { PowerField } from '../../src/sim/power';
import { WaterField } from '../../src/sim/water';
import { FAC_WIND } from '../../src/sim/config/power';
import { FAC_GROUNDWATER } from '../../src/sim/config/water';
import { seedCityIfEmpty } from '../../src/world/citySeed';
import { decodeOverride, encodeOverride } from '../../src/net/codec';

const w = new World(0),
  x = w.baseCx * CHUNK_SIZE + 10,
  y = w.baseCy * CHUNK_SIZE + 10;
w.setBuild(x, y - 1, Build.Road, false);
w.placeFacility(x, y, FAC_WIND, 0);
const house = (dx: number, dy = 0) => {
  w.setBuild(x + dx, y + dy, Build.ZoneR, false);
  w.placeBuilding(x + dx, y + dy, ZONE_R, 1, 0);
};
house(4);
house(7);
house(10);
house(14);
const power = new PowerField();
power.ensure(w);
assert.equal(power.supplyAt(x + 10, y), 1, 'chain of nearby buildings conducts without wires');
assert.equal(power.supplyAt(x + 14, y), 0, 'four tile gap breaks chain');
assert.equal(power.coverage.get(`${x + 13},${y}`), 1, 'range extends exactly three tiles');
assert.equal(power.coverage.has(`${x + 14},${y}`), false, 'empty coverage cannot relay');
w.demolishAt(x + 7, y);
power.ensure(w);
assert.equal(power.supplyAt(x + 10, y), 0, 'demolished bridge building disconnects descendants');
house(7);
power.ensure(w);
assert.equal(power.supplyAt(x + 10, y), 1);
w.setWire(x + 12, y, true);
power.ensure(w);
assert.equal(power.supplyAt(x + 14, y), 1, 'wire joins building relay networks');
w.setBuild(x, y - 1, Build.None);
power.ensure(w);
assert.equal(power.supplyAt(x + 4, y), 0, 'generator needs road');
w.setBuild(x, y - 1, Build.Road, false);
// High demand is counted once per building, even with multiple relay paths.
for (let i = 0; i < 16; i++) {
  const hx = x + (i % 4) * 4,
    hy = y + 4 + Math.floor(i / 4) * 4;
  w.setBuild(hx, hy, Build.ZoneR, false);
  w.placeBuilding(hx, hy, ZONE_R, 3, 0);
}
power.ensure(w);
assert.equal(power.summary.demand, 16 * 135 + 4 * 8);
assert.equal(power.supplyAt(x + 4, y), 2000 / power.summary.demand);
w.setBuild(x + 20, y + 2, Build.Road, false);
w.placeFacility(x + 20, y + 3, FAC_GROUNDWATER, 0);
w.setPipe(x + 20, y + 4, 1);
const water = new WaterField();
water.power = power;
water.ensure(w);
assert.equal(water.summary.waterCapacity, 0, 'unpowered pump cannot produce water');
for (let dx = 14; dx <= 20; dx++) w.setWire(x + dx, y, true);
power.ensure(w);
water.ensure(w);
assert.ok(
  water.summary.waterCapacity > 0 && water.summary.waterCapacity < 1000,
  'brownout scales pump output',
);
const border = (w.baseCx + 1) * CHUNK_SIZE;
w.setWire(border - 1, y + 25, true);
w.setWire(border, y + 25, true);
power.ensure(w);
const taken = w.takeDirty().chunks;
const saved = new Map<string, ChunkOverride>();
for (const c of taken)
  saved.set(`${c.cx},${c.cy}`, {
    ...c,
    wires: decodeOverride(encodeOverride(c.wires), CHUNK_TILES),
  });
const restored = new World(0);
restored.setPersistedOverrides(saved);
const copy = new PowerField();
copy.ensure(restored);
assert.deepEqual(copy.summary, power.summary);
restored.unloadChunk(w.baseCx + 1, w.baseCy);
assert.equal(restored.getWire(border, y + 25), true, 'wire-only chunk survives unload');
restored.clearBuilt();
assert.equal(restored.getWire(border, y + 25), false);

const city = new World(0);
assert.ok(seedCityIfEmpty(city));
const cityPower = new PowerField();
cityPower.ensure(city);
const cityWater = new WaterField();
cityWater.power = cityPower;
cityWater.ensure(city);
console.log(
  'Generated city:',
  JSON.stringify({ power: cityPower.summary, water: cityWater.summary }),
);
assert.ok(cityPower.summary.demand > 1000);
assert.equal(cityPower.summary.supply, 1, 'generated city fully powered');
assert.equal(cityWater.summary.supply, 1, 'generated city fully supplied');
assert.equal(cityWater.summary.drainage, 1, 'generated city fully drained');
assert.equal(cityWater.summary.contaminatedBuildings, 0, 'generated pipes never mix');
assert.equal(seedCityIfEmpty(city), null, 'existing cities preserved');
for (const cityIndex of [1, 7]) {
  const sample = new World(cityIndex);
  assert.ok(seedCityIfEmpty(sample));
  const p = new PowerField();
  p.ensure(sample);
  const water = new WaterField();
  water.power = p;
  water.ensure(sample);
  assert.equal(p.summary.supply, 1, `city ${cityIndex} power`);
  assert.equal(water.summary.supply, 1, `city ${cityIndex} water`);
  assert.equal(water.summary.drainage, 1, `city ${cityIndex} sewage`);
  assert.equal(water.summary.contaminatedBuildings, 0, `city ${cityIndex} clean pipes`);
}
console.log(
  'STEP 4.3 smoke passed: building relays, exact range, broken bridges, wires, blackout, capacity, pumps, persistence and seeded infrastructure.',
);
