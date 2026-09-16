import { strict as assert } from 'node:assert';
import { World } from '../../src/world/world';
import { Build } from '../../src/world/build';
import { MacroSim } from '../../src/sim/macro';
import { JunctionIndex, type Junction } from '../../src/sim/traffic/junctions';
import {
  configureSignals,
  SignalCoordinator,
  AUTO_SIGNAL_SPACING,
} from '../../src/sim/traffic/signalPolicy';
import {
  signalState,
  SignalState,
  SIGNAL_PERIOD_MS,
  greenRemainingMs,
} from '../../src/sim/traffic/signals';
import { signalMount } from '../../src/render/signalLayer';
import { walkingDirection, PedestrianLayer } from '../../src/render/pedestrianLayer';
import { createCanvas } from '@napi-rs/canvas';
import { Texture } from 'pixi.js';
import { tileToWorldX, tileToWorldY } from '../../src/core/iso';
import { CHUNK_SIZE } from '../../src/core/constants';
import type { MacroState } from '../../src/net/types';
import type { Vehicle } from '../../src/sim/traffic/vehicles';

const world = new World(0);
const state: MacroState = { money: 1000, population: 0, tick: 0, tickedAt: 0 };
const sim = new MacroSim(world, state);
for (let x = -24; x <= 24; x++)
  for (let y = -24; y <= 24; y++)
    if (x % 6 === 0 || y % 6 === 0) world.setBuild(x, y, Build.Road, false);
const index = new JunctionIndex();
const rebuild = () => index.build(world, -24, -24, 24, 24);
rebuild();
assert.ok(index.junctions.length > 20);
assert.equal(
  index.junctions.filter((j) => j.signalized).length,
  0,
  'short residential blocks yield instead of signaling every corner',
);
assert.equal(sim.setRoadSignal(1, 1, true), false, 'non-road refused');
assert.equal(sim.setRoadSignal(0, 0, true), true);
rebuild();
assert.equal(index.at(0, 0)?.signalized, true);
sim.setRoadSignal(0, 0, false);
rebuild();
assert.equal(index.at(0, 0)?.signalized, false);
sim.setRoadSignal(2, 0, true);
rebuild();
assert.equal(index.at(2, 0)?.signalized, true, 'manual straight-road signal');
const restored = new World(0);
new MacroSim(restored, JSON.parse(JSON.stringify(state)));
assert.deepEqual(restored.signalOverrides, world.signalOverrides, 'save/load manual overrides');
world.setBuild(2, 0, Build.None, false);
assert.equal(state.signalOverrides?.['2,0'], undefined, 'demolition clears saved override');

const wide = new World(0);
const wideSim = new MacroSim(wide, { ...state, signalOverrides: {} });
for (let x = -24; x <= 24; x++) for (let y = 0; y <= 1; y++) wide.setBuild(x, y, Build.Road, false);
for (let y = -24; y <= 24; y++) for (let x = 0; x <= 1; x++) wide.setBuild(x, y, Build.Road, false);
index.build(wide, -24, -24, 24, 24);
assert.equal(index.at(0, 0)?.signalized, true);
wideSim.setRoadSignal(0, 0, false);
wideSim.setRoadSignal(1, 1, true);
index.build(wide, -24, -24, 24, 24);
assert.equal(
  index.at(0, 0)?.signalized,
  true,
  'reinstall anywhere in same junction clears removal',
);

function junction(x: number, y = 0): Junction {
  return {
    id: x + 100,
    minX: x,
    maxX: x,
    minY: y,
    maxY: y,
    cells: new Int32Array([x, y]),
    legs: [0, 1, 2, 3].map((enterDir) => ({ enterDir, length: 12, width: 2 })),
    legMask: 15,
    maxLegWidth: 2,
    signalized: true,
    offsetMs: 0,
  };
}
const group = [0, 6, 12, 18, 24, 30, 36].map((x) => junction(x));
configureSignals(new World(0), group);
const active = group.filter((j) => j.signalized);
assert.ok(active.length >= 2);
for (let i = 1; i < active.length; i++)
  assert.ok(active[i].minX - active[i - 1].minX >= AUTO_SIGNAL_SPACING);
const a = junction(0),
  b = junction(18);
configureSignals(new World(0), [a, b]);
for (let t = 0; t < SIGNAL_PERIOD_MS; t += 50)
  assert.equal(
    signalState(a, 0, t),
    signalState(b, 0, t + 3000),
    'sequential corridor progression at travel speed',
  );
for (const dir of [0, 1, 2, 3]) {
  const m = signalMount(a, dir);
  assert.ok((dir & 1 ? Math.abs(m.tx) : Math.abs(m.ty)) > 0.4, 'pole on verge not center');
  assert.ok(Math.hypot(m.hx - m.tx, m.hy - m.ty) > 0.3, 'arm reaches over lane');
}
const coordinator = new SignalCoordinator();
const vehicles = Array.from(
  { length: 30 },
  () => ({ dir: 1, speed: 0, routeIdx: 0, route: { tiles: new Int32Array([0, 0]) } }) as Vehicle,
);
let oldGreen = a.green0Ms!,
  oldOffset = a.offsetMs,
  changes = 0;
for (let time = 0; time <= 300000; time += 50) {
  coordinator.update([a], vehicles, time);
  if (a.green0Ms !== oldGreen || a.offsetMs !== oldOffset) {
    assert.ok(Math.abs(a.green0Ms! - oldGreen) <= 500);
    changes++;
    oldGreen = a.green0Ms!;
    oldOffset = a.offsetMs;
  }
  assert.ok(
    !(
      signalState(a, 0, time) === SignalState.Green && signalState(a, 1, time) === SignalState.Green
    ),
    'no conflicting greens under adaptation',
  );
  assert.ok(a.green0Ms! >= 4500 && a.green0Ms! <= 9500, 'minor axis cannot starve');
  for (const dir of [0, 1])
    if (signalState(a, dir, time) !== SignalState.Green)
      assert.equal(greenRemainingMs(a, dir, time), 0);
}
assert.ok(a.green0Ms! < 7000, 'sustained y demand receives more green');
assert.ok(changes <= 16, 'bounded cycle updates');
const path: [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 1],
];
assert.deepEqual(
  [0.5, 1.5, 2.5, 3.5].map((progress) => walkingDirection({ path, progress })),
  [0, 1, 3, 2],
  'turn and return facing',
);
console.log(
  'Signal policy passed: block spacing, road-only overrides, save/load, straight roads, multi-cell reinstall, corridor progression, bounded adaptation, no conflicting greens, roadside arms, walker turns.',
);

const art = createCanvas(64, 64),
  ctx = art.getContext('2d');
ctx.fillStyle = '#fff';
ctx.fillRect(0, 0, 64, 64);
ctx.clearRect(24, 12, 8, 8);
const atlas = {
  texture: Texture.from(art),
  placeholder: false,
  uv: () => [0, 0, 1, 1] as [number, number, number, number],
};
const occlusionWorld = new World(0);
const bx = occlusionWorld.baseCx * CHUNK_SIZE + 8,
  by = occlusionWorld.baseCy * CHUNK_SIZE + 8;
occlusionWorld.setHeight(bx, by, 0);
occlusionWorld.setBuild(bx, by, Build.ZoneR, false);
occlusionWorld.placeBuilding(bx, by, 0, 1, 0);
const layer = new PedestrianLayer(atlas, atlas);
layer.prepare(occlusionWorld, {
  cx0: occlusionWorld.baseCx,
  cy0: occlusionWorld.baseCy,
  cx1: occlusionWorld.baseCx,
  cy1: occlusionWorld.baseCy,
});
const left = tileToWorldX(bx, by) - 32,
  top = tileToWorldY(bx, by) - 47;
const rearMask = layer.maskFor(bx - 1, by - 1, left + 30, top + 30);
assert.equal(rearMask(left + 20, top + 20), true, 'rear pole pixels hidden by opaque facade');
assert.equal(rearMask(left + 26, top + 16), false, 'transparent sprite gap preserves pole pixels');
assert.equal(
  layer.maskFor(bx + 1, by + 1, left + 30, top + 30)(left + 20, top + 20),
  false,
  'front pole remains visible',
);
console.log(
  'Signal alpha depth passed: rear facade masks only opaque pixels, transparent gaps and front poles remain visible.',
);
