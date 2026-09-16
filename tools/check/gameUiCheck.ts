import { strict as assert } from 'node:assert';
import { BUILD_CATEGORIES, BUILD_ITEMS } from '../../src/ui/constructionCatalog';
import { FACILITY_SPECS } from '../../src/sim/facilities';
import { MacroSim } from '../../src/sim/macro';
import { MS_PER_TICK } from '../../src/sim/simConstants';
import { World } from '../../src/world/world';
import type { MacroState } from '../../src/net/types';

// The shallow catalog must expose every existing tool and facility, without duplicates.
assert.equal(BUILD_CATEGORIES.length, 7);
assert.equal(new Set(BUILD_ITEMS.map((x) => x.id)).size, BUILD_ITEMS.length);
assert.equal(BUILD_ITEMS.length, FACILITY_SPECS.length + 17);
for (const category of BUILD_CATEGORIES)
  assert.ok(BUILD_ITEMS.some((x) => x.category === category.id));
for (const spec of FACILITY_SPECS) {
  const entries = BUILD_ITEMS.filter((x) => x.kind === spec.kind);
  assert.equal(entries.length, 1, `${spec.name} must appear exactly once`);
  assert.equal(entries[0].cost, spec.cost);
  assert.equal(entries[0].unlock, spec.unlockLevel);
  assert.equal(entries[0].tool, 'facility');
}
assert.deepEqual(
  BUILD_ITEMS.filter((x) => x.kind === undefined)
    .map((x) => x.tool)
    .sort(),
  [
    'zoneR',
    'zoneC',
    'zoneI',
    'road',
    'runway',
    'taxiway',
    'signalInstall',
    'signalRemove',
    'metroTunnel',
    'metroStation',
    'metroErase',
    'metroView',
    'wire',
    'wireErase',
    'waterPipe',
    'sewerPipe',
    'pipeErase',
  ].sort(),
);

const state: MacroState = { money: 100000, population: 0, tick: 0, tickedAt: 1000 };
const world = new World(1);
const sim = new MacroSim(world, state);
sim.primeCatchup(1000);
sim.update(MS_PER_TICK / 2, 1);
const money = sim.money;
const tick = sim.tick;
for (let now = 2000; now <= 60000; now += 1000) sim.holdClock(now);
assert.equal(sim.tick, tick, 'live pause must not advance simulation');
assert.equal(sim.money, money, 'live pause must not charge upkeep');
assert.equal(state.tickedAt, 60000);
const restored = new MacroSim(world, { ...state });
restored.primeCatchup(60000);
assert.equal(restored.catchupLeft, 0, 'saved live pause must not become offline catch-up');
sim.update(MS_PER_TICK / 2, 1);
assert.equal(sim.tick, tick + 1, 'resume preserves the partial tick');
sim.update(MS_PER_TICK * 2, 1);
assert.equal(sim.tick, tick + 3, 'double time advances two ticks');
console.log(
  `Game UI passed: ${BUILD_ITEMS.length} entries, all facilities, pause/save/resume and time scale.`,
);
