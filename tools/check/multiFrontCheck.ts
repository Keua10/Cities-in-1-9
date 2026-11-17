import assert from 'node:assert/strict';

/**
 * 동시 전쟁(피드백 1차): 한 나라가 두 나라와 동시에, 또는 세 나라가 서로 싸운다(최대 3곳).
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
const A = make('alice', 0, 0, 8, 6, 2);
const B = make('bob', 12, 0, 8, 6, 2);
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

// 1. B 가 A 에 선포, C 도 A 에 선포 → A 는 두 나라와 동시에 싸운다(3곳).
assert.equal(await B.war.declare(A.profile() as never, B.profile() as never, 'small', false), '');
await settle();
assert.equal(await C.war.declare(A.profile() as never, C.profile() as never, 'small', false), '');
await settle();
assert.equal(A.war.currentWars().length, 2, 'A 는 전쟁 2개');
// 2. D 가 B 에 선포하면 4곳 → 불가.
const why = await D.war.declare(B.profile() as never, D.profile() as never, 'small', false);
assert.ok(why.includes('3곳까지'), why);
// C 가 B 에도 선포 → 세 나라가 서로(여전히 3곳) → 된다.
assert.equal(await C.war.declare(B.profile() as never, C.profile() as never, 'small', false), '');
await settle();
assert.equal(C.war.currentWars().length, 2, 'C 는 A·B 둘과');
console.log('  OK   동시 전쟁: 한 나라가 두 나라와, 세 나라가 서로(3곳), 4곳째 선포 불가');

// 3. 개전 뒤 A 의 전장: B·C 부대가 모두 적이다.
newUnit(A.sim.army.army, 'infantry', { cx: A.origin.cx + 7, cy: A.origin.cy + 1 }, {}, 0).state =
  'idle';
newUnit(B.sim.army.army, 'infantry', { cx: B.origin.cx + 4, cy: B.origin.cy + 3 }, {}, 0).state =
  'idle';
newUnit(C.sim.army.army, 'infantry', { cx: C.origin.cx + 3, cy: C.origin.cy + 1 }, {}, 0).state =
  'idle';
await tickAll(WAR_PREP_MS + 10_000);
const link = A.sim.army.war!;
assert.ok(link && !link.paused, 'A 전쟁 연결');
const owners = new Set(link.enemy.units.map((u) => u.id.split(':')[0]));
assert.ok(owners.has('bob') && owners.has('carol'), `A 의 적 = B·C (${[...owners]})`);
assert.ok(link.enemy.owned.has(chunkKey(B.origin.cx + 1, B.origin.cy + 1)), 'B 땅이 적 땅');
assert.ok(link.enemy.owned.has(chunkKey(C.origin.cx + 1, C.origin.cy + 1)), 'C 땅이 적 땅');
// 소규모 전쟁: 미사일 금지 땅으로 표시
assert.ok(link.noMissile?.has(chunkKey(B.origin.cx + 1, B.origin.cy + 1)), '소규모 → 미사일 불가');
console.log('  OK   두 전선의 적을 한 전장에서 상대, 소규모 전쟁 땅은 미사일 불가');

// 4. A 가 B 국경 청크를 점령 → A–B 전쟁에만 점령 주장이 적힌다.
const target = { cx: B.origin.cx, cy: B.origin.cy + 4 };
const unit = A.sim.army.units[0];
assert.equal(A.sim.army.order(unit.id, target.cx, target.cy), '');
await tickAll(4 * 60_000);
const fronts = (A.war as any).fronts as Map<string, { claims: Record<string, number> }>;
const ab = A.war.currentWars().find((w) => w.parties.includes('bob'))!;
const ac = A.war.currentWars().find((w) => w.parties.includes('carol'))!;
const key = chunkKey(target.cx, target.cy);
assert.ok(key in (fronts.get(ab.id)?.claims ?? {}), 'A–B 전쟁에 점령 주장');
assert.ok(!(key in (fronts.get(ac.id)?.claims ?? {})), 'A–C 전쟁에는 없음');
console.log('  OK   점령 주장은 그 땅이 걸린 전쟁에만');
console.log('Multi-front passed: three-city wars, merged battlefield, per-war claims.');
