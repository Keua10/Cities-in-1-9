import assert from 'node:assert/strict';

/**
 * 군사 4·5단계 — 두 도시 전쟁 한 판을 처음부터 끝까지(가짜 Firestore, 한 프로세스).
 * 선전포고 → 준비 5분 → 개전 → 부대 이동·전투·점령 → 항복 → 승인 → 배상·영토 이전.
 */

let clock = 1_800_000_000_000;
const realNow = Date.now;
Date.now = () => clock;
(globalThis as any).window = { setInterval: () => 0, setTimeout: () => 0, clearInterval() {} };
(globalThis as any).document = { visibilityState: 'visible', addEventListener() {} };

const { chunkKey } = await import('../../src/core/iso');
const { CHUNK_SIZE } = await import('../../src/core/constants');
const { World } = await import('../../src/world/world');
const { MacroSim } = await import('../../src/sim/macro');
const { WarSession } = await import('../../src/net/warSession');
const { newUnit } = await import('../../src/sim/military/army');
const { chunkTerrain } = await import('../../src/sim/military/terrain');
const { CONTINENT_H, CONTINENT_W, CONTINENT_X0, CONTINENT_Y0 } = await import(
  '../../src/world/continent'
);
const { WAR_PREP_MS } = await import('../../src/sim/config/war');
void CHUNK_SIZE;

// 넓은 평지(가로 20청크 × 세로 6청크)
function plain(): { cx: number; cy: number } {
  for (let cy = CONTINENT_Y0 + 10; cy < CONTINENT_Y0 + CONTINENT_H - 10; cy += 2)
    for (let cx = CONTINENT_X0 + 10; cx < CONTINENT_X0 + CONTINENT_W - 30; cx += 2) {
      let ok = true;
      for (let x = 0; x < 20 && ok; x++)
        for (let y = 0; y < 6 && ok; y++)
          if (chunkTerrain(cx + x, cy + y).kind !== 'plain') ok = false;
      if (ok) return { cx, cy };
    }
  throw new Error('평지 없음');
}
const p = plain();
const capOf = (uid: string, o: { cx: number; cy: number }) =>
  uid === 'alice' ? chunkKey(o.cx, o.cy) : chunkKey(o.cx + 2, o.cy);
const make = (uid: string, ox: number) => {
  const lv = 2;
  const origin = { cx: p.cx + ox, cy: p.cy + 1 };
  const world = new World(origin);
  const owned: string[] = [];
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 6; x++) owned.push(chunkKey(origin.cx + x, origin.cy + y));
  const sim = new MacroSim(world, {
    money: 100_000,
    population: 0,
    tick: 0,
    tickedAt: 0,
    territory: { owned, capitalLevel: lv, capital: capOf(uid, origin) },
  });
  sim.army.uid = uid;
  return { uid, world, sim, origin, owned };
};
const A = make('alice', 0);
const B = make('bob', 10);
// A: 국경 쪽에 보병 3, B: 국경 청크에 보병 1
for (let i = 0; i < 3; i++) {
  const u = newUnit(
    A.sim.army.army,
    'infantry',
    { cx: A.origin.cx + 5, cy: A.origin.cy + 1 + i },
    {},
    0,
  );
  u.state = 'idle';
}
const bu = newUnit(B.sim.army.army, 'infantry', { cx: B.origin.cx, cy: B.origin.cy + 1 }, {}, 0);
bu.state = 'idle';

const sa = new WarSession(A.uid, A.sim, '앨리스시');
const sb = new WarSession(B.uid, B.sim, '밥시');
const notes: string[] = [];
sa.onNotice = (t) => notes.push(`A: ${t}`);
sb.onNotice = (t) => notes.push(`B: ${t}`);
sa.start();
sb.start();
const profile = (c: typeof A) => ({
  uid: c.uid,
  cityIndex: c.uid === 'alice' ? 1 : 2,
  cityName: c.uid === 'alice' ? '앨리스시' : '밥시',
  origin: chunkKey(c.origin.cx, c.origin.cy),
  owned: c.owned,
  capital: capOf(c.uid, c.origin),
  capitalLevel: 2,
  cityLevel: 4,
  population: 1000,
  updatedAt: clock,
  online: true,
  lastSeen: clock,
});
const tickAll = async (ms: number) => {
  for (let t = 0; t < ms; t += 500) {
    clock += 500;
    A.sim.army.update(clock);
    B.sim.army.update(clock);
    (sa as any).tick();
    (sb as any).tick();
    await new Promise((r) => setImmediate(r));
  }
};

// 1. 선전포고
const why = await sa.declare(profile(B) as any, profile(A) as any, 'small', false);
assert.equal(why, '', why);
await tickAll(1000);
assert.equal(sa.status().phase, 'prep');
assert.equal(sb.status().phase, 'prep');
assert.ok(
  notes.some((n) => n.startsWith('B: ⚠')),
  '상대에게 선전포고 알림',
);
assert.ok(A.sim.atWar && !A.sim.grantsEnabled, '전쟁 중: 1배속, 지원금 끊김');
const again = await sa.declare(profile(B) as any, profile(A) as any, 'small', false);
assert.ok(again.includes('이미'), '전쟁 중 또 선포 불가');
await tickAll(WAR_PREP_MS);
assert.equal(sa.status().phase, 'active');
console.log('  OK   선전포고 → 준비 5분 → 개전');

// 2. A 가 B 국경 청크로 진격
const target = { cx: B.origin.cx, cy: B.origin.cy + 1 };
for (const u of A.sim.army.units) {
  const r = A.sim.army.order(u.id, target.cx, target.cy);
  assert.equal(r, '', r);
}
await tickAll(6 * 60_000);
const bLeft = B.sim.army.units;
assert.ok(
  bLeft.length === 0 ||
    bLeft[0].state === 'retreating' ||
    bLeft[0].cx !== target.cx ||
    bLeft[0].cy !== target.cy ||
    bLeft[0].org < 30,
  'B 부대가 밀려남',
);
const st = sa.status();
assert.ok(st.scoreMe > 0, `A 점수 ${st.scoreMe}`);
const occupiedByA = [...((sa as any).claims ? Object.keys((sa as any).claims) : [])];
assert.ok(occupiedByA.includes(chunkKey(target.cx, target.cy)), 'A 가 B 국경 청크를 점령');
assert.ok(!occupiedByA.includes(chunkKey(B.origin.cx + 2, B.origin.cy)), '수도는 점령 못 함');
console.log(
  `  OK   진격·전투·점령 (점수 ${st.scoreMe} : ${st.scoreEnemy}, 점령 ${occupiedByA.length}청크)`,
);

// 3. 끊김 → 일시정지
const before = { ...A.sim.army.units[0] };
clock += 30_000; // B 가 30초 동안 스냅숏을 못 보냄(A 만 진행)
for (let i = 0; i < 6; i++) {
  clock += 500;
  A.sim.army.update(clock);
  (sa as any).tick();
  await new Promise((r) => setImmediate(r));
}
assert.equal(sa.status().phase, 'paused', '상대 끊기면 일시정지');
void before;
await tickAll(5_000);
assert.equal(sa.status().phase, 'active', '다시 이어지면 재개');
console.log('  OK   상대 끊김 → 일시정지 → 재개');

// 4. 항복 → 승인 → 배상
const moneyA = A.sim.money;
const moneyB = B.sim.money;
const ownedB = B.sim.territory.count;
await sb.offerSurrender();
await tickAll(1000);
assert.ok(sa.status().surrenderOffered);
await sa.acceptSurrender();
await tickAll(3000);
assert.equal(sa.status().phase, 'ended');
assert.ok(Math.abs(B.sim.money - moneyB * 0.75) < 2, `B 배상 25% (${moneyB} → ${B.sim.money})`);
assert.ok(A.sim.money > moneyA, 'A 가 배상을 받음');
assert.ok(B.sim.territory.count < ownedB, 'B 영토 감소');
assert.ok(A.sim.territory.isOwned(target.cx, target.cy), 'A 가 점령지를 얻음');
assert.ok(!A.sim.atWar && A.sim.grantsEnabled, '전쟁이 끝나면 평시');
const re = await sa.declare(profile(B) as any, profile(A) as any, 'small', false);
assert.ok(re.includes('시간 뒤'), '패전국 재선포 48시간 금지');
console.log(
  `  OK   항복 → 승전 정산(배상 ${Math.round(moneyB * 0.25)}만 원, 영토 ${ownedB - B.sim.territory.count}청크)`,
);
Date.now = realNow;
console.log(
  'War session passed: declare, prep, battle, occupation, pause, surrender, reparations.',
);
