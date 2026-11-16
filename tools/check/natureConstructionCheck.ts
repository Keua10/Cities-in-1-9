import assert from 'node:assert/strict';
import { World } from '../../src/world/world';
import { Terrain } from '../../src/world/terrain';
import { Build } from '../../src/world/build';
import { MacroSim } from '../../src/sim/macro';
import { NatureSystem } from '../../src/sim/nature';
import { ConstructionSystem, constructionSeconds } from '../../src/sim/construction';
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
assert.equal(job.workMs, constructionSeconds(0) * 1000, 'work is real-time seconds');
// 공사는 실제 시계로 진행된다. 저장 후 접속하지 않은 동안에도 이어서 계산한다.
const t0 = 1_000_000;
state.constructionAt = t0;
const restoredState = JSON.parse(JSON.stringify(state));
const restored = new ConstructionSystem(
  world,
  restoredState,
  new MetroNetwork(world, restoredState, () => {}),
  () => {},
);
restored.update(t0 + job.workMs! - 1);
assert.equal(world.buildingCovering(10, 10), null);
assert(restored.progress(restored.jobs[0]) > 0.99);
restored.update(t0 + job.workMs!);
assert.equal(world.buildingCovering(10, 10)?.kind, 0);
assert.equal(restored.jobs.length, 0);
assert.equal(restoredState.money, state.money, 'completion never charges again');

// 스타트 버닝 구간은 10배로 진행한다.
const boosted = fixture();
boosted.sim.construction.start(40, 40, 2, 99); // 병원 3분
const bj = boosted.sim.construction.jobs[0];
boosted.state.constructionAt = t0;
boosted.state.startBoostMs = 60_000;
assert.equal(boosted.sim.construction.remainingMs(bj), bj.workMs! / 10);
boosted.sim.construction.update(t0 + 10_000, 10_000);
assert.equal(bj.doneMs, 100_000);
boosted.sim.construction.update(t0 + 20_000, 0);
assert.equal(bj.doneMs, 110_000);

// 예전 저장(생활 시계 started/finishes)도 남은 비율 그대로 옮겨진다.
const legacy = fixture();
legacy.state.lifeElapsedMs = 5_000;
legacy.state.construction = [
  { tx: 50, ty: 50, kind: 0, span: 2, cost: 0, started: 0, finishes: 20_000 },
];
const lj = legacy.sim.construction.jobs[0];
// 진행 비율(25%)은 그대로, 길이는 지금 공사 기간 표를 따른다.
assert.equal(lj.workMs, constructionSeconds(0) * 1000);
assert.equal(lj.doneMs, constructionSeconds(0) * 1000 * 0.25);
// 표가 바뀌기 전에 착공한 공사도 새 기간을 따른다(언제 착공했든 같은 속도).
legacy.state.construction.push({
  tx: 60,
  ty: 60,
  kind: 2,
  span: 3,
  cost: 0,
  workMs: 6_000_000,
  doneMs: 3_000_000,
});
const old = legacy.sim.construction.jobs[1];
assert.equal(old.workMs, constructionSeconds(2) * 1000);
assert.equal(old.doneMs, constructionSeconds(2) * 500);
assert.equal(lj.started, undefined);

const station = fixture();
station.world.setBuild(20, 19, Build.Road);
station.sim.construction.start(20, 20, 26, 99);
assert.equal(station.sim.metro.stationAtSurface(20, 20), undefined);
const sj = station.sim.construction.jobs[0];
assert(sj);
station.state.constructionAt = 0;
station.sim.construction.update(sj.workMs!);
assert(station.sim.metro.stationAtSurface(20, 20));
assert.equal(station.state.money, 982000);
station.sim.construction.start(30, 30, 0, 99);
assert(station.sim.construction.cancel(31, 31));
assert.equal(station.world.getBuild(30, 30), Build.None);
assert.equal(station.world.getBuild(31, 31), Build.None);

// 철거 도구는 공사 중인 칸을 지우지 않는다. 공사 창의 "공사 취소" 로만 취소한다.
{
  const f = fixture();
  const t = new Tools(f.world, { invalidateTile() {}, forceRedraw() {} } as any, f.sim);
  t.setTool('facility');
  t.facilityKind = 2;
  t.tapTile(70, 70);
  t.confirmPlacement();
  assert.equal(f.sim.construction.jobs.length, 1);
  t.setTool('bulldoze');
  t.tapTile(69, 69);
  t.tapTile(73, 73);
  t.confirmPlacement();
  assert.equal(f.sim.construction.jobs.length, 1, 'bulldoze never cancels construction');
  assert.equal(f.world.getBuild(71, 71), Build.Civic);
  assert(t.cancelConstruction(71, 71));
  assert.equal(f.sim.construction.jobs.length, 0);
  for (let y = 70; y < 73; y++)
    for (let x = 70; x < 73; x++)
      assert.equal(f.world.getBuild(x, y), Build.None, 'cancel frees the plot');
}

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
