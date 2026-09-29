import assert from 'node:assert/strict';
import { World } from '../../src/world/world';
import { Terrain } from '../../src/world/terrain';
import { Build } from '../../src/world/build';
import { MacroSim } from '../../src/sim/macro';
import { NatureSystem } from '../../src/sim/nature';
import { ConstructionSystem, completionLabel } from '../../src/sim/construction';
import { MetroNetwork } from '../../src/sim/metro';
import type { MacroState } from '../../src/net/types';
import { DAYTIME_DAY_MS } from '../../src/sim/simConstants';
import { sessionDaytimeAt } from '../../src/sim/time';
import { Tools } from '../../src/ui/tools';
import { FACILITY_SPECS } from '../../src/sim/facilities';
import { lightingColor } from '../../src/render/dayNight';

function fixture() {
  const world = new World();
  world.getTile = () => Terrain.Grass;
  world.sampleHeight = () => 0;
  world.isExplored = () => true;
  const state: MacroState = {
    money: 1000000,
    population: 0,
    tick: 0,
    tickedAt: Date.now(),
    lifeElapsedMs: 0,
  };
  const sim = new MacroSim(world, state);
  return { world, state, sim };
}
assert.equal(DAYTIME_DAY_MS, 600000);
assert.equal(sessionDaytimeAt(25000, 0).hour, 8.5);
const { world, state, sim } = fixture();
const tools = new Tools(world, { invalidateTile() {}, forceRedraw() {} } as any, sim);
tools.setTool('facility');
tools.facilityKind = 0;
tools.tapTile(10, 10);
assert.equal(state.money, 1000000, 'tap does not charge');
assert.equal(sim.construction.jobs.length, 0, 'tap does not start construction');
assert(tools.summary().active && tools.summary().canConfirm);
tools.cancelPlacement();
assert.equal(world.getBuild(10, 10), Build.None);
tools.tapTile(10, 10);
tools.confirmPlacement();
assert.equal(state.money, 1000000 - FACILITY_SPECS[0].cost);
const job = sim.construction.jobs[0];
assert(job);
assert.equal(world.buildingCovering(10, 10), null, 'unfinished facility cannot provide services');
assert.equal(world.getBuild(10, 10), Build.Civic, 'reserved footprint blocks other construction');
tools.tapTile(10, 10);
tools.confirmPlacement();
assert.equal(sim.construction.jobs.length, 1, 'no duplicate charges or overlapping jobs');
assert.equal(completionLabel(job.finishes), '1일 15:30');
const restoredState = JSON.parse(JSON.stringify(state));
const restored = new ConstructionSystem(
  world,
  restoredState,
  new MetroNetwork(world, restoredState, () => {}),
  () => {},
);
restoredState.lifeElapsedMs = job.finishes - 1;
restored.update();
assert.equal(world.buildingCovering(10, 10), null);
restoredState.lifeElapsedMs++;
restored.update();
assert.equal(world.buildingCovering(10, 10)?.kind, 0);
assert.equal(restored.jobs.length, 0);
assert.equal(restoredState.money, state.money, 'completion never charges again');

const station = fixture();
station.world.setBuild(20, 19, Build.Road);
station.sim.construction.start(20, 20, 26, 99);
assert.equal(station.sim.metro.stationAtSurface(20, 20), undefined);
const sj = station.sim.construction.jobs[0];
assert(sj);
station.state.lifeElapsedMs = sj.finishes;
station.sim.construction.update();
assert(station.sim.metro.stationAtSurface(20, 20));
assert.equal(station.state.money, 982000);
station.sim.construction.start(30, 30, 0, 99);
assert(station.sim.construction.cancel(31, 31));
assert.equal(station.world.getBuild(30, 30), Build.None);
assert.equal(station.world.getBuild(31, 31), Build.None);

function weatherFixture() {
  const f = fixture();
  f.world.setBuild(10, 10, Build.ZoneR);
  f.world.placeBuilding(10, 10, 0, 1, 0);
  f.sim.nature.setWeather({
    precipitation: 'clear',
    intensity: 0,
    windSpeed: 0,
    direction: 0,
    temperature: 10,
    cloud: 0,
  });
  return f;
}
const f = weatherFixture(),
  nature = f.sim.nature;
nature.start('typhoon', 3, 10, 10, 90, 10);
assert.equal(nature.windAt(10, 10).speed, 0, 'typhoon eye is calm');
assert(nature.windAt(27, 10).speed > 45, 'eyewall is stronger than the eye');
f.state.lifeElapsedMs = DAYTIME_DAY_MS / 24;
assert(Math.abs(nature.center()!.x - 20) < 1e-9, 'eastward path uses life hours');
assert.equal(nature.center()!.y, 10);
nature.stop();
assert.equal(nature.center(), null);
nature.setWeather({
  precipitation: 'rain',
  intensity: 1,
  windSpeed: 3,
  direction: 180,
  temperature: 10,
  cloud: 1,
});
assert(nature.roadGripAt(10, 10) < 1);
nature.setWeather({
  precipitation: 'snow',
  intensity: 1,
  windSpeed: 3,
  direction: 180,
  temperature: -5,
  cloud: 1,
});
f.state.nature!.lastStep = f.state.lifeElapsedMs!;
f.state.lifeElapsedMs! += 1000;
nature.update();
assert(nature.state.snow['10,10'] > 0, 'snow accumulates in freezing weather');
nature.setWeather({
  precipitation: 'clear',
  intensity: 0,
  windSpeed: 0,
  direction: 0,
  temperature: 20,
  cloud: 0,
});
const snow = nature.state.snow['10,10'];
f.state.lifeElapsedMs! += 1000;
nature.update();
assert(nature.state.snow['10,10'] < snow, 'snow melts after weather stops');

const slope = weatherFixture();
slope.world.sampleHeight = (x) => (x === 10 ? 1 : 0);
slope.sim.nature.state.water['10,10'] = 1;
slope.state.lifeElapsedMs = 1000;
slope.sim.nature.update();
assert((slope.sim.nature.state.water['11,10'] ?? 0) > 0, 'surface water flows downhill');
const a = weatherFixture(),
  b = weatherFixture();
for (const q of [a, b]) q.sim.nature.start('earthquake', 5, 10, 10, 0, 0);
for (let i = 0; i < 12; i++) {
  a.state.lifeElapsedMs! += 1000;
  a.sim.nature.update();
}
b.state.lifeElapsedMs = 12000;
b.sim.nature.update();
b.sim.nature.update();
assert.deepEqual(
  a.sim.nature.state,
  b.sim.nature.state,
  'fixed-step damage independent of frame grouping',
);
assert(a.sim.nature.state.destroyed > 0, 'severe natural disaster actually damages buildings');
const restoredNature = new NatureSystem(a.world, JSON.parse(JSON.stringify(a.state)), () => {});
assert.deepEqual(
  restoredNature.state,
  a.sim.nature.state,
  'nature state survives JSON save/restore',
);
const night = lightingColor({ ...sessionDaytimeAt(0, 0), hour: 0 });
assert((night & 255) > ((night >> 16) & 255), 'night is blue ambient, not grayscale');
assert.equal(lightingColor({ ...sessionDaytimeAt(0, 0), hour: 12 }), 0xffffff);
console.log(
  'PASS construction confirmation, reservations, fees, life clock, completion/restore, metro, cancellation, typhoon path/eye, road grip, snow/melt, downhill drainage, disaster damage/determinism, coloured night.',
);
