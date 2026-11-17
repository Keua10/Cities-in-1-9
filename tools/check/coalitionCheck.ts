import assert from 'node:assert/strict';

/**
 * 군사 6단계 — 대규모 전쟁(연합) 한 판(가짜 Firestore, 한 프로세스에 세 도시).
 * A(수도 3) 가 B(수도 3) 에 대규모 전쟁 선포 → 동맹 C(수도 2) 가 A 진영으로 참가 →
 * B 는 C 땅을 못 친다 → A 가 B 수도 청크까지 점령 → B 항복: C 동의만으로는 부족(2/3),
 * A 동의로 승전 → B 배상을 A·C 가 기여도대로 나눔.
 */

let clock = 1_900_000_000_000;
Date.now = () => clock;
(globalThis as any).window = { setInterval: () => 0, setTimeout: () => 0, clearInterval() {} };
(globalThis as any).document = { visibilityState: 'visible', addEventListener() {} };

const { chunkKey } = await import('../../src/core/iso');
const { World } = await import('../../src/world/world');
const { MacroSim } = await import('../../src/sim/macro');
const { WarSession } = await import('../../src/net/warSession');
const { AllianceSession } = await import('../../src/net/alliances');
const { newUnit } = await import('../../src/sim/military/army');
const { chunkTerrain } = await import('../../src/sim/military/terrain');
const { CONTINENT_H, CONTINENT_W, CONTINENT_X0, CONTINENT_Y0 } = await import(
  '../../src/world/continent'
);
const { WAR_PREP_MS } = await import('../../src/sim/config/war');

function plain(): { cx: number; cy: number } {
  for (let cy = CONTINENT_Y0 + 10; cy < CONTINENT_Y0 + CONTINENT_H - 20; cy += 2)
    for (let cx = CONTINENT_X0 + 10; cx < CONTINENT_X0 + CONTINENT_W - 30; cx += 2) {
      let ok = true;
      for (let x = 0; x < 22 && ok; x++)
        for (let y = 0; y < 8 && ok; y++)
          if (chunkTerrain(cx + x, cy + y).kind !== 'plain') ok = false;
      if (ok) return { cx, cy };
    }
  throw new Error('평지 없음');
}
const p = plain();
const make = (uid: string, ox: number, oy: number, w: number, h: number, lv: number) => {
  const origin = { cx: p.cx + ox, cy: p.cy + oy };
  const world = new World(origin);
  const owned: string[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) owned.push(chunkKey(origin.cx + x, origin.cy + y));
  const capital = chunkKey(origin.cx, origin.cy);
  const sim = new MacroSim(world, {
    money: 100_000,
    population: 0,
    tick: 0,
    tickedAt: 0,
    territory: { owned, capitalLevel: lv, capital },
  } as never);
  sim.army.uid = uid;
  const profile = () => ({
    uid,
    cityIndex: uid.charCodeAt(0),
    cityName: `${uid}시`,
    origin: capital,
    owned,
    capital,
    capitalLevel: lv,
    cityLevel: 7,
    population: 1000,
    updatedAt: clock,
    online: true,
    lastSeen: clock,
  });
  const war = new WarSession(uid, sim, `${uid}시`);
  const ally = new AllianceSession(uid, sim, `${uid}시`);
  war.alliances = ally;
  ally.atWarWith = (u) => war.atWarWith(u);
  return { uid, sim, origin, owned, profile, war, ally };
};
// A: x 0~7 (수도 6×6), B: x 12~19 (수도 6×6), C: A 아래 줄 y 6~7 (수도 2레벨 4×4 는 넘지만 점검엔 상관없음)
const A = make('alice', 0, 0, 8, 6, 3);
const B = make('bob', 12, 0, 8, 6, 3);
const C = make('carol', 0, 6, 8, 2, 2);
const D = make('dave', 12, 6, 8, 2, 2);
const all = [A, B, C, D];
const notes: string[] = [];
for (const c of all) {
  c.war.onNotice = (t) => notes.push(`${c.uid}: ${t}`);
  c.ally.onNotice = (t) => notes.push(`${c.uid}: ${t}`);
  c.war.start();
  c.ally.start();
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
const tickAll = async (ms: number) => {
  for (let t = 0; t < ms; t += 500) {
    clock += 500;
    for (const c of all) c.sim.army.update(clock);
    for (const c of all) (c.war as any).tick();
    await new Promise((r) => setImmediate(r));
  }
};

// A 보병 3 (국경), B 보병 1 (B 수도 서쪽 끝 청크)
for (let i = 0; i < 3; i++)
  newUnit(
    A.sim.army.army,
    'infantry',
    { cx: A.origin.cx + 7, cy: A.origin.cy + 1 + i },
    {},
    0,
  ).state = 'idle';
newUnit(B.sim.army.army, 'infantry', { cx: B.origin.cx, cy: B.origin.cy + 1 }, {}, 0).state =
  'idle';

// 0. A·C 동맹
assert.equal(await C.ally.request(A.uid, 'alice시', 0), '');
await settle();
assert.equal(await A.ally.accept(A.ally.incoming()[0].id), '');
await settle();
assert.ok(C.ally.isAllied(A.uid));

// 1. 대규모 전쟁 선포, C 참가, D 는 동맹이 아니라 못 함
assert.ok(
  (await C.war.declare(B.profile() as any, C.profile() as any, 'large', false)).includes('3레벨'),
);
assert.equal(await A.war.declare(B.profile() as any, A.profile() as any, 'large', false), '');
await tickAll(1000);
const w0 = C.war.openLarge[0];
assert.ok(w0, 'C 에게 참가할 수 있는 대규모 전쟁이 보인다');
assert.ok(D.war.joinWhy(w0, 'b', D.profile() as any).includes('동맹'));
assert.ok(C.war.joinWhy(w0, 'b', C.profile() as any).includes('동맹'), 'C 는 B 진영에 못 낌');
assert.equal(await C.war.join(w0, 'a', C.profile() as any), '');
await tickAll(1000);
assert.equal(C.war.status().phase, 'prep');
assert.deepEqual(B.war.status().enemies.sort(), ['alice시', 'carol시']);
assert.ok(
  notes.some((n) => n.startsWith('bob:') && n.includes('참가')),
  'B 에게 참가 알림',
);
assert.ok(C.war.atWarWith(B.uid) && !C.war.atWarWith(A.uid));
await tickAll(WAR_PREP_MS);
assert.equal(A.war.status().phase, 'active');
console.log('  OK   대규모 전쟁 선포(수도 3레벨) → 동맹 C 가 A 진영으로 참가(동맹 아니면 불가)');

// 2. B(수도 3) 는 참가국 C(수도 2) 땅을 칠 수 없다. A 는 B 수도까지 점령할 수 있다.
{
  const bfB = B.sim.army.battlefield(clock);
  assert.ok(bfB.enemy!.owned.has(chunkKey(A.origin.cx + 7, A.origin.cy)), 'B 는 A 땅을 칠 수 있음');
  assert.ok(!bfB.enemy!.owned.has(chunkKey(C.origin.cx, C.origin.cy)), 'B 는 C 땅을 못 침');
  const bfA = A.sim.army.battlefield(clock);
  assert.ok(
    !bfA.enemy!.capital.has(chunkKey(B.origin.cx, B.origin.cy)),
    '대규모: B 수도도 점령 대상',
  );
  const bfC = C.sim.army.battlefield(clock);
  assert.ok(bfC.me.owned.has(chunkKey(A.origin.cx, A.origin.cy)), 'C 는 A 땅에서 보급받음');
}
const target = { cx: B.origin.cx, cy: B.origin.cy + 1 };
for (const u of A.sim.army.units) assert.equal(A.sim.army.order(u.id, target.cx, target.cy), '');
await tickAll(7 * 60_000);
const occ = [...(A.war as any).fronts.values()].flatMap((f: any) => Object.keys(f.claims));
assert.ok(occ.includes(chunkKey(target.cx, target.cy)), `A 가 B 수도 청크 점령 (${occ})`);
const st = C.war.status();
assert.ok(st.scoreMe > st.scoreEnemy, `C 가 보는 진영 점수 ${st.scoreMe} : ${st.scoreEnemy}`);
console.log(
  `  OK   참가국 땅 보호, 대규모 전쟁 수도 점령 (진영 점수 ${st.scoreMe} : ${st.scoreEnemy})`,
);

// 2.5 휴전 제안: 직접 참여국 둘 다 + 참가국 2/3. B 가 반대하면 무산.
{
  const { ceasefireAccepted } = await import('../../src/sim/military/warRules');
  const w = A.war.current()!;
  const base = { ...w, ceasefireOffer: { by: C.uid, at: 0, votes: {} as Record<string, boolean> } };
  const v = (votes: Record<string, boolean>) =>
    ceasefireAccepted({ ...base, ceasefireOffer: { ...base.ceasefireOffer, votes } });
  assert.ok(!v({ alice: true, carol: true }), 'B(직접 참여국) 없이 2/3 는 안 됨');
  assert.ok(v({ alice: true, bob: true }), '참가 3곳 중 A·B = 2/3');

  assert.equal(await C.war.offerCeasefire(), '');
  await tickAll(1000);
  assert.ok(notes.some((n) => n.startsWith('bob:') && n.includes('휴전을 제안')));
  assert.equal(B.war.status().ceasefire?.needed, 2);
  await A.war.voteCeasefire(true);
  await tickAll(1000);
  assert.equal(A.war.status().ceasefire?.yes, 2, 'C(제안)·A 찬성');
  assert.equal(A.war.status().phase, 'active', 'B 동의 전이라 계속');
  await B.war.voteCeasefire(false);
  await tickAll(1500);
  assert.equal(A.war.status().ceasefire, null, '직접 참여국 반대 → 무산');
  assert.ok(notes.some((n) => n.includes('무산')));
}
console.log('  OK   휴전 제안: 참가국 2/3 + 직접 참여국 둘 다, 반대하면 무산');

// 3. 항복: C 혼자 동의(1/2)로는 부족, A(대표) 동의로 승전
const mB = B.sim.money;
const mA = A.sim.money;
const mC = C.sim.money;
await C.war.offerSurrender(); // 대표가 아니면 아무 일도 없음
await tickAll(1000);
assert.ok(!B.war.status().surrenderOffered && !A.war.status().surrenderOffered);
await B.war.offerSurrender();
await tickAll(1000);
assert.ok(C.war.status().surrenderOffered);
await C.war.acceptSurrender();
await tickAll(1000);
assert.notEqual(A.war.status().phase, 'ended', 'C 혼자서는 2/3 가 안 됨');
await A.war.acceptSurrender();
await tickAll(3000);
assert.equal(A.war.status().phase, 'ended');
assert.equal(B.war.status().war?.result, 'winA');
assert.ok(Math.abs(B.sim.money - mB * 0.75) < 2, `B 배상 25% (${mB} → ${B.sim.money})`);
const gotA = A.sim.money - mA;
const gotC = C.sim.money - mC;
assert.ok(gotA > 0 && gotC > 0, `A·C 둘 다 몫을 받음 (${gotA}, ${gotC})`);
assert.ok(Math.abs(gotA + gotC - mB * 0.25) < 2, '나눈 합 = 배상 전체');
assert.ok(gotA > gotC, '점령한 A 가 더 많이');
assert.ok(A.sim.territory.isOwned(target.cx, target.cy), 'A 가 점령지를 얻음');
assert.ok(!B.sim.territory.isOwned(target.cx, target.cy));
console.log(
  `  OK   항복 동의(대표 또는 2/3), 배상 기여도 분배 (A ${Math.round(gotA)} · C ${Math.round(gotC)}만 원)`,
);
console.log('Coalition passed: large war, join, protection, capital, consent, split reparations.');
