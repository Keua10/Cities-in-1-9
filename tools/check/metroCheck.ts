import { strict as assert } from 'node:assert';
import { facCode } from '../../src/sim/buildings';
import { facilityArt } from '../../src/render/facilityArt';
import { World } from '../../src/world/world';
import { Build } from '../../src/world/build';
import { Terrain } from '../../src/world/terrain';
import { CHUNK_SIZE, CHUNK_TILES } from '../../src/core/constants';
import { decodeOverride, encodeOverride } from '../../src/net/codec';
import type { ChunkOverride } from '../../src/world/world';
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
  world.setBuild(x + dx, y + 1, Build.Road, false);
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
assert.equal(world.getBld(x, y), facCode(26), 'station owns real surface building');
assert.equal(world.getBuild(x, y + 1), Build.Road, 'adjacent road preserved');
const restoredState = JSON.parse(JSON.stringify(state));
const restored = new MetroNetwork(world, restoredState, () => {});
assert.equal(metro.stationAccess(`${x},${y}`), true);
const line = metro.saveLine(null, '중앙선', '#68b6ac', [`${x},${y}`, `${x + 8},${y}`]);
assert.equal(line.ok, true);
assert.equal(metro.saveLine(null, '빈 노선', '#68b6ac', []).ok, false);
assert.equal(metro.saveLine(null, '중복', '#68b6ac', [`${x},${y}`, `${x},${y}`]).ok, false);
assert.equal(metro.saveLine(line.id!, '역순', '#ce9960', [`${x + 8},${y}`, `${x},${y}`]).ok, true);
assert.equal(metro.state.lines?.length, 1);
assert.equal(metro.linePath(metro.state.lines![0].stops)?.length, 9);
const savedLines = new MetroNetwork(world, JSON.parse(JSON.stringify(state)), () => {});
assert.equal(savedLines.state.lines?.[0].name, '역순');
assert.equal(savedLines.stationAccess(`${x},${y}`), true);
const chunks = new Map<string, ChunkOverride>();
for (const c of world.takeDirty().chunks)
  chunks.set(`${c.cx},${c.cy}`, {
    ...c,
    build: decodeOverride(encodeOverride(c.build), CHUNK_TILES),
    bld: decodeOverride(encodeOverride(c.bld), CHUNK_TILES),
  });
const restoredWorld = new World(0);
restoredWorld.setPersistedOverrides(chunks);
const completeRestore = new MetroNetwork(
  restoredWorld,
  JSON.parse(JSON.stringify(state)),
  () => {},
);
assert.equal(restoredWorld.getBld(x, y), facCode(26), 'new facility code survives RLE parcel save');
assert.equal(
  completeRestore.stationAccess(`${x},${y}`),
  true,
  'surface access survives full world and macro reload',
);
assert.equal(completeRestore.linePath(completeRestore.state.lines![0].stops)?.length, 9);
restoredWorld.setBuild(x, y + 1, Build.None);
assert.equal(
  completeRestore.stationAccess(`${x},${y}`),
  false,
  'removed road closes passenger access',
);
const art = facilityArt(26);
assert.equal(art.size, 64);
assert.equal(art.clippedPixels, 0, 'station sprite stays inside native footprint canvas');
assert.ok(
  art.data.every((v, i) => i % 4 !== 3 || v === 0 || v === 255),
  'binary pixel alpha',
);
assert.equal(metro.edit(x + 1, y + 1, 'station').ok, false, 'cannot replace road');
world.setBuild(x + 3, y - 1, Build.ZoneR);
assert.equal(metro.edit(x + 3, y - 1, 'station').ok, false, 'cannot replace zoned plot');
assert.equal(
  restored.path(`${x},${y}`, `${x + 8},${y}`)?.length,
  9,
  'serialized city restores same path',
);
metro.edit(x + 4, y, 'erase');
assert.equal(
  metro.linePath(metro.state.lines![0].stops),
  null,
  'broken route is not silently rerouted through absent track',
);
assert.equal(
  metro.saveLine(line.id!, '연결 끊김', '#68b6ac', metro.state.lines![0].stops).ok,
  false,
);
assert.equal(
  metro.path(`${x},${y}`, `${x + 8},${y}`),
  null,
  'removed middle tunnel disconnects network',
);
assert.equal(world.getBuild(x + 4, y + 1), Build.Road, 'underground removal preserves road');
metro.edit(x, y, 'erase');
assert.equal(world.getBuild(x, y), Build.None, 'station removal removes its surface facility');
assert.equal(
  metro.state.lines?.[0].stops.length,
  2,
  'broken line retains stop references for explicit repair',
);
metro.deleteLine(line.id!);
assert.equal(metro.state.lines?.length, 0);
assert.ok(metro.state.stations[`${x + 8},${y}`], 'deleting route preserves station');
delete metro.state.stations[`${x + 8},${y}`].surface;
world.removeFacilityAt(x + 8, y);
assert.equal(
  metro.stationAccess(`${x + 8},${y}`),
  false,
  'legacy station is not falsely accessible',
);
assert.equal(metro.repairSurface(`${x + 8},${y}`).ok, true);
assert.equal(metro.stationAccess(`${x + 8},${y}`), true);
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
// 터널도 두 점 + 확정이다. 드래그는 언제나 지도 이동으로 간다.
assert.equal(tools.isPainting(), 'tap');
tools.tapAtWorld(tileToWorldX(x, y), tileToWorldY(x, y));
tools.tapAtWorld(tileToWorldX(x + 3, y), tileToWorldY(x + 3, y));
assert.equal(sim.metro.path(`${x},${y}`, `${x + 3},${y}`), null, 'nothing is built before ✓');
tools.confirmPlacement();
assert.ok(sim.metro.path(`${x},${y}`, `${x + 3},${y}`), 'two taps build a continuous tunnel');
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
