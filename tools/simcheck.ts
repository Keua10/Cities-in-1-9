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
    } else {
      // 왼쪽 절반은 주거, 오른쪽 위는 상업, 오른쪽 아래는 공업
      const zone =
        lx < CHUNK_SIZE / 2 ? Build.ZoneR : ly < CHUNK_SIZE / 2 ? Build.ZoneC : Build.ZoneI;
      world.setBuild(tx, ty, zone);
      zones++;
    }
  }
}
console.log(`도로 ${roads}칸, 지구 ${zones}칸을 깔았습니다.`);

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

const DAYS = 220;
for (let day = 0; day <= DAYS; day++) {
  if (day % 20 === 0) report(day);
  for (let t = 0; t < TICKS_PER_DAY; t++) {
    sim['step']();
    minimumMoney = Math.min(minimumMoney, sim.money);
  }
}
report(DAYS);

const occupancyPct = Math.round(sim.stats.occupancy * 100);
console.log(
  `검증 요약: 최소 자금 ${Math.round(minimumMoney).toLocaleString('ko-KR')}원` +
    ` · 재건축 철거 ${rebuildDemolitions}채 · 최종 입주율 ${occupancyPct}%`,
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
