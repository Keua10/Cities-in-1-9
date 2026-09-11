import { strict as assert } from 'node:assert';
import { CHUNK_SIZE } from '../../src/core/constants';
import { World } from '../../src/world/world';
import { Build } from '../../src/world/build';
import { MacroSim } from '../../src/sim/macro';
import { emptyMacro } from '../../src/net/types';
import {
  DEFAULT_POLICIES,
  normalizePolicies,
  taxSatisfactionPenalty,
} from '../../src/sim/policies';
import { ServiceField } from '../../src/sim/services';
import { FACILITY_SPECS } from '../../src/sim/facilities';
import { FACILITY_ATLAS_COLUMN } from '../../src/render/facilityAtlas';
import {
  FAC_INCINERATOR as WASTE,
  FAC_CREMATORIUM as CREMA,
  FAC_CEMETERY as CEMETERY,
} from '../../src/sim/config/sanitation';
import {
  ZONE_R,
  ZONE_C,
  ZONE_I,
  FACILITY_COUNT,
  facilityKindOfCode,
  isFacilityAnchor,
} from '../../src/sim/buildings';
import { TAX_PER_JOB, TAX_PER_RESIDENT } from '../../src/sim/simConstants';
import { FAC_COMM_TOWER } from '../../src/sim/config/special';
import { FAC_MINIPARK } from '../../src/sim/facilities';
import { seedCityIfEmpty } from '../../src/world/citySeed';

assert.deepEqual(normalizePolicies(), DEFAULT_POLICIES);
assert.deepEqual(normalizePolicies({ taxR: NaN, taxC: -1, taxI: 80, serviceBudget: Infinity }), {
  taxR: 9,
  taxC: 0,
  taxI: 20,
  serviceBudget: 100,
});
for (const spec of FACILITY_SPECS) {
  for (const key of [
    'span',
    'cost',
    'capacity',
    'range',
    'strength',
    'upkeepPerDay',
    'unlockLevel',
  ] as const)
    assert.ok(Number.isFinite(spec[key]), `${spec.name} ${key}`);
  // 소공원(4)과 STEP 4.6 통신탑(17)만 도로 없이 놓을 수 있다.
  assert.equal(
    spec.needsRoad,
    spec.kind !== FAC_MINIPARK && spec.kind !== FAC_COMM_TOWER,
    'only mini park and the communication tower are road optional',
  );
}
assert.equal(FACILITY_SPECS.length, FACILITY_COUNT);
assert.equal(
  new Set(FACILITY_SPECS.map((s) => `${s.span}:${FACILITY_ATLAS_COLUMN[s.kind]}`)).size,
  FACILITY_COUNT,
);

const world = new World(0),
  x = world.baseCx * CHUNK_SIZE + 10,
  y = world.baseCy * CHUNK_SIZE + 20;
for (let dx = 0; dx <= 35; dx++) world.setBuild(x + dx, y, Build.Road, false);
world.placeFacility(x, y + 1, WASTE, 0);
world.placeFacility(x + 10, y + 1, CREMA, 0);
world.placeFacility(x + 27, y + 1, CEMETERY, 0);
const services = new ServiceField();
services.rebuild(world);
const ownerA = services.ownerFor(x + 12, y - 1, 1, CREMA);
const ownerB = services.ownerFor(x + 29, y - 1, 1, CREMA);
assert.equal(services.facilityList()[ownerA].kind, CREMA);
assert.equal(services.facilityList()[ownerB].kind, CEMETERY, 'cemetery is a funeral alternative');
services.accrueSanitation(x + 12, y - 1, 1, 2000, true);
services.accrueSanitation(x + 29, y - 1, 1, 1000, true);
services.accrueSanitation(x + 29, y - 1, 1, 500, false);
services.settleLoads();
assert.equal(services.loadOf(ownerA), 2000);
assert.equal(services.loadOf(ownerB), 1000, 'commercial demand must not consume funeral service');
assert.equal(services.loadOf(services.ownerFor(x + 12, y - 1, 1, WASTE)), 3500);
assert.equal(services.qualityOf(ownerA), 1);
const upkeep = services.dailyUpkeep();
services.budget = 0.5;
assert.equal(services.dailyUpkeep(), upkeep / 2);
assert.equal(services.qualityOf(ownerA), 0.5);
services.budget = 1.5;
assert.equal(services.capacityOfKind(CREMA), 9000);
assert.equal(services.qualityOf(ownerA), 1);
services.budget = 1;
services.accrueSanitation(x + 12, y - 1, 1, 10000, true);
services.settleLoads();
assert.ok(services.qualityOf(ownerA) < 0.5, 'overload reduces quality');
services.power = { supplyAt: () => 0 };
assert.equal(services.qualityOf(ownerA), 0, 'no electricity means no service');
services.power = null;
world.setBuild(x + 20, y, Build.None);
services.rebuild(world);
assert.equal(services.ownerFor(x + 29, y - 1, 1, WASTE), -1, 'disconnected roads cannot serve');
assert.equal(services.facilityList()[services.ownerFor(x + 29, y - 1, 1, CREMA)].kind, CEMETERY);

const macro = emptyMacro();
const sim = new MacroSim(world, macro);
let saved = 0;
sim.onMacroChange = () => saved++;
sim.stats.tiers[ZONE_R][0].filled = 100;
sim.stats.tiers[ZONE_C][0].filled = 50;
sim.stats.tiers[ZONE_I][0].filled = 25;
const baseline = sim.financeEstimate().income;
assert.ok(Math.abs(baseline - (100 * TAX_PER_RESIDENT[0] + 75 * TAX_PER_JOB[0])) < 1e-9);
sim.setPolicies({ taxR: 0, taxC: 18, taxI: 9, serviceBudget: 70 });
assert.ok(Math.abs(sim.financeEstimate().income - 125 * TAX_PER_JOB[0]) < 1e-9);
assert.ok(taxSatisfactionPenalty(sim.policies, ZONE_C) > 0);
assert.ok(taxSatisfactionPenalty(sim.policies, ZONE_R) < 0);
assert.equal(saved, 1);
const restored = new MacroSim(world, JSON.parse(JSON.stringify(macro)));
assert.deepEqual(restored.policies, sim.policies);
assert.equal(restored.services.budget, 0.7);
// "맵 초기화" 가 저장할 macro. Firestore 는 undefined 필드가 하나만 있어도 저장
// 전체를 거부하므로, 초기화가 남긴 macro 에는 undefined 가 절대 없어야 한다.
// 남으면 초기화가 서버에 안 실리고 새로고침 뒤 예전 도시가 그대로 돌아온다.
macro.transport = { harbors: {} };
macro.disasters = { seed: 1, active: [], nextAt: 0 } as unknown as typeof macro.disasters;
sim.resetState(60000, 1);
assert.deepEqual(sim.policies, DEFAULT_POLICIES);
assert.equal(sim.services.budget, 1);
for (const [key, value] of Object.entries(macro))
  assert.notEqual(value, undefined, `초기화한 macro.${key} 가 undefined 입니다`);
for (const key of ['transport', 'disasters', 'policies', 'prosperity'])
  assert.equal(key in macro, false, `초기화가 macro.${key} 를 키째로 지우지 않았습니다`);
assert.deepEqual(JSON.parse(JSON.stringify(macro)), macro, '저장 payload 에 손실이 있습니다');

// New kinds use the same cross-chunk building save path and remain independently demolishable.
const border = (world.baseCx + 1) * CHUNK_SIZE;
world.placeFacility(border - 1, y + 10, CEMETERY, 0);
const chunks = world.takeDirty().chunks;
const copy = new World(0);
copy.setPersistedOverrides(new Map(chunks.map((c) => [`${c.cx},${c.cy}`, c])));
assert.equal(copy.buildingCovering(border + 1, y + 11)?.kind, CEMETERY);
copy.demolishAt(border, y + 11);
assert.equal(copy.buildingCovering(border - 1, y + 10), null);

for (const index of [0, 1, 7]) {
  const city = new World(index);
  seedCityIfEmpty(city);
  const citySim = new MacroSim(city, emptyMacro());
  citySim.primeCatchup(1);
  citySim.update(2500, 1);
  citySim.update(2500, 1);
  citySim.update(2500, 1);
  const counts = new Array(FACILITY_COUNT).fill(0);
  for (const p of city.developedParcels())
    for (const code of p.bld ?? []) if (isFacilityAnchor(code)) counts[facilityKindOfCode(code)]++;
  assert.ok(counts[WASTE] >= 4 && counts[CREMA] >= 2 && counts[CEMETERY] >= 2);
  assert.equal(citySim.power.summary.supply, 1);
  assert.equal(citySim.water.summary.supply, 1);
  assert.equal(citySim.water.summary.drainage, 1);
  assert.ok(citySim.sanitation.waste > 0.9, `city ${index} waste ${citySim.sanitation.waste}`);
  assert.ok(
    citySim.sanitation.funeral > 0.9,
    `city ${index} funeral ${citySim.sanitation.funeral}`,
  );
  console.log(`city ${index}:`, citySim.sanitation);
}
console.log(
  'STEP 4.4/4.5: policy bounds, independent taxes, finance, budgets, funeral alternatives, road/power loss, overload, persistence, reset, generated cities passed.',
);
