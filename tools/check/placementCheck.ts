import { strict as assert } from 'node:assert';
import { CHUNK_SIZE, CHUNK_TILES, OVERRIDE_NONE } from '../../src/core/constants';
import { tileToWorldX, tileToWorldY } from '../../src/core/iso';
import { decodeOverride, encodeOverride } from '../../src/net/codec';
import { pedestrianHidden } from '../../src/render/pedestrianLayer';
import { ZONE_R, ZONE_C } from '../../src/sim/buildings';
import { CongestionMap } from '../../src/sim/congestion';
import { FAC_FIRE } from '../../src/sim/facilities';
import { findWalkPath, PedestrianPool, walkEdgeCost } from '../../src/sim/pedestrians';
import { roadDistancesFrom, RoadField, roadTileCapacity, tileKey } from '../../src/sim/roadGraph';
import { ServiceField } from '../../src/sim/services';
import { COST_ROAD, ROAD_DIST_UNREACHABLE } from '../../src/sim/simConstants';
import { JunctionIndex } from '../../src/sim/traffic/junctions';
import { Router, type Route } from '../../src/sim/traffic/router';
import { Tools } from '../../src/ui/tools';
import { Build, canConnectRoads, roadMask } from '../../src/world/build';
import { surfaceAt } from '../../src/world/slope';
import { Terrain } from '../../src/world/terrain';
import { World, type ChunkOverride } from '../../src/world/world';

let checks = 0;
function check(name: string, run: () => void) {
  run();
  checks++;
  console.log(`  OK ${name}`);
}
function fixture() {
  const world = new World();
  const x = world.baseCx * CHUNK_SIZE + 24,
    y = world.baseCy * CHUNK_SIZE + 24;
  for (let dy = -20; dy < 40; dy++)
    for (let dx = -20; dx < 45; dx++) {
      world.setHeight(x + dx, y + dy, 0);
      world.setTile(x + dx, y + dy, Terrain.Grass);
    }
  let money = 100000;
  const dirty: string[] = [];
  const tools = new Tools(
    world,
    { invalidateTile: (tx, ty) => dirty.push(`${tx},${ty}`) } as any,
    {
      spend: (n) => {
        if (money < n) return false;
        money -= n;
        return true;
      },
    } as any,
  );
  tools.setTool('road');
  const point = (dx: number, dy: number) =>
    [tileToWorldX(x + dx, y + dy), tileToWorldY(x + dx, y + dy)] as const;
  const click = (dx: number, dy: number) => {
    tools.beginPaint(...point(dx, dy));
    tools.endPaint();
  };
  const drag = (a: number, b: number, c: number, d: number) => {
    tools.beginPaint(...point(a, b));
    tools.movePaint(...point(c, d));
    tools.endPaint();
  };
  return {
    world,
    x,
    y,
    tools,
    point,
    click,
    drag,
    dirty,
    money: () => money,
    setMoney: (n: number) => (money = n),
  };
}
const f = fixture(),
  { world: w, x, y } = f;
check('인접 클릭 도로는 독립되며 양쪽 경계가 닫힌다', () => {
  f.click(0, 0);
  f.click(1, 0);
  assert.equal(roadMask(w, x, y), 0);
  assert.equal(roadMask(w, x + 1, y), 0);
  assert.equal(roadDistancesFrom(w, x, y, 20).size, 1);
});
check('드래그가 기존 두 도로를 무료로 연결한다', () => {
  const before = f.money();
  f.drag(0, 0, 1, 0);
  assert.equal(f.money(), before);
  assert.equal(roadMask(w, x, y), 1);
  assert.equal(roadMask(w, x + 1, y), 4);
});
check('빠른 드래그 보간·평행 도로 측면 분리·정확한 과금', () => {
  f.drag(1, 0, 10, 0);
  const before = f.money();
  f.drag(0, 1, 10, 1);
  assert.equal(before - f.money(), 11 * COST_ROAD);
  for (let dx = 0; dx <= 10; dx++) {
    assert.equal(w.roadsConnected(x + dx, y, x + dx, y + 1), false);
    if (dx < 10) assert(w.roadsConnected(x + dx, y + 1, x + dx + 1, y + 1));
  }
  assert.equal(roadTileCapacity(w, x + 5, y), 1);
  const j = new JunctionIndex();
  j.build(w, x - 5, y - 5, x + 15, y + 6);
  assert.equal(j.junctions.length, 0);
});
check('실제 연결을 추가해야 T자 교차로가 생긴다', () => {
  f.drag(5, 1, 5, 8);
  const j = new JunctionIndex();
  j.build(w, x - 5, y - 5, x + 15, y + 12);
  assert.equal(j.idAt(x + 5, y), -1);
  assert(j.idAt(x + 5, y + 1) >= 0);
  f.drag(5, 0, 5, 1);
  j.build(w, x - 5, y - 5, x + 15, y + 12);
  assert(j.idAt(x + 5, y) >= 0);
});
check('RLE 저장 왕복·연결 없는 0 보존·옛 저장 도로 보존', () => {
  const map = new Map<string, ChunkOverride>();
  for (const c of w.takeDirty().chunks)
    map.set(`${c.cx},${c.cy}`, {
      ...c,
      roadLinks: decodeOverride(encodeOverride(c.roadLinks), CHUNK_TILES),
    });
  const loaded = new World();
  loaded.setPersistedOverrides(map);
  for (let dx = 0; dx <= 10; dx++)
    assert.equal(roadMask(loaded, x + dx, y), roadMask(w, x + dx, y));
  assert(!loaded.roadsConnected(x, y, x, y + 1));
  const oldMap = new Map([...map].map(([k, v]) => [k, { ...v, roadLinks: undefined }]));
  const old = new World();
  old.setPersistedOverrides(oldMap);
  assert(old.roadsConnected(x, y, x, y + 1));
  old.setBuild(x - 1, y, Build.Road);
  assert(!old.roadsConnected(x - 1, y, x, y));
});
check('청크 경계 양쪽 저장·철거 후 재설치 자동 재연결 금지', () => {
  const ax = (w.baseCx + 1) * CHUNK_SIZE - 1;
  w.setBuild(ax, y, Build.Road);
  w.setBuild(ax + 1, y, Build.Road);
  w.takeDirty();
  w.connectRoads(ax, y, ax + 1, y);
  assert.equal(w.takeDirty().chunks.length, 2);
  w.setBuild(ax + 1, y, Build.None);
  w.setBuild(ax + 1, y, Build.Road);
  assert(!w.roadsConnected(ax, y, ax + 1, y));
});
check('경로 캐시는 도로 개수 변화 없는 연결 편집도 반영한다', () => {
  const r = new Router(w, new CongestionMap());
  let found: Route | null = null;
  const request = () => {
    r.request(x, y, x + 10, y, 1, (v) => (found = v));
    r.update(1);
  };
  request();
  assert(found);
  w.setBuild(x + 6, y, Build.None);
  w.setBuild(x + 6, y, Build.Road);
  request();
  assert.equal(found, null);
  w.connectRoads(x + 5, y, x + 6, y);
  w.connectRoads(x + 6, y, x + 7, y);
  request();
  assert(found);
});
check('도로 거리장·필수 서비스는 미연결 경계를 넘지 않는다', () => {
  const g = fixture(),
    { world, x, y } = g;
  g.drag(0, 0, 5, 0);
  g.drag(6, 0, 12, 0);
  world.setBuild(x, y + 1, Build.ZoneC);
  world.placeBuilding(x, y + 1, ZONE_C, 1, 0);
  world.placeFacility(x, y - 2, FAC_FIRE, 0);
  const road = new RoadField();
  road.rebuild(world);
  assert(road.nearRoad(x + 10, y + 1), '건물의 물리적 도로 접근은 논리 연결과 구분한다');
  assert.equal(road.distToJobs(x + 10, y), ROAD_DIST_UNREACHABLE);
  const service = new ServiceField();
  service.rebuild(world);
  assert.equal(service.ownerFor(x + 10, y + 1, 1, FAC_FIRE), -1);
  g.drag(5, 0, 6, 0);
  road.rebuild(world);
  service.rebuild(world);
  assert.notEqual(road.distToJobs(x + 10, y), ROAD_DIST_UNREACHABLE);
  assert(service.ownerFor(x + 10, y + 1, 1, FAC_FIRE) >= 0);
});
check('물·예산 부족·드래그 종료는 가짜 연결을 남기지 않는다', () => {
  const g = fixture();
  g.world.setTile(g.x + 2, g.y, Terrain.WaterShallow);
  g.drag(0, 0, 4, 0);
  assert.equal(g.world.getBuild(g.x + 2, g.y), Build.None);
  assert(!roadDistancesFrom(g.world, g.x, g.y, 10).has(tileKey(g.x + 4, g.y)));
  g.setMoney(0);
  g.drag(0, 0, 0, 3);
  assert.equal(g.world.getBuild(g.x, g.y + 1), Build.None);
  g.setMoney(1000);
  g.click(0, 1);
  assert(!g.world.roadsConnected(g.x, g.y, g.x, g.y + 1));
});
check('램프는 논리 연결만 반영하고 복합 비탈 연결을 거부한다', () => {
  const g = fixture(),
    { world, x, y } = g;
  world.setHeight(x + 1, y, 1);
  world.setHeight(x, y + 1, 1);
  world.setBuild(x, y, Build.Road);
  world.setBuild(x + 1, y, Build.Road);
  world.setBuild(x, y + 1, Build.Road);
  assert.deepEqual(surfaceAt(world, x, y), { zc: 0, dzx: 0, dzy: 0 });
  assert(canConnectRoads(world, x, y, x + 1, y).ok);
  world.connectRoads(x, y, x + 1, y);
  assert(surfaceAt(world, x, y).dzx > 0);
  assert(!canConnectRoads(world, x, y, x, y + 1).ok);
});
check('보행 경로: 도로 가장자리 우선·건물 내부 금지·별개 건물 사이 허용', () => {
  const g = fixture(),
    { world, x, y } = g;
  g.drag(0, 0, 10, 0);
  const path = findWalkPath(world, [x, y], [x + 10, y]);
  assert(path.length > 1);
  assert(path.every((p) => p[1] === y - 0.5));
  for (let dy = 0; dy < 2; dy++)
    for (let dx = 0; dx < 4; dx++) world.setBuild(x + dx, y + 2 + dy, Build.ZoneR);
  world.placeBuilding(x, y + 2, ZONE_R, 2, 0);
  world.placeBuilding(x + 2, y + 2, ZONE_R, 2, 0);
  assert.equal(walkEdgeCost(world, x + 1, y + 2, x + 1, y + 3), Infinity);
  assert(Number.isFinite(walkEdgeCost(world, x + 2, y + 2, x + 2, y + 3)));
  const around = findWalkPath(world, [x, y + 3], [x + 4, y + 3]);
  assert(around.length > 1);
  for (let i = 1; i < around.length; i++)
    assert(
      Number.isFinite(
        walkEdgeCost(
          world,
          around[i - 1][0] + 0.5,
          around[i - 1][1] + 0.5,
          around[i][0] + 0.5,
          around[i][1] + 0.5,
        ),
      ),
    );
  const pool = new PedestrianPool(world);
  for (let i = 0; i < 30; i++) pool.update(50, world.baseCx, world.baseCy, 1);
  assert(pool.walkers.length > 0 && pool.walkers.length <= 72);
  const before = pool.walkers.map((p) => [p.x, p.y]);
  pool.update(50, world.baseCx, world.baseCy, 1);
  assert.notDeepEqual(
    pool.walkers.map((p) => [p.x, p.y]),
    before,
  );
  world.clearBuilt();
  pool.update(50, world.baseCx, world.baseCy, 1);
  assert.equal(pool.walkers.length, 0);
});
check('보행자 가림: 뒤쪽은 불투명 그림에 가리고 앞쪽·투명 여백은 보인다', () => {
  const pixels = {
    width: 20,
    height: 20,
    data: new Uint8ClampedArray(20 * 20 * 4).fill(255),
  } as ImageData;
  const b = { maxTx: 5, maxTy: 5, x: 0, y: 0, size: 20, u: 0, v: 0, pixels };
  assert(pedestrianHidden({ x: 1, y: 1 }, 10, 12, b));
  assert(!pedestrianHidden({ x: 5, y: 1 }, 10, 12, b));
  pixels.data.fill(0);
  assert(!pedestrianHidden({ x: 1, y: 1 }, 10, 12, b));
});
console.log(`1단계 집중 검사 ${checks}개 통과`);
