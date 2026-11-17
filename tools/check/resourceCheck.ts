import assert from 'node:assert/strict';
import { CHUNK_SIZE } from '../../src/core/constants';
import { chunkKey } from '../../src/core/iso';
import type { MacroState } from '../../src/net/types';
import { LocalMarket } from '../../src/sim/market';
import { FAC_COAL_POWER, POWER_SPECS } from '../../src/sim/config/power';
import {
  CONSUMER_SPECS,
  FAC_COAL_MINE_1,
  FAC_IRON_MINE_1,
  FAC_IRON_MINE_2,
  FAC_IRON_MINE_3,
  FAC_OIL_WELL_1,
  FAC_REFINERY,
  FAC_STEEL_MILL,
  INDUSTRY_BONUS_FIRST,
  MARKET_REF_STOCK,
  MINE_SPECS,
  marketPrice,
  RESOURCE_STORAGE,
  tradeTotal,
} from '../../src/sim/config/resources';
import { constructionSeconds } from '../../src/sim/construction';
import { FACILITY_SPECS } from '../../src/sim/facilities';
import { MacroSim } from '../../src/sim/macro';
import { mineSiteProblem, ResourceSystem } from '../../src/sim/resources';
import type { FacilityRecord } from '../../src/sim/services';
import { BUILD_ITEMS } from '../../src/ui/constructionCatalog';
import {
  CONTINENT_H,
  CONTINENT_W,
  CONTINENT_X0,
  CONTINENT_Y0,
  quickSite,
} from '../../src/world/continent';
import { depositAt, type Deposit } from '../../src/world/deposits';
import { World } from '../../src/world/world';

/**
 * 군사 2단계 — 자원 점검.
 *  1. 매장지: 결정론, 대륙에 드물게(육지 청크의 3~15%), 세 자원 모두, 지역 편차, 최소량 보장.
 *  2. 광산 자리: 자원 종류·난이도·단계 규칙.
 *  3. 채굴: 비축이 늘고 매장량이 줄고, 바닥나면 멈춘다. 창고가 차면 쉰다.
 *  4. 가공: 제철소·정유소가 재료를 쓰고 공업 보너스를 준다. 재료가 없으면 멈춘다.
 *  5. 석탄 화력: 석탄이 떨어지면 전력망에서 빠진다.
 *  6. 시장: 재고가 많으면 싸고 적으면 비싸다. 사고팔면 재고가 움직인다.
 *  7. 시설 표·건설 메뉴·공사 시간.
 */

// 1. 매장지
const counts = { iron: 0, coal: 0, oil: 0 };
let land = 0;
let deposits = 0;
const found: Record<string, Array<{ cx: number; cy: number; d: Deposit }>> = {};
for (let cy = CONTINENT_Y0; cy < CONTINENT_Y0 + CONTINENT_H; cy += 2)
  for (let cx = CONTINENT_X0; cx < CONTINENT_X0 + CONTINENT_W; cx += 2) {
    if (!quickSite(cx * CHUNK_SIZE + 16, cy * CHUNK_SIZE + 16).water) land++;
    const d = depositAt(cx, cy);
    if (!d) continue;
    deposits++;
    counts[d.resource]++;
    assert.ok(d.reserve >= 2_500, '매장지는 최소량 보장');
    (found[`${d.resource}${d.difficulty}`] ??= []).push({ cx, cy, d });
  }
const share = deposits / land;
assert.ok(share > 0.03 && share < 0.15, `매장지는 드물게 (${(share * 100).toFixed(1)}%)`);
for (const r of ['iron', 'coal', 'oil'] as const) assert.ok(counts[r] > 50, `${r} 매장지가 있다`);
const again = depositAt(found.iron0[0].cx, found.iron0[0].cy);
assert.deepEqual(again, found.iron0[0].d, '같은 좌표면 같은 매장지');
// 지역 편차: 32×32 청크 구역마다 자원 종류 구성이 다르다.
const regions = new Set<string>();
for (let gy = -3; gy < 3; gy++)
  for (let gx = -4; gx < 4; gx++) {
    const has = { iron: 0, coal: 0, oil: 0 };
    for (let y = 0; y < 32; y += 2)
      for (let x = 0; x < 32; x += 2) {
        const d = depositAt(gx * 32 + x, gy * 32 + y);
        if (d) has[d.resource]++;
      }
    regions.add(`${has.iron > 3 ? 'I' : ''}${has.coal > 3 ? 'C' : ''}${has.oil > 3 ? 'O' : ''}`);
  }
assert.ok(regions.size >= 4, `지역마다 자원 구성이 다르다 (${[...regions].join(',')})`);
console.log(
  `  OK   매장지 육지의 ${(share * 100).toFixed(1)}% · 철 ${counts.iron} · 석탄 ${counts.coal} · 석유 ${counts.oil} (표본) · 지역 구성 ${regions.size}가지`,
);

// 2. 광산 자리
const shallowIron = found.iron0[0];
const mediumIron = (found.iron1 ?? [])[0];
const deepIron = (found.iron2 ?? [])[0];
assert.ok(mediumIron && deepIron, '보통·깊은 철 매장지도 있다');
const at = (c: { cx: number; cy: number }) => ({
  tx: c.cx * CHUNK_SIZE + 10,
  ty: c.cy * CHUNK_SIZE + 10,
});
{
  const s = at(shallowIron);
  assert.equal(mineSiteProblem(FAC_IRON_MINE_1, s.tx, s.ty, null), '');
  assert.ok(mineSiteProblem(FAC_COAL_MINE_1, s.tx, s.ty, null).includes('철 매장지'));
  const m = at(mediumIron);
  assert.ok(mineSiteProblem(FAC_IRON_MINE_1, m.tx, m.ty, null).includes('2단계'));
  assert.equal(mineSiteProblem(FAC_IRON_MINE_2, m.tx, m.ty, null), '');
  const dp = at(deepIron);
  assert.ok(mineSiteProblem(FAC_IRON_MINE_2, dp.tx, dp.ty, null).includes('3단계'));
  assert.equal(mineSiteProblem(FAC_IRON_MINE_3, dp.tx, dp.ty, null), '');
  // 매장지가 아닌 곳
  let empty = { tx: 0, ty: 0 };
  for (let i = 0; i < 400; i++) {
    const cx = shallowIron.cx + 20 + (i % 20);
    const cy = shallowIron.cy + Math.floor(i / 20);
    if (!depositAt(cx, cy)) {
      empty = { tx: cx * CHUNK_SIZE + 5, ty: cy * CHUNK_SIZE + 5 };
      break;
    }
  }
  assert.ok(
    mineSiteProblem(FAC_OIL_WELL_1, empty.tx, empty.ty, null).includes('매장지가 아닙니다'),
  );
}
console.log('  OK   광산 자리: 자원 종류·난이도(얕음 1단계, 보통 2단계, 깊음 3단계)');

// 3. 채굴
let index = 0;
const rec = (kind: number, tx: number, ty: number, hasRoad = true): FacilityRecord => ({
  index: index++,
  kind,
  tx,
  ty,
  span: FACILITY_SPECS[kind].span,
  hasRoad,
});
const macro: MacroState = { money: 100_000, population: 0, tick: 0, tickedAt: 0 };
const res = new ResourceSystem(macro);
const site = at(shallowIron);
const ironMine = rec(FAC_IRON_MINE_1, site.tx, site.ty);
res.refresh([ironMine]);
assert.equal(res.summary.activeMines, 1);
assert.equal(res.summary.production.iron, MINE_SPECS[FAC_IRON_MINE_1].output);
res.advance(1);
assert.equal(
  Math.round(res.stockNow.iron),
  MINE_SPECS[FAC_IRON_MINE_1].output,
  '하루 캐면 하루치가 쌓인다',
);
const key = chunkKey(shallowIron.cx, shallowIron.cy);
assert.equal(Math.round(macro.mined![key]), MINE_SPECS[FAC_IRON_MINE_1].output);
res.refresh([rec(FAC_IRON_MINE_1, site.tx, site.ty, false)]);
assert.equal(res.summary.activeMines, 0, '도로가 없으면 멈춤');
// 바닥내기
macro.mined![key] = shallowIron.d.reserve - 10;
res.refresh([ironMine]);
res.advance(5);
assert.equal(Math.round(macro.mined![key]), shallowIron.d.reserve, '남은 만큼만 캔다');
res.refresh([ironMine]);
assert.equal(res.mineAt(site.tx, site.ty)?.state, 'depleted');
assert.ok(mineSiteProblem(FAC_IRON_MINE_1, site.tx, site.ty, macro).includes('다 캤'));
// 창고가 가득
macro.mined![key] = 0;
macro.resources!.iron = RESOURCE_STORAGE;
res.refresh([ironMine]);
assert.equal(res.mineAt(site.tx, site.ty)?.state, 'full');
console.log('  OK   채굴: 비축 증가·매장량 감소·바닥나면 멈춤·창고 가득하면 쉼');

// 4. 가공
macro.resources = { iron: 100, coal: 100, oil: 0 };
const mill = rec(FAC_STEEL_MILL, site.tx + 40, site.ty);
const refinery = rec(FAC_REFINERY, site.tx + 50, site.ty);
res.refresh([mill, refinery]);
assert.equal(res.summary.steelActive, 1);
assert.equal(res.summary.refineryActive, 0, '석유가 없으면 정유소는 멈춘다');
assert.equal(res.summary.industryBonus, INDUSTRY_BONUS_FIRST);
res.advance(1);
assert.equal(res.stockNow.iron, 100 - CONSUMER_SPECS[FAC_STEEL_MILL].input.iron!);
assert.equal(res.stockNow.coal, 100 - CONSUMER_SPECS[FAC_STEEL_MILL].input.coal!);
macro.resources.oil = 500;
res.refresh([mill, refinery]);
assert.ok(res.summary.industryBonus > INDUSTRY_BONUS_FIRST && res.summary.gasDiscount);
res.advance(10);
assert.ok(res.stockNow.iron === 0 && res.stockNow.coal === 0, '재료는 0 아래로 안 내려간다');
res.refresh([mill, refinery]);
assert.equal(res.summary.steelActive, 0, '재료가 떨어지면 제철소 멈춤');
console.log('  OK   제철소·정유소: 재료 소비, 공업 보너스, 재료 없으면 멈춤');

// 5. 석탄 화력 + 매크로 통합
{
  const world = new World(0);
  const m: MacroState = { money: 100_000, population: 0, tick: 0, tickedAt: 0 };
  const sim = new MacroSim(world, m);
  assert.ok(POWER_SPECS[FAC_COAL_POWER].capacity > POWER_SPECS[12].capacity);
  sim.resources.addStock('coal', 50);
  assert.equal(sim.power.coalFuel, true);
  const rev = world.utilityRevision;
  sim.resources.addStock('coal', -50);
  assert.equal(sim.power.coalFuel, false, '석탄이 떨어지면 화력이 꺼진다');
  assert.ok(world.utilityRevision > rev, '전력망을 다시 센다');
  sim.resources.addStock('coal', 10);
  assert.equal(sim.power.coalFuel, true);
  // 공업 보너스가 세수에 들어간다
  sim.stats.tiers[2][0].filled = 1000;
  const base = sim.financeEstimate().taxes;
  sim.resources.summary.industryBonus = 0.2;
  assert.ok(Math.abs(sim.financeEstimate().taxes - base * 1.2) < 1e-6);
  // 시장 거래 반영용 돈 조정
  sim.adjustMoney(-500);
  assert.equal(sim.money, 99_500);
  sim.resetState();
  assert.deepEqual(m.resources, { iron: 0, coal: 0, oil: 0, wood: 0, ammo: 0 });
}
console.log('  OK   석탄 화력 연료·공업 세수 보너스·초기화');

// 6. 시장
assert.ok(marketPrice('iron', 0) > marketPrice('iron', MARKET_REF_STOCK.iron));
assert.ok(
  marketPrice('iron', MARKET_REF_STOCK.iron * 3) < marketPrice('iron', MARKET_REF_STOCK.iron),
);
assert.ok(tradeTotal('oil', 20_000, 100) > tradeTotal('oil', 20_000, -100), '사는 값 > 파는 값');
{
  const market = new LocalMarket();
  const p0 = market.price('coal');
  const sold = await market.trade('coal', -1000, 0, 1500, 0);
  assert.ok(sold.ok && sold.qty === -1000 && sold.cost < 0, '팔면 돈을 받는다');
  assert.equal(market.stock.coal, MARKET_REF_STOCK.coal + 1000);
  assert.ok(market.price('coal') < p0, '많이 팔리면 싸진다');
  const bought = await market.trade('coal', 500, 1_000_000, 0, 10_000);
  assert.ok(bought.ok && bought.qty === 500 && bought.cost > 0);
  const poor = await market.trade('coal', 500, 10, 0, 10_000);
  assert.ok(!poor.ok || poor.cost <= 10, '돈만큼만 산다');
  const none = await market.trade('iron', -100, 0, 0, 0);
  assert.ok(!none.ok, '없는 자원은 못 판다');
}
console.log('  OK   시장: 재고에 따른 시세, 사고팔기, 돈·재고 한도');

// 7. 표
for (const kind of [
  ...Object.keys(MINE_SPECS).map(Number),
  FAC_STEEL_MILL,
  FAC_REFINERY,
  FAC_COAL_POWER,
]) {
  const spec = FACILITY_SPECS[kind];
  assert.ok(spec && spec.name && spec.span >= 3 && spec.cost > 0, `시설 ${kind} 표`);
  assert.ok(
    BUILD_ITEMS.some((i) => i.kind === kind),
    `건설 메뉴에 ${spec.name}`,
  );
}
assert.equal(constructionSeconds(FAC_IRON_MINE_1), 180);
assert.equal(constructionSeconds(FAC_IRON_MINE_2), 900);
assert.equal(constructionSeconds(FAC_IRON_MINE_3), 2400);
assert.deepEqual(
  [FAC_IRON_MINE_1, FAC_IRON_MINE_2, FAC_IRON_MINE_3].map((k) => FACILITY_SPECS[k].unlockLevel),
  [2, 5, 8],
);
// 벌목장(숲에서만 나무 40/일)·탄약 공장(철 10 + 석탄 5 + 나무 5 → 탄약 20/일)
{
  const { forestShare } = await import('../../src/sim/military/terrain');
  const { FAC_LUMBER_CAMP, FAC_AMMO_FACTORY } = await import('../../src/sim/config/resources');
  let forest: [number, number] | null = null;
  let bare: [number, number] | null = null;
  for (let cy = 60; cy < 140 && (!forest || !bare); cy++)
    for (let cx = -40; cx < 40 && (!forest || !bare); cx++) {
      const f = forestShare(cx, cy);
      if (f >= 0.6 && !forest) forest = [cx, cy];
      if (f === 0 && !bare) bare = [cx, cy];
    }
  assert.ok(forest && bare, '숲 청크와 숲 없는 청크');
  const rec = (kind: number, cx: number, cy: number, index: number): FacilityRecord =>
    ({
      index,
      kind,
      tx: cx * CHUNK_SIZE + 4,
      ty: cy * CHUNK_SIZE + 4,
      span: 3,
      hasRoad: true,
      needsRoad: true,
    }) as FacilityRecord;
  const macro = { resources: { iron: 100, coal: 100, oil: 0, wood: 0, ammo: 0 } } as MacroState;
  const rs = new ResourceSystem(macro);
  rs.refresh([
    rec(FAC_LUMBER_CAMP, forest![0], forest![1], 0),
    rec(FAC_LUMBER_CAMP, bare![0], bare![1], 1),
  ]);
  assert.equal(rs.summary.production.wood, 40, '숲 벌목장만 일함');
  assert.ok(
    rs.consumerAt(bare![0] * CHUNK_SIZE + 4, bare![1] * CHUNK_SIZE + 4)!.reason.includes('숲'),
  );
  rs.advance(1);
  assert.equal(rs.stockNow.wood, 40);
  rs.refresh([rec(FAC_AMMO_FACTORY, bare![0], bare![1], 0)]);
  rs.advance(1);
  assert.equal(rs.stockNow.ammo, 20);
  assert.equal(rs.stockNow.iron, 90);
  assert.equal(rs.stockNow.wood, 35);
  console.log('  OK   벌목장(숲에서만 나무 40/일), 탄약 공장(철·석탄·나무 → 탄약 20/일)');
}
console.log(
  'Resources passed: deposits, mine sites, mining, processing, coal power, market, tables.',
);
