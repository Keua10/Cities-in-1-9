import assert from 'node:assert/strict';
import { chunkKey } from '../../src/core/iso';
import { DRAFT_SHARE, UNIT_SPECS } from '../../src/sim/config/military';
import {
  draftMen,
  draftRoom,
  emptyArmy,
  findPath,
  newUnit,
  removeUnit,
  stepArmy,
  type ArmyState,
  type Battlefield,
  type Side,
  type Unit,
} from '../../src/sim/military/army';
import { chunkTerrain, terrainOptions } from '../../src/sim/military/terrain';
import { CONTINENT_H, CONTINENT_W, CONTINENT_X0, CONTINENT_Y0 } from '../../src/world/continent';

// 넓은 평지가 필요한 점검이라 숲 판정을 끈다(숲은 warCheck 에서 따로 본다).
terrainOptions.forest = false;

/**
 * 군사 4단계 — 부대·이동·전투·점령 점검(순수 계산).
 */

// 지형 찾기: 넓은 평지 한 줄
function findPlainRow(len: number): { cx: number; cy: number } {
  for (let cy = CONTINENT_Y0 + 10; cy < CONTINENT_Y0 + CONTINENT_H - 10; cy += 3)
    for (let cx = CONTINENT_X0 + 10; cx < CONTINENT_X0 + CONTINENT_W - len - 10; cx += 3) {
      let ok = true;
      for (let i = 0; i < len && ok; i++)
        for (let j = -1; j <= 1 && ok; j++)
          if (chunkTerrain(cx + i, cy + j).kind !== 'plain') ok = false;
      if (ok) return { cx, cy };
    }
  throw new Error('평지가 없음');
}
const base = findPlainRow(14);
const side = (uid: string, units: Unit[], owned: string[]): Side => ({
  uid,
  units,
  owned: new Set(owned),
  capital: new Set(),
  trenches: new Set(),
  urban: new Set(),
});
const rowKeys = (x0: number, x1: number) => {
  const out: string[] = [];
  for (let x = x0; x <= x1; x++)
    for (let y = -1; y <= 1; y++) out.push(chunkKey(base.cx + x, base.cy + y));
  return out;
};

// 1. 징병
{
  const army = emptyArmy();
  const residents = new Map([
    ['0,0', 1000],
    ['1,0', 2000],
    ['2,0', 100],
  ]);
  assert.equal(draftRoom(army, residents, DRAFT_SHARE), 200 + 400 + 20);
  const src = draftMen(army, residents, 500, DRAFT_SHARE)!;
  assert.deepEqual(src, { '1,0': 400, '0,0': 100 });
  assert.equal(draftMen(army, residents, 500, DRAFT_SHARE), null, '20%를 넘게 뽑을 수 없다');
  const u = newUnit(army, 'infantry', { cx: 0, cy: 0 }, src, 0);
  assert.equal(u.state, 'training');
  removeUnit(army, u.id, true);
  assert.deepEqual(army.drafted, {}, '해산하면 인원이 돌아간다');
}
console.log('  OK   징병: 청크 거주 20%까지, 해산하면 돌아감');

// 2. 길 찾기와 이동
const peaceBf = (army: ArmyState, now: number): Battlefield => ({
  now,
  me: side('A', army.units, rowKeys(0, 13)),
  enemy: null,
  occupied: new Map(),
  capitalProtected: true,
  foreign: () => false,
});
{
  const army = emptyArmy();
  const u = newUnit(army, 'infantry', base, {}, 0);
  const path = findPath(base, { cx: base.cx + 6, cy: base.cy }, 'infantry', peaceBf(army, 0));
  assert.equal(path.length, 6);
  stepArmy(army, peaceBf(army, 61_000), 1000);
  assert.equal(u.state, 'idle', '훈련 1분 뒤 출동 가능');
  u.path = path;
  u.state = 'moving';
  let t = 61_000;
  while (u.path.length && t < 400_000) {
    t += 1000;
    stepArmy(army, peaceBf(army, t), 1000);
  }
  const secs = (t - 61_000) / 1000;
  // 보병 3청크/분, 평지 → 6청크에 약 120초
  assert.ok(secs > 100 && secs < 140, `평지 6청크 이동 ${secs}초`);
  assert.equal(u.cx, base.cx + 6);
}
console.log('  OK   길 찾기·이동: 보병 평지 3청크/분');

// 3. 같은 보병끼리 전투
function duel(
  aType: 'infantry' | 'artillery',
  bType: 'infantry',
  opts: { trench?: boolean } = {},
): { secs: number; aLoss: number; bLoss: number; loser: string } {
  const A = emptyArmy();
  const B = emptyArmy();
  const at = { cx: base.cx + 7, cy: base.cy };
  const a = newUnit(A, aType, at, {}, -1e9);
  const b = newUnit(B, bType, at, {}, -1e9);
  a.state = 'idle';
  b.state = 'idle';
  const aOwned = rowKeys(0, 6);
  const bOwned = rowKeys(7, 13);
  const occA = new Map<string, string>();
  const sA = side('A', A.units, aOwned);
  const sB = side('B', B.units, bOwned);
  if (opts.trench) sB.trenches.add(chunkKey(at.cx, at.cy));
  let t = 0;
  while (t < 600_000) {
    t += 1000;
    const snapA = structuredClone(A.units);
    const snapB = structuredClone(B.units);
    stepArmy(
      A,
      {
        now: t,
        me: sA,
        enemy: { ...sB, units: snapB },
        occupied: occA,
        capitalProtected: true,
        foreign: () => false,
      },
      1000,
    );
    stepArmy(
      B,
      {
        now: t,
        me: sB,
        enemy: { ...sA, units: snapA },
        occupied: occA,
        capitalProtected: true,
        foreign: () => false,
      },
      1000,
    );
    sA.units = A.units;
    sB.units = B.units;
    const ar = A.units[0];
    const br = B.units[0];
    if (!ar || ar.state === 'retreating')
      return {
        secs: t / 1000,
        aLoss: 500 - (ar?.men ?? 0),
        bLoss: 500 - (br?.men ?? 0),
        loser: 'A',
      };
    if (!br || br.state === 'retreating')
      return { secs: t / 1000, aLoss: 500 - ar.men, bLoss: 500 - (br?.men ?? 0), loser: 'B' };
  }
  return { secs: 600, aLoss: 0, bLoss: 0, loser: '-' };
}
{
  const r = duel('infantry', 'infantry');
  assert.ok(r.secs > 40 && r.secs < 90, `보병끼리 약 1분 (${r.secs}초)`);
  assert.ok(r.aLoss > 20 && r.aLoss < 120, `사상자 10% 안팎 (${Math.round(r.aLoss)})`);
  const tr = duel('infantry', 'infantry', { trench: true });
  assert.equal(tr.loser, 'A', '참호에 든 쪽이 이긴다');
  console.log(
    `  OK   전투: 보병끼리 ${r.secs}초, 사상 ${Math.round(r.aLoss)}/${Math.round(r.bLoss)} · 참호 방어 승`,
  );
}

// 4. 점령: 적 부대 없는 적 청크에 60초
{
  const A = emptyArmy();
  const u = newUnit(A, 'infantry', { cx: base.cx + 9, cy: base.cy }, {}, -1e9);
  u.state = 'idle';
  const occ = new Map<string, string>();
  const sA = side('A', A.units, rowKeys(0, 6));
  const sB = side('B', [], rowKeys(7, 13));
  const key = chunkKey(base.cx + 9, base.cy);
  let got = false;
  for (let t = 1000; t <= 70_000; t += 1000) {
    const ev = stepArmy(
      A,
      { now: t, me: sA, enemy: sB, occupied: occ, capitalProtected: true, foreign: () => false },
      1000,
    );
    if (ev.some((e) => e.type === 'occupied' && e.key === key)) {
      got = true;
      assert.ok(t >= 60_000, '60초 뒤');
    }
  }
  assert.ok(got && occ.get(key) === 'A');
  // 수도는 소규모 전쟁에서 점령 못 함
  const u2 = newUnit(A, 'infantry', { cx: base.cx + 10, cy: base.cy }, {}, -1e9);
  u2.state = 'idle';
  sB.capital.add(chunkKey(base.cx + 10, base.cy));
  for (let t = 71_000; t <= 200_000; t += 1000)
    stepArmy(
      A,
      { now: t, me: sA, enemy: sB, occupied: occ, capitalProtected: true, foreign: () => false },
      1000,
    );
  assert.ok(!occ.has(chunkKey(base.cx + 10, base.cy)), '소규모 전쟁: 수도 보호');
}
console.log('  OK   점령 60초, 소규모 전쟁 수도 보호');

// 5. 포위 전멸: 후퇴할 내 땅이 없으면
{
  const r = (() => {
    const A = emptyArmy();
    const B = emptyArmy();
    const at = { cx: base.cx + 10, cy: base.cy };
    const a = newUnit(A, 'infantry', at, {}, -1e9);
    a.state = 'idle';
    a.org = 1;
    for (let i = 0; i < 3; i++) {
      const b = newUnit(B, 'infantry', at, {}, -1e9);
      b.state = 'idle';
    }
    const ev = stepArmy(
      A,
      {
        now: 1000,
        me: side('A', A.units, []),
        enemy: side('B', B.units, rowKeys(0, 13)),
        occupied: new Map(),
        capitalProtected: true,
        foreign: () => false,
      },
      1000,
    );
    return ev;
  })();
  assert.ok(
    r.some((e) => e.type === 'destroyed' && e.why === 'encircled'),
    '갈 곳 없으면 전멸',
  );
}
console.log('  OK   포위되면 전멸');
assert.ok(
  UNIT_SPECS.infantry.cost < UNIT_SPECS.artillery.cost && UNIT_SPECS.infantry.buildSec <= 60,
);
console.log('Military passed: draft, path, movement, combat, trench, occupation, encirclement.');
