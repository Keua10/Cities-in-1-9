import { strict as assert } from 'node:assert';
import { createCanvas } from '@napi-rs/canvas';
import { Texture } from 'pixi.js';
import { TerrainStructureScene } from '../../src/render/terrainStructureScene';
import { VehicleMesh, type VehicleSceneData } from '../../src/render/vehicleMesh';
import { writeQuad } from '../../src/render/quadBuffers';
import { World } from '../../src/world/world';
import { Build } from '../../src/world/build';
import { surfaceHeightAt } from '../../src/world/slope';
import { lanePosition } from '../../src/sim/traffic/laneGeometry';
import { tileToWorldX, tileToWorldY } from '../../src/core/iso';
import { MAX_ACTIVE_VEHICLES } from '../../src/core/constants';
import type { Vehicle } from '../../src/sim/traffic/vehicles';
import { drawPlaceholder } from '../../src/render/vehicleAtlas';
import { worldToTileF } from '../../src/core/iso';

(globalThis as any).document = { createElement: () => createCanvas(1, 1) };
const terrainArt = createCanvas(64, 32),
  buildingArt = createCanvas(64, 64),
  carArt = createCanvas(32, 32);
for (const [canvas, color] of [
  [terrainArt, '#208030'],
  [buildingArt, '#f02090'],
  [carArt, '#20c0ff'],
] as const) {
  canvas.getContext('2d').fillStyle = color;
  canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height);
}
// A transparent opening must reveal just the part of the rear vehicle beneath it.
buildingArt.getContext('2d').clearRect(0, 24, 32, 16);
const children: any[] = [];
const parent: any = {
  addChild: (m: any) => children.push(m),
  removeChild: (m: any) => children.splice(children.indexOf(m), 1),
};
const scene = new TerrainStructureScene(
  parent,
  Texture.from(terrainArt),
  Texture.from(buildingArt),
);
const positions = new Float32Array(8),
  uvs = new Float32Array(8);
writeQuad(positions, 0, 0, 0, 64, 64);
writeQuad(uvs, 0, 0, 0, 1, 1);
const ground: any = {
  revision: 0,
  heightRevision: 0,
  visualRevision: 0,
  sceneTiles: () => ({ positions, uvs, tiles: [{ tx: 0, ty: 0, start: 0, count: 1 }] }),
};
const structure: any = {
  sceneData: () => ({
    positions,
    uvs,
    quads: [{ tx: 0, ty: 0, depth: 2, span: 1, kind: null, zone: 0, variant: 0 }],
  }),
};
scene.update([ground], [structure]);
// Attaching traffic after a first frame must rebuild packed UVs for the taller atlas.
scene.setVehicleTexture(Texture.from(carArt));
scene.update([ground], [structure]);
const data: VehicleSceneData = {
  positions: new Float32Array(8),
  uvs: new Float32Array(8),
  depths: [1],
};
writeQuad(data.positions, 0, 16, 16, 48, 48);
writeQuad(data.uvs, 0, 0, 0, 1, 1);
function raster() {
  const canvas = createCanvas(64, 64),
    ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  for (const mesh of [...children].sort((a, b) => a.zIndex - b.zIndex)) {
    if (mesh.visible === false) continue;
    const art = mesh.texture.source.resource,
      p = mesh.geometry.positions,
      u = mesh.geometry.uvs;
    for (let i = 0; i < p.length; i += 8) {
      if (p[i + 2] === p[i] || p[i + 5] === p[i + 1]) continue;
      ctx.drawImage(
        art,
        u[i] * art.width,
        u[i + 1] * art.height,
        (u[i + 2] - u[i]) * art.width,
        (u[i + 5] - u[i + 1]) * art.height,
        p[i],
        p[i + 1],
        p[i + 2] - p[i],
        p[i + 5] - p[i + 1],
      );
    }
  }
  return (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data];
}
scene.updateVehicles(data);
let pixel = raster();
assert.deepEqual(pixel(40, 32), [240, 32, 144, 255], 'front wall covers rear vehicle');
assert.deepEqual(pixel(24, 32), [32, 192, 255, 255], 'opening reveals part of same rear vehicle');
data.depths[0] = 3;
scene.updateVehicles(data);
pixel = raster();
assert.deepEqual(
  pixel(40, 32),
  [32, 192, 255, 255],
  'front vehicle covers wall where their images overlap',
);
const staticMeshes = children.filter((m) => m.zIndex % 3 !== 1);
const rebuilds = scene.rebuildCount;
for (let frame = 0; frame < 120; frame++) {
  data.depths[0] = frame % 4;
  scene.update([ground], [structure]);
  scene.updateVehicles(data);
}
assert.equal(scene.rebuildCount, rebuilds, 'moving vehicles do not rebuild static geometry');
assert.ok(
  staticMeshes.every((m) => children.includes(m)),
  'static mesh identity survives traffic updates',
);
scene.setOpacity(0.22);
const packed = children[0].texture.source.resource;
assert.equal(
  packed.getContext('2d').getImageData(1, 100, 1, 1).data[3],
  255,
  'utility overlay leaves traffic opaque',
);
const many: VehicleSceneData = {
  positions: new Float32Array(MAX_ACTIVE_VEHICLES * 8),
  uvs: new Float32Array(MAX_ACTIVE_VEHICLES * 8),
  depths: Array(MAX_ACTIVE_VEHICLES).fill(1),
};
for (let i = 0; i < many.depths.length; i++) {
  writeQuad(many.positions, i, 16, 16, 48, 48);
  writeQuad(many.uvs, i, 0, 0, 1, 1);
}
scene.updateVehicles(many);
const band = children.find((m) => m.zIndex === 4);
assert.ok(
  band.geometry.positions.length >= MAX_ACTIVE_VEHICLES * 8,
  'band capacity handles global vehicle limit',
);
data.depths = [1];
scene.updateVehicles(data);
assert.ok(
  band.geometry.positions.slice(8).every((n: number) => n === 0),
  'shrinking traffic clears old quads',
);
scene.update([], []);
scene.updateVehicles({ positions: new Float32Array(), uvs: new Float32Array(), depths: [] });
assert.equal(children.length, 0, 'empty view frees both static and pooled vehicle bands');

// Sample production vehicle geometry on both lanes over a connected ramp, and through a turn.
const world = new World(0),
  x0 = world.baseCx * 64 + 20,
  y0 = world.baseCy * 64 + 20;
for (let y = -2; y <= 5; y++)
  for (let x = -4; x <= 4; x++) world.setHeight(x0 + x, y0 + y, x >= 0 ? 1 : 0);
for (let x = -3; x <= 3; x++) {
  world.setBuild(x0 + x, y0, Build.Road, false);
  if (x > -3) world.connectRoads(x0 + x - 1, y0, x0 + x, y0);
}
for (let y = 1; y <= 3; y++) {
  world.setBuild(x0 + 3, y0 + y, Build.Road, false);
  world.connectRoads(x0 + 3, y0 + y - 1, x0 + 3, y0 + y);
}
const points = Array.from({ length: 7 }, (_, i) => [x0 + i - 3, y0]).concat([
  [x0 + 3, y0 + 1],
  [x0 + 3, y0 + 2],
  [x0 + 3, y0 + 3],
]);
const vehicleMesh = new VehicleMesh(world, {
  texture: Texture.from(carArt),
  placeholder: false,
  uv: () => [0, 0, 1, 1],
});
for (const routePoints of [points, [...points].reverse()]) {
  const vehicle = {
    route: { tiles: new Int32Array(routePoints.flat()), costAtPlan: 0 },
    routeIdx: 0,
    tileT: 0,
    kind: 0,
    tier: 0,
    destTx: 0,
    destTy: 0,
  } as Vehicle;
  for (let frame = 0; frame < 900; frame++) {
    const progress = frame / 100;
    vehicle.routeIdx = Math.floor(progress);
    vehicle.tileT = progress % 1;
    vehicleMesh.update([vehicle]);
    const d = vehicleMesh.sceneData(),
      [x, y] = lanePosition(vehicle.route, vehicle.routeIdx, vehicle.tileT);
    const p = d.positions;
    assert.ok(Math.abs((p[0] + p[2]) / 2 - tileToWorldX(x, y)) < 0.01, 'exact lane x');
    assert.ok(
      Math.abs(p[1] + 21 - tileToWorldY(x, y, surfaceHeightAt(world, x, y))) < 0.01,
      'wheel anchor uses road surface through slopes and turns',
    );
    assert.ok(Math.abs(p[2] - p[0] - 32) < 0.001, 'native 32px width within Float32 precision');
    assert.ok(Math.abs(p[5] - p[1] - 32) < 0.001, 'native 32px height within Float32 precision');
    assert.equal(d.depths.length, 1);
  }
}
vehicleMesh.update([]);
assert.equal(vehicleMesh.sceneData().depths.length, 0, 'no stale vehicles after route removal');
// Raster pixels at the nose/wheels can extend onto the next tile before the center does.
// They must not be cut by a later flat road quad, in either direction or during a turn.
const actualCars = createCanvas(512, 64);
drawPlaceholder(actualCars.getContext('2d') as unknown as CanvasRenderingContext2D);
const pixels = actualCars.getContext('2d').getImageData(0, 0, 512, 64).data;
const nativeMesh = new VehicleMesh(world, {
  texture: Texture.from(actualCars),
  placeholder: true,
  uv: (kind, dir, variant) => {
    const x = (dir * 4 + variant) * 32,
      y = kind * 32;
    return [x / 512, y / 64, (x + 32) / 512, (y + 32) / 64];
  },
});
for (let y = -2; y <= 5; y++) for (let x = -4; x <= 4; x++) world.setHeight(x0 + x, y0 + y, 0);
let clipped = 0;
for (const routePoints of [points, [...points].reverse()])
  for (const kind of [0, 1]) {
    const v = {
      route: { tiles: new Int32Array(routePoints.flat()), costAtPlan: 0 },
      routeIdx: 0,
      tileT: 0,
      kind,
      tier: 0,
      destTx: 0,
      destTy: 0,
    } as Vehicle;
    for (let frame = 0; frame < 900; frame++) {
      v.routeIdx = Math.floor(frame / 100);
      v.tileT = (frame / 100) % 1;
      nativeMesh.update([v]);
      const d = nativeMesh.sceneData(),
        p = d.positions,
        u = d.uvs;
      for (let py = 0; py < 32; py++)
        for (let px = 0; px < 32; px++) {
          if (
            pixels[((Math.round(u[1] * 64) + py) * 512 + Math.round(u[0] * 512) + px) * 4 + 3] < 128
          )
            continue;
          const tile = worldToTileF(p[0] + px + 0.5, p[1] + py + 0.5);
          if (Math.round(tile.tx) + Math.round(tile.ty) > d.depths[0]) clipped++;
        }
    }
  }
assert.equal(clipped, 0, 'flat road never covers an opaque vehicle pixel at a tile seam');
delete (globalThis as any).document;
console.log(
  'PASS vehicle scene: partial rear occlusion, front visibility, zero flat-road clipped pixels over 3600 native-car frames, both ramp directions and turns, static cache, attach UV rebuild, utility alpha, 1000-car capacity, shrink and empty cleanup',
);
