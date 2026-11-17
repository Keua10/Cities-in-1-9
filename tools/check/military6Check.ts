import assert from 'node:assert/strict';
import { chunkKey } from '../../src/core/iso';
import {
  AIR_RANGE_CHUNKS,
  BOMB_INTERVAL_MS,
  EMBARKED_MOVE,
  FAC_MISSILE_DEFENSE,
  FAC_MUNITIONS,
  FAC_TANK_FACTORY,
  MACHINE_STRENGTH,
  MISSILE_DEFENSE_INTERCEPT,
  SHORE_BOMBARD,
  UNIT_SPECS,
  type UnitType,
} from '../../src/sim/config/military';
import {
  emptyArmy,
  findPath,
  hitFactor,
  newUnit,
  passFactor,
  stepArmy,
  strikeRoll,
  type ArmyState,
  type Battlefield,
  type Side,
  type Unit,
} from '../../src/sim/military/army';
import { ArmySystem } from '../../src/sim/military/armySystem';
import { chunkTerrain, terrainOptions } from '../../src/sim/military/terrain';
import { World } from '../../src/world/world';
import { MacroSim } from '../../src/sim/macro';
import type { FacilityRecord } from '../../src/sim/services';
import { FACILITY_SPECS } from '../../src/sim/facilities';
import { CONTINENT_H, CONTINENT_W, CONTINENT_X0, CONTINENT_Y0 } from '../../src/world/continent';

// 넓은 평지가 필요한 점검이라 숲 판정을 끈다(숲은 warCheck 에서 따로 본다).
terrainOptions.forest = false;

/**
 * 군사 6단계 — 기갑·대공·공군·해군·미사일 점검(순수 계산 + ArmySystem).
 */

function find(test: (cx: number, cy: number) => boolean): { cx: number; cy: number } {
  for (let cy = CONTINENT_Y0 + 10; cy < CONTINENT_Y0 + CONTINENT_H - 10; cy += 2)
    for (let cx = CONTINENT_X0 + 10; cx < CONTINENT_X0 + CONTINENT_W - 30; cx += 2)
      if (test(cx, cy)) return { cx, cy };
  throw new Error('지형 없음');
}
const plainAt = (cx: number, cy: number, w: number, h: number) => {
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++) if (chunkTerrain(cx + x, cy + y).kind !== 'plain') return false;
  return true;
};
const base = find((cx, cy) => plainAt(cx, cy - 1, 26, 3));
const side = (uid: string, units: Unit[], owned: string[], extra: Partial<Side> = {}): Side => ({
  uid,
  units,
  owned: new Set(owned),
  capital: new Set(),
  trenches: new Set(),
  urban: new Set(),
  ...extra,
});
const keys = (x0: number, x1: number) => {
  const out: string[] = [];
  for (let x = x0; x <= x1; x++)
    for (let y = -1; y <= 1; y++) out.push(chunkKey(base.cx + x, base.cy + y));
  return out;
};
const mk = (army: ArmyState, type: UnitType, x: number, y = 0): Unit => {
  const u = newUnit(army, type, { cx: base.cx + x, cy: base.cy + y }, {}, 0);
  u.state = 'idle';
  return u;
};
const bf = (me: Side, enemy: Side | null, now = 0): Battlefield => ({
  now,
  me,
  enemy,
  occupied: new Map(),
  capitalProtected: true,
  foreign: () => false,
});

// 0. 경험치(피해 배율 0.5~1.8)·탄약(없으면 공격 절반) — 피드백 1차
{
  const { expMul, expRank } = await import('../../src/sim/config/military');
  assert.equal(expMul(0), 1);
  assert.equal(expMul(100), 1.8);
  assert.equal(expMul(-50), 0.5);
  assert.equal(expRank(-10), '하급');
  const hit = (exp: number, noAmmo = false) => {
    const a = emptyArmy();
    const b = emptyArmy();
    const me = mk(a, 'infantry', 2);
    const foe = mk(b, 'infantry', 2);
    foe.exp = exp;
    if (noAmmo) foe.noAmmo = true;
    const before = me.men;
    stepArmy(a, bf(side('a', a.units, keys(0, 6)), side('b', b.units, keys(7, 9)), 1000), 1000);
    return before - me.men;
  };
  const d0 = hit(0);
  assert.ok(Math.abs(hit(100) / d0 - 1.8) < 1e-6, '정예 1.8배');
  assert.ok(Math.abs(hit(-50) / d0 - 0.5) < 1e-6, '하급 0.5배');
  assert.ok(Math.abs(hit(0, true) / d0 - 0.5) < 1e-6, '탄약 없으면 절반');
  // 싸우면 경험이 쌓인다.
  const a = emptyArmy();
  const b = emptyArmy();
  const me = mk(a, 'infantry', 2);
  mk(b, 'infantry', 2);
  for (let t = 1; t <= 20; t++)
    stepArmy(a, bf(side('a', a.units, keys(0, 6)), side('b', b.units, keys(7, 9)), t * 1000), 1000);
  assert.ok(me.exp > 1.5 && me.exp < 2.5, `20초 전투 경험 ${me.exp}`);
  console.log('  OK   경험치 배율 0.5~1.8(보통 1)·전투로 상승·탄약 없으면 공격 절반');
}

// 0-2. 부대 합치기·나누기
{
  const { mergeUnits, splitUnit } = await import('../../src/sim/military/army');
  const a = emptyArmy();
  const x = mk(a, 'infantry', 2);
  const y = mk(a, 'infantry', 2);
  x.source = { k1: 500 };
  y.source = { k2: 500 };
  x.exp = 40;
  y.men = 250;
  y.exp = 10;
  assert.ok(mergeUnits(a, [x.id, mk(a, 'artillery', 2).id]).includes('같은 병종'));
  assert.equal(mergeUnits(a, [x.id, y.id]), '');
  assert.equal(x.men, 750);
  assert.equal(x.maxMen, 1000);
  assert.ok(Math.abs(x.exp - 30) < 1e-6, `인원 비율로 섞인 경험 ${x.exp}`);
  assert.deepEqual(x.source, { k1: 500, k2: 500 });
  assert.ok(!a.units.includes(y));
  const z = splitUnit(a, x.id);
  assert.ok(typeof z !== 'string');
  assert.equal(x.men + (z as typeof x).men, 750);
  assert.equal((z as typeof x).exp, x.exp);
  assert.equal((z as typeof x).source.k1 + x.source.k1, 500);
  console.log('  OK   부대 합치기(같은 병종·같은 청크, 경험·조직력 인원 비율)·나누기(반씩)');
}

// 0-3. 영해(영토에서 2청크 바다)·영공·통과 규율·무단 통과 공격
{
  const W = await import('../../src/sim/military/waters');
  // 해안 땅 청크 찾기: 동쪽 1칸이 바다, 동쪽 3칸도 바다.
  const coast = find(
    (cx, cy) =>
      chunkTerrain(cx, cy).kind !== 'sea' &&
      chunkTerrain(cx + 1, cy).kind === 'sea' &&
      chunkTerrain(cx + 2, cy).kind === 'sea' &&
      chunkTerrain(cx + 3, cy).kind === 'sea',
  );
  const land = [chunkKey(coast.cx, coast.cy)];
  const sea = W.territorialSea(land);
  assert.ok(sea.has(chunkKey(coast.cx + 2, coast.cy)), '2청크 바다 = 영해');
  assert.ok(!sea.has(chunkKey(coast.cx + 3, coast.cy)), '3청크 = 공해');
  const air = W.airspace(land, sea);
  assert.ok(air.has(land[0]) && air.has(chunkKey(coast.cx + 1, coast.cy)), '영공 = 영토 + 영해');
  const now = 1_000_000;
  const p = (state: 'notified' | 'asked' | 'granted', until = now + 1000) =>
    ({ from: 'x', to: 'y', state, at: now, until }) as const;
  assert.ok(W.passValid('open', undefined, now));
  assert.ok(!W.passValid('notify', undefined, now));
  assert.ok(W.passValid('notify', p('notified'), now));
  assert.ok(!W.passValid('notify', p('notified', now - 1), now), '신고 기한 지남');
  assert.ok(!W.passValid('permit', p('notified'), now), '허가 규율은 신고로 안 됨');
  assert.ok(!W.passValid('permit', p('asked'), now));
  assert.ok(W.passValid('permit', p('granted'), now));
  const space = { sea, air };
  const ship = { type: 'ship' as const, cx: coast.cx + 2, cy: coast.cy };
  assert.ok(W.trespassing(ship, space, 'permit', undefined, now), '허가 없는 군함 = 무단');
  assert.ok(!W.trespassing(ship, space, 'permit', p('granted'), now));
  assert.ok(!W.trespassing({ ...ship, cx: coast.cx + 3 }, space, 'permit', undefined, now), '공해');
  assert.ok(
    !W.trespassing(
      { type: 'infantry', cx: coast.cx, cy: coast.cy },
      space,
      'permit',
      undefined,
      now,
    ),
    '땅 부대는 영공 규율 대상 아님',
  );
  // 맞는 쪽: 무단 통과한 군함만 다친다.
  const origin = { cx: base.cx, cy: base.cy - 1 };
  const world = new World(origin);
  const sim = new MacroSim(world, { money: 0, population: 0, tick: 0, tickedAt: 0 } as never);
  const sys = new ArmySystem(
    sim.state,
    sim.territory,
    sim.resources,
    () => [],
    () => 9,
    () => {},
  );
  const boat = newUnit(sys.army, 'ship', { cx: coast.cx + 2, cy: coast.cy }, {}, 0);
  boat.state = 'idle';
  const before = boat.men;
  assert.equal(
    sys.takeIncident(chunkKey(boat.cx, boat.cy), 30, space, true),
    0,
    '통과 허가면 무사',
  );
  assert.ok(sys.takeIncident(chunkKey(boat.cx, boat.cy), 30, space, false) > 0);
  assert.ok(boat.men < before, '무단 통과 군함 피해');
  // 평시 군용기는 남의 영공(땅 위)을 지날 수 있고, 땅 부대는 못 간다.
  const a = emptyArmy();
  const f = mk(a, 'fighter', 2);
  const foreign = new Set(keys(4, 6));
  const peace: Battlefield = {
    ...bf(side('a', a.units, keys(0, 3)), null),
    foreign: (k) => foreign.has(k),
  };
  assert.ok(
    findPath(f, { cx: base.cx + 5, cy: base.cy }, 'fighter', peace).length > 0,
    '군용기 남의 영공 통과',
  );
  assert.equal(
    findPath(f, { cx: base.cx + 5, cy: base.cy }, 'infantry', peace).length,
    0,
    '땅 부대는 불가',
  );
  console.log(
    '  OK   영해 2청크·영공·통과 규율(자유·신고·허가)·무단 통과 부대만 공격, 군용기 남의 영공 통과',
  );
}

// 0-4. 공병 다리: 하천 청크에 1분 멈추면 나무 50으로 다리 → 내 부대는 평지처럼 건넌다.
{
  const river = find((cx, cy) => chunkTerrain(cx, cy).kind === 'river');
  const origin = { cx: base.cx, cy: base.cy - 1 };
  const world = new World(origin);
  const sim = new MacroSim(world, { money: 0, population: 0, tick: 0, tickedAt: 0 } as never);
  const sys = new ArmySystem(
    sim.state,
    sim.territory,
    sim.resources,
    () => [],
    () => 9,
    () => {},
  );
  sim.resources.addStock('wood', 60);
  const e = newUnit(sys.army, 'engineer', { cx: river.cx, cy: river.cy }, {}, 0);
  e.state = 'idle';
  const key = chunkKey(river.cx, river.cy);
  const slow = passFactor(bf(sys.mySide(), null), 'infantry', key, river.cx, river.cy);
  for (let t = 1; t <= 70; t++) sys.update(1_000_000 + t * 1000);
  assert.ok(sys.army.bridges?.includes(key), '다리 놓음');
  assert.ok(sim.resources.stockNow.wood < 20, '나무 50 사용');
  const fast = passFactor(bf(sys.mySide(), null), 'infantry', key, river.cx, river.cy);
  assert.ok(slow < 1 && fast === 1, `다리 위 이동 ${slow} → ${fast}`);
  console.log('  OK   공병 다리(하천 1분, 나무 50) → 평지처럼 건넘');
}

// 1. 기계 부대 전력, 땅·하늘·바다 이동
{
  const a = emptyArmy();
  const tank = mk(a, 'armor', 0);
  assert.equal(tank.men, MACHINE_STRENGTH, '기계 부대 전력 100');
  assert.ok(
    Object.values(UNIT_SPECS).every((s) => s.available),
    '6단계: 9종 모두',
  );
  const sea = find((cx, cy) => chunkTerrain(cx, cy).kind === 'sea');
  const me = side('a', a.units, keys(0, 3));
  const b0 = bf(me, null);
  const sk = chunkKey(sea.cx, sea.cy);
  assert.equal(passFactor(b0, 'fighter', sk, sea.cx, sea.cy), 1, '공군은 바다 위도');
  assert.equal(passFactor(b0, 'ship', sk, sea.cx, sea.cy), 1, '군함은 바다');
  assert.equal(
    passFactor(b0, 'ship', chunkKey(base.cx, base.cy), base.cx, base.cy),
    0,
    '군함은 땅 불가',
  );
  assert.equal(passFactor(b0, 'infantry', sk, sea.cx, sea.cy), 0, '해군 기지 없으면 바다 불가');
  const sail = bf(side('a', a.units, keys(0, 3), { canSail: true }), null);
  assert.equal(
    passFactor(sail, 'infantry', sk, sea.cx, sea.cy),
    EMBARKED_MOVE,
    '해군 기지: 배로 건넘',
  );
  assert.equal(passFactor(sail, 'infantry', sk, sea.cx, sea.cy, true), 0, '바다로 후퇴는 안 함');
  assert.equal(passFactor(b0, 'missile', sk, sea.cx, sea.cy), 0);
  // 공군 사거리: 내 땅에서 12청크
  const f = mk(a, 'fighter', 1);
  assert.ok(findPath(f, { cx: base.cx + 3 + AIR_RANGE_CHUNKS, cy: base.cy }, 'fighter', b0).length);
  assert.equal(
    findPath(f, { cx: base.cx + 4 + AIR_RANGE_CHUNKS, cy: base.cy }, 'fighter', b0).length,
    0,
    '12청크 넘으면 못 감',
  );
}
console.log('  OK   기계 전력·공군 어디든(12청크)·군함 바다·해군 기지면 땅 부대가 배로');

// 2. 누가 누구를 치나
{
  const a = emptyArmy();
  const at = (t: UnitType) => mk(a, t, 0);
  assert.equal(hitFactor(at('infantry'), 'air', 0), 0, '보병은 공군을 못 침');
  assert.equal(hitFactor(at('aa'), 'air', 1), 1, '대공은 이웃 청크 공군도');
  assert.equal(hitFactor(at('fighter'), 'air', 0), 1);
  assert.ok(hitFactor(at('fighter'), 'ground', 0) < 1);
  assert.equal(hitFactor(at('bomber'), 'air', 0), 0, '폭격기는 공중전 불가');
  assert.equal(hitFactor(at('ship'), 'ground', 1), SHORE_BOMBARD, '함포');
  assert.equal(hitFactor(at('ship'), 'ground', 0), 0);
  assert.equal(hitFactor(at('artillery'), 'ground', 1), 1);
  assert.equal(hitFactor(at('missile'), 'ground', 0), 0);
}
console.log('  OK   상성 표(대공↔공군, 전투기, 폭격기, 함포, 포병)');

// 3. 공중전·대공·지상 통과
{
  const mine = emptyArmy();
  const theirs = emptyArmy();
  const fighter = mk(mine, 'fighter', 6);
  const inf = mk(mine, 'infantry', 5);
  inf.path = [chunkKey(base.cx + 6, base.cy), chunkKey(base.cx + 7, base.cy)];
  inf.state = 'moving';
  mk(theirs, 'aa', 7); // 이웃 청크에서 내 전투기를 쏜다
  mk(theirs, 'fighter', 6);
  const me = side('a', mine.units, keys(0, 4));
  const en = side('b', theirs.units, keys(8, 14));
  const org0 = fighter.org;
  for (let t = 1; t <= 150; t++) stepArmy(mine, bf(me, en, t * 1000), 1000);
  assert.ok(fighter.org < org0, '내 전투기가 대공·전투기에 맞음');
  assert.notEqual(fighter.state, 'fighting', '공군은 붙잡히지 않음');
  assert.equal(inf.cx, base.cx + 7, '보병은 적 전투기가 있는 청크를 지나간다');
  assert.ok(['fighting', 'retreating'].includes(inf.state), '땅에 있는 적 대공과는 교전');
}
console.log('  OK   공중전·대공 사격, 공군은 길이 막히지 않음');

// 4. 폭격: 적 땅 위 1분마다 타격 기록
{
  const mine = emptyArmy();
  const bomber = mk(mine, 'bomber', 10);
  const me = side('a', mine.units, keys(0, 4));
  const en = side('b', [], keys(8, 14));
  for (let t = 1; t <= 125; t++) stepArmy(mine, bf(me, en, t * 1000), 1000);
  assert.equal(mine.strikes?.length, 2, `2분이면 폭탄 두 번 (${mine.strikes?.length})`);
  assert.equal(mine.strikes![0].kind, 'bomb');
  assert.equal(mine.strikes![0].key, chunkKey(bomber.cx, bomber.cy));
}
console.log('  OK   폭격기: 적 땅 위 1분마다 타격');

// 5. ArmySystem: 공장별 생산, 군수 공장, 미사일 발사·요격·시설 파괴
{
  const origin = { cx: base.cx, cy: base.cy - 1 };
  const world = new World(origin);
  const sim = new MacroSim(world, {
    money: 1_000_000,
    population: 0,
    tick: 0,
    tickedAt: 0,
  } as never);
  let facilities: FacilityRecord[] = [];
  const destroyed: number[] = [];
  const sys = new ArmySystem(
    sim.state,
    sim.territory,
    sim.resources,
    () => facilities,
    () => 9,
    () => {},
  );
  sys.destroyFacility = (f) => {
    destroyed.push(f.kind);
    facilities = facilities.filter((x) => x !== f);
    return true;
  };
  const fac = (kind: number, cx: number, cy: number): FacilityRecord => ({
    index: facilities.length,
    kind,
    tx: cx * 32 + 4,
    ty: cy * 32 + 4,
    span: FACILITY_SPECS[kind].span,
    hasRoad: true,
  });
  sim.resources.addStock('iron', 1000);
  sim.resources.addStock('oil', 1000);
  assert.ok(sys.recruitBlock('armor').includes('전차 공장'));
  facilities.push(fac(FAC_TANK_FACTORY, base.cx + 1, base.cy));
  assert.equal(sys.recruit('armor', 0), '');
  const t1 = sys.units.at(-1)!;
  assert.equal(t1.readyAt, UNIT_SPECS.armor.buildSec * 1000);
  facilities.push(fac(FAC_MUNITIONS, base.cx + 2, base.cy));
  assert.equal(sys.recruit('armor', 0), '');
  assert.equal(sys.units.at(-1)!.readyAt, UNIT_SPECS.armor.buildSec * 1000 * 0.7, '군수 공장 −30%');
  assert.ok(sys.recruitBlock('missile').includes('미사일 기지'));

  // 미사일 받기: 방어 시설 있으면 60% 요격(결정론)
  const target = { cx: base.cx + 2, cy: base.cy };
  const tk = chunkKey(target.cx, target.cy);
  facilities.push(fac(FAC_MISSILE_DEFENSE, base.cx + 1, base.cy + 1));
  let hitId = '';
  let blockId = '';
  for (let i = 0; i < 50 && (!hitId || !blockId); i++) {
    const id = `m${i}`;
    if (strikeRoll(id) < MISSILE_DEFENSE_INTERCEPT) blockId ||= id;
    else hitId ||= id;
  }
  const loss0 = sys.army.lossValue ?? 0;
  sys.war = {
    enemy: side('b', [], []),
    occupied: new Map(),
    capitalProtected: true,
    paused: false,
    enemyStrikes: [
      { id: blockId, kind: 'missile', key: tk, at: 1000, power: 80 },
      { id: hitId, kind: 'missile', key: tk, at: 1000, power: 80 },
    ],
  };
  sys.update(1500); // 첫 호출은 시계만 맞춘다
  const ev = sys.update(2000).filter((e) => e.type === 'struck');
  assert.equal(ev.length, 2);
  assert.ok(ev[0].type === 'struck' && ev[0].intercepted, '요격');
  assert.ok(ev[1].type === 'struck' && !ev[1].intercepted && ev[1].destroyed.includes('군수 공장'));
  assert.deepEqual(destroyed, [FAC_MUNITIONS]);
  assert.equal((sys.army.lossValue ?? 0) - loss0 >= FACILITY_SPECS[FAC_MUNITIONS].cost, true);
  assert.equal(
    sys.update(5000).filter((e) => e.type === 'struck').length,
    0,
    '같은 타격은 한 번만',
  );

  // 미사일 쏘기
  const silo = newUnit(sys.army, 'missile', { cx: base.cx, cy: base.cy }, {}, 0);
  silo.state = 'idle';
  sys.war.enemy = side('b', [], keys(8, 14));
  assert.ok(sys.launch(silo.id, base.cx + 3, base.cy).includes('적 땅'));
  assert.equal(sys.launch(silo.id, base.cx + 9, base.cy, 9000), '');
  assert.ok(!sys.units.includes(silo), '쏜 미사일은 사라짐');
  assert.equal(sys.army.strikes?.at(-1)?.kind, 'missile');
}
console.log('  OK   공장별 생산·군수 공장 −30%·미사일 발사·요격 60%·시설 파괴(점수)');

// 6. 민간 시설 역할·전시 경제
{
  const mine = emptyArmy();
  const a1 = mk(mine, 'infantry', 1);
  const a2 = mk(mine, 'infantry', 2);
  a1.org = 10;
  a2.org = 10;
  const me = side('a', mine.units, keys(0, 4), {
    hospitals: new Set([chunkKey(base.cx + 1, base.cy)]),
  });
  for (let t = 1; t <= 10; t++) stepArmy(mine, bf(me, null, t * 1000), 1000);
  assert.ok(Math.abs(a1.org - 20) < 0.01 && Math.abs(a2.org - 15) < 0.01, '병원 둘레 회복 2배');

  const world = new World({ cx: base.cx, cy: base.cy });
  const sim = new MacroSim(world, { money: 0, population: 0, tick: 0, tickedAt: 0 } as never);
  const now = 50_000_000;
  assert.equal(sim.warMood(now), 0);
  sim.atWar = true;
  sim.state.warSince = now - 2 * 3_600_000;
  assert.ok(Math.abs(sim.warMood(now) + 0.04) < 1e-9, '전쟁 2시간: 만족도 −4%');
  sim.state.warSince = now - 100 * 3_600_000;
  assert.equal(sim.warMood(now), -0.15, '전쟁 피로 최대 15%');
  assert.equal(sim.rebuildMul(now), 1, '전쟁 중엔 복구 가속 없음');
  sim.atWar = false;
  sim.state.warEndedAt = now - 3_600_000;
  sim.state.warOutcome = 'lose';
  assert.equal(sim.rebuildMul(now), 3, '패전국 6시간 공사 ×3');
  sim.state.warOutcome = 'win';
  assert.equal(sim.rebuildMul(now), 2);
  assert.equal(sim.warMood(now), 0.05, '승전 기분');
  assert.equal(sim.rebuildMul(now + 6 * 3_600_000), 1, '6시간 뒤 끝');
  sim.atWar = true;
  sim.update(1, 0);
  assert.equal(sim.food.importPriceMul, 1.5, '전쟁 중 식량 수입 1.5배');
}
console.log('  OK   병원 회복 2배·전쟁 피로·승전 기분·전후 복구(×2·×3)·식량 수입 1.5배');

// 7. 밤·날씨(공유 시계로 결정), 공중 수송, 식량 봉쇄
{
  const W = await import('../../src/sim/military/weather');
  const DAY = 600_000;
  assert.ok(W.isNight(0) && !W.isNight(DAY / 2), '0시 밤, 12시 낮');
  assert.equal(W.visionAt(DAY / 2, 2), 2);
  assert.equal(W.visionAt(0, 2), 1, '밤 시야 절반');
  const counts: Record<string, number> = { clear: 0, rain: 0, snow: 0, wind: 0 };
  for (let p = 0; p < 400; p++) counts[W.weatherAt(p * W.WEATHER_PERIOD_MS, base.cx, base.cy)]++;
  assert.ok(counts.clear > 180 && counts.clear < 320, `맑음 비율 ${JSON.stringify(counts)}`);
  assert.equal(
    W.weatherAt(123_456_789, base.cx, base.cy),
    W.weatherAt(123_456_789 + 1000, base.cx + 1, base.cy + 1),
    '같은 지역·같은 20분이면 같은 날씨(두 기기 동일)',
  );
  // 비 오는 시각을 찾아 이동이 느린지
  let wet = -1;
  for (let p = 0; p < 400 && wet < 0; p++) {
    const w = W.weatherAt(p * W.WEATHER_PERIOD_MS, base.cx + 3, base.cy);
    if (w === 'rain' || w === 'snow') wet = p * W.WEATHER_PERIOD_MS;
  }
  let dry = -1;
  for (let p = 0; p < 400 && dry < 0; p++)
    if (W.weatherAt(p * W.WEATHER_PERIOD_MS, base.cx + 3, base.cy) === 'clear')
      dry = p * W.WEATHER_PERIOD_MS;
  const walk = (t0: number) => {
    const a = emptyArmy();
    const u = mk(a, 'infantry', 2);
    u.path = [chunkKey(base.cx + 3, base.cy)];
    u.state = 'moving';
    stepArmy(a, bf(side('a', a.units, keys(0, 6)), null, t0 + 1000), 1000);
    return u.progress;
  };
  assert.ok(Math.abs(walk(wet) / walk(dry) - W.WET_MOVE) < 1e-6, '비·눈 이동 −20%');
  // 계절은 대륙 공통: 겨울에는 비 대신 눈, 여름에는 눈이 없다.
  const DAYMS = 60_000;
  const winter = (270 + 10) * DAYMS;
  const summer = (90 + 10) * DAYMS;
  assert.equal(W.worldSeason(winter), 3);
  assert.equal(W.worldSeason(summer), 1);
  let snowSummer = 0;
  let rainWinter = 0;
  for (let p = 0; p < 200; p++) {
    if (W.weatherAt(summer + (p % 4) * W.WEATHER_PERIOD_MS, base.cx + p, base.cy) === 'snow')
      snowSummer++;
    if (W.weatherAt(winter + (p % 4) * W.WEATHER_PERIOD_MS, base.cx + p, base.cy) === 'rain')
      rainWinter++;
  }
  assert.equal(snowSummer + rainWinter, 0, '여름 눈·겨울 비 없음');
  assert.ok(
    W.temperatureAt(summer + 30 * DAYMS, base.cy) > W.temperatureAt(winter + 30 * DAYMS, base.cy),
  );
  // 도시 화면 날씨 = 전쟁 날씨(같은 시각·같은 자리).
  const origin = { cx: base.cx + 3, cy: base.cy };
  const world = new World(origin);
  const sim = new MacroSim(world, { money: 0, population: 0, tick: 0, tickedAt: 0 } as never);
  const realNow = Date.now;
  for (const t of [wet, dry]) {
    Date.now = () => t;
    const kind = W.weatherAt(t, origin.cx, origin.cy);
    const p = sim.nature.weather.precipitation;
    assert.equal(
      p === 'clear' ? kind === 'clear' || kind === 'wind' : kind === 'rain' || kind === 'snow',
      true,
      `도시 날씨 ${p} = 전쟁 날씨 ${kind}`,
    );
  }
  Date.now = realNow;
}
{
  const origin = { cx: base.cx, cy: base.cy - 1 };
  const world = new World(origin);
  const sim = new MacroSim(world, { money: 10_000, population: 0, tick: 0, tickedAt: 0 } as never);
  let facilities: FacilityRecord[] = [];
  const sys = new ArmySystem(
    sim.state,
    sim.territory,
    sim.resources,
    () => facilities,
    () => 9,
    () => {},
  );
  const u = newUnit(sys.army, 'infantry', { cx: base.cx + 1, cy: base.cy }, {}, 0);
  u.state = 'idle';
  const [ox, oy] = [...sim.territory.ownedKeys()].at(-1)!.split(',').map(Number);
  assert.ok(sys.airliftBlock(u.id, ox, oy).includes('공항'), '공항이 있어야');
  facilities = [
    {
      index: 0,
      kind: 18,
      tx: (base.cx + 1) * 32 + 4,
      ty: base.cy * 32 + 4,
      span: 2,
      hasRoad: true,
    },
  ];
  assert.ok(sys.airliftBlock(u.id, base.cx + 30, base.cy).includes('내 땅'), '내 땅에만');
  const money0 = sim.state.money;
  assert.equal(sys.airlift(u.id, ox, oy, 1000), '');
  assert.equal(sim.state.money, money0 - 200, '수송비');
  assert.ok(u.airlift && u.state === 'moving');
  assert.ok(sys.order(u.id, ox, oy).includes('날아가는'), '날아가는 동안 명령 불가');
  const me = sys.battlefield(1000);
  stepArmy(sys.army, { ...me, now: 2000 }, 1000);
  assert.ok(u.airlift, '아직 비행 중');
  const ev = stepArmy(sys.army, { ...me, now: u.airlift!.arriveAt }, 1000);
  assert.ok(
    ev.some((e) => e.type === 'landed') && u.cx === ox && u.cy === oy && !u.airlift,
    '도착',
  );
}
{
  const origin = { cx: base.cx, cy: base.cy - 1 };
  const world = new World(origin);
  const sim = new MacroSim(world, { money: 10_000, population: 0, tick: 0, tickedAt: 0 } as never);
  const owned = [...sim.territory.ownedKeys()];
  const edge = owned[0];
  sim.atWar = true;
  sim.army.war = {
    enemy: side('b', [], []),
    occupied: new Map([[edge, '#enemy']]),
    capitalProtected: true,
    paused: false,
  };
  sim.update(1, 0);
  assert.ok(sim.blockaded, '국경 청크를 빼앗기면 봉쇄');
  assert.equal(sim.food.importLimit, 0.5);
  sim.food.summary.production = 0;
  sim.food.summary.consumption = 100;
  sim.food.applyStock(0);
  assert.equal(sim.food.summary.importPerDay, 50, '수입 절반');
  assert.equal(sim.food.summary.hunger, 0.5, '나머지는 굶주림');
  sim.army.war.occupied = new Map();
  sim.update(1, 0);
  assert.ok(!sim.blockaded && sim.food.importLimit === 1, '되찾으면 풀림');
}
console.log(
  '  OK   밤(시야 절반)·날씨(비·눈 이동 −20%, 공유 시계로 같음, 계절 공통, 도시 화면 = 전쟁 날씨)·공중 수송·식량 봉쇄(수입 절반·굶주림)',
);

void BOMB_INTERVAL_MS;
console.log('Military stage 6 passed: machines, air/sea domains, matchups, bombing, missiles.');
