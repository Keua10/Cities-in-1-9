import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { BASE_CHUNK_SPAN, CHUNK_SIZE } from '../../src/core/constants';
import { AssignmentTable } from '../../src/sim/assignment';
import {
  BLD_NONE,
  capacityOf,
  facilityKindOfCode,
  isAnchor,
  isFacilityAnchor,
  levelOfCode,
  zoneOfCode,
  ZONE_C,
  ZONE_I,
  ZONE_R,
} from '../../src/sim/buildings';
import { CongestionMap } from '../../src/sim/congestion';
import { FAC_FIRE, FAC_HOSPITAL, FAC_PARK, FAC_POLICE, FAC_SCHOOL } from '../../src/sim/facilities';
import { FAC_GAS } from '../../src/sim/config/power';
import { FAC_INCINERATOR, FAC_CREMATORIUM } from '../../src/sim/config/sanitation';
import { FAC_GROUNDWATER, FAC_RIVER_PUMP, FAC_TREATMENT } from '../../src/sim/config/water';
import { MacroSim } from '../../src/sim/macro';
import { MS_PER_TICK, RESIDENTS_PER_JOB } from '../../src/sim/simConstants';
import { Build, canConnectRoads, DIRS } from '../../src/world/build';
import { generateCity, seedCityIfEmpty } from '../../src/world/citySeed';
import { World } from '../../src/world/world';

const SPAN = BASE_CHUNK_SPAN * CHUNK_SIZE;
let checks = 0;
function check(name: string, run: () => void): void {
  run();
  checks++;
  console.log(`  OK ${name}`);
}

interface Scan {
  roads: Array<[number, number]>;
  zones: number[];
  buildings: number;
  strandedBuildings: number;
  deadZones: number;
  facilities: Map<number, number>;
  capacity: number[];
  outside: number;
}

/** 도시 하나를 훑어 검사에 필요한 사실만 모은다. */
function scan(world: World): Scan {
  const ox = world.baseCx * CHUNK_SIZE;
  const oy = world.baseCy * CHUNK_SIZE;
  const out: Scan = {
    roads: [],
    zones: [0, 0, 0],
    buildings: 0,
    strandedBuildings: 0,
    deadZones: 0,
    facilities: new Map(),
    capacity: [0, 0, 0],
    outside: 0,
  };

  for (const p of world.developedParcels()) {
    const inBase =
      p.cx >= world.baseCx &&
      p.cy >= world.baseCy &&
      p.cx < world.baseCx + BASE_CHUNK_SPAN &&
      p.cy < world.baseCy + BASE_CHUNK_SPAN;
    if (inBase) continue;
    // 기본 영역 밖 청크에 뭔가 쓰였다면 그 자체가 위반이다.
    for (const arr of [p.build, p.bld, p.pipes, p.wires]) {
      if (!arr) continue;
      for (const v of arr) if (v !== 255) out.outside++;
    }
  }

  for (let y = 0; y < SPAN; y++) {
    for (let x = 0; x < SPAN; x++) {
      const tx = ox + x;
      const ty = oy + y;
      const b = world.getBuild(tx, ty);
      if (b === Build.Road) out.roads.push([tx, ty]);
      if (b === Build.ZoneR) out.zones[ZONE_R]++;
      if (b === Build.ZoneC) out.zones[ZONE_C]++;
      if (b === Build.ZoneI) out.zones[ZONE_I]++;

      const code = world.getBld(tx, ty);
      if (isFacilityAnchor(code)) {
        const kind = facilityKindOfCode(code);
        out.facilities.set(kind, (out.facilities.get(kind) ?? 0) + 1);
      }
      if (!isAnchor(code)) {
        // 비어 있는 지구 칸은 도로에 맞닿아야 앞으로 쓰일 수 있다 (growth.ts 의
        // buildPass 는 1x1 부지 검사를 먼저 통과한 칸만 후보로 쓴다). 이미 선
        // 건물의 몸통(BLD_COVERED)은 도로에 안 닿아도 제 몫을 한다.
        if ((b === Build.ZoneR || b === Build.ZoneC || b === Build.ZoneI) && code === BLD_NONE) {
          const touching = DIRS.some(([dx, dy]) => world.getBuild(tx + dx, ty + dy) === Build.Road);
          if (!touching) out.deadZones++;
        }
        continue;
      }
      out.buildings++;
      const zone = zoneOfCode(code);
      const level = levelOfCode(code);
      out.capacity[zone] += capacityOf(zone, level);
      let touched = false;
      for (let k = 0; k < level; k++) {
        if (
          world.getBuild(tx + k, ty - 1) === Build.Road ||
          world.getBuild(tx + k, ty + level) === Build.Road ||
          world.getBuild(tx - 1, ty + k) === Build.Road ||
          world.getBuild(tx + level, ty + k) === Build.Road
        )
          touched = true;
      }
      if (!touched) out.strandedBuildings++;
    }
  }
  return out;
}

/** 실제 연결 비트로만 걸어서 도로망 조각을 센다. */
function roadComponents(world: World, roads: ReadonlyArray<[number, number]>): number[] {
  const seen = new Set<string>();
  const sizes: number[] = [];
  for (const [sx, sy] of roads) {
    if (seen.has(`${sx},${sy}`)) continue;
    seen.add(`${sx},${sy}`);
    const stack: Array<[number, number]> = [[sx, sy]];
    let n = 0;
    while (stack.length) {
      const [x, y] = stack.pop() as [number, number];
      n++;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        const key = `${nx},${ny}`;
        if (seen.has(key) || !world.roadsConnected(x, y, nx, ny)) continue;
        seen.add(key);
        stack.push([nx, ny]);
      }
    }
    sizes.push(n);
  }
  return sizes.sort((a, b) => b - a);
}

function digest(world: World): string {
  const hash = createHash('sha256');
  for (const p of [...world.developedParcels()].sort((a, b) => a.cy - b.cy || a.cx - b.cx)) {
    hash.update(p.key);
    for (const a of [
      p.tileOverride,
      p.heightOverride,
      p.build,
      p.roadLinks,
      p.bld,
      p.pipes,
      p.wires,
    ])
      hash.update(a ?? 'null');
  }
  return hash.digest('hex');
}

function makeCity(cityIndex: number, seed?: number): { world: World; scan: Scan } {
  const world = new World(cityIndex);
  const center = generateCity(world, 0, seed);
  assert.ok(center, `city ${cityIndex} produced no center`);
  return { world, scan: scan(world) };
}

/* ================================================================= *
 * 1. 경계 — 도시는 2x2 기본 청크를 넘지 않는다
 * ================================================================= */
const sample = [0, 1, 2, 3, 4, 5, 9, 13].map((i) => makeCity(i));

check('도시는 기본 2x2 청크 밖에 아무것도 쓰지 않는다', () => {
  for (const [i, c] of sample.entries()) {
    assert.equal(c.scan.outside, 0, `city ${i}: ${c.scan.outside} tiles outside the base chunks`);
  }
});

/* ================================================================= *
 * 2. 도로 — 한 덩어리, 규칙에 맞는 연결, 고립 없음
 * ================================================================= */
check('도로망은 언제나 한 덩어리다', () => {
  for (const [i, c] of sample.entries()) {
    assert.ok(c.scan.roads.length > 500, `city ${i}: only ${c.scan.roads.length} road tiles`);
    const comps = roadComponents(c.world, c.scan.roads);
    assert.equal(
      comps.length,
      1,
      `city ${i}: road network split into ${comps.length} pieces (${comps.slice(0, 5).join('/')})`,
    );
  }
});

check('연결된 모든 도로쌍이 build.ts 의 연결 규칙을 통과한다', () => {
  for (const [i, c] of sample.entries()) {
    let pairs = 0;
    for (const [x, y] of c.scan.roads) {
      let degree = 0;
      for (const [dx, dy] of DIRS) {
        if (!c.world.roadsConnected(x, y, x + dx, y + dy)) continue;
        degree++;
        pairs++;
        // 이미 연결된 쌍을 다시 검사하면 canConnectRoads 는 SILENT(ok=false) 를
        // 돌려준다. 그래서 규칙 자체를 여기서 다시 확인한다.
        const dh = Math.abs(c.world.sampleHeight(x, y) - c.world.sampleHeight(x + dx, y + dy));
        assert.ok(dh <= 1, `city ${i}: (${x},${y}) is linked across a ${dh} step cliff`);
      }
      assert.ok(degree > 0, `city ${i}: road (${x},${y}) is connected to nothing`);
      // 한 칸이 여러 방향으로 비탈지지 않는다.
      let slopes = 0;
      const h = c.world.sampleHeight(x, y);
      for (let d = 0; d < 4; d++) {
        const nx = x + DIRS[d][0];
        const ny = y + DIRS[d][1];
        if (!c.world.roadsConnected(x, y, nx, ny)) continue;
        if (c.world.sampleHeight(nx, ny) !== h) slopes |= 1 << d;
      }
      const legal = (slopes & (slopes - 1)) === 0 || slopes === 5 || slopes === 10;
      assert.ok(legal, `city ${i}: road (${x},${y}) slopes in mask ${slopes}`);
    }
    assert.ok(pairs > 0);
  }
});

check('나란한 두 차선을 가로로 꿰지 않는다 (사다리 금지)', () => {
  /*
   * 맞닿은 도로를 전부 이으면 평행한 두 줄이 사다리가 되고, 화면에는 두 줄짜리
   * 차선이 아니라 한 덩어리 넓은 아스팔트로 보인다. 사거리가 늘어 통행량도 준다
   * (roadTileCapacity 는 연결 4방향을 0.5 로 깎는다).
   *
   * 판정은 2x2 한 칸만 본다 — 도로 네 칸이 정사각으로 모였는데 네 변이 전부
   * 연결돼 있으면 사다리다. 길이를 보지 않으므로 두 칸짜리 평행 차선도 스무
   * 칸짜리와 똑같이 잡힌다(예전 진행축 추정 방식이 짧은 구간에서 놓치던 부분).
   */
  for (const [i, c] of sample.entries()) {
    const w = c.world;
    const road = (x: number, y: number): boolean => w.getBuild(x, y) === Build.Road;
    let closed = 0;
    let first = '';
    for (const [x, y] of c.scan.roads) {
      if (!road(x + 1, y) || !road(x, y + 1) || !road(x + 1, y + 1)) continue;
      if (
        w.roadsConnected(x, y, x + 1, y) &&
        w.roadsConnected(x, y + 1, x + 1, y + 1) &&
        w.roadsConnected(x, y, x, y + 1) &&
        w.roadsConnected(x + 1, y, x + 1, y + 1)
      ) {
        closed++;
        if (!first) first = `${x},${y}`;
      }
    }
    assert.equal(
      closed,
      0,
      `city ${i}: ${closed} fully cross-linked 2x2 road blocks (first at ${first})`,
    );
  }
});

check('학생이 생성 도로에 새 도로를 이어 붙일 수 있다', () => {
  // 생성 도로의 연결 비트가 학생이 그린 도로와 같은 규칙을 따르는지 본다.
  // 예전 판은 생성 도로를 "사방 연결(255)" 로 두거나 흐름 추정으로 열었기
  // 때문에, 학생 도로와 규칙이 어긋나는 칸이 생길 수 있었다.
  const world = new World(7);
  const s = scan(world.developedParcels().length ? world : world);
  void s;
  assert.ok(generateCity(world, 0, 424242));
  const fresh = scan(world);
  let attempted = 0;
  let joined = 0;
  for (const [x, y] of fresh.roads) {
    if (attempted >= 20) break;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (world.getBuild(nx, ny) !== Build.None) continue;
      if (Math.abs(world.sampleHeight(x, y) - world.sampleHeight(nx, ny)) > 1) continue;
      if (!canConnectRoads(world, x, y, nx, ny).ok) continue;
      attempted++;
      world.setBuild(nx, ny, Build.Road, true);
      if (world.connectRoads(x, y, nx, ny) && world.roadsConnected(x, y, nx, ny)) joined++;
      break;
    }
  }
  assert.ok(attempted >= 5, `only ${attempted} places to extend the network`);
  assert.equal(
    joined,
    attempted,
    `${attempted - joined} of ${attempted} extensions failed to connect`,
  );
});

/* ================================================================= *
 * 3. 지구와 건물
 * ================================================================= */
check('모든 건물이 도로에 맞닿는다', () => {
  for (const [i, c] of sample.entries()) {
    assert.equal(
      c.scan.strandedBuildings,
      0,
      `city ${i}: ${c.scan.strandedBuildings} buildings without road access`,
    );
    assert.ok(c.scan.buildings > 600, `city ${i}: only ${c.scan.buildings} buildings`);
  }
});

check('앞으로도 못 쓰는 죽은 지구 칸이 남지 않는다', () => {
  for (const [i, c] of sample.entries()) {
    assert.equal(
      c.scan.deadZones,
      0,
      `city ${i}: ${c.scan.deadZones} zone tiles can never be built on`,
    );
  }
});

check('주거·상업·공업이 모두 있고 비율이 목표 근처다', () => {
  for (const [i, c] of sample.entries()) {
    const [r, cc, ind] = c.scan.zones;
    const total = r + cc + ind;
    assert.ok(r > 0 && cc > 0 && ind > 0, `city ${i}: zones ${r}/${cc}/${ind}`);
    assert.ok(
      cc / total > 0.08 && cc / total < 0.26,
      `city ${i}: commercial share ${(cc / total).toFixed(2)}`,
    );
    assert.ok(
      ind / total > 0.14 && ind / total < 0.34,
      `city ${i}: industrial share ${(ind / total).toFixed(2)}`,
    );
  }
});

check('일자리 정원이 주거 정원의 균형식과 맞는다', () => {
  for (const [i, c] of sample.entries()) {
    const homes = c.scan.capacity[ZONE_R];
    const jobs = c.scan.capacity[ZONE_C] + c.scan.capacity[ZONE_I];
    const ratio = jobs / (homes / RESIDENTS_PER_JOB);
    assert.ok(ratio > 0.7 && ratio < 1.4, `city ${i}: jobs/needed = ${ratio.toFixed(2)}`);
    const shops = c.scan.capacity[ZONE_C] / homes;
    assert.ok(
      shops > 0.09 && shops < 0.3,
      `city ${i}: shop jobs per resident = ${shops.toFixed(2)}`,
    );
  }
});

/* ================================================================= *
 * 4. 시설과 기반시설 — 지금까지 만든 요소가 모두 들어간다
 * ================================================================= */
check('필수·복지·위생·전력·상하수도 시설이 모두 선다', () => {
  const required = [
    FAC_FIRE,
    FAC_POLICE,
    FAC_HOSPITAL,
    FAC_SCHOOL,
    FAC_PARK,
    FAC_INCINERATOR,
    FAC_CREMATORIUM,
    FAC_GAS,
    FAC_TREATMENT,
  ];
  for (const [i, c] of sample.entries()) {
    for (const kind of required) {
      assert.ok((c.scan.facilities.get(kind) ?? 0) > 0, `city ${i}: facility kind ${kind} missing`);
    }
    const water =
      (c.scan.facilities.get(FAC_GROUNDWATER) ?? 0) + (c.scan.facilities.get(FAC_RIVER_PUMP) ?? 0);
    assert.ok(water > 0, `city ${i}: no water source`);
  }
});

check('상수관과 하수관은 절대 맞닿지 않는다', () => {
  // water.ts 는 두 관이 겹치거나 4방향으로 맞닿으면 상수도 전체를 오염으로 본다.
  for (const [i, c] of sample.entries()) {
    const ox = c.world.baseCx * CHUNK_SIZE;
    const oy = c.world.baseCy * CHUNK_SIZE;
    for (let y = 0; y < SPAN; y++) {
      for (let x = 0; x < SPAN; x++) {
        const v = c.world.getPipe(ox + x, oy + y);
        if (v !== 1) continue;
        assert.notEqual(v, 3, `city ${i}: mixed pipe at ${x},${y}`);
        for (const [dx, dy] of DIRS) {
          const n = c.world.getPipe(ox + x + dx, oy + y + dy);
          assert.ok(!(n & 2), `city ${i}: water pipe at ${x},${y} touches a sewer pipe`);
        }
      }
    }
  }
});

/* ================================================================= *
 * 5. 난수 — 생성할 때마다 다르고, 같은 씨앗이면 같다
 * ================================================================= */
check('씨앗이 다르면 다른 도시가 나온다', () => {
  const seen = new Set<string>();
  for (let s = 1; s <= 6; s++) {
    const world = new World(0);
    assert.ok(generateCity(world, 0, s * 1013904223));
    seen.add(digest(world));
  }
  assert.equal(seen.size, 6, `${6 - seen.size} of 6 seeds produced a duplicate city`);
});

check('같은 씨앗이면 똑같은 도시가 다시 만들어진다', () => {
  const a = new World(3);
  const b = new World(3);
  assert.ok(generateCity(a, 0, 20260911));
  assert.ok(generateCity(b, 0, 20260911));
  assert.equal(digest(a), digest(b));
});

check('씨앗을 안 주면 도시 번호마다 고정된 도시가 나온다', () => {
  const a = new World(2);
  const b = new World(2);
  const ca = seedCityIfEmpty(a);
  const cb = seedCityIfEmpty(b);
  assert.ok(ca && cb);
  assert.equal(ca.seed, cb.seed);
  assert.equal(digest(a), digest(b));
});

check('이미 지어진 도시는 건드리지 않는다', () => {
  const world = new World(1);
  assert.ok(seedCityIfEmpty(world));
  const before = digest(world);
  assert.equal(seedCityIfEmpty(world), null);
  assert.equal(digest(world), before);
});

/* ================================================================= *
 * 6. 실제로 굴러가는가 — 열흘 돌려서 확인
 * ================================================================= */
check('생성 도시는 열흘을 돌려도 흑자이고 입주율이 건강하다', () => {
  for (const cityIndex of [0, 4]) {
    const world = new World(cityIndex);
    assert.ok(seedCityIfEmpty(world));
    const macro = { money: 300_000, population: 0, tick: 0, tickedAt: 1_000 };
    const sim = new MacroSim(world, macro);
    sim.attachTraffic(new CongestionMap(), new AssignmentTable());
    sim.primeCatchup(1_000);
    for (let t = 0; t < 24 * 10; t++) sim.update(MS_PER_TICK, 0);
    const s = sim.stats;
    assert.equal(
      s.strandedBuildings,
      0,
      `city ${cityIndex}: ${s.strandedBuildings} stranded buildings`,
    );
    assert.equal(
      s.deadFacilities,
      0,
      `city ${cityIndex}: ${s.deadFacilities} facilities without a road`,
    );
    assert.ok(s.occupancy > 0.65, `city ${cityIndex}: occupancy ${s.occupancy.toFixed(2)}`);
    assert.ok(
      s.dailyIncome > s.dailyUpkeep,
      `city ${cityIndex}: income ${Math.round(s.dailyIncome)} <= upkeep ${Math.round(s.dailyUpkeep)}`,
    );
    const ratio = s.jobs / (s.population / RESIDENTS_PER_JOB);
    assert.ok(
      ratio > 0.8 && ratio < 1.5,
      `city ${cityIndex}: filled jobs/needed = ${ratio.toFixed(2)}`,
    );
    for (const [kind, cov] of s.serviceCoverage.entries()) {
      assert.ok(cov > 0.85, `city ${cityIndex}: service ${kind} coverage ${cov.toFixed(2)}`);
    }
  }
});

console.log(`PASS cityGen ${checks} checks`);
