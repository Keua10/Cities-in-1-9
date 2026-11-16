import assert from 'node:assert/strict';
import { CHUNK_SIZE } from '../../src/core/constants';
import {
  FAC_FISHERY,
  FAC_FOOD_PLANT,
  FAC_GRAIN_FARM,
  FAC_GRANARY,
  FAC_GREENHOUSE,
  FOOD_BASE_STORAGE,
  FOOD_EXPORT_PRICE,
  FOOD_IMPORT_PRICE,
  FOOD_LOCAL_SUPPLY,
  FOOD_SPECS,
} from '../../src/sim/config/food';
import { constructionSeconds } from '../../src/sim/construction';
import { canPlaceFacility, FACILITY_SPECS } from '../../src/sim/facilities';
import { FoodSystem, footprintFertility } from '../../src/sim/food';
import type { FacilityRecord } from '../../src/sim/services';
import { BUILD_ITEMS } from '../../src/ui/constructionCatalog';
import { fertilityAt } from '../../src/world/continent';
import { defaultOrigin } from '../../src/world/sites';
import { isWater } from '../../src/world/terrain';
import { World } from '../../src/world/world';

/**
 * 식량 자급 점검: 생산·소비·비축·수입·수출, 비옥도 차이, 시설 규칙, 메뉴.
 */

const origin = defaultOrigin(0);
const world = new World(origin);
const x0 = origin.cx * CHUNK_SIZE;
const y0 = origin.cy * CHUNK_SIZE;
let index = 0;
const rec = (kind: number, tx: number, ty: number, hasRoad = true): FacilityRecord => ({
  index: index++,
  kind,
  tx,
  ty,
  span: FACILITY_SPECS[kind].span,
  hasRoad,
});

// 1. 주변 넓은 땅에서 가장 비옥한 곳(하천가 풀밭)과 가장 척박한 곳(마른 고지)을 찾는다.
let best = { tx: x0, ty: y0, f: -1 };
let worst = { tx: x0, ty: y0, f: 9 };
for (let ty = y0 - 384; ty < y0 + 512; ty += 8)
  for (let tx = x0 - 384; tx < x0 + 512; tx += 8) {
    if (isWater(world.getTile(tx, ty))) continue;
    const f = fertilityAt(tx, ty);
    if (f > best.f) best = { tx, ty, f };
    if (f < worst.f) worst = { tx, ty, f };
  }
const fBest = footprintFertility(best.tx, best.ty, 5);
const fWorst = footprintFertility(worst.tx, worst.ty, 5);
assert.ok(fBest > fWorst + 0.4, `비옥도 차이가 너무 작습니다: ${fBest} / ${fWorst}`);

const food = new FoodSystem(world);
food.refresh([rec(FAC_GRAIN_FARM, best.tx, best.ty)], 0, 0);
const rich = food.summary.production;
food.refresh([rec(FAC_GRAIN_FARM, worst.tx, worst.ty)], 0, 0);
const poor = food.summary.production;
assert.ok(rich > poor * 1.3, `하천 가까운 땅이 충분히 더 거둬야 합니다: ${rich} / ${poor}`);
assert.equal(rich, Math.round(FOOD_SPECS[FAC_GRAIN_FARM].output * fBest));
console.log(`  OK   같은 곡물 농장: 비옥한 땅 ${rich} vs 척박한 땅 ${poor} (하루)`);

// 2. 땅을 가리지 않는 시설은 어디서나 같다.
food.refresh([rec(FAC_GREENHOUSE, worst.tx, worst.ty)], 0, 0);
assert.equal(food.summary.production, FOOD_SPECS[FAC_GREENHOUSE].output);

// 3. 도로가 끊긴 농장은 생산하지 않는다.
food.refresh([rec(FAC_GRAIN_FARM, best.tx, best.ty, false)], 0, 0);
assert.equal(food.summary.production, 0);
assert.equal(food.summary.activeFarms, 0);
assert.equal(food.summary.farms, 1);

// 4. 근교 농가: 작은 마을은 농장 없이도 먹는다.
food.refresh([], 200, 0);
assert.equal(food.summary.production, 200);
assert.equal(food.summary.importPerDay, 0);
assert.equal(food.summary.selfSufficiency, 1);

// 5. 큰 도시가 농장이 없고 창고가 비면 사 온다.
food.refresh([], 2_000, 0);
assert.equal(food.summary.importPerDay, 2_000 - FOOD_LOCAL_SUPPLY);
assert.equal(food.summary.importCost, (2_000 - FOOD_LOCAL_SUPPLY) * FOOD_IMPORT_PRICE);
// 창고에 식량이 있으면 먼저 꺼내 먹는다.
food.refresh([], 2_000, 1_000);
assert.equal(food.summary.importPerDay, 0);
assert.ok(food.advanceStock(1_000, 0.5) < 1_000);
assert.equal(food.advanceStock(100, 1), 0);
console.log('  OK   부족하면 창고 → 수입 순서, 근교 농가 300명분');

// 6. 남으면 쌓고, 창고가 차면 판다. 창고·가공 공장이 용량과 생산을 늘린다.
food.refresh([rec(FAC_GREENHOUSE, x0, y0), rec(FAC_GRANARY, x0 + 4, y0)], 100, 0);
assert.equal(food.summary.capacity, FOOD_BASE_STORAGE + FOOD_SPECS[FAC_GRANARY].storage);
assert.equal(food.summary.exportPerDay, 0);
const cap = food.summary.capacity;
food.applyStock(cap);
const surplus = food.summary.production - food.summary.consumption;
assert.equal(food.summary.exportPerDay, surplus);
assert.equal(food.summary.exportIncome, surplus * FOOD_EXPORT_PRICE);
assert.equal(food.advanceStock(cap, 1), cap);
food.refresh([rec(FAC_GREENHOUSE, x0, y0), rec(FAC_FOOD_PLANT, x0 + 4, y0)], 0, 0);
assert.equal(food.summary.processingBonus, 0.2);
assert.equal(food.summary.production, Math.round(FOOD_SPECS[FAC_GREENHOUSE].output * 1.2));
food.refresh(
  [rec(FAC_GREENHOUSE, x0, y0), rec(FAC_FOOD_PLANT, x0 + 4, y0), rec(FAC_FOOD_PLANT, x0 + 8, y0)],
  0,
  0,
);
assert.ok(Math.abs(food.summary.processingBonus - 0.3) < 1e-9);
console.log('  OK   비축 → 수출, 창고 +20,000, 가공 +20%/+10%');

// 7. 어업 기지는 물에 닿아야 짓고, 물 종류에 따라 거둔다.
let shore: { tx: number; ty: number } | null = null;
let inland: { tx: number; ty: number } | null = null;
for (let ty = y0 + 2; ty < y0 + 124 && !(shore && inland); ty++)
  for (let tx = x0 + 2; tx < x0 + 124; tx++) {
    const ok = canPlaceFacility(world, tx, ty, FAC_FISHERY, 3);
    if (ok.ok && !shore) shore = { tx, ty };
    if (!ok.ok && ok.reason.includes('어업') && !inland) inland = { tx, ty };
    if (shore && inland) break;
  }
assert.ok(shore, '기본 영역 하천가에 어업 기지를 지을 수 있어야 합니다');
assert.ok(inland, '물에서 먼 곳은 어업 기지를 막아야 합니다');
food.refresh([rec(FAC_FISHERY, shore!.tx, shore!.ty)], 0, 0);
assert.ok(food.summary.production > 0);

// 8. 메뉴·잠금·공사 기간.
const farmItems = BUILD_ITEMS.filter((i) => i.category === 'farm');
assert.equal(farmItems.length, Object.keys(FOOD_SPECS).length);
assert.equal(FACILITY_SPECS[FAC_GRAIN_FARM].unlockLevel, 1);
assert.equal(FACILITY_SPECS[FAC_GREENHOUSE].unlockLevel, 3);
assert.ok(constructionSeconds(FAC_GRAIN_FARM) <= 60, '기초 농장은 1분 안에 지어진다');
assert.ok(constructionSeconds(FAC_GRAIN_FARM) < constructionSeconds(22));
console.log(
  'Food passed: fertility matters, local supply, stock, import/export, processing, fishery, menu.',
);
