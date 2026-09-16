import { strict as assert } from 'node:assert';
import { World } from '../../src/world/world';
import { Build } from '../../src/world/build';
import { Terrain } from '../../src/world/terrain';
import { CHUNK_SIZE } from '../../src/core/constants';
import { tileToWorldX, tileToWorldY } from '../../src/core/iso';
import { MetroNetwork, METRO_TUNNEL_COST, METRO_STATION_COST } from '../../src/sim/metro';
import { MacroSim } from '../../src/sim/macro';
import { Tools } from '../../src/ui/tools';
import type { MacroState } from '../../src/net/types';
import type { WorldRenderer } from '../../src/render/worldRenderer';

const world = new World(0),
  x = world.baseCx * CHUNK_SIZE + 4,
  y = world.baseCy * CHUNK_SIZE + 4;
const state: MacroState = { money: 1000000, population: 0, tick: 0, tickedAt: 0 };
let changes = 0;
const metro = new MetroNetwork(world, state, () => changes++);
for (let dx = 0; dx <= 8; dx++) {
  world.setTile(x + dx, y, Terrain.Grass);
  world.setHeight(x + dx, y, 0);
  world.setBuild(x + dx, y, Build.Road, false);
}
assert.equal(state.metro, undefined, 'old city remains unchanged until first edit');
assert.equal(metro.edit(x, y, 'station').ok, true);
const afterFirst = state.money;
assert.equal(afterFirst, 1000000 - METRO_STATION_COST);
metro.edit(x, y, 'station');
metro.edit(x, y, 'tunnel');
assert.equal(state.money, afterFirst, 'duplicate construction is free');
metro.edit(x + 8, y, 'station');
assert.deepEqual(metro.connectedStations(`${x},${y}`), []);
for (let dx = 1; dx < 8; dx++) assert.equal(metro.edit(x + dx, y, 'tunnel').ok, true);
assert.equal(state.money, 1000000 - 2 * METRO_STATION_COST - 7 * METRO_TUNNEL_COST);
assert.deepEqual(metro.connectedStations(`${x},${y}`), [`${x + 8},${y}`]);
assert.equal(metro.path(`${x},${y}`, `${x + 8},${y}`)?.length, 9);
assert.equal(world.getBuild(x, y), Build.Road, 'underground station preserves surface road');
const restoredState = JSON.parse(JSON.stringify(state));
const restored = new MetroNetwork(world, restoredState, () => {});
assert.equal(
  restored.path(`${x},${y}`, `${x + 8},${y}`)?.length,
  9,
  'serialized city restores same path',
);
metro.edit(x + 4, y, 'erase');
assert.equal(
  metro.path(`${x},${y}`, `${x + 8},${y}`),
  null,
  'removed middle tunnel disconnects network',
);
assert.equal(world.getBuild(x + 4, y), Build.Road, 'underground removal preserves road');
metro.edit(x, y, 'erase');
assert.equal(metro.state.stations[`${x},${y}`], undefined);
assert.equal(
  restored.state.stations[`${x},${y}`].name,
  '지하철 1역',
  'save snapshot stays independent',
);
const beforeDenied = JSON.stringify(state);
assert.equal(metro.edit(x + 100000, y, 'tunnel').ok, false, 'unexplored area denied');
assert.equal(JSON.stringify(state), beforeDenied);
state.money = 0;
assert.equal(metro.edit(x + 4, y, 'tunnel').ok, false);
assert.equal(metro.state.tunnels[`${x + 4},${y}`], undefined);
state.money = 100000;
world.setTile(x + 4, y, Terrain.Water);
assert.equal(metro.edit(x + 4, y, 'station').ok, false);
assert.equal(metro.edit(x + 4, y, 'tunnel').ok, true, 'underwater tunnel permitted');
world.setTile(x + 2, y + 4, Terrain.Grass);
assert.equal(metro.edit(x + 2, y + 4, 'station').ok, false, 'station needs road access');
assert.ok(changes >= 10, 'changes notify saving');

const sim = new MacroSim(world, state),
  tools = new Tools(world, {} as WorldRenderer, sim);
for (let dy = -8; dy <= 8; dy++)
  for (let dx = -8; dx <= 12; dx++) world.setHeight(x + dx, y + dy, 0);
tools.setTool('metroTunnel');
assert.equal(tools.isPainting(), true);
tools.beginPaint(tileToWorldX(x, y), tileToWorldY(x, y));
tools.movePaint(tileToWorldX(x + 3, y), tileToWorldY(x + 3, y));
tools.endPaint();
assert.ok(sim.metro.path(`${x},${y}`, `${x + 3},${y}`), 'real drag brush builds continuous tunnel');
tools.setTool('metroStation');
assert.equal(tools.isPainting(), 'tap');
tools.setTool('metroErase');
assert.equal(tools.isPainting(), 'tap');
tools.setTool('metroView');
assert.equal(tools.isPainting(), false);
sim.resetState(60000, 0);
assert.equal(state.metro, undefined);
assert.equal(sim.metro.path(`${x},${y}`, `${x + 3},${y}`), null);
console.log(
  'Metro construction passed: station/tunnel costs, duplicates, road access, surface preservation, continuous drag, graph split, shortest path, old saves, JSON restore, insufficient funds, unexplored land, underwater tunnels, reset.',
);
