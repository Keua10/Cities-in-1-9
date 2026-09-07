/**
 * 개발용 검증 스크립트. 게임 빌드에는 포함되지 않는다.
 *
 * 브라우저 없이 매크로 시뮬레이션만 돌려서
 *   - 도시가 실제로 자라는지
 *   - 1단계로 꽉 찬 뒤 2단계 재건축이 일어나는지
 *   - 돈이 파산으로 곤두박질치지 않는지
 * 를 확인한다.
 *
 * 실행:  node tools/simcheck.mjs   (esbuild 로 번들한 뒤)
 */
import { CHUNK_SIZE } from '../src/core/constants';
import { growParcel, sectorNeighborhoodHasEmptyLot } from '../src/sim/growth';
import { MacroSim } from '../src/sim/macro';
import { RoadField } from '../src/sim/roadGraph';
import {
  REDEVELOPMENT_SECTOR_SIZE,
  START_MONEY,
  TICKS_PER_DAY,
} from '../src/sim/simConstants';
import { isAnchor, levelOfCode, zoneOfCode } from '../src/sim/buildings';
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
} from '../src/sim/facilities';
import { Build } from '../src/world/build';
import { World } from '../src/world/world';
import { isWater } from '../src/world/terrain';

// 섹터 경계의 바로 옆 빈 필지도 3x3 섹터 검색에 잡히는지 먼저 확인한다.
const sectorProbe = new World(0);
sectorProbe.setBuild(REDEVELOPMENT_SECTOR_SIZE, 0, Build.ZoneR);
if (!sectorNeighborhoodHasEmptyLot(sectorProbe, REDEVELOPMENT_SECTOR_SIZE - 1, 0)) {
  throw new Error('인접 섹터의 빈 필지를 찾지 못했습니다');
}
sectorProbe.placeBuilding(REDEVELOPMENT_SECTOR_SIZE, 0, 0, 1, 0);
if (sectorNeighborhoodHasEmptyLot(sectorProbe, REDEVELOPMENT_SECTOR_SIZE - 1, 0)) {
  throw new Error('건물이 들어선 필지를 빈 필지로 잘못 판정했습니다');
}
console.log('16x16 섹터 + 인접 8섹터 빈 필지 판정 통과');

// 꽉 찬 섹터에서는 footprint 전체가 조건을 만족할 때만 L1 묶음이 L3로 올라간다.
const redevelopmentWorld = new World(0);
for (let ty = 0; ty < REDEVELOPMENT_SECTOR_SIZE; ty++) {
  for (let tx = 0; tx < REDEVELOPMENT_SECTOR_SIZE; tx++) {
    redevelopmentWorld.setBuild(tx, ty, Build.ZoneR);
    redevelopmentWorld.placeBuilding(tx, ty, 0, 1, 0);
  }
}
for (let ty = 0; ty < 3; ty++) {
  for (let tx = 0; tx < 3; tx++) redevelopmentWorld.setHeight(tx, ty, 0);
}
redevelopmentWorld.setBuild(-1, 0, Build.Road);
const redevelopmentField = new RoadField();
redevelopmentField.rebuild(redevelopmentWorld);
const redevelopmentParcel = redevelopmentWorld.peekParcel(0, 0);
if (!redevelopmentParcel) throw new Error('재개발 검증 필지가 없습니다');
const redevelopment = growParcel(redevelopmentWorld, redevelopmentParcel, {
  demand: [
    [-1, -1, 1],
    [-1, -1, -1],
    [-1, -1, -1],
  ],
  field: redevelopmentField,
  today: 31,
  tick: 1,
  money: 100_000,
});
if (redevelopment.built !== 1 || redevelopment.demolished !== 9) {
  throw new Error(
    `꽉 찬 섹터의 L1→L3 재개발 실패: 신축 ${redevelopment.built}, 철거 ${redevelopment.demolished}`,
  );
}
console.log('꽉 찬 섹터의 footprint 전체 L1→L3 상향 재개발 통과');

const world = new World(0);
const macro = { money: START_MONEY, population: 0, tick: 0, tickedAt: Date.now() };

// base 안에서 물이 아니고 고도가 고른 청크를 하나 고른다.
let target = { cx: world.baseCx, cy: world.baseCy };
let bestScore = -1;
for (let dy = 0; dy < 4; dy++) {
  for (let dx = 0; dx < 4; dx++) {
    const cx = world.baseCx + dx;
    const cy = world.baseCy + dy;
    let dry = 0;
    for (let ly = 0; ly < CHUNK_SIZE; ly += 2) {
      for (let lx = 0; lx < CHUNK_SIZE; lx += 2) {
        const tx = cx * CHUNK_SIZE + lx;
        const ty = cy * CHUNK_SIZE + ly;
        if (!isWater(world.getTile(tx, ty))) dry++;
      }
    }
    if (dry > bestScore) {
      bestScore = dry;
      target = { cx, cy };
    }
  }
}
console.log(`대상 청크 ${target.cx},${target.cy} (마른 땅 비율 ${((bestScore / 1024) * 100).toFixed(0)}%)`);

// 6칸마다 도로를 긋고(5칸 폭 블록) 나머지를 지구로 채운다. 학생이 격자 도시를 만든 상황.
const bx = target.cx * CHUNK_SIZE;
const by = target.cy * CHUNK_SIZE;

/*
 * 3.3단계: 이 도시에 필요한 서비스·복지 시설의 자리를 먼저 잡는다.
 *
 * 3.3 이후로 시설은 "있으면 좋은 것" 이 아니라 기반시설이다. 소방서도 공원도
 * 없는 8천명짜리 도시는 설계상 건강한 도시가 아니므로, 그런 도시에 "입주율
 * 70~94%" 를 요구하는 것은 더 이상 의미 있는 검증이 아니다. 그래서 이 시나리오는
 * 학생이 실제로 하는 것과 같이 시설을 함께 짓는다. 목표 범위는 그대로 둔다.
 *
 * 규모의 근거(정원은 simConstants):
 *   소방서 220건물 · 경찰 3,000명 · 병원 5,000명 · 학교 2,500명
 * 최종 인구 8천~9천, 건물 1,300채대를 감당할 만큼 놓는다.
 */
const FACILITY_PLAN: ReadonlyArray<readonly [number, number]> = [
  [FAC_FIRE, 6],
  [FAC_POLICE, 3],
  [FAC_HOSPITAL, 2],
  [FAC_SCHOOL, 4],
  [FAC_PARK, 5],
  [FAC_SPORTS, 2],
  [FAC_MINIPARK, 4],
];

/** 5x5 블록의 왼쪽 위 칸들. 도로 격자가 lx/ly % 6 === 0 이므로 블록은 6k+1 에서 시작한다. */
const blockOrigins: Array<[number, number]> = [];
for (let ly = 1; ly + 3 <= CHUNK_SIZE; ly += 6) {
  for (let lx = 1; lx + 3 <= CHUNK_SIZE; lx += 6) blockOrigins.push([lx, ly]);
}

/*
 * 짓는 순서는 **종류를 돌아가며** 섞는다.
 *
 * 종류별로 몰아서 지으면(소방서 6채 -> 경찰 3채 -> ...) 유지비 상한에 걸리는
 * 시점까지 앞쪽 두 종류만 서고 병원·학교·공원은 영영 안 선다. 그러면 커버율이
 * 한쪽만 오르고 도시가 "수입이 없어 시설을 못 짓고, 시설이 없어 수입이 안 느는"
 * 부트스트랩 함정에 빠진다. 한 채씩 돌아가며 지어야 커버가 고르게 퍼진다.
 */
const wishlist: number[] = [];
{
  const remaining = FACILITY_PLAN.map(([kind, count]) => ({ kind, count }));
  let added = true;
  while (added) {
    added = false;
    for (const entry of remaining) {
      if (entry.count <= 0) continue;
      wishlist.push(entry.kind);
      entry.count--;
      added = true;
    }
  }
}
const stride = Math.max(1, Math.floor(blockOrigins.length / wishlist.length));
const reserved: Array<[number, number, number]> = [];
for (let i = 0; i < wishlist.length; i++) {
  const origin = blockOrigins[(i * stride) % blockOrigins.length];
  if (!origin) break;
  reserved.push([origin[0], origin[1], wishlist[i]]);
}

// 시설이 들어설 칸에는 지구를 깔지 않는다. 지구를 깔아두면 나중에 시설을 놓을 때
// 다 자란 건물이 헐려서, 시설의 효과가 아니라 철거의 여파를 재게 된다.
const facilityCells = new Set<string>();
for (const [lx, ly, kind] of reserved) {
  const span = FACILITY_SPECS[kind].span;
  for (let dy = 0; dy < span; dy++) {
    for (let dx = 0; dx < span; dx++) facilityCells.add(`${lx + dx},${ly + dy}`);
  }
}

let roads = 0;
let zones = 0;
for (let ly = 0; ly < CHUNK_SIZE; ly++) {
  for (let lx = 0; lx < CHUNK_SIZE; lx++) {
    const tx = bx + lx;
    const ty = by + ly;
    if (isWater(world.getTile(tx, ty))) continue;
    if (lx % 6 === 0 || ly % 6 === 0) {
      world.setBuild(tx, ty, Build.Road);
      roads++;
    } else if (!facilityCells.has(`${lx},${ly}`)) {
      // 왼쪽 절반은 주거, 오른쪽 위는 상업, 오른쪽 아래는 공업
      const zone =
        lx < CHUNK_SIZE / 2 ? Build.ZoneR : ly < CHUNK_SIZE / 2 ? Build.ZoneC : Build.ZoneI;
      world.setBuild(tx, ty, zone);
      zones++;
    }
  }
}

console.log(`도로 ${roads}칸, 지구 ${zones}칸을 깔았습니다.`);
console.log(`시설 자리 ${reserved.length}곳을 비워뒀습니다. 도시가 자라는 대로 하나씩 짓습니다.`);

const sim = new MacroSim(world, macro);
let minimumMoney = macro.money;
let rebuildDemolitions = 0;
const originalDemolish = world.demolishAt.bind(world);
world.demolishAt = ((tx: number, ty: number) => {
  const result = originalDemolish(tx, ty);
  if (result) rebuildDemolitions++;
  return result;
}) as typeof world.demolishAt;
sim.primeCatchup(Date.now());

/*
 * 시설은 **도시가 자라는 대로 하나씩** 짓는다.
 *
 * 19채를 첫날에 다 지으면 하루 유지비가 1만 원인데 시작 자금이 6만 원이라
 * 3주 만에 파산하고, money <= 0 에서 성장이 멈춰 도시가 그대로 얼어붙는다.
 * 학생도 그렇게 하지 않는다 — 돈이 되고 필요해질 때 한 채씩 늘린다.
 *
 * 짓는 조건 두 가지:
 *   1) 건설비의 몇 배쯤 여유가 있을 것 (한 채 짓고 바로 빈털터리가 되지 않게)
 *   2) 시설 유지비 총액이 하루 수입의 일정 비율을 넘지 않을 것
 *      — 명세 11장이 목표로 잡은 15~25% 구간이 이 상한이다.
 */
const UPKEEP_INCOME_SHARE = 0.25;
const MONEY_RESERVE_MUL = 4;
let facilitiesPlaced = 0;
let facilityUpkeep = 0;
let nextFacility = 0;

function tryBuildFacility(): void {
  while (nextFacility < reserved.length) {
    const [lx, ly, kind] = reserved[nextFacility];
    const spec = FACILITY_SPECS[kind];
    // 물·경사지에 걸린 자리는 건너뛴다. 지형은 좌표에서 결정론적으로 나오므로
    // 어느 기기에서 돌려도 같은 자리가 빠진다.
    if (!canPlaceFacility(world, bx + lx, by + ly, kind).ok) {
      nextFacility++;
      continue;
    }
    if (sim.money < spec.cost * MONEY_RESERVE_MUL) return;
    if (facilityUpkeep + spec.upkeepPerDay > sim.stats.dailyIncome * UPKEEP_INCOME_SHARE) {
      return;
    }
    world.placeFacility(bx + lx, by + ly, kind, sim.day);
    facilityUpkeep += spec.upkeepPerDay;
    facilitiesPlaced++;
    nextFacility++;
    return; // 하루에 한 채씩만
  }
}

const DAYS = 220;
for (let day = 0; day <= DAYS; day++) {
  if (day % 20 === 0) report(day);
  for (let t = 0; t < TICKS_PER_DAY; t++) {
    sim['step']();
    minimumMoney = Math.min(minimumMoney, sim.money);
  }
  tryBuildFacility();
}
report(DAYS);

const occupancyPct = Math.round(sim.stats.occupancy * 100);
const upkeepShare =
  sim.stats.dailyIncome > 0 ? (facilityUpkeep / sim.stats.dailyIncome) * 100 : 0;
console.log(
  `검증 요약: 최소 자금 ${Math.round(minimumMoney).toLocaleString('ko-KR')}원` +
    ` · 재건축 철거 ${rebuildDemolitions}채 · 최종 입주율 ${occupancyPct}%`,
);
console.log(
  `시설 ${facilitiesPlaced}/${reserved.length}채 · 하루 유지비 ${facilityUpkeep.toLocaleString('ko-KR')}원` +
    ` (하루 수입의 ${upkeepShare.toFixed(1)}%) · ` +
    `커버율 [${sim.stats.serviceCoverage.map((v) => Math.round(v * 100)).join(',')}]` +
    ` · 복지 충족 ${Math.round(sim.stats.amenityFulfilled * 100)}%`,
);
if (minimumMoney <= 0) throw new Error('도시 자금이 0원 이하로 떨어졌습니다');
if (sim.stats.occupancy < 0.7 || sim.stats.occupancy > 0.94) {
  throw new Error(`최종 입주율이 목표 범위를 크게 벗어났습니다: ${occupancyPct}%`);
}

function report(day: number): void {
  const counts: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  let empty = 0;
  for (const p of world.developedParcels()) {
    empty += p.emptyPlots;
    if (!p.bld) continue;
    for (let i = 0; i < p.bld.length; i++) {
      const c = p.bld[i];
      if (isAnchor(c)) counts[zoneOfCode(c)][levelOfCode(c) - 1]++;
    }
  }
  const d = sim.demand
    .map((row) => row.map((v) => v.toFixed(2).padStart(5)).join(' '))
    .join(' | ');
  console.log(
    `${String(day).padStart(4)}일  인구 ${String(Math.round(sim.stats.population)).padStart(6)}` +
      `  돈 ${String(Math.round(sim.money)).padStart(9)}` +
      `  빈부지 ${String(empty).padStart(4)}` +
      `  R ${counts[0].join('/')}  C ${counts[1].join('/')}  I ${counts[2].join('/')}` +
      `  입주 ${(sim.stats.occupancy * 100).toFixed(0)}%` +
      `\n        수요 ${d}`,
  );
}
