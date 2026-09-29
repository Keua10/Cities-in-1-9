import { Build } from '../../src/world/build';
import assert from 'node:assert/strict';
import { MacroSim } from '../../src/sim/macro';
import { World } from '../../src/world/world';
import { Terrain } from '../../src/world/terrain';
import { ZONE_R, ZONE_C } from '../../src/sim/buildings';
import { DAYTIME_DAY_MS, MS_PER_TICK, OFFLINE_SPEED } from '../../src/sim/simConstants';
import { pollutionCeiling, environmentCeiling, environmentScore } from '../../src/sim/environment';
import { qualityFromLoad } from '../../src/sim/serviceQuality';
import { FAC_FIRE, FAC_HOSPITAL, FAC_SCHOOL } from '../../src/sim/facilities';
import { FAC_INCINERATOR } from '../../src/sim/config/sanitation';
import { DisasterSim, type Incident } from '../../src/sim/disasters';

const makeSim = () =>
  new MacroSim(new World(), { money: 1000, population: 0, tick: 0, tickedAt: 1000 });
const sim = makeSim();
sim.financeEstimate = () => ({ income: 123.4567, upkeep: 23.4567 });
sim.update(1000, 1);
assert.equal(sim.money, 1000.0833, 'cash arrives before any macro tick or citizen arrival');
for (let ms = 1000; ms < DAYTIME_DAY_MS; ms += 1000) sim.update(1000, 1);
assert.equal(
  sim.money,
  1100,
  'a full displayed day earns exactly daily net, with no midnight double payment',
);
sim.holdClock();
sim.update(0, 1);
assert.equal(sim.money, 1100, 'pause does not accrue');
sim.financeEstimate = () => ({ income: 0, upkeep: 100 });
for (let ms = 0; ms < DAYTIME_DAY_MS; ms += 1000) sim.update(1000, 1);
assert.equal(sim.money, 1000, 'upkeep uses the same continuous clock and whole-won precision');
const offline = makeSim();
offline.financeEstimate = () => ({ income: 100, upkeep: 0 });
offline.primeCatchup(1000 + (MS_PER_TICK * 10) / OFFLINE_SPEED);
offline.update(0, 10);
assert.equal(offline.money, 1002.0833, 'offline catchup accrues its bounded elapsed time once');

const excellent = { parks: 1, noise: 0, traffic: 0, access: 1, pollution: 0 };
assert.equal(environmentCeiling(ZONE_R, excellent), 1);
assert(pollutionCeiling(ZONE_R, 0.1) < 0.73);
assert(pollutionCeiling(ZONE_R, 0.25) < 0.39);
assert.equal(environmentCeiling(ZONE_R, { ...excellent, pollution: 0.7 }), 0);
assert(environmentScore({ ...excellent, pollution: 0.8 }) < 0.3);
assert(environmentCeiling(ZONE_C, { ...excellent, pollution: 0.7 }) > 0);

// Full MacroSim: clean occupied home becomes vacant near pollution despite plentiful amenities,
// and recovers after removal. No saved occupancy or renderer-only proxy is involved.
const world = new World();
world.getTile = () => Terrain.Grass;
world.sampleHeight = () => 0;
world.setBuild(20, 20, Build.ZoneR, false);
world.placeBuilding(20, 20, ZONE_R, 1, 0);
const city = new MacroSim(world, { money: 1000, population: 0, tick: 0, tickedAt: 1000 });
city.roadField.commuteFor = () => 1;
city.services.amenityForBuilding = () => 100;
city.primeCatchup(1000);
const clean = city.occupancyAt(20, 20)!;
assert(clean > 0.9);
world.placeFacility(22, 20, FAC_INCINERATOR, 0);
city.primeCatchup(1000);
assert.equal(city.occupancyAt(20, 20), 0);
assert(city.buildingAlerts(20, 20).includes('pollution'));
world.demolishAt(22, 20);
city.primeCatchup(1000);
assert(city.occupancyAt(20, 20)! > 0.9);

assert(qualityFromLoad(FAC_FIRE, 1.1) < 0.56);
assert(qualityFromLoad(FAC_FIRE, 1.2) < 0.39);
for (const kind of [FAC_HOSPITAL, FAC_SCHOOL]) {
  assert.equal(qualityFromLoad(kind, 1.1), 1);
  assert(qualityFromLoad(kind, 1.2) > 0.97);
  assert(qualityFromLoad(kind, 2) < 0.7);
}

function fireTrial(ratio: number) {
  const w = new World();
  const active: Incident[] = [];
  for (let i = 0; i < 100; i++) {
    const tx = 10 + (i % 10) * 4,
      ty = 10 + Math.floor(i / 10) * 4;
    w.placeBuilding(tx, ty, ZONE_R, 1, 0);
    active.push({ kind: 0, tx, ty, code: 0, born: 0, startedTick: 0 });
  }
  const fires = new DisasterSim({
    version: 1,
    active,
    started: [100, 0, 0],
    extinguished: 0,
    burned: 0,
  });
  let fireTicks = 0;
  for (let tick = 1; tick <= 12; tick++) {
    fireTicks += fires.active.length;
    fires.step(w, { serviceQualityAt: () => qualityFromLoad(FAC_FIRE, ratio) }, tick, 0);
  }
  return { fireTicks, burned: fires.burned };
}
const normal = fireTrial(1),
  overloaded = fireTrial(1.2);
assert(
  overloaded.fireTicks > normal.fireTicks * 1.7,
  '20% overload materially prolongs real incidents',
);
assert(overloaded.burned > normal.burned, 'overload increases actual losses');
console.log(
  'PASS continuous finance, offline/pause precision, pollution vacancy/recovery, mild healthcare load, fire duration:',
  { normal, overloaded },
);
