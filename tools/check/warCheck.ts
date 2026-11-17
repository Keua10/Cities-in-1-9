import assert from 'node:assert/strict';
import { MacroSim } from '../../src/sim/macro';
import {
  ceasefireDue,
  declareBlock,
  judge,
  judgeDue,
  mergeClaims,
  reparations,
  surpriseBlock,
  territoryDistance,
  warScore,
  type WarDoc,
} from '../../src/sim/military/warRules';
import { CEASEFIRE_QUIET_MS, WAR_JUDGE_AFTER_MS } from '../../src/sim/config/war';
import { World } from '../../src/world/world';
import {
  attackFactor,
  chunkTerrain,
  defenseFactor,
  moveFactor,
} from '../../src/sim/military/terrain';
import { seenBy } from '../../src/sim/military/warRules';
import { CONTINENT_H, CONTINENT_W, CONTINENT_X0, CONTINENT_Y0 } from '../../src/world/continent';

/**
 * 군사 4·5단계 — 전쟁 규칙(순수 계산). 네트워크 연결은 브라우저 두 계정으로 확인.
 */

const ring = (x0: number, y0: number, n: number) => {
  const out: string[] = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out.push(`${x0 + x},${y0 + y}`);
  return out;
};
const A = ring(0, 0, 8);
const B = ring(20, 0, 8);
assert.equal(territoryDistance(A, B), 13);
const now = 1_000_000_000;
const base = (over: Partial<Parameters<typeof declareBlock>[0]> = {}) =>
  declareBlock({
    now,
    kind: 'small',
    me: { uid: 'a', online: true, capitalLevel: 2, cityLevel: 4, owned: A },
    them: { uid: 'b', online: true, capitalLevel: 2, owned: B },
    wars: [],
    ...over,
  });
assert.equal(base(), '');
assert.ok(
  base({ me: { uid: 'a', online: true, capitalLevel: 1, cityLevel: 3, owned: A } }).includes(
    '수도 2레벨',
  ),
);
assert.ok(base({ them: { uid: 'b', online: false, capitalLevel: 2, owned: B } }).includes('접속'));
assert.ok(base({ kind: 'large' }).includes('3레벨'));
// 거리 제한 없음: 아주 먼 도시에도 선포할 수 있다.
assert.equal(
  base({ them: { uid: 'b', online: true, capitalLevel: 2, owned: ring(400, 0, 4) } }),
  '',
);
const war = (over: Partial<WarDoc>): WarDoc => ({
  id: 'w',
  a: 'a',
  b: 'b',
  parties: ['a', 'b'],
  names: {},
  kind: 'small',
  surprise: false,
  state: 'active',
  declaredAt: now - 1000,
  startsAt: now - 1000,
  ...over,
});
// 동시 전쟁: 상대가 C 와 싸우는 중이어도 나(A)는 선포할 수 있다(3곳).
assert.equal(base({ wars: [war({ a: 'b', b: 'c', parties: ['b', 'c'] })] }), '');
// 나·상대와 이미 같은 전쟁 중이면 불가.
assert.ok(base({ wars: [war({})] }).includes('이미 이 도시와'));
assert.ok(
  base({ wars: [war({ state: 'ended', peaceUntil: now + 3_600_000 })] }).includes('시간 뒤'),
);
assert.equal(base({ wars: [war({ state: 'ended', peaceUntil: now - 1 })] }), '');
// 상대가 나 아닌 도시와 전쟁 중(상대 전쟁 기록에서): 3곳이면 된다.
assert.equal(base({ theirWars: [war({ id: 'x', a: 'b', b: 'c', parties: ['b', 'c'] })] }), '');
// 세 나라가 서로: b–c, a–c 전쟁 중에 a 가 b 에게 → 3곳 그대로라 된다.
assert.equal(
  base({
    wars: [war({ id: 'ac', a: 'a', b: 'c', parties: ['a', 'c'] })],
    theirWars: [war({ id: 'bc', a: 'b', b: 'c', parties: ['b', 'c'] })],
  }),
  '',
);
// 4곳째: b–c, c–d 전쟁 중인데 a 가 b 에게 → 4곳이라 불가.
assert.ok(
  base({
    theirWars: [war({ id: 'bc', a: 'b', b: 'c', parties: ['b', 'c'] })],
    otherWars: [war({ id: 'cd', a: 'c', b: 'd', parties: ['c', 'd'] })],
  }).includes('3곳까지'),
  '동시 전쟁 3곳 제한',
);
// 대규모 전쟁에 동맹으로 참가한 도시는 세지 않는다.
assert.equal(
  base({
    theirWars: [war({ id: 'bc', a: 'b', b: 'c', parties: ['b', 'c', 'e', 'f'], kind: 'large' })],
  }),
  '',
);
// 패전국 보호: b 가 c 에게 졌으면 a 도 48시간 동안 b 에게 선포 불가
assert.ok(
  base({
    theirWars: [
      war({
        id: 'y',
        a: 'c',
        b: 'b',
        parties: ['c', 'b'],
        state: 'ended',
        result: 'winA',
        endedAt: now - 3_600_000,
      }),
    ],
  }).includes('보호'),
  '패전국은 누구에게서든 48시간 보호',
);
assert.equal(
  base({
    theirWars: [
      war({
        id: 'y',
        a: 'c',
        b: 'b',
        parties: ['c', 'b'],
        state: 'ended',
        result: 'winA',
        endedAt: now - 49 * 3_600_000,
      }),
    ],
  }),
  '',
);
console.log(
  '  OK   선전포고 조건: 수도 레벨·접속·거리 제한 없음·동시 전쟁 3곳·재선포 금지·패전국 보호',
);

// 기습
const sb = (mine: number, theirs: number, level = 5, night = true) =>
  surpriseBlock({
    now,
    cityLevel: level,
    myId: 'a',
    wars: [],
    myUnits: [{ cx: 9, cy: 3, men: mine }],
    theirUnits: [{ cx: 20, cy: 3, men: theirs }],
    theirOwned: ring(11, 0, 8),
    night,
  });
assert.equal(sb(1500, 1000), '', '밤: 상대 시야 1청크라 2청크 떨어진 부대는 안 보임');
assert.ok(sb(1400, 1000).includes('1.5배'));
assert.ok(sb(1500, 1000, 4).includes('5레벨'));
assert.ok(
  sb(1500, 1000, 5, false).includes('보고 있습니다'),
  '낮: 2청크면 보임(산이 가리지 않으면)',
);
// 산이 가리면 낮에도 숨는다
{
  const { chunkTerrain } = await import('../../src/sim/military/terrain');
  const { seenBy } = await import('../../src/sim/military/warRules');
  let found = false;
  for (let y = -60; y < 60 && !found; y++)
    for (let x = -100; x < 100 && !found; x++) {
      if (chunkTerrain(x + 1, y).kind !== 'mountain') continue;
      if (chunkTerrain(x, y).kind === 'mountain' || chunkTerrain(x + 2, y).kind === 'mountain')
        continue;
      assert.ok(!seenBy(x, y, [{ cx: x + 2, cy: y }], false), '산 너머는 안 보임');
      assert.ok(seenBy(x + 1, y, [{ cx: x + 2, cy: y }], false), '바로 옆은 보임');
      found = true;
    }
  assert.ok(found, '시험할 산 청크');
}
console.log('  OK   기습: 도시 5레벨, 국경 병력 1.5배, 상대 시야 밖(산 뒤·밤)');

// 점령 주장 합치기
const occ = mergeClaims(
  { uid: 'a', claims: { '20,0': 100, '1,1': 300 }, owned: A },
  { uid: 'b', claims: { '1,1': 200, '2,2': 150 }, owned: B },
);
assert.equal(occ.get('20,0'), 'a', 'A 가 B 땅 점령');
assert.equal(occ.has('1,1'), false, 'A 가 늦게 되찾았으면 원래대로');
assert.equal(occ.get('2,2'), 'b');
assert.equal(warScore(occ, 'a', 5000), 7000);
console.log('  OK   점령 주장 합치기(늦은 쪽 승), 점수 = 적 손실 + 점령 × 2,000');

// 판정
assert.equal(judge(15_000, 10_000), 'winA');
assert.equal(judge(14_000, 10_000), 'truce');
assert.equal(judge(0, 3000), 'winB');
assert.equal(judge(0, 0), 'truce');
assert.ok(ceasefireDue(war({ startsAt: now - CEASEFIRE_QUIET_MS - 1 }), 0, now));
assert.ok(!ceasefireDue(war({ startsAt: now - CEASEFIRE_QUIET_MS - 1 }), now - 1000, now));
assert.ok(judgeDue(war({ pausedAt: now - WAR_JUDGE_AFTER_MS - 1 }), now));
assert.ok(!judgeDue(war({ pausedAt: now - 1000 }), now));
assert.deepEqual(reparations(10_000, { iron: 100, coal: 10, oil: 0 }), {
  money: 2500,
  iron: 30,
  coal: 3,
  oil: 0,
});
console.log('  OK   판정 1.5배, 휴전 20분, 끊김 24시간 판정, 배상 25%·30%');

// 영토 내주기·얻기
{
  const w = new World(0);
  const sim = new MacroSim(w, { money: 1000, population: 0, tick: 0, tickedAt: 0 });
  const t = sim.territory;
  const key = `${w.baseCx},${w.baseCy}`;
  t.cede([key]);
  assert.ok(!t.isOwned(w.baseCx, w.baseCy) && t.isCeded(key));
  t.people = new Map([[key, { residents: 500, floating: 0, raw: 500 }]]);
  t.update(Date.now(), true);
  assert.ok(!t.isOwned(w.baseCx, w.baseCy), '빼앗긴 땅은 다시 자동 점령되지 않는다');
  const far = `${w.baseCx + 30},${w.baseCy}`;
  t.annex([far]);
  t.update(Date.now() + 20 * 60_000, true);
  assert.ok(t.isOwned(w.baseCx + 30, w.baseCy), '얻은 땅은 길이 없어도 유지');
  t.foreign = new Set([`${w.baseCx - 1},${w.baseCy}`]);
  t.people = new Map([[`${w.baseCx - 1},${w.baseCy}`, { residents: 500, floating: 0, raw: 500 }]]);
  t.update(Date.now(), true);
  assert.ok(!t.isOwned(w.baseCx - 1, w.baseCy), '다른 도시 영토는 자동 점령 안 됨');
}
console.log('  OK   영토 내주기(다시 안 생김)·얻기(연결 예외)·다른 도시 땅 보호');
// 숲: 이동 60%, 기갑 공격 −20%, 방어 +25%, 시야를 가린다.
{
  const forest = { kind: 'forest' as const, height: 1, valley: false };
  assert.equal(moveFactor(forest, 'infantry', false, true), 0.6);
  assert.equal(attackFactor(forest, 'armor', false, null), 0.8);
  assert.equal(defenseFactor(forest, 'infantry', false, false), 1.25);
  let f: { cx: number; cy: number } | null = null;
  for (let cy = CONTINENT_Y0 + 5; cy < CONTINENT_Y0 + CONTINENT_H - 5 && !f; cy++)
    for (let cx = CONTINENT_X0 + 5; cx < CONTINENT_X0 + CONTINENT_W - 5 && !f; cx++)
      if (chunkTerrain(cx, cy).kind === 'forest') f = { cx, cy };
  assert.ok(f, '대륙에 숲 청크가 있다');
  // 숲 너머(2칸)는 낮에도 안 보인다.
  assert.ok(!seenBy(f!.cx + 1, f!.cy, [{ cx: f!.cx - 1, cy: f!.cy }], false), '숲이 시야를 가림');
  console.log('  OK   숲: 이동 60%·기갑 −20%·방어 +25%·시야 가림');
}
console.log(
  'War passed: declare, surprise, claims, score, judge, ceasefire, reparations, territory.',
);
