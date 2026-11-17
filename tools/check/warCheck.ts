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
import { CEASEFIRE_QUIET_MS, WAR_JUDGE_AFTER_MS, WAR_RANGE_CHUNKS } from '../../src/sim/config/war';
import { World } from '../../src/world/world';

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
assert.ok(
  base({ them: { uid: 'b', online: true, capitalLevel: 2, owned: ring(40, 0, 4) } }).includes(
    `${WAR_RANGE_CHUNKS}청크`,
  ),
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
assert.ok(base({ wars: [war({ a: 'b', b: 'c', parties: ['b', 'c'] })] }).includes('상대가 이미'));
assert.ok(
  base({ wars: [war({ state: 'ended', peaceUntil: now + 3_600_000 })] }).includes('시간 뒤'),
);
assert.equal(base({ wars: [war({ state: 'ended', peaceUntil: now - 1 })] }), '');
console.log('  OK   선전포고 조건: 수도 레벨·접속·거리·다른 전쟁·재선포 금지');

// 기습
const sb = (mine: number, theirs: number, level = 5) =>
  surpriseBlock({
    now,
    cityLevel: level,
    myId: 'a',
    wars: [],
    myUnits: [{ cx: 9, cy: 3, men: mine }],
    theirUnits: [{ cx: 20, cy: 3, men: theirs }],
    theirOwned: ring(11, 0, 8),
  });
assert.equal(sb(1500, 1000), '');
assert.ok(sb(1400, 1000).includes('1.5배'));
assert.ok(sb(1500, 1000, 4).includes('5레벨'));
console.log('  OK   기습: 도시 5레벨, 국경 병력 1.5배');

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
console.log('  OK   판정 1.5배, 휴전 1시간, 끊김 24시간 판정, 배상 25%·30%');

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
console.log(
  'War passed: declare, surprise, claims, score, judge, ceasefire, reparations, territory.',
);
