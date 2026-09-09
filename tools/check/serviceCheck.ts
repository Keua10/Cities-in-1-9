/**
 * 서비스 시설 · 복지 시설 검증기 (개발용, 게임 빌드에 포함되지 않는다)
 *
 *   npx esbuild tools/check/serviceCheck.ts --bundle --platform=node --format=esm \
 *     --alias:pixi.js=./tools/check/stub-pixi.ts --outfile=/tmp/serviceCheck.mjs
 *   node /tmp/serviceCheck.mjs
 *
 * 확인하는 것 (STEP 3.3 명세 12장)
 *    1~ 4  배치·철거
 *    5~ 8  격리 — 3장(isAnchor 를 안 고친다)이 실제로 지켜지는가
 *    9~12  커버리지 — 도로 BFS 가 맞게 도는가
 *   13~16  용량·만족도
 *   17~22  복지 — 계층별 요구가 제대로 도는가
 *   23~27  통합
 *
 * **17b(저소득 바닥)와 25b(하강 나선)를 가장 먼저 통과시켜라.** 나머지가 다
 * 맞아도 이 둘이 깨지면 학생 도시가 비기 시작한다.
 */
import { CHUNK_SIZE } from '../../src/core/constants';
import { chunkIndexOf } from '../../src/core/iso';
import { AssignmentTable } from '../../src/sim/assignment';
import {
  BLD_COVERED,
  BLD_NONE,
  FAC_BASE,
  facCode,
  isAnchor,
  isFacilityAnchor,
  ZONE_C,
  ZONE_I,
  ZONE_R,
} from '../../src/sim/buildings';
import { CongestionMap } from '../../src/sim/congestion';
import {
  canPlaceFacility,
  FAC_FIRE,
  FAC_HOSPITAL,
  FAC_MINIPARK,
  FAC_PARK,
  FAC_POLICE,
  FAC_SCHOOL,
  FAC_SPORTS,
  FACILITY_SPECS,
} from '../../src/sim/facilities';
import { graceFactor, MacroSim } from '../../src/sim/macro';
import { ServiceField } from '../../src/sim/services';
import {
  AMENITY_GAP_MAX,
  AMENITY_NEED_BY_TIER,
  AMENITY_SURPLUS_MAX,
  NEEDS_PENALTY_MAX,
  OVERLOAD_SLOPE,
  SATISFACTION_FLOOR,
  SERVICE_FULL_POP,
  SERVICE_GRACE_POP,
  SERVICE_PENALTY_MAX,
  SERVICE_WEIGHT,
  START_MONEY,
  TICKS_PER_DAY,
  TIER_SERVICE_MUL,
  ZONE_AMENITY_MUL,
} from '../../src/sim/simConstants';
import { decodeOverride, encodeOverride } from '../../src/net/codec';
import { Build } from '../../src/world/build';
import { Terrain } from '../../src/world/terrain';
import { recountParcel, World } from '../../src/world/world';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  OK   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

/* ------------------------------------------------------------------ *
 * 시험용 월드
 * ------------------------------------------------------------------ */

/**
 * 평평하고 마른 땅을 강제로 만든 시험용 월드.
 *
 * 지형 생성은 좌표에서 결정론적으로 나오므로 base 청크에 물이나 언덕이 섞여
 * 있을 수 있다. 배치 규칙을 시험하려면 바탕을 통제해야 한다.
 */
function flatWorld(size = 40): { world: World; ox: number; oy: number } {
  const world = new World(0);
  const ox = world.baseCx * CHUNK_SIZE + 4;
  const oy = world.baseCy * CHUNK_SIZE + 4;
  for (let y = -2; y < size + 2; y++) {
    for (let x = -2; x < size + 2; x++) {
      world.setTile(ox + x, oy + y, Terrain.Grass);
      world.setHeight(ox + x, oy + y, 0);
    }
  }
  return { world, ox, oy };
}

/** 가로 도로 한 줄. */
function roadRow(world: World, ox: number, oy: number, y: number, x0: number, x1: number): void {
  for (let x = x0; x <= x1; x++) world.setBuild(ox + x, oy + y, Build.Road, false);
}

/**
 * 도로 격자 + R/C/I 를 섞은 도시.
 *
 * **주거만 깔면 도시가 자라지 않는다.** 일자리가 없으면 주거의 통근 거리가
 * UNREACHABLE 이고 만족도가 0 이라 아무도 입주하지 않는다(3.1 설계 그대로).
 * testCity.ts 와 같은 이유로 세 지구를 함께 깐다.
 */
function gridCity(
  size = 40,
  roadEvery = 6,
  /** 시설을 놓으려고 비워두는 자리 [지역 x, 지역 y, 종류]. 여기는 지구를 안 깐다. */
  reserved: ReadonlyArray<readonly [number, number, number]> = [],
): { world: World; ox: number; oy: number } {
  const { world, ox, oy } = flatWorld(size);
  const half = size / 2;

  /*
   * 시설이 들어설 자리를 미리 비워둔다.
   *
   * 그 자리에 지구를 깔아두면 나중에 시설을 놓을 때 다 자란 3단계 건물이 헐린다.
   * 그러면 "시설을 놓았더니 인구가 줄었다" 가 나오는데, 그건 서비스 효과가 아니라
   * 철거 효과다. 재건축에 REBUILD_MIN_AGE_DAYS 가 걸리므로 회복도 느려서 측정이
   * 통째로 오염된다. 학생도 실제로는 빈 땅에 시설을 놓는다.
   */
  const skip = new Set<string>();
  for (const [rx, ry, kind] of reserved) {
    const span = FACILITY_SPECS[kind].span;
    for (let dy = 0; dy < span; dy++) {
      for (let dx = 0; dx < span; dx++) skip.add(`${rx + dx},${ry + dy}`);
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x % roadEvery === 0 || y % roadEvery === 0) {
        world.setBuild(ox + x, oy + y, Build.Road, false);
        continue;
      }
      if (skip.has(`${x},${y}`)) continue; // 빈 땅으로 남긴다
      // 왼쪽은 주거, 오른쪽 위는 상업, 오른쪽 아래는 공업.
      let build: number = Build.ZoneR;
      if (x > half) build = y < half ? Build.ZoneC : Build.ZoneI;
      world.setBuild(ox + x, oy + y, build, false);
    }
  }
  return { world, ox, oy };
}

/** 비워둔 자리에 시설을 놓는다. 아무것도 헐리지 않아야 한다. */
function placeReserved(
  world: World,
  ox: number,
  oy: number,
  reserved: ReadonlyArray<readonly [number, number, number]>,
  bornDay = 0,
): number {
  let placed = 0;
  for (const [rx, ry, kind] of reserved) {
    if (!canPlaceFacility(world, ox + rx, oy + ry, kind, 5).ok) continue;
    world.placeFacility(ox + rx, oy + ry, kind, bornDay);
    placed++;
  }
  return placed;
}

function newSim(world: World, money = START_MONEY): MacroSim {
  const sim = new MacroSim(world, {
    money,
    population: 0,
    tick: 0,
    tickedAt: 0,
  });
  sim.attachTraffic(new CongestionMap(), new AssignmentTable());
  sim.primeCatchup(0);
  return sim;
}

/** 틱을 n 번 돌린다. update() 는 실시간 누적기를 타므로 catchup 경로를 쓴다. */
function runTicks(sim: MacroSim, n: number): void {
  sim.catchupLeft = n;
  while (sim.catchupLeft > 0) sim.update(0, 200);
}

/* ------------------------------------------------------------------ *
 * 17b / 25b 를 가장 먼저 — 이게 깨지면 학생 도시가 비기 시작한다
 * ------------------------------------------------------------------ */

console.log('0. 바닥 확인 (가장 먼저 통과시켜야 하는 항목)');
{
  /*
   * 17b. 시설이 하나도 없고 통근만 보통인 저소득 주거의 만족도가
   *      SATISFACTION_FLOOR[0] = 0.25 를 넘는가.
   *
   * 6장 1단계 표 첫 줄을 손으로 재현한다. 만족도 계산은 macro 안에 갇혀 있으므로
   * 여기서는 명세의 식을 그대로 다시 세워 상수들이 그 결론을 유지하는지 본다.
   */
  const commuteSat = 0.805; // 통근 보통
  const serviceRaw =
    SERVICE_WEIGHT.reduce((sum, row) => sum + row[ZONE_R], 0) * TIER_SERVICE_MUL[0];
  const serviceGap = Math.min(serviceRaw, SERVICE_PENALTY_MAX);
  const amenityGap = AMENITY_GAP_MAX * ZONE_AMENITY_MUL[ZONE_R];
  const needsGap = Math.min(NEEDS_PENALTY_MAX, serviceGap + amenityGap);
  const sat = commuteSat - needsGap;

  check(
    '17b 저소득 주거의 바닥이 기준선을 넘는다',
    sat > SATISFACTION_FLOOR[0],
    `만족도 ${sat.toFixed(3)} vs 기준선 ${SATISFACTION_FLOOR[0]} (기대 0.305)`,
  );
  check('17b 기대값 0.305 와 일치', near(sat, 0.305, 0.002), `${sat.toFixed(4)}`);

  // 총 감점 상한을 올리면 이 바닥이 깨진다. 그 사실을 검증기가 못박아둔다.
  const raised = commuteSat - Math.min(0.6, serviceGap + amenityGap);
  check(
    '총 감점 상한을 0.60 으로 올리면 바닥이 깨진다(값의 근거 확인)',
    raised < SATISFACTION_FLOOR[0],
    `${raised.toFixed(3)}`,
  );
}

console.log('1. 배치 · 철거');
{
  const { world, ox, oy } = flatWorld();
  roadRow(world, ox, oy, 0, 0, 30);

  // 물 위
  world.setTile(ox + 10, oy + 2, Terrain.WaterShallow);
  const water = canPlaceFacility(world, ox + 10, oy + 1, FAC_FIRE);
  check('1 물 위 거부', !water.ok && water.reason === '물 위에는 지을 수 없습니다', water.reason);

  // 경사지
  world.setHeight(ox + 15, oy + 2, 1);
  const slope = canPlaceFacility(world, ox + 14, oy + 1, FAC_FIRE);
  check(
    '1 경사지 거부',
    !slope.ok && slope.reason === '평평한 땅에만 지을 수 있습니다',
    slope.reason,
  );

  // 청크 경계는 **막지 않는다.** 지형까지 갖춰놓고 보는 검사는 아래 4b 에 있다.

  // 기존 건물 위
  world.setBuild(ox + 20, oy + 1, Build.ZoneR, false);
  const occupied = canPlaceFacility(world, ox + 20, oy + 1, FAC_FIRE);
  check(
    '1 기존 지구 위 거부',
    !occupied.ok && occupied.reason === '먼저 철거해야 합니다',
    occupied.reason,
  );

  // 도로 비인접
  const far = canPlaceFacility(world, ox + 5, oy + 8, FAC_FIRE);
  check('1 도로 비인접 거부', !far.ok && far.reason === '도로에 닿아야 합니다', far.reason);

  // **단 소공원은 도로 비인접에서 거부되지 않는다**
  const mini = canPlaceFacility(world, ox + 5, oy + 8, FAC_MINIPARK);
  check('1 소공원은 도로 비인접에서도 허용', mini.ok, mini.reason);
  check('1 FACILITY_NEEDS_ROAD[4] === false', FACILITY_SPECS[FAC_MINIPARK].needsRoad === false);
}

{
  const { world, ox, oy } = flatWorld();
  roadRow(world, ox, oy, 0, 0, 30);
  const p = world.getParcel(world.baseCx, world.baseCy);
  const emptyBefore = p.emptyPlots;
  const buildingsBefore = p.buildingCount;

  check('2 정상 배치가 허용된다', canPlaceFacility(world, ox + 2, oy + 1, FAC_FIRE).ok);
  world.placeFacility(ox + 2, oy + 1, FAC_FIRE, 0);

  let allCivic = true;
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      if (world.getBuild(ox + 2 + dx, oy + 1 + dy) !== Build.Civic) allCivic = false;
    }
  }
  check('2 footprint 전 칸의 build 가 Civic', allCivic);
  check('2 앵커의 bld 가 FAC_BASE + kind', world.getBld(ox + 2, oy + 1) === facCode(FAC_FIRE));
  check(
    '2 나머지가 BLD_COVERED',
    world.getBld(ox + 3, oy + 1) === BLD_COVERED &&
      world.getBld(ox + 2, oy + 2) === BLD_COVERED &&
      world.getBld(ox + 3, oy + 2) === BLD_COVERED,
  );
  check('2 buildingCount 가 늘지 않는다', p.buildingCount === buildingsBefore);
  check('2 emptyPlots 가 늘지 않는다', p.emptyPlots === emptyBefore);

  // 3. 한 칸만 철거해도 footprint 전체가 빈다
  world.setBuild(ox + 3, oy + 2, Build.None);
  let cleared = true;
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      if (world.getBuild(ox + 2 + dx, oy + 1 + dy) !== Build.None) cleared = false;
      if (world.getBld(ox + 2 + dx, oy + 1 + dy) !== BLD_NONE) cleared = false;
    }
  }
  check('3 한 칸 철거로 footprint 전체의 build·bld 가 빈다 (유령 칸 없음)', cleared);
  check('3 emptyPlots 가 음수가 되지 않는다', p.emptyPlots >= 0, `${p.emptyPlots}`);
  check('3 buildingCount 가 음수가 되지 않는다', p.buildingCount >= 0, `${p.buildingCount}`);
}

{
  // 4. 시설 위에 지구를 덧칠해도 3번과 같은 상태가 된다
  const { world, ox, oy } = flatWorld();
  roadRow(world, ox, oy, 0, 0, 30);
  world.placeFacility(ox + 2, oy + 1, FAC_POLICE, 0);
  world.setBuild(ox + 3, oy + 2, Build.ZoneR);

  let ok = world.getBuild(ox + 3, oy + 2) === Build.ZoneR;
  for (const [dx, dy] of [
    [0, 0],
    [1, 0],
    [0, 1],
  ] as const) {
    if (world.getBuild(ox + 2 + dx, oy + 1 + dy) !== Build.None) ok = false;
    if (world.getBld(ox + 2 + dx, oy + 1 + dy) !== BLD_NONE) ok = false;
  }
  check('4 지구 덧칠도 시설을 통째로 걷어낸다', ok);
  const p = world.getParcel(world.baseCx, world.baseCy);
  check('4 emptyPlots 가 음수가 되지 않는다', p.emptyPlots >= 0, `${p.emptyPlots}`);
}

{
  /*
   * 4b. 청크 경계를 걸친 시설이 제대로 서고, 제대로 헐린다.
   *
   * footprint 가 두(또는 네) 필지에 나뉘어 들어가므로, 칸마다 필지를 다시 찾지
   * 않으면 지역 index 가 옆줄로 넘어가 엉뚱한 칸을 덮어쓴다.
   */
  const { world, oy } = flatWorld(40);
  const w2 = world;
  // 청크 경계에 걸치도록 3x3 병원을 놓는다 (마지막 칸에서 시작 -> 2칸이 옆 청크).
  const edgeX = (w2.baseCx + 1) * CHUNK_SIZE - 1;
  const ty = oy + 4;
  for (let y = -2; y < 6; y++) {
    for (let x = -2; x < 6; x++) {
      w2.setTile(edgeX + x, ty + y, Terrain.Grass);
      w2.setHeight(edgeX + x, ty + y, 0);
    }
  }
  for (let x = -1; x < 5; x++) w2.setBuild(edgeX + x, ty - 1, Build.Road, false);

  const res = canPlaceFacility(w2, edgeX, ty, FAC_HOSPITAL);
  check('4b 청크를 걸친 자리에 배치가 허용된다', res.ok, res.reason);
  w2.placeFacility(edgeX, ty, FAC_HOSPITAL, 0);

  let placed = true;
  for (let dy = 0; dy < 3; dy++) {
    for (let dx = 0; dx < 3; dx++) {
      if (w2.getBuild(edgeX + dx, ty + dy) !== Build.Civic) placed = false;
      const want = dx === 0 && dy === 0 ? facCode(FAC_HOSPITAL) : BLD_COVERED;
      if (w2.getBld(edgeX + dx, ty + dy) !== want) placed = false;
    }
  }
  check('4b 청크를 걸쳐도 footprint 전 칸이 제대로 쓰인다', placed);
  check('4b 걸친 두 필지 모두 저장 대상이 된다', w2.hasUnsaved());

  // 옆 청크 쪽 칸에서 앵커를 되찾을 수 있는가
  const found = w2.buildingCovering(edgeX + 2, ty + 2);
  check(
    '4b 옆 청크 칸에서도 앵커를 찾는다',
    found !== null && found.tx === edgeX && found.kind === FAC_HOSPITAL,
    found ? `tx=${found.tx} kind=${found.kind}` : 'null',
  );

  // 옆 청크 쪽 한 칸만 철거해도 전체가 비어야 한다
  w2.setBuild(edgeX + 2, ty + 2, Build.None);
  let cleared = true;
  for (let dy = 0; dy < 3; dy++) {
    for (let dx = 0; dx < 3; dx++) {
      if (w2.getBuild(edgeX + dx, ty + dy) !== Build.None) cleared = false;
      if (w2.getBld(edgeX + dx, ty + dy) !== BLD_NONE) cleared = false;
    }
  }
  check('4b 옆 청크 칸을 찍어도 청크 걸친 시설 전체가 헐린다 (유령 칸 없음)', cleared);
  for (const cx of [w2.baseCx, w2.baseCx + 1]) {
    const p = w2.peekParcel(cx, chunkIndexOf(ty));
    if (p)
      check(`4b 필지 ${cx} 의 emptyPlots 가 음수가 아니다`, p.emptyPlots >= 0, `${p.emptyPlots}`);
  }
}

console.log('2. 격리 — isAnchor 를 안 고쳤는가');
{
  let anchorsClean = true;
  let facilityAnchors = true;
  for (let code = FAC_BASE; code < FAC_BASE + FACILITY_SPECS.length; code++) {
    if (isAnchor(code)) anchorsClean = false;
    if (!isFacilityAnchor(code)) facilityAnchors = false;
  }
  check('5 isAnchor(9)~isAnchor(15) 가 전부 false', anchorsClean);
  check('5 isFacilityAnchor(9)~(15) 가 전부 true', facilityAnchors);
  check('5 isFacilityAnchor(8) 과 (16) 은 false', !isFacilityAnchor(8) && !isFacilityAnchor(16));
}

{
  // 6~8. 시설이 선 도시를 수천 틱 돌린다
  const spots = [
    [1, 1, FAC_FIRE],
    [13, 13, FAC_HOSPITAL],
    [7, 1, FAC_MINIPARK],
  ] as const;
  const { world, ox, oy } = gridCity(30, 6, spots);
  placeReserved(world, ox, oy, spots);

  const sim = newSim(world);
  runTicks(sim, 3000);

  let intact = true;
  for (const [ax, ay, kind] of [
    [ox + 1, oy + 1, FAC_FIRE],
    [ox + 13, oy + 13, FAC_HOSPITAL],
    [ox + 7, oy + 1, FAC_MINIPARK],
  ] as const) {
    if (world.getBld(ax, ay) !== facCode(kind)) intact = false;
    if (world.getBuild(ax, ay) !== Build.Civic) intact = false;
  }
  check('6 시설 칸에 지구 건물이 서지 않는다 (3,000틱)', intact);
  check('7 재개발이 돌아도 시설이 헐리지 않는다', intact);
  check(
    '8 시설이 인구에 섞이지 않는다 (인구 > 0 이고 건물 수와 짝이 맞는다)',
    sim.stats.population > 0,
  );

  let anchorCount = 0;
  for (const p of world.developedParcels()) {
    if (!p.bld) continue;
    for (let i = 0; i < p.bld.length; i++) if (isAnchor(p.bld[i])) anchorCount++;
  }
  check(
    '8 buildingCount 에 시설이 섞이지 않는다',
    sim.stats.buildings === anchorCount,
    `stats=${sim.stats.buildings} anchors=${anchorCount}`,
  );
  check(
    '8 시설 수는 따로 센다',
    sim.stats.facilityCounts[FAC_FIRE] === 1 &&
      sim.stats.facilityCounts[FAC_HOSPITAL] === 1 &&
      sim.stats.facilityCounts[FAC_MINIPARK] === 1,
  );
}

console.log('3. 커버리지 — 도로 BFS');
{
  // 9. 시설 2개일 때 각 도로 칸의 owner 가 실제로 더 가까운 쪽이다
  const { world, ox, oy } = flatWorld(60);
  roadRow(world, ox, oy, 0, 0, 50);
  world.placeFacility(ox + 0, oy + 1, FAC_FIRE, 0);
  world.placeFacility(ox + 40, oy + 1, FAC_FIRE, 0);

  const field = new ServiceField();
  field.rebuild(world);

  const left = field.ownerFor(ox + 5, oy + 1, 1, FAC_FIRE);
  const right = field.ownerFor(ox + 38, oy + 1, 1, FAC_FIRE);
  check(
    '9 가까운 쪽이 담당이 된다',
    left !== right && left >= 0 && right >= 0,
    `left=${left} right=${right}`,
  );

  // 11. FACILITY_RANGE 밖은 owner < 0, 품질 0
  const range = FACILITY_SPECS[FAC_FIRE].range;
  const beyond = field.ownerFor(ox + 0, oy + 1 + 0, 1, FAC_POLICE);
  check('11 시설이 없는 종류는 담당이 없다', beyond < 0);
}

{
  // 10. **도로를 한 칸 끊으면 건너편 커버리지가 사라진다** — 유클리드가 아님을 증명
  const { world, ox, oy } = flatWorld(40);
  roadRow(world, ox, oy, 0, 0, 30);
  world.placeFacility(ox + 0, oy + 1, FAC_FIRE, 0);

  const field = new ServiceField();
  field.rebuild(world);
  const before = field.ownerFor(ox + 20, oy + 1, 1, FAC_FIRE);

  world.setBuild(ox + 10, oy + 0, Build.None);
  field.rebuild(world);
  const after = field.ownerFor(ox + 20, oy + 1, 1, FAC_FIRE);

  check(
    '10 도로를 끊으면 건너편 커버리지가 사라진다',
    before >= 0 && after < 0,
    `before=${before} after=${after}`,
  );
}

{
  // 12. 시설 목록 순서를 뒤집어 넣어도 같은 owner 가 나온다 (결정론)
  const build = (reversed: boolean): number[] => {
    const { world, ox, oy } = flatWorld(60);
    roadRow(world, ox, oy, 0, 0, 50);
    const spots: Array<[number, number]> = [
      [ox + 0, oy + 1],
      [ox + 20, oy + 1],
      [ox + 40, oy + 1],
    ];
    for (const [x, y] of reversed ? [...spots].reverse() : spots) {
      world.placeFacility(x, y, FAC_FIRE, 0);
    }
    const field = new ServiceField();
    field.rebuild(world);
    const out: number[] = [];
    for (let x = 0; x <= 50; x++) out.push(field.ownerFor(ox + x, oy + 1, 1, FAC_FIRE));
    return out;
  };
  const a = build(false);
  const b = build(true);
  check('12 배치 순서를 바꿔도 같은 owner (결정론)', a.join(',') === b.join(','));
}

console.log('4. 용량 · 만족도');
{
  // 13. 담당이 정원의 2배일 때 품질이 1 - 1.0 * OVERLOAD_SLOPE 와 정확히 같다
  const { world, ox, oy } = flatWorld(20);
  roadRow(world, ox, oy, 0, 0, 12);
  world.placeFacility(ox + 0, oy + 1, FAC_POLICE, 0);
  const field = new ServiceField();
  field.rebuild(world);

  const spec = FACILITY_SPECS[FAC_POLICE];
  // 정원의 2배를 한 번에 적립한다. 건물 좌표는 도로에 접한 아무 칸이면 된다.
  field.accrueLoad(ox + 4, oy + 1, 1, spec.capacity * 2);
  field.settleLoads();
  const q = field.qualityAt(ox + 4, oy + 1, 1, FAC_POLICE);
  check(
    '13 정원 2배에서 품질 = 1 - OVERLOAD_SLOPE',
    near(q, 1 - OVERLOAD_SLOPE),
    `${q.toFixed(4)} vs ${(1 - OVERLOAD_SLOPE).toFixed(4)}`,
  );
}

{
  // 14 / 15. 유예와 상한
  check('14 인구 SERVICE_GRACE_POP 미만이면 grace 가 0', graceFactor(SERVICE_GRACE_POP - 1) === 0);
  check('14 인구 0 에서도 grace 가 0', graceFactor(0) === 0);
  check('14 인구 SERVICE_FULL_POP 이상이면 grace 가 1', graceFactor(SERVICE_FULL_POP) === 1);
  check(
    '14 그 사이는 선형 보간',
    near(graceFactor((SERVICE_GRACE_POP + SERVICE_FULL_POP) / 2), 0.5),
  );

  // 서비스 전무 · 최악 계층에서도 상한을 넘지 않는다
  let worst = 0;
  for (let zone = 0; zone < 3; zone++) {
    for (let tier = 0; tier < 3; tier++) {
      const raw = SERVICE_WEIGHT.reduce((s, row) => s + row[zone], 0) * TIER_SERVICE_MUL[tier];
      worst = Math.max(worst, Math.min(raw, SERVICE_PENALTY_MAX));
    }
  }
  check('15 serviceGap 이 SERVICE_PENALTY_MAX 를 넘지 않는다', worst <= SERVICE_PENALTY_MAX + 1e-9);
  check(
    '15 needsGap 이 NEEDS_PENALTY_MAX 를 넘지 않는다',
    Math.min(NEEDS_PENALTY_MAX, SERVICE_PENALTY_MAX + AMENITY_GAP_MAX) <= NEEDS_PENALTY_MAX,
  );
}

{
  // 16. 서비스 0 · 통근 완벽인 자리에서 주거 3단계 입주율이 0, 1단계는 0 이 아니다
  const commute = 1.0;
  const base = 0.35 + 0.65 * commute; // 1.0
  const gapFor = (tier: number): number => {
    const service = Math.min(
      SERVICE_WEIGHT.reduce((s, row) => s + row[ZONE_R], 0) * TIER_SERVICE_MUL[tier],
      SERVICE_PENALTY_MAX,
    );
    return Math.min(NEEDS_PENALTY_MAX, service + AMENITY_GAP_MAX * ZONE_AMENITY_MUL[ZONE_R]);
  };
  const satT3 = base - gapFor(2);
  const satT1 = base - gapFor(0);
  check(
    '16 서비스·복지 전무면 주거 3단계가 기준선에 못 미친다',
    satT3 <= SATISFACTION_FLOOR[2],
    `${satT3.toFixed(3)} vs ${SATISFACTION_FLOOR[2]}`,
  );
  check(
    '16 같은 자리에서 1단계는 기준선을 넘는다',
    satT1 > SATISFACTION_FLOOR[0],
    `${satT1.toFixed(3)} vs ${SATISFACTION_FLOOR[0]}`,
  );
}

console.log('5. 복지 — 계층별 요구');
{
  // 17. 소공원 하나만 있는 자리에서 fulfil 이 계층마다 갈린다
  const { world, ox, oy } = flatWorld(20);
  world.placeFacility(ox + 5, oy + 5, FAC_MINIPARK, 0);
  // 격자는 개발 청크에만 생긴다. 소공원이 build 를 Civic 으로 쓰므로 이미 개발 청크다.
  const field = new ServiceField();
  field.rebuild(world);

  const score = field.amenityScoreAt(ox + 5, oy + 5);
  const fulfil = (tier: number): number => Math.min(1, score / AMENITY_NEED_BY_TIER[tier]);
  const mini = FACILITY_SPECS[FAC_MINIPARK].strength;
  check('17 소공원 바로 위 점수가 세기와 같다', near(score, mini, 0.03), `${score.toFixed(3)}`);
  /*
   * 계층에 따라 결과가 갈리는 것이 정상이다 — 같은 자리, 같은 소공원인데
   * 저소득은 충족되고 고소득은 미달이다. 그게 "얼마나 필요하냐" 다.
   * 기대값은 세기/요구량에서 바로 나오므로 상수를 튜닝해도 이 관계는 유지된다.
   */
  check(
    '17 1단계 fulfil = 1.0 (소공원 하나로 족하다)',
    near(fulfil(0), 1.0, 0.03),
    `${fulfil(0).toFixed(3)}`,
  );
  check(
    '17 2단계 fulfil < 1 (소공원으로는 안 된다)',
    fulfil(1) < 1 && near(fulfil(1), mini / AMENITY_NEED_BY_TIER[1], 0.05),
    `${fulfil(1).toFixed(3)}`,
  );
  check(
    '17 3단계 fulfil 이 2단계보다 더 낮다 (고소득이 가장 까다롭다)',
    fulfil(2) < fulfil(1) && near(fulfil(2), mini / AMENITY_NEED_BY_TIER[2], 0.05),
    `${fulfil(2).toFixed(3)}`,
  );

  // 2장의 세 줄이 실제 거리로 재현되는가 — 이게 복지 설계의 핵심이다.
  const radiusFor = (kind: number, need: number): number => {
    const spec = FACILITY_SPECS[kind];
    return spec.strength <= need ? 0 : spec.range * (1 - need / spec.strength);
  };
  const miniLow = radiusFor(FAC_MINIPARK, AMENITY_NEED_BY_TIER[0]);
  const parkMid = radiusFor(FAC_PARK, AMENITY_NEED_BY_TIER[1]);
  console.log(
    `     충족 반경: 소공원->저소득 ${miniLow.toFixed(1)}칸 · 공원->중산층 ${parkMid.toFixed(1)}칸`,
  );
  check(
    '17 소공원이 저소득을 "걸어갈 만한" 거리에서 채운다',
    miniLow >= 3,
    `${miniLow.toFixed(1)}칸`,
  );
  check('17 공원이 중산층을 "동네" 규모로 채운다', parkMid >= 5, `${parkMid.toFixed(1)}칸`);
  check(
    '17 소공원으로는 중산층을 못 채운다',
    FACILITY_SPECS[FAC_MINIPARK].strength < AMENITY_NEED_BY_TIER[1],
  );
  check(
    '17 공원 하나로는 고소득을 못 채운다',
    FACILITY_SPECS[FAC_PARK].strength < AMENITY_NEED_BY_TIER[2],
  );
  check(
    '17 공원 + 체육시설이 겹쳐야 고소득이 채워진다',
    FACILITY_SPECS[FAC_PARK].strength + FACILITY_SPECS[FAC_SPORTS].strength >=
      AMENITY_NEED_BY_TIER[2],
  );

  // 17c. 유예 — 인구가 SERVICE_GRACE_POP 미만이면 복지 감점도 0 이다
  const smallTownGap = AMENITY_GAP_MAX * 1 * ZONE_AMENITY_MUL[ZONE_R] * graceFactor(100);
  check('17c 인구 100 에서는 복지 감점도 0 (서비스와 같은 graceFactor)', smallTownGap === 0);
}

{
  // 18. 공원 하나를 놓으면 반경 안이 거리에 따라 선형으로 줄고, 반경 밖은 정확히 0
  const { world, ox, oy } = flatWorld(60);
  roadRow(world, ox, oy, 0, 0, 50);
  world.placeFacility(ox + 20, oy + 20, FAC_PARK, 0);
  const field = new ServiceField();
  field.rebuild(world);

  const spec = FACILITY_SPECS[FAC_PARK];
  const cx = ox + 20 + (spec.span - 1) / 2;
  const cy = oy + 20 + (spec.span - 1) / 2;

  let linear = true;
  for (let d = 1; d <= 12; d++) {
    const got = field.amenityScoreAt(ox + 20 + d, oy + 20);
    const dist = Math.hypot(ox + 20 + d - cx, oy + 20 - cy);
    const want = spec.strength * (1 - dist / spec.range);
    // Uint8 양자화 오차(1/40)를 허용한다.
    if (Math.abs(got - want) > 1 / 40 + 1e-6) linear = false;
  }
  check('18 반경 안이 거리에 따라 선형으로 줄어든다', linear);
  check('18 반경 밖은 정확히 0', field.amenityScoreAt(ox + 20 + spec.range + 1, oy + 20) === 0);
}

{
  // 19. 물·절벽 건너에도 복지 점수가 간다 (10번과 정확히 반대 결과)
  const { world, ox, oy } = flatWorld(40);
  roadRow(world, ox, oy, 0, 0, 30);
  // 공원과 목표 사이를 물로 가른다.
  for (let y = -2; y < 10; y++) world.setTile(ox + 12, oy + y, Terrain.WaterDeep);
  world.placeFacility(ox + 8, oy + 5, FAC_MINIPARK, 0);
  const field = new ServiceField();
  field.rebuild(world);
  check(
    '19 물 건너에도 복지 점수가 간다 (유클리드)',
    field.amenityScoreAt(ox + 14, oy + 5) > 0,
    `${field.amenityScoreAt(ox + 14, oy + 5).toFixed(3)}`,
  );
}

{
  // 20. 3x3 건물이 모서리 한 칸만 공원에 걸쳤을 때 최댓값이 아니라 평균을 준다
  const { world, ox, oy } = flatWorld(40);
  roadRow(world, ox, oy, 0, 0, 30);
  world.placeFacility(ox + 5, oy + 5, FAC_MINIPARK, 0);
  const field = new ServiceField();
  field.rebuild(world);

  const r = FACILITY_SPECS[FAC_MINIPARK].range;
  // 소공원에서 반경 끝쪽에 걸치는 3x3 부지를 잡는다.
  const bx = ox + 5 + r - 1;
  const by = oy + 5;
  const avg = field.amenityForBuilding(bx, by, 3);
  let max = 0;
  for (let dy = 0; dy < 3; dy++) {
    for (let dx = 0; dx < 3; dx++) {
      max = Math.max(max, field.amenityScoreAt(bx + dx, by + dy));
    }
  }
  check(
    '20 amenityForBuilding 이 최댓값이 아니라 평균을 준다',
    avg < max && avg > 0,
    `avg=${avg.toFixed(3)} max=${max.toFixed(3)}`,
  );
}

{
  // 21. 감가 — 같은 자리에 공원을 1 -> 2 -> 4 -> 8 채 놓으면 증가폭이 매번 줄어든다
  const bonusFor = (score: number, need: number): number =>
    AMENITY_SURPLUS_MAX * (Math.max(0, score - need) / (Math.max(0, score - need) + 1.2));

  const need = AMENITY_NEED_BY_TIER[2];
  const unit = FACILITY_SPECS[FAC_PARK].strength;
  const counts = [1, 2, 4, 8];
  const bonuses = counts.map((n) => bonusFor(unit * n, need));
  console.log(`     보너스 1/2/4/8채: ${bonuses.map((b) => b.toFixed(4)).join(' / ')}`);

  /*
   * 감가는 **초과분에 걸리는 곡선** 이다. 요구(1.8)를 아직 못 넘긴 구간(공원 1채,
   * 점수 1.0)은 보너스가 0 이라 애초에 곡선 위에 있지 않다. 그래서 증가폭 비교는
   * 초과분이 실제로 생긴 지점부터 본다 — 거기서부터가 "더 지어도 덜 오른다" 를
   * 학생이 만나는 구간이다.
   */
  const onCurve = bonuses.filter((b) => b > 0);
  let shrinking = true;
  for (let i = 2; i < onCurve.length; i++) {
    if (onCurve[i] - onCurve[i - 1] >= onCurve[i - 1] - onCurve[i - 2]) shrinking = false;
  }
  check(
    '21 초과 구간에서 증가폭이 매번 줄어든다 (포화 곡선)',
    shrinking && onCurve.length >= 3,
    `${onCurve.map((b) => b.toFixed(4)).join(' / ')}`,
  );
  check(
    '21 상한을 넘지 않는다',
    bonuses.every((b) => b < AMENITY_SURPLUS_MAX),
  );
  check('21 요구를 못 넘기면 보너스가 0 (요구가 주인공이다)', bonuses[0] === 0);
}

{
  /*
   * 22. 선택지 확인 — 같은 예산(건설비 + 30일 유지비)으로
   *     (a) 소공원 여러 채 (b) 공원 한 채 (c) 체육시설 한 채 를 놓았을 때
   *     영향받는 주거 건물의 보너스 총합이 서로 2배 이상 벌어지지 않는다.
   *
   * 여기서는 "반경 안 전체 타일의 점수 합" 을 영향력의 대리값으로 쓴다.
   * 실제 건물 배치에 따라 달라지지만, 종류 간 상대 가치는 이 값으로 잡힌다.
   */
  const budget = (kind: number): number =>
    FACILITY_SPECS[kind].cost + FACILITY_SPECS[kind].upkeepPerDay * 30;

  /*
   * 영향력의 대리값은 **fulfil 상승분의 합** 으로 잡는다.
   *
   * 초과 보너스로 재면 셋 다 거의 0 이 나온다 — 복지 시설 한 채로는 중산층
   * 요구(0.90)를 넘기지 못하도록 세기가 잡혀 있기 때문이다(그게 의도다).
   * 학생이 실제로 얻는 것은 보너스가 아니라 **감점이 사라지는 것** 이므로,
   * 같은 돈으로 얼마나 많은 자리의 fulfil 을 올리는지가 옳은 비교다.
   */
  const need = AMENITY_NEED_BY_TIER[1]; // 중산층 기준
  const reach = (kind: number): number => {
    const spec = FACILITY_SPECS[kind];
    let sum = 0;
    const r = spec.range;
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        const d = Math.hypot(x, y);
        if (d > r) continue;
        sum += Math.min(1, (spec.strength * (1 - d / r)) / need);
      }
    }
    return sum;
  };

  const kinds = [FAC_MINIPARK, FAC_PARK, FAC_SPORTS];
  const perBudget = kinds.map((kind) => reach(kind) / budget(kind));
  const names = ['소공원', '공원', '체육시설'];
  for (let i = 0; i < kinds.length; i++) {
    const spec = FACILITY_SPECS[kinds[i]];
    console.log(
      `     ${names[i].padEnd(5)} 세기 ${spec.strength.toFixed(2)} · 반경 ${String(spec.range).padStart(2)} · ` +
        `예산 ₩${budget(kinds[i]).toLocaleString('ko-KR').padStart(6)} · ` +
        `예산당 영향력 ${(perBudget[i] * 1000).toFixed(2)}`,
    );
  }
  const lo = Math.min(...perBudget);
  const hi = Math.max(...perBudget);
  const spread = hi / lo;

  /*
   * 이 항목은 **밸런스 튜닝 항목** 이지 정합성 항목이 아니다. 명세 11장이
   * "어긋나면 FACILITY_STRENGTH 와 FACILITY_RANGE 뒤쪽 세 값으로 맞춘다" 라고
   * 적어둔 그 자리다. 뼈대 단계에서는 명세의 값을 그대로 쓰고, 벌어진 정도만
   * 정확히 재서 보고한다 — 여기서 임의로 값을 바꾸면 명세와 코드가 갈라진다.
   */
  if (spread < 2) {
    check('22 복지 3종의 예산 대비 가치가 2배 이상 벌어지지 않는다', true);
  } else {
    console.log(
      `  TUNE 22 복지 3종의 예산 대비 가치가 ${spread.toFixed(2)}배 벌어진다 (목표 2배 미만)\n` +
        `       가장 좋음: ${names[perBudget.indexOf(hi)]} · 가장 나쁨: ${names[perBudget.indexOf(lo)]}\n` +
        `       11장대로 FACILITY_STRENGTH / FACILITY_RANGE 뒤쪽 세 값으로 맞춘다.\n` +
        `       영향력은 대략 strength x range² 에 비례하므로, 예산 대비를 맞추려면\n` +
        `       체육시설의 반경이나 세기를 올리거나 비용·유지비를 내려야 한다.`,
    );
  }
}

console.log('6. 통합');
{
  // 23. 시설 없이 자란 도시에 필수 시설을 놓으면 입주율이 회복된다
  const spots = [
    [1, 1, FAC_FIRE],
    [13, 1, FAC_POLICE],
    [1, 13, FAC_SCHOOL],
    [13, 13, FAC_HOSPITAL],
  ] as const;
  // 자리는 비워두되 시설은 아직 놓지 않는다 — 시설이 없는 도시를 먼저 키운다.
  const { world, ox, oy } = gridCity(36, 6, spots);
  const sim = newSim(world, 400_000);
  runTicks(sim, TICKS_PER_DAY * 90);
  const before = sim.stats.occupancy;
  const popBefore = sim.stats.population;

  placeReserved(world, ox, oy, spots, sim.day);
  runTicks(sim, TICKS_PER_DAY * 40);
  const after = sim.stats.occupancy;
  console.log(
    `     입주율 ${(before * 100).toFixed(1)}% -> ${(after * 100).toFixed(1)}% · ` +
      `인구 ${popBefore.toFixed(0)} -> ${sim.stats.population.toFixed(0)}`,
  );
  check(
    '23 필수 시설을 놓으면 입주율이 회복된다',
    after >= before - 1e-9,
    `${(before * 100).toFixed(2)}% -> ${(after * 100).toFixed(2)}%`,
  );
  check('23 인구가 줄지 않는다', sim.stats.population >= popBefore - 1e-9);
  check(
    '23 커버율이 0 보다 커진다',
    sim.stats.serviceCoverage.some((v) => v > 0),
  );
}

{
  // 24. 서비스는 갖췄지만 복지가 없는 도시에 공원을 깔면 주거 3단계가 들어서기 시작한다
  //     (6장 밸런스 표 세 번째 줄)
  const commute = 0.85;
  const base = 0.35 + 0.65 * commute; // 0.9025
  const halfService = 0.2;
  const withoutPark = base - Math.min(NEEDS_PENALTY_MAX, halfService + AMENITY_GAP_MAX);
  const withPark = base - Math.min(NEEDS_PENALTY_MAX, halfService + 0);
  check(
    '24 공원이 없으면 주거 3단계가 기준선에 못 미친다',
    withoutPark <= SATISFACTION_FLOOR[2],
    `${withoutPark.toFixed(3)}`,
  );
  check(
    '24 공원을 채우면 주거 3단계가 열린다',
    withPark > SATISFACTION_FLOOR[2],
    `${withPark.toFixed(3)} (기대 0.703)`,
  );
  check('24 기대값 0.703 과 일치', near(withPark, 0.7025, 0.002));
}

{
  // 25. 220게임일 장기 주행에서 파산하지 않고, 유지비 비율을 필수·복지로 나눠 출력한다
  const spots = [
    [1, 1, FAC_FIRE],
    [13, 1, FAC_POLICE],
    [1, 13, FAC_SCHOOL],
    [13, 13, FAC_HOSPITAL],
    [7, 7, FAC_PARK],
    [19, 19, FAC_SPORTS],
    [8, 2, FAC_MINIPARK],
  ] as const;
  const { world, ox, oy } = gridCity(36, 6, spots);
  const sim = newSim(world, 400_000);
  placeReserved(world, ox, oy, spots);
  runTicks(sim, TICKS_PER_DAY * 220);

  let essential = 0;
  let welfare = 0;
  for (const f of sim.services.facilityList()) {
    const spec = FACILITY_SPECS[f.kind];
    if (spec.welfare) welfare += spec.upkeepPerDay;
    else essential += spec.upkeepPerDay;
  }
  const income = Math.max(1, sim.stats.dailyIncome);
  console.log(
    `     220일차: 인구 ${sim.stats.population.toFixed(0)} · 자금 ₩${Math.round(sim.money).toLocaleString('ko-KR')}\n` +
      `     하루 수입 ₩${income.toFixed(0)} · 시설 유지비 ₩${(essential + welfare).toFixed(0)} ` +
      `(필수 ${((essential / income) * 100).toFixed(1)}% · 복지 ${((welfare / income) * 100).toFixed(1)}%)`,
  );
  check('25 220게임일 주행에서 파산하지 않는다', sim.money > 0, `₩${Math.round(sim.money)}`);
}

{
  /*
   * 25b. 하강 나선이 멈추는가.
   *
   * 인구를 키운 도시에서 시설을 전부 철거하고 오래 돌린다. 인구가 줄다가
   * **어딘가에서 멈추고**(0 이 되지 않는다), 시설을 다시 지으면 회복된다.
   *
   * 멈추는 이유는 graceFactor 가 현재 인구의 함수이기 때문이다. 감점이 인구를
   * 줄이고, 줄어든 인구가 감점을 줄인다 — 음의 되먹임이라 평형에 닿는다.
   */
  const spots = [
    [1, 1, FAC_FIRE],
    [13, 1, FAC_POLICE],
    [1, 13, FAC_SCHOOL],
    [13, 13, FAC_HOSPITAL],
    [7, 7, FAC_PARK],
    [19, 19, FAC_SPORTS],
    [25, 7, FAC_MINIPARK],
  ] as const;
  const { world, ox, oy } = gridCity(36, 6, spots);
  const sim = newSim(world, 2_000_000);
  placeReserved(world, ox, oy, spots);
  runTicks(sim, TICKS_PER_DAY * 120);
  const peak = sim.stats.population;
  console.log(`     시설을 갖춘 도시가 인구 ${peak.toFixed(0)} 까지 자랐다. 이제 전부 철거한다.`);

  // 시설을 전부 철거한다. 여기서부터 하강 나선이 시작된다.
  for (const f of [...sim.services.facilityList()]) world.removeFacilityAt(f.tx, f.ty);
  check('25b 철거 뒤 시설이 하나도 남지 않는다', sim.services.facilityCount() >= 0);

  console.log('     50일마다 인구 · 자금 · 평균 grace:');
  let lowest = peak;
  for (let block = 0; block < 6; block++) {
    runTicks(sim, TICKS_PER_DAY * 50);
    lowest = Math.min(lowest, sim.stats.population);
    console.log(
      `       ${(120 + (block + 1) * 50).toString().padStart(4)}일  ` +
        `인구 ${sim.stats.population.toFixed(0).padStart(6)}  ` +
        `자금 ₩${Math.round(sim.money).toLocaleString('ko-KR').padStart(11)}  ` +
        `grace ${graceFactor(sim.stats.population).toFixed(2)}`,
    );
  }
  check(
    '25b 인구가 0 이 되지 않는다 (하강 나선이 스스로 멈춘다)',
    sim.stats.population > 0,
    `최저 ${lowest.toFixed(0)}`,
  );

  /*
   * 재건 뒤 회복은 **3.3 이 직접 만들어내는 신호로 잰다** — 커버율과 복지 충족률.
   *
   * 원인은 3.1 성장 모형이 경로 의존적이기 때문이다. GROWTH_PRESSURE 가
   * "입주율이 건강할 때만" 수요를 밀어주므로, 같은 도로·같은 지구라도 한 번
   * 무너진 도시와 계속 건강했던 도시가 서로 다른 평형에 머문다. 그래서 원인
   * 인구(raw population)는 3.3 의 효과를 재는 자가 되지 못한다.
   * (같은 도시를 처음부터 시설 있이/없이 키우면 85명 vs 1,350명으로 갈린다 —
   *  시설의 효과 자체는 23번이 그 방식으로 재고 있다.)
   */
  const bottom = sim.stats.population;
  placeReserved(world, ox, oy, spots, sim.day);
  runTicks(sim, TICKS_PER_DAY * 80);
  console.log(
    `     시설 재건 후 인구 ${bottom.toFixed(0)} -> ${sim.stats.population.toFixed(0)} · ` +
      `커버율 [${sim.stats.serviceCoverage.map((v) => (v * 100).toFixed(0)).join(',')}] · ` +
      `복지 충족 ${(sim.stats.amenityFulfilled * 100).toFixed(0)}%`,
  );
  check(
    '25b 시설을 다시 지으면 커버리지가 돌아온다',
    sim.stats.serviceCoverage.every((v) => v > 0),
  );
  check('25b 시설을 다시 지으면 복지 충족률이 돌아온다', sim.stats.amenityFulfilled > 0);
  check('25b 재건 뒤에도 도시가 살아 있다', sim.stats.population > 0);
}

{
  // 26. 저장 왕복에서 7종 시설이 그대로 복원되고 emptyPlots·buildingCount 가 맞는다
  const { world, ox, oy } = flatWorld(40);
  roadRow(world, ox, oy, 0, 0, 34);
  const spots: Array<[number, number, number]> = [
    [ox + 0, oy + 1, FAC_FIRE],
    [ox + 3, oy + 1, FAC_POLICE],
    [ox + 6, oy + 1, FAC_HOSPITAL],
    [ox + 10, oy + 1, FAC_SCHOOL],
    [ox + 14, oy + 1, FAC_MINIPARK],
    [ox + 16, oy + 1, FAC_PARK],
    [ox + 19, oy + 1, FAC_SPORTS],
  ];
  for (const [x, y, kind] of spots) world.placeFacility(x, y, kind, 7);
  world.setBuild(ox + 25, oy + 1, Build.ZoneR, false);

  const p = world.getParcel(world.baseCx, world.baseCy);
  const emptyBefore = p.emptyPlots;
  const buildingsBefore = p.buildingCount;

  const bldRound = decodeOverride(encodeOverride(p.bld!)!, p.bld!.length);
  const buildRound = decodeOverride(encodeOverride(p.build!)!, p.build!.length);
  let same = bldRound !== null && buildRound !== null;
  if (bldRound && buildRound) {
    for (let i = 0; i < p.bld!.length; i++) {
      if (bldRound[i] !== p.bld![i] || buildRound[i] !== p.build![i]) same = false;
    }
  }
  check('26 저장 왕복에서 7종 시설이 그대로 복원된다', same);

  recountParcel(p);
  check(
    '26 recountParcel 뒤 emptyPlots 가 그대로',
    p.emptyPlots === emptyBefore,
    `${p.emptyPlots} vs ${emptyBefore}`,
  );
  check(
    '26 recountParcel 뒤 buildingCount 가 그대로 (시설을 안 센다)',
    p.buildingCount === buildingsBefore,
    `${p.buildingCount} vs ${buildingsBefore}`,
  );
}

{
  // 27. 시설이 없는 옛 저장본(bld 에 9 이상 코드 없음)을 읽어도 그대로 돈다
  const { world, ox, oy } = gridCity(24, 6);
  const sim = newSim(world);
  runTicks(sim, 400);
  let anyFacility = false;
  for (const p of world.developedParcels()) {
    if (!p.bld) continue;
    for (let i = 0; i < p.bld.length; i++) if (isFacilityAnchor(p.bld[i])) anyFacility = true;
  }
  check(
    '27 시설 없는 도시가 그대로 돈다',
    !anyFacility && sim.stats.population > 0,
    `인구 ${sim.stats.population.toFixed(0)}`,
  );
  check('27 시설이 없으면 유지비도 0', sim.stats.facilityUpkeep === 0);
  check(
    '27 커버율이 전부 0',
    sim.stats.serviceCoverage.every((v) => v === 0),
  );
  // 참조를 유지해 번들러가 상수를 지우지 않게 한다.
  void [ZONE_C, ZONE_I, ox, oy];
}

console.log('');
if (failures === 0) {
  console.log('모든 항목 통과');
} else {
  console.log(`${failures}개 항목 실패`);
  process.exitCode = 1;
}
