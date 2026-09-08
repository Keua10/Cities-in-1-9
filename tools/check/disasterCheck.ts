import { strict as assert } from 'node:assert';
import { CHUNK_SIZE } from '../../src/core/constants';
import {
  DisasterSim,
  normalizeDisasters,
  type DisasterState,
  type Incident,
} from '../../src/sim/disasters';
import { BLD_NONE, ZONE_R } from '../../src/sim/buildings';
import { MacroSim } from '../../src/sim/macro';
import { ServiceField } from '../../src/sim/services';
import { DISASTER_MAX_ACTIVE, MS_PER_TICK, OFFLINE_SPEED } from '../../src/sim/simConstants';
import { FAC_FIRE } from '../../src/sim/facilities';
import { Build } from '../../src/world/build';
import { Terrain } from '../../src/world/terrain';
import { World, type ChunkOverride } from '../../src/world/world';

let checks = 0;
function check(name: string, ok: boolean) {
  assert.ok(ok, name);
  checks++;
  console.log(`  OK   ${name}`);
}
const q = (value: number) => ({ serviceQualityAt: () => value });
function fixture(n = 1) {
  const world = new World(0),
    ox = world.baseCx * CHUNK_SIZE + 4,
    oy = world.baseCy * CHUNK_SIZE + 4;
  for (let i = 0; i < n; i++) {
    const x = ox + (i % 16) * 3,
      y = oy + Math.floor(i / 16) * 3;
    world.setBuild(x, y, Build.ZoneR, false);
    world.placeBuilding(x, y, ZONE_R, 1, 0);
  }
  return { world, ox, oy };
}
function state(world: World, kind: 0 | 1 | 2, startedTick = 0): DisasterState {
  const active: Incident[] = [];
  for (const p of world.developedParcels())
    if (p.bld)
      for (let i = 0; i < p.bld.length; i++) {
        if (p.bld[i] >= 9) continue;
        const tx = p.cx * CHUNK_SIZE + (i % CHUNK_SIZE),
          ty = p.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
        active.push({ kind, tx, ty, code: p.bld[i], born: world.bornDayAt(tx, ty), startedTick });
      }
  return { version: 1, active, started: [0, 0, 0], extinguished: 0, burned: 0 };
}
function cloneWorld(world: World): World {
  const map = new Map<string, ChunkOverride>();
  for (const p of world.developedParcels())
    map.set(p.key, {
      tiles: p.tileOverride?.slice() ?? null,
      heights: p.heightOverride?.slice() ?? null,
      build: p.build?.slice() ?? null,
      bld: p.bld?.slice() ?? null,
      bornLo: p.bornLo?.slice() ?? null,
      bornHi: p.bornHi?.slice() ?? null,
    });
  const w = new World(0);
  w.setPersistedOverrides(map);
  return w;
}

console.log('STEP 3.4 재해 검증');
check('옛 저장본은 사건 없이 시작', normalizeDisasters(undefined, 0).active.length === 0);
{
  const { world } = fixture(200),
    s = state(world, 0);
  check('저장 사건 수 상한', normalizeDisasters(s, 0).active.length === DISASTER_MAX_ACTIVE);
  s.active = [
    s.active[0],
    s.active[0],
    { ...s.active[1], startedTick: 99 },
    { ...s.active[2], code: 9 },
  ];
  check('중복/미래 시각/시설 사건을 불러오지 않음', normalizeDisasters(s, 0).active.length === 1);
  check(
    '알 수 없는 버전은 비어 있는 상태',
    normalizeDisasters({ ...s, version: 2 }, 0).active.length === 0,
  );
}
{
  const { world, ox, oy } = fixture();
  const d = new DisasterSim(state(world, 0));
  check('화재 건물 재건축 차단', d.blocksRebuild(ox, oy, 1, world));
  world.demolishAt(ox, oy);
  check('수동 철거 직후 사건 조회는 없음', d.at(ox, oy, world) === null);
  d.step(world, q(0), 1, 0);
  check('철거 사건 청소와 이중 전소 방지', d.active.length === 0 && d.burned === 0);
  world.placeBuilding(ox, oy, ZONE_R, 1, 1);
  check('같은 자리에 새로 지은 건물은 옛 사건을 상속하지 않음', d.at(ox, oy, world) === null);
}
{
  const { world } = fixture(64),
    protectedWorld = cloneWorld(world);
  const weak = new DisasterSim(state(world, 0)),
    strong = new DisasterSim(state(protectedWorld, 0));
  for (let tick = 1; tick <= 12; tick++) {
    weak.step(world, q(0), tick, 0);
    strong.step(protectedWorld, q(1), tick, 0);
  }
  check('서비스 없는 화재는 실제 건물을 전소시킴', weak.burned > 50);
  check(
    '소방 품질 1은 전소를 줄이고 진압을 늘림',
    strong.burned < weak.burned / 5 && strong.extinguished > weak.extinguished,
  );
  check(
    '진행 중 화재는 12시간 안에 해결됨',
    weak.active.length === 0 && strong.active.length === 0,
  );
  const survivors = world.developedParcels().reduce((n, p) => n + p.buildingCount, 0);
  check('전소 건물 수와 집계 일치', survivors + weak.burned === 64);
  check(
    '전소 뒤 지구와 재건축 가능 빈 부지 보존',
    world.developedParcels().reduce((n, p) => n + p.emptyPlots, 0) === weak.burned,
  );
  check('전소가 기존 저장 경로를 더럽힘', world.takeDirty().chunks.length > 0);
  console.log(`     화재 64건: 미보호 전소 ${weak.burned}, 완전 보호 전소 ${strong.burned}`);
}
{
  const world = new World(0),
    x = (world.baseCx + 1) * CHUNK_SIZE - 1,
    y = world.baseCy * CHUNK_SIZE + 8;
  for (let dx = 0; dx < 3; dx++) {
    world.setBuild(x + dx, y, Build.ZoneR, false);
    world.placeBuilding(x + dx, y, ZONE_R, 1, 0);
  }
  let spreadTick = -1;
  for (let tick = 1; tick < 500; tick++) {
    const s = state(world, 0, tick - 1);
    s.active = s.active.filter((e) => e.tx === x);
    const d = new DisasterSim(s, tick - 1);
    d.step(world, q(0), tick, 0);
    if (d.at(x + 1, y, world)) {
      spreadTick = tick;
      check('청크 경계의 이웃 건물로 확산', d.at(x + 1, y, world)?.startedTick === tick);
      check('같은 틱에 두 번째 이웃까지 연쇄 확산하지 않음', d.at(x + 2, y, world) === null);
      break;
    }
  }
  check('확산을 실제로 발생시켜 검사함', spreadTick > 0);
  world.demolishAt(x + 1, y);
  world.setBuild(x + 1, y, Build.Road, false);
  let crossedRoad = false;
  for (let tick = 1; tick <= 100; tick++) {
    const s = state(world, 0, tick - 1);
    s.active = s.active.filter((e) => e.tx === x);
    const d = new DisasterSim(s, tick - 1);
    d.step(world, q(0), tick, 0);
    if (d.at(x + 2, y, world)) crossedRoad = true;
  }
  check('도로를 건너 불이 뛰지 않음', !crossedRoad);
}
for (const kind of [1, 2] as const) {
  const { world } = fixture(64),
    highWorld = cloneWorld(world);
  const low = new DisasterSim(state(world, kind)),
    high = new DisasterSim(state(highWorld, kind));
  for (let tick = 1; tick <= 5; tick++) {
    low.step(world, q(0), tick, 0);
    high.step(highWorld, q(1), tick, 0);
  }
  check(
    `${kind === 1 ? '경찰' : '병원'} 품질이 사건 회복을 빠르게 함`,
    high.active.length < low.active.length,
  );
  for (let tick = 6; tick <= 24; tick++) low.step(world, q(0), tick, 0);
  check(
    '범죄·질병은 영구 잔류하거나 건물을 전소시키지 않음',
    low.active.length === 0 && low.burned === 0,
  );
}
{
  const { world } = fixture(120),
    other = cloneWorld(world);
  const a = new DisasterSim(),
    b = new DisasterSim();
  for (let tick = 1; tick <= 4000; tick++) {
    a.step(world, q(0), tick, 1);
    b.step(other, q(1), tick, 1);
  }
  const low = a.snapshot().started,
    high = b.snapshot().started;
  check(
    '자연 발생이 화재·범죄·질병 모두 실제 발생',
    low.every((v) => v > 0),
  );
  check(
    '시설 품질이 세 종류의 자연 발생을 모두 줄임',
    low.every((v, k) => high[k] < v),
  );
  console.log(`     120채·4000틱 자연 발생: 미보호 [${low}], 완전 보호 [${high}]`);
}
{
  const { world } = fixture(60),
    other = cloneWorld(world);
  const a = new DisasterSim(state(world, 0));
  let b = new DisasterSim(state(other, 0));
  for (let tick = 1; tick <= 40; tick++) {
    a.step(world, q(0.2), tick, 0);
    b.step(other, q(0.2), tick, 0);
    if (tick === 4) b = new DisasterSim(JSON.parse(JSON.stringify(b.snapshot())), tick);
  }
  check(
    '저장·재접속 후 사건과 누적 결과가 연속 실행과 일치',
    JSON.stringify(a.snapshot()) === JSON.stringify(b.snapshot()),
  );
  check(
    '저장·재접속 후 물리 건물 피해도 일치',
    world
      .developedParcels()
      .every(
        (p) => [...(p.bld ?? [])].join() === [...(other.peekParcel(p.cx, p.cy)?.bld ?? [])].join(),
      ),
  );
}
{
  const { world, ox, oy } = fixture();
  const macro = { money: 0, population: 0, tick: 0, tickedAt: 1000, disasters: state(world, 0) };
  const sim = new MacroSim(world, macro);
  sim.primeCatchup(1000);
  check('매크로 화재 건물 입주율 0', sim.occupancyAt(ox, oy) === 0);
  let saved = 0;
  sim.onMacroChange = () => saved++;
  for (let i = 0; i < 12; i++) sim.update(MS_PER_TICK, 0);
  check(
    '매크로 틱이 재해를 처리하고 저장 상태를 갱신',
    macro.disasters.active.length === 0 && saved > 0,
  );
  check('파산해도 재해 처리는 계속됨', sim.tick === 12);
}
{
  const { world, ox, oy } = fixture();
  // 실제 ServiceField의 소방 품질이 도로 제거에 따라 0으로 바뀌는지 확인한다.
  for (let y = -2; y <= 5; y++)
    for (let x = -2; x <= 10; x++) {
      world.setTile(ox + x, oy + y, Terrain.Grass);
      world.setHeight(ox + x, oy + y, 0);
    }
  for (let x = 0; x <= 8; x++) world.setBuild(ox + x, oy - 1, Build.Road, false);
  world.placeFacility(ox + 5, oy, FAC_FIRE, 0);
  const services = new ServiceField();
  services.rebuild(world);
  check('실제 소방서 서비스 품질 연결', services.serviceQualityAt(ox, oy, FAC_FIRE) > 0);
  for (let x = 0; x <= 8; x++) world.setBuild(ox + x, oy - 1, Build.None, false);
  services.rebuild(world);
  check(
    '도로 단절은 재해가 읽는 품질도 0으로 만듦',
    services.serviceQualityAt(ox, oy, FAC_FIRE) === 0,
  );
  const d = new DisasterSim();
  for (let tick = 1; tick <= 300; tick++) d.step(world, services, tick, 0);
  check(
    '소도시 자연 재해 유예·시설 비대상',
    d.active.length === 0 && world.getBld(ox + 5, oy) !== BLD_NONE,
  );
}
{
  const { world } = fixture(24),
    other = cloneWorld(world);
  const liveState = {
    money: 0,
    population: 0,
    tick: 0,
    tickedAt: 1000,
    disasters: state(world, 0),
  };
  const offlineState = structuredClone(liveState);
  const live = new MacroSim(world, liveState),
    offline = new MacroSim(other, offlineState);
  live.primeCatchup(1000);
  offline.primeCatchup(1000 + (12 * MS_PER_TICK) / OFFLINE_SPEED);
  check('실제 접속 공백이 12틱 캐치업을 예약', offline.catchupLeft === 12);
  for (let i = 0; i < 12; i++) live.update(MS_PER_TICK, 0);
  while (offline.catchupLeft > 0) offline.update(0, 3);
  check(
    '실시간과 3틱씩 오프라인 캐치업의 사건 결과 일치',
    JSON.stringify(live.disasters.snapshot()) === JSON.stringify(offline.disasters.snapshot()),
  );
  check(
    '오프라인 전소 결과도 실시간과 일치',
    world
      .developedParcels()
      .every(
        (p) => [...(p.bld ?? [])].join() === [...(other.peekParcel(p.cx, p.cy)?.bld ?? [])].join(),
      ),
  );
}
console.log(`재해 검증 통과 (${checks}개)`);
