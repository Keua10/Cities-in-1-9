import { FAC_OCC_TOWER, OCC_TOWER_MS } from '../../src/sim/config/military';
import { FACILITY_SPECS } from '../../src/sim/facilities';
import { strict as assert } from 'node:assert';
import { BASE_CHUNK_SPAN, CHUNK_SIZE } from '../../src/core/constants';
import { chunkKey } from '../../src/core/iso';
import type { MacroState } from '../../src/net/types';
import { canPlaceFacility, FAC_PARK } from '../../src/sim/facilities';
import { MacroSim } from '../../src/sim/macro';
import { cityLevelFor, CITY_LEVELS, FACILITY_UNLOCK_LEVEL } from '../../src/sim/progression';
import {
  CAPITAL_MOVE_COOLDOWN_MS,
  CAPITAL_MOVE_MS,
  CUT_GRACE_MS,
  OCCUPY_FLOATING,
  OCCUPY_RESIDENTS,
  TerritorySystem,
} from '../../src/sim/territory';
import { Build, canPlaceZone } from '../../src/world/build';
import { Terrain } from '../../src/world/terrain';
import { World } from '../../src/world/world';

/**
 * 군사 1단계 — 영토·수도·도시 레벨 9단계 점검.
 *
 *  1. 도시 레벨은 번영도와 영토 청크 수를 둘 다 본다(9단계).
 *  2. 시작 영토 4×4, 수도 2×2 가 한가운데, 둘레 2청크 탐사.
 *  3. 지구는 내 땅·개척지에만, 공공 시설은 내 땅에만.
 *  4. 거주 100 / 유동 150 + 도로 연결이면 자동 점령, 연결이 없으면 점령 안 됨.
 *  5. 길이 끊기면 실제 10분 뒤 잃는다(시작 영토는 안 잃는다).
 *  6. 수도 확장: 도시 레벨 + 수도 ≤ 영토 25% + 둘러싼 땅이 전부 내 땅.
 *  7. 수도 이전: 5분 걸리고, 하루 한 번.
 */

// 1. 레벨
assert.equal(CITY_LEVELS.length, 9);
assert.equal(FACILITY_UNLOCK_LEVEL.length, 51);
assert.equal(cityLevelFor(0, 16), 1);
assert.equal(cityLevelFor(100, 16), 1, '영토 20청크 전에는 2레벨이 안 된다');
assert.equal(cityLevelFor(100, 20), 2);
assert.equal(cityLevelFor(6000, 30), 3, '번영도가 넘쳐도 영토가 막는다');
assert.equal(cityLevelFor(6000, 200), 9);
assert.equal(cityLevelFor(500, 1000), 4);
console.log('  OK   도시 레벨 9단계, 번영도·영토 둘 다 필요');

// 2. 시작 영토
const macro = (): MacroState => ({ money: 1_000_000, population: 0, tick: 0, tickedAt: 1000 });
const world = new World(0);
const m = macro();
const sim = new MacroSim(world, m);
const t = sim.territory;
world.landRule = t.landRule;
const bx = world.baseCx;
const by = world.baseCy;
assert.equal(t.count, BASE_CHUNK_SPAN * BASE_CHUNK_SPAN);
assert.deepEqual(t.capitalRect(), { cx: bx + 1, cy: by + 1, span: 2 });
assert.ok(world.isExplored(bx - 2, by - 2) && world.isExplored(bx + 5, by + 5));
assert.ok(!world.isExplored(bx - 3, by));
assert.equal(m.territory?.owned.length, 16, '영토가 저장 상태에 실린다');
console.log('  OK   시작 영토 4×4, 수도 2×2 가운데, 둘레 2청크 탐사');

// 3. 짓는 곳
const flat = (cx: number, cy: number) => {
  for (let y = 0; y < CHUNK_SIZE; y++)
    for (let x = 0; x < CHUNK_SIZE; x++) {
      world.setHeight(cx * CHUNK_SIZE + x, cy * CHUNK_SIZE + y, 0);
      world.setTile(cx * CHUNK_SIZE + x, cy * CHUNK_SIZE + y, Terrain.Grass);
    }
};
for (let cy = by - 2; cy <= by + 5; cy++) for (let cx = bx - 2; cx <= bx + 5; cx++) flat(cx, cy);
const tile = (cx: number, cy: number) => ({ tx: cx * CHUNK_SIZE + 10, ty: cy * CHUNK_SIZE + 10 });
{
  const own = tile(bx, by);
  const frontier = tile(bx - 1, by);
  const far = tile(bx - 2, by);
  assert.ok(canPlaceZone(world, own.tx, own.ty, Build.ZoneR).ok);
  assert.ok(canPlaceZone(world, frontier.tx, frontier.ty, Build.ZoneR).ok, '개척지에는 지구 가능');
  assert.ok(!canPlaceZone(world, far.tx, far.ty, Build.ZoneR).ok, '두 칸 밖은 지구 불가');
  assert.ok(canPlaceFacility(world, own.tx, own.ty, FAC_PARK, 9).ok);
  const r = canPlaceFacility(world, frontier.tx, frontier.ty, FAC_PARK, 9);
  assert.ok(!r.ok && r.reason.includes('영토'), '공공 시설은 개척지에 못 짓는다');
  // 발전소(풍력 11)는 개척지에도 짓는다.
  assert.ok(canPlaceFacility(world, frontier.tx, frontier.ty, 11, 9).ok);
  // 점령타워(50): 맞닿은 개척지에만, 내 땅·두 칸 밖·청크 경계 걸침은 불가, 도시 2레벨부터.
  assert.ok(canPlaceFacility(world, frontier.tx, frontier.ty, 50, 9).ok, '타워는 맞닿은 청크');
  assert.ok(!canPlaceFacility(world, own.tx, own.ty, 50, 9).ok, '타워는 내 땅에 안 됨');
  assert.ok(!canPlaceFacility(world, far.tx, far.ty, 50, 9).ok, '타워는 두 칸 밖 안 됨');
  const edge = (bx - 1) * CHUNK_SIZE + CHUNK_SIZE - 1;
  const rr = canPlaceFacility(world, edge, frontier.ty, 50, 9);
  assert.ok(!rr.ok, `청크 경계를 걸친 타워 불가: ${rr.reason}`);
  assert.ok(!canPlaceFacility(world, frontier.tx, frontier.ty, 50, 1).ok, '도시 1레벨 불가');
}
console.log('  OK   지구는 내 땅·개척지, 공공 시설은 내 땅에만, 발전소는 어디든');

// 4. 자동 점령: 수도에서 서쪽 개척지 청크(bx-1, by+1)까지 도로를 낸다.
const roadY = (by + 1) * CHUNK_SIZE + 5;
const x0 = (bx - 1) * CHUNK_SIZE + 5;
const x1 = (bx + 1) * CHUNK_SIZE + 5;
for (let x = x0; x <= x1; x++) world.setBuild(x, roadY, Build.Road);
for (let x = x0; x < x1; x++) world.connectRoads(x, roadY, x + 1, roadY);
const west = chunkKey(bx - 1, by + 1);
const north = chunkKey(bx + 1, by - 1);
let now = 1_000_000;
t.people = new Map([
  [west, { residents: OCCUPY_RESIDENTS, floating: 0, raw: OCCUPY_RESIDENTS }],
  [north, { residents: 0, floating: OCCUPY_FLOATING + 10, raw: 0 }],
]);
t.update(now, true);
assert.ok(t.isOwned(bx - 1, by + 1), '도로로 이어진 청크는 거주 100명이면 점령');
assert.ok(!t.isOwned(bx + 1, by - 1), '길이 없으면 유동인구가 많아도 점령 안 됨');
assert.equal(t.count, 17);
assert.ok(world.isExplored(bx - 3, by + 1), '새 땅 둘레가 탐사된다');
t.people = new Map([
  [west, { residents: OCCUPY_RESIDENTS - 1, floating: OCCUPY_FLOATING - 1, raw: 0 }],
]);
t.people.set(chunkKey(bx - 2, by + 1), { residents: 500, floating: 0, raw: 500 });
t.update(now + 2000, true);
assert.ok(t.isOwned(bx - 1, by + 1), '한 번 얻은 땅은 인구가 줄어도 안 잃는다');
assert.ok(!t.isOwned(bx - 2, by + 1), '도로가 안 닿은 청크는 점령 안 됨');
console.log('  OK   거주 100·유동 150 + 도로 연결이면 자동 점령');

// 5. 끊김
world.setBuild((bx + 0) * CHUNK_SIZE + 2, roadY, Build.None);
now += 10_000;
t.update(now, true);
assert.ok(t.isCut(bx - 1, by + 1), '길이 끊기면 끊김 표시');
assert.equal(t.cutChunks(now)[0].leftMs, CUT_GRACE_MS);
t.update(now + CUT_GRACE_MS - 1000, true);
assert.ok(t.isOwned(bx - 1, by + 1), '10분 전에는 안 잃는다');
t.update(now + CUT_GRACE_MS + 1000, true);
assert.ok(!t.isOwned(bx - 1, by + 1), '10분이 지나면 무소유');
assert.ok(t.isOwned(bx, by + 1), '시작 영토는 길이 없어도 안 잃는다');
assert.equal(t.count, 16);
console.log('  OK   길이 끊기면 10분 뒤 무소유, 시작 영토는 유지');

// 6. 수도 확장 — 영토 64청크(8×8)로 만든 상태에서
{
  const w2 = new World(0);
  const m2 = macro();
  const owned: string[] = [];
  for (let cy = by - 2; cy < by + 6; cy++)
    for (let cx = bx - 2; cx < bx + 6; cx++) owned.push(chunkKey(cx, cy));
  m2.territory = { owned, capitalLevel: 1, capital: chunkKey(bx + 1, by + 1) };
  const t2 = new TerritorySystem(w2, m2);
  assert.equal(t2.count, 64);
  assert.ok(t2.expandCapital(3).includes('도시 레벨 4'), '도시 4레벨 전에는 못 넓힌다');
  assert.equal(t2.expandCapital(4), '');
  const cap = t2.capitalRect();
  assert.equal(cap.span, 4);
  assert.ok(cap.cx <= bx + 1 && cap.cy <= by + 1 && cap.cx + 4 >= bx + 3 && cap.cy + 4 >= by + 3);
  assert.ok(t2.expandCapital(9).includes('25%'), '6×6 은 영토 144청크가 필요');

  // 7. 수도 이전: 시작 영토 안 다른 자리(연결 규칙 예외)로.
  const m3 = macro();
  const t3 = new TerritorySystem(new World(0), m3);
  const target = t3.moveTarget(bx, by);
  assert.deepEqual(target, { cx: bx, cy: by, span: 2 });
  let clock = 5_000_000;
  assert.equal(t3.startMove(target, clock), '');
  assert.ok(t3.startMove(target, clock).includes('이미'));
  t3.update(clock + CAPITAL_MOVE_MS - 1000, true);
  assert.deepEqual(t3.capitalRect(), { cx: bx + 1, cy: by + 1, span: 2 }, '5분 전에는 그대로');
  t3.update(clock + CAPITAL_MOVE_MS + 1000, true);
  assert.deepEqual(t3.capitalRect(), target, '5분 뒤 새 수도');
  clock += CAPITAL_MOVE_MS + 2000;
  assert.ok(t3.moveBlock(t3.moveTarget(bx + 2, by + 2), clock).includes('하루'));
  assert.equal(t3.moveBlock(t3.moveTarget(bx + 2, by + 2), clock + CAPITAL_MOVE_COOLDOWN_MS), '');
  assert.ok(t3.moveBlock(t3.moveTarget(bx + 6, by + 6), clock + CAPITAL_MOVE_COOLDOWN_MS));
}
console.log('  OK   수도 확장(레벨·25%·둘러싼 땅), 이전(5분·하루 한 번)');

// 8. 매크로 시뮬과 저장 왕복
{
  const m4 = macro();
  const w4 = new World(0);
  const s4 = new MacroSim(w4, m4);
  assert.equal(s4.cityLevel, 1);
  m4.prosperity = 6000;
  assert.equal(s4.cityLevel, 1, '시작 영토 16청크로는 2레벨이 안 된다');
  const saved = JSON.parse(JSON.stringify(m4)) as MacroState;
  saved.territory!.owned.push(chunkKey(bx - 1, by), chunkKey(bx - 1, by + 1));
  saved.territory!.owned.push(chunkKey(bx - 1, by + 2), chunkKey(bx - 1, by + 3));
  const again = new MacroSim(new World(0), saved);
  assert.equal(again.territory.count, 20);
  assert.equal(again.cityLevel, 2);
}
// 9. 점령타워: 맞닿은 무소유 청크만, 실제 1시간 뒤 영토, 타워가 헐리면 취소
{
  const w5 = new World(0);
  const s5 = new MacroSim(w5, macro());
  const t5 = s5.territory;
  const east = chunkKey(bx + 4, by + 1);
  assert.equal(t5.towerRule(bx + 4, by + 1), '');
  assert.ok(t5.towerRule(bx + 1, by + 1).includes('이미'));
  assert.ok(t5.towerRule(bx + 6, by + 1).includes('맞닿은'));
  t5.foreign = new Set([chunkKey(bx - 1, by)]);
  assert.ok(t5.towerRule(bx - 1, by).includes('다른 도시'));
  const at = 9_000_000;
  t5.updateTowers(new Set([east]), at);
  assert.equal(t5.towerProgress(at)[0].leftMs, OCC_TOWER_MS);
  t5.updateTowers(new Set([east]), at + OCC_TOWER_MS - 1);
  assert.ok(!t5.isOwned(bx + 4, by + 1), '1시간 전에는 아직');
  t5.updateTowers(new Set([east]), at + OCC_TOWER_MS);
  assert.ok(t5.isOwned(bx + 4, by + 1), '1시간 뒤 내 땅');
  t5.update(at + OCC_TOWER_MS + 60 * 60_000, true);
  assert.ok(t5.isOwned(bx + 4, by + 1), '사람이 없고 도로가 없어도 유지');
  const far = chunkKey(bx + 5, by + 1);
  t5.updateTowers(new Set([far]), at);
  t5.updateTowers(new Set(), at + 1000);
  t5.updateTowers(new Set([far]), at + OCC_TOWER_MS);
  assert.ok(!t5.isOwned(bx + 5, by + 1), '헐었다 다시 지으면 처음부터');
  const p5 = FACILITY_SPECS[FAC_OCC_TOWER];
  assert.equal(p5.unlockLevel, 2);
  assert.equal(p5.cost, 20_000);
  assert.equal(p5.needsRoad, false);
}
console.log('  OK   점령타워(맞닿은 무소유 청크, 1시간, 철거 시 취소)');
console.log(
  'Territory passed: 9 levels, start land, build rules, auto occupation, cut, capital, tower.',
);
