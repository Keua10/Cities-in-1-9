import assert from 'node:assert/strict';
import { AssignmentTable } from '../../src/sim/assignment';
import { CongestionMap } from '../../src/sim/congestion';
import { FAC_FIRE, FACILITY_SPECS } from '../../src/sim/facilities';
import { MacroSim } from '../../src/sim/macro';
import {
  GRANT_BASE,
  GRANT_UPKEEP_SHARE,
  IDLE_UPKEEP_SHARE,
  MS_PER_TICK,
  START_MONEY,
} from '../../src/sim/simConstants';
import { FAC_AIRPORT_L3 } from '../../src/sim/config/special';
import { Tools } from '../../src/ui/tools';
import { seedCityIfEmpty } from '../../src/world/cityGen';
import { Terrain } from '../../src/world/terrain';
import { World } from '../../src/world/world';

/**
 * 재정 점검: "웬만해선 적자가 나지 않고, 잘 운영하면 훨씬 잘 번다."
 */

function emptyTown() {
  const world = new World();
  world.getTile = () => Terrain.Grass;
  world.sampleHeight = () => 0;
  world.isExplored = () => true;
  const macro = { money: START_MONEY * 10, population: 0, tick: 0, tickedAt: 1000 };
  const sim = new MacroSim(world, macro);
  const tools = new Tools(world, { invalidateTile() {}, forceRedraw() {} } as any, sim);
  const place = (kind: number, tx: number, ty: number) => {
    world.placeFacility(tx, ty, kind, 0);
  };
  tools.setTool('road');
  tools.tapTile(0, 0);
  tools.tapTile(80, 0);
  tools.confirmPlacement();
  return { world, sim, place };
}

// 1. 빈 시설은 운영비가 적게 든다.
{
  const { sim, place } = emptyTown();
  place(FAC_FIRE, 2, 1);
  sim.services.rebuild((sim as any).world);
  const full = FACILITY_SPECS[FAC_FIRE].upkeepPerDay;
  assert.equal(sim.services.dailyUpkeep(), full);
  assert.ok(Math.abs(sim.services.operatingUpkeep() - full * IDLE_UPKEEP_SHARE) < 1e-9);
  console.log(`  OK   빈 소방서 운영비 ${full * IDLE_UPKEEP_SHARE} (정가 ${full})`);
}

// 2. 사람 없이 기초 시설만 지은 새 도시도 적자가 아니다(정부 지원금).
{
  const { sim, place, world } = emptyTown();
  [0, 1, 2, 3, 7, 11, 27, 28].forEach((kind, i) => place(kind, 2 + i * 6, 1));
  sim.services.rebuild(world);
  sim.update(MS_PER_TICK, 1);
  const f = sim.financeEstimate();
  assert.ok(f.upkeep > 0);
  assert.ok(f.income - f.upkeep >= 0, `새 도시 적자: ${f.income - f.upkeep}`);
  assert.ok((f.grant ?? 0) > 0);
  console.log(
    `  OK   인구 0, 기초 시설 8개: 지출 ${Math.round(f.upkeep)} 을 지원금 ${Math.round(f.grant!)} 이 메움`,
  );
  // 전쟁 같은 특수 상황에서 지원금이 끊기면 적자가 보인다.
  sim.grantsEnabled = false;
  const war = sim.financeEstimate();
  assert.ok(war.income - war.upkeep < 0);
  assert.equal(war.grant, 0);
}

// 3. 터무니없이 과하게 지으면(빈 땅에 대형 공항) 지원금 한도를 넘어 적자다.
{
  const { sim, place, world } = emptyTown();
  place(FAC_AIRPORT_L3, 10, 1);
  sim.services.rebuild(world);
  sim.update(MS_PER_TICK, 1);
  const f = sim.financeEstimate();
  assert.ok(f.income - f.upkeep < 0, '과잉 투자는 적자여야 합니다');
  assert.ok(Math.abs(f.grant! - (f.upkeep * GRANT_UPKEEP_SHARE + GRANT_BASE)) < 1e-6);
  console.log(
    `  OK   빈 땅의 대형 공항: 하루 ${Math.round(f.income - f.upkeep)} 적자 (지원금 한도)`,
  );
}

// 4. 잘 운영된 대도시는 지원금 없이 크게 남긴다.
{
  const world = new World(0);
  assert.ok(seedCityIfEmpty(world));
  const macro = { money: 300_000, population: 0, tick: 0, tickedAt: 1_000 };
  const sim = new MacroSim(world, macro);
  sim.attachTraffic(new CongestionMap(), new AssignmentTable());
  sim.primeCatchup(1_000);
  for (let t = 0; t < 24 * 3; t++) sim.update(MS_PER_TICK, 0);
  const f = sim.financeEstimate();
  assert.equal(f.grant, 0);
  assert.ok(f.income > f.upkeep * 1.8, `대도시 세입/지출 ${(f.income / f.upkeep).toFixed(2)}`);
  console.log(
    `  OK   생성 대도시: 세입 ${Math.round(f.income)} / 지출 ${Math.round(f.upkeep)} (×${(f.income / f.upkeep).toFixed(2)})`,
  );
}
console.log('Economy passed: idle upkeep, grant floor, overbuild deficit, rich well-run city.');
