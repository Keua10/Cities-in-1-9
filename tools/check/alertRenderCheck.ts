import assert from 'node:assert/strict';
import { BuildingAlertLayer } from '../../src/render/buildingAlertLayer';
import { PollutionLayer } from '../../src/render/pollutionLayer';
import { Camera } from '../../src/core/camera';
import { World } from '../../src/world/world';
import { ZONE_R } from '../../src/sim/buildings';
import { Terrain } from '../../src/world/terrain';
import { tileToWorldY } from '../../src/core/iso';
import type { MacroSim } from '../../src/sim/macro';
import { FAC_INCINERATOR } from '../../src/sim/config/sanitation';
const world = new World();
world.sampleHeight = () => 0;
world.getTile = () => Terrain.Grass;
world.isExplored = () => true;
world.placeBuilding(20, 20, ZONE_R, 1, 0);
const sim = { tick: 1, buildingAlerts: () => ['power', 'water', 'sewer'] } as unknown as MacroSim;
const camera = new Camera();
camera.resize(1200, 800);
camera.y = tileToWorldY(20, 20, 0);
const range = { cx0: 0, cy0: 0, cx1: 0, cy1: 0 };
const layer = new BuildingAlertLayer();
let width = 0;
for (const zoom of [0.2, 0.5, 1, 2, 3]) {
  camera.zoom = zoom;
  layer.draw(world, sim, range, true, camera, 0);
  const screenWidth = layer.graphics.getLocalBounds().width * layer.graphics.scale.x * zoom;
  width ||= screenWidth;
  assert.equal(screenWidth, width, 'Real Pixi glyph geometry keeps fixed pixel width');
  assert.equal(layer.graphics.scale.x * zoom, 1);
}
camera.zoom = 1;
layer.draw(world, sim, range, true, camera, 0);
const power = JSON.stringify(
  layer.graphics.context.instructions.map((i) =>
    i.action === 'fill' || i.action === 'stroke' ? i.data.style.color : i.action,
  ),
);
layer.draw(world, sim, range, true, camera, 500);
assert(Math.abs(layer.graphics.position.y) > 1, 'Paused simulation still bobs');
assert(layer.graphics.alpha < 1, 'Pulse is animated');
layer.draw(world, sim, range, true, camera, 2400);
assert.notEqual(
  JSON.stringify(
    layer.graphics.context.instructions.map((i) =>
      i.action === 'fill' || i.action === 'stroke' ? i.data.style.color : i.action,
    ),
  ),
  power,
  'Multiple issues cycle without a sim tick',
);
layer.draw(world, sim, range, false, camera, 2500);
assert.equal(layer.graphics.visible, false);
layer.draw(world, sim, range, true, camera, 2500);
assert.equal(layer.graphics.visible, true);
world.demolishAt(20, 20);
layer.draw(world, sim, range, true, camera, 2500);
assert.equal(
  layer.graphics.context.instructions.length,
  0,
  'Removed building leaves no stale alert',
);
const pollution = new PollutionLayer();
world.placeFacility(20, 20, FAC_INCINERATOR, 0);
pollution.update(world, null, range, true);
assert(
  pollution.graphics.context.instructions.length > 0,
  'Land pollution renders without a water network',
);
world.demolishAt(20, 20);
pollution.update(world, null, range, true);
assert.equal(
  pollution.graphics.context.instructions.length,
  0,
  'Land overlay invalidates on demolition',
);
console.log(
  'PASS real Pixi geometry: constant screen size, paused bob/pulse, issue cycling, toggle, stale alert/overlay removal',
);

// Hit testing uses the same world transform, zoom cancellation and bob as drawing.
world.placeBuilding(20, 20, ZONE_R, 1, 0);
for (const zoom of [0.2, 0.55, 1, 3]) {
  camera.zoom = zoom;
  layer.draw(world, sim, range, true, camera, 500);
  const wy = tileToWorldY(20, 20, 0) - 16 * 1.6 - 12 / zoom + layer.graphics.position.y;
  assert.deepEqual(layer.hitTest(0, wy)?.alerts, ['power', 'water', 'sewer']);
  assert.equal(layer.hitTest(100 / zoom, wy), null);
  layer.draw(world, sim, range, false, camera, 500);
  assert.equal(layer.hitTest(0, wy), null);
}
console.log('PASS alert hit targets at every zoom, animated bob, hidden and missed targets');
