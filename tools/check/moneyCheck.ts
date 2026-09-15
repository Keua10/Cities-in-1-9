import { strict as assert } from 'node:assert';
import { formatMoney, parseAdminMoney, toWon } from '../../src/ui/money';
import { COST_ROAD, COST_ZONE, MS_PER_TICK, TICKS_PER_DAY } from '../../src/sim/simConstants';
import { MacroSim } from '../../src/sim/macro';
import { World } from '../../src/world/world';

assert.equal(formatMoney(COST_ZONE), '₩80,000');
assert.equal(formatMoney(COST_ZONE, true), '₩8만');
assert.equal(formatMoney(COST_ROAD), '₩120,000');
assert.equal(formatMoney(300000, true), '₩30억');
assert.equal(formatMoney(-1.125), '-₩11,250');
assert.equal(formatMoney(0, true, true), '₩0');
assert.equal(formatMoney(0.0001), '₩1');
assert.equal(formatMoney(1, true, true), '+₩1만');
for (const won of [0, 1, 123456789, 1000000000000])
  assert.equal(toWon(parseAdminMoney(String(won))!), won, 'admin input round-trip is in won');
for (const input of ['', ' ', '-1', '1.5', 'Infinity', '1e6', '1,000', '1000000000001'])
  assert.equal(parseAdminMoney(input), null, `invalid money ${input}`);

// An existing save is never rewritten on viewing money. Construction still deducts
// exactly the same ledger amount, and its displayed deduction equals its price.
const save = { money: 60000, population: 0, tick: 0, tickedAt: 1000 };
const sim = new MacroSim(new World(1), save);
const before = JSON.stringify(save);
assert.equal(formatMoney(sim.money), '₩600,000,000');
assert.equal(JSON.stringify(save), before);
const balance = toWon(sim.money);
assert.equal(sim.spend(COST_ZONE), true);
assert.equal(balance - toWon(sim.money), 80000);
const restored = new MacroSim(new World(1), JSON.parse(JSON.stringify(save)));
assert.equal(toWon(restored.money), balance - 80000, 'save reload must not double-convert');
const poor = new MacroSim(new World(1), { ...save, money: COST_ZONE - 1 });
assert.equal(poor.spend(COST_ZONE), false, 'affordability must not change');
const tiny = new MacroSim(new World(1), {
  ...save,
  money: parseAdminMoney('1')!,
  tick: 0,
  tickedAt: 1000,
});
tiny.primeCatchup(1000);
for (let tick = 0; tick < TICKS_PER_DAY; tick++) tiny.update(MS_PER_TICK, 1);
assert.equal(
  toWon(tiny.money),
  1,
  'whole-won admin balances survive daily settlement without activity',
);
console.log(
  'Money passed: all-won display, admin input, exact spend, unchanged saves and purchasing power.',
);
