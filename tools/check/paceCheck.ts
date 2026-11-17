import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { constructionSeconds } from '../../src/sim/construction';
import { FACILITY_SPECS } from '../../src/sim/facilities';
import { MacroSim } from '../../src/sim/macro';
import {
  CONSTRUCTION_SECONDS,
  DAYTIME_DAY_MS,
  MAX_CATCHUP_TICKS,
  MS_PER_TICK,
  OFFLINE_MAX_REAL_MS,
  OFFLINE_SPEED,
  PEACE_SPEED,
  START_BOOST_INCOME,
  START_BOOST_MS,
  TICKS_PER_DAY,
} from '../../src/sim/simConstants';
import { World } from '../../src/world/world';

/**
 * 게임 속도 밸런스 점검: 공사 등급, 스타트 버닝, 평시 배속, 접속하지 않은 동안의 시간.
 */

// 1. 공사 기간: 모든 시설에 값이 있고, 기초는 빠르고 고급은 오래 걸린다.
assert.equal(
  CONSTRUCTION_SECONDS.length,
  FACILITY_SPECS.length,
  '시설마다 공사 기간이 있어야 합니다',
);
const sec = (name: string) => constructionSeconds(FACILITY_SPECS.findIndex((s) => s.name === name));
for (const n of [
  '소방서',
  '경찰서',
  '지하수 펌프',
  '풍력 발전소',
  '곡물 농장',
  '채소 농장',
  '곡물 창고',
])
  assert.ok(sec(n) <= 40, `${n} 은 기초 시설이라 40초 안에 지어져야 합니다`);
for (const n of ['병원', '학교', '과수원', '목장'])
  assert.ok(sec(n) >= 60 && sec(n) <= 180, `${n} 은 일반 시설(1~3분)`);
for (const n of ['하수처리장', '가스 발전소', '소형 공항', '식품 가공 공장'])
  assert.ok(sec(n) >= 600 && sec(n) <= 1200, `${n} 은 고급 시설(10~20분)`);
assert.equal(sec('대형 공항'), 2 * 3600);
// 군사 시설 기준점(확정): 기본 군사 공항 40분, 중간 2시간, 미사일 등 최종 기술 3시간 이상.
assert.equal(sec('군사 공항(기본)'), 40 * 60);
assert.equal(sec('군사 공항(중간)'), 2 * 3600);
assert.ok(sec('미사일 기지') >= 3 * 3600 && sec('미사일 방어') >= 3 * 3600);
assert.ok(
  Math.max(...CONSTRUCTION_SECONDS.slice(0, 48)) < 3 * 3600,
  '민간 시설은 최종 군사 시설(3시간)보다 짧다',
);
// 레벨이 높을수록 공사가 길다(같은 레벨 안에서 순서는 자유). 공사 등급은 예전 5단계
// 기준이고, 9단계 레벨은 1→1, 2~3→2, 4~5→3, 6~7→4, 8~9→5 등급으로 묶인다.
const GRADE = [1, 2, 2, 3, 3, 4, 4, 5, 5];
const byLevel = new Map<number, number[]>();
FACILITY_SPECS.forEach((s, k) => {
  // 자원 시설(36~)은 설계안 Ⅳ의 공사 시간(3분·15분·40분)을 따른다 — resources 점검이 본다.
  if (k >= 36) return;
  const g = GRADE[s.unlockLevel - 1];
  byLevel.set(g, [...(byLevel.get(g) ?? []), constructionSeconds(k)]);
});
assert.ok(Math.max(...byLevel.get(4)!) > Math.max(...byLevel.get(3)!));
assert.ok(Math.min(...byLevel.get(5)!) > Math.max(...byLevel.get(4)!));
console.log('  OK   공사 등급: 기초 ≤40초 · 일반 1~3분 · 고급 10~20분 · L4 40분 · L5 2시간');

// 2. 스타트 버닝: 한 번만, 플레이 시간으로 줄고, 수입만 10배.
const makeSim = () => {
  const macro = { money: 1000, population: 0, tick: 0, tickedAt: 1000 };
  return { macro, sim: new MacroSim(new World(), macro) };
};
const { macro, sim } = makeSim();
sim.financeEstimate = (mul = 1) => ({ income: 100 * mul, upkeep: 40 });
assert.equal(sim.incomeMultiplier, 1);
assert.ok(sim.grantStartBoost());
assert.ok(!sim.grantStartBoost(), '버닝은 도시마다 한 번만');
assert.equal(sim.startBoostLeftMs, START_BOOST_MS);
assert.equal(sim.incomeMultiplier, START_BOOST_INCOME);
// 게임 시간 1일을 평시 배속으로 돌린다 = 플레이 시간 DAYTIME_DAY_MS / PEACE_SPEED.
const realDay = DAYTIME_DAY_MS / PEACE_SPEED;
for (let ms = 0; ms < realDay; ms += 1000) sim.update(1000 * PEACE_SPEED, 1, 1000);
assert.equal(sim.startBoostLeftMs, START_BOOST_MS - realDay);
assert.equal(
  macro.money,
  1000 + 100 * START_BOOST_INCOME - 40,
  '버닝 중 하루 수입은 10배, 유지비는 그대로',
);
for (let ms = 0; ms < START_BOOST_MS; ms += 1000) sim.update(1000 * PEACE_SPEED, 1, 1000);
assert.equal(sim.startBoostLeftMs, 0);
assert.equal(macro.startBoostMs, undefined, '다 쓰면 저장에서 지운다');
assert.equal(sim.incomeMultiplier, 1);
const before = macro.money;
for (let ms = 0; ms < realDay; ms += 1000) sim.update(1000 * PEACE_SPEED, 1, 1000);
assert.equal(macro.money, before + 60, '버닝이 끝나면 원래 수입');
// 관리자 초기화는 새 도시라 버닝을 다시 받는다.
sim.resetState(1000, 0);
assert.ok(sim.grantStartBoost());
console.log(
  `  OK   스타트 버닝: 한 번만, 플레이 ${START_BOOST_MS / 60000}분, 수입 ×${START_BOOST_INCOME}`,
);

// 3. 평시 배속과 접속하지 않은 동안.
assert.equal(PEACE_SPEED, 2);
const offline = makeSim();
offline.sim.primeCatchup(1000 + OFFLINE_MAX_REAL_MS);
assert.equal(offline.sim.catchupLeft, MAX_CATCHUP_TICKS, '현실 하루 = 게임 2일');
assert.equal(MAX_CATCHUP_TICKS, 2 * TICKS_PER_DAY);
const week = makeSim();
week.sim.primeCatchup(1000 + 7 * OFFLINE_MAX_REAL_MS);
assert.equal(week.sim.catchupLeft, MAX_CATCHUP_TICKS, '하루보다 오래 비워도 하루치까지만');
const hour = makeSim();
hour.sim.primeCatchup(1000 + 3_600_000);
assert.equal(hour.sim.catchupLeft, Math.floor((3_600_000 / MS_PER_TICK) * OFFLINE_SPEED));
assert.ok(hour.sim.catchupLeft <= 2, '한 시간 비우면 게임 시간 두 시간 정도');
console.log('  OK   평시 2×, 미접속 현실 하루 = 게임 2일, 상한 하루');

// 4. 화면: 일시정지·배속 버튼이 없고 버닝 표시가 있다.
const html = readFileSync('index.html', 'utf8');
assert.ok(!/data-speed="/.test(html), '시간 조절 버튼은 없어야 합니다');
assert.ok(html.includes('id="start-boost"'));
console.log('Pace passed: build tiers, start boost, peace speed, offline time.');
