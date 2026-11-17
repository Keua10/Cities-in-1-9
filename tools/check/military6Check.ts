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
import { chunkTerrain } from '../../src/sim/military/terrain';
import { World } from '../../src/world/world';
import { MacroSim } from '../../src/sim/macro';
import type { FacilityRecord } from '../../src/sim/services';
import { FACILITY_SPECS } from '../../src/sim/facilities';
import { CONTINENT_H, CONTINENT_W, CONTINENT_X0, CONTINENT_Y0 } from '../../src/world/continent';

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

void BOMB_INTERVAL_MS;
console.log('Military stage 6 passed: machines, air/sea domains, matchups, bombing, missiles.');
