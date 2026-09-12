import { strict as assert } from 'node:assert';
import { createCanvas } from '@napi-rs/canvas';
import { Texture } from 'pixi.js';
import { CHUNK_SIZE } from '../../src/core/constants';
import { tileToWorldY } from '../../src/core/iso';
import { World } from '../../src/world/world';
import { Build } from '../../src/world/build';
import { makeSlopeSampler, surfaceAt, surfaceHeightAt } from '../../src/world/slope';
import { ChunkMesh } from '../../src/render/chunkMesh';
import { StructureMesh, collectStructures } from '../../src/render/structureMesh';
import {
  TerrainStructureScene,
  sortSceneCommands,
  type SceneCommand,
} from '../../src/render/terrainStructureScene';

(globalThis as any).document = { createElement: () => createCanvas(1, 1) };
const groundArt = createCanvas(64, 32),
  buildingArt = createCanvas(192, 192);
groundArt.getContext('2d').fillStyle = '#208030';
groundArt.getContext('2d').fillRect(0, 0, 64, 32);
buildingArt.getContext('2d').fillStyle = '#f02090';
buildingArt.getContext('2d').fillRect(0, 0, 192, 192);
const terrain: any = {
  texture: Texture.from(groundArt),
  uv: () => [0, 0, 1, 1],
  uvWall: () => [0, 0, 1, 1],
};
const atlas: any = {
  texture: Texture.from(buildingArt),
  buildingUv: () => [0, 0, 1, 1],
  facilityUv: () => [0, 0, 1, 1],
};
const world = new World(0),
  cx = world.baseCx,
  cy = world.baseCy,
  x = (cx + 1) * CHUNK_SIZE,
  y = cy * CHUNK_SIZE + 12;
for (let oy = -3; oy <= 5; oy++)
  for (let ox = -6; ox <= 6; ox++) world.setHeight(x + ox, y + oy, ox >= 0 ? 1 : 0);
for (let ox = -3; ox <= 3; ox++) {
  world.setBuild(x + ox, y + 3, Build.Road, false);
  if (ox > -3) world.connectRoads(x + ox - 1, y + 3, x + ox, y + 3);
}
// Connected ramp planes, including both directions of the shared boundary.
assert.notEqual(surfaceAt(world, x - 1, y + 3).dzx, 0);
const left = surfaceAt(world, x - 1, y + 3),
  right = surfaceAt(world, x, y + 3);
assert.equal(left.zc + left.dzx / 2, right.zc - right.dzx / 2);
assert.ok(
  Math.abs(
    surfaceHeightAt(world, x - 0.5 - 1e-5, y + 3) - surfaceHeightAt(world, x - 0.5 + 1e-5, y + 3),
  ) < 1e-4,
);
world.placeBuilding(x - 3, y, 0, 3, 0);
world.placeFacility(x - 1, y - 3, 2, 0);
const parcels = [world.getParcel(cx, cy), world.getParcel(cx + 1, cy)];
const quads = parcels.flatMap(collectStructures);
const structure = new StructureMesh(parcels[0], atlas, (x, y) => world.sampleHeight(x, y), quads);
const ground = [cx, cx + 1].map(
  (c) => new ChunkMesh(world.getChunk(c, cy), terrain, () => 0, makeSlopeSampler(world)),
);
const children: any[] = [];
const parent: any = {
  addChild: (m: any) => children.push(m),
  removeChild: (m: any) => children.splice(children.indexOf(m), 1),
};
const scene = new TerrainStructureScene(parent, terrain.texture, atlas.texture);
scene.update(ground, [structure]);
assert.equal(children.length, 1, 'terrain and both structure types share one draw mesh');
const commands: SceneCommand[] = [];
for (const mesh of ground) {
  const d = mesh.sceneTiles();
  for (const t of d.tiles)
    commands.push({
      ...t,
      span: 1,
      depth: t.tx + t.ty,
      structure: false,
      positions: d.positions,
      uvs: d.uvs,
    });
}
const sd = structure.sceneData();
sd.quads.forEach((q, i) =>
  commands.push({
    ...q,
    structure: true,
    start: i,
    count: 1,
    positions: sd.positions,
    uvs: sd.uvs,
  }),
);
sortSceneCommands(commands);
const g = children[0].geometry;
let offset = 0;
for (const command of commands) {
  const length = command.count * 8;
  assert.deepEqual(
    g.positions.slice(offset, offset + length),
    command.positions.slice(command.start * 8, command.start * 8 + length),
    'every terrain/ramp/wall and sprite vertex preserved',
  );
  offset += length;
}
assert.equal(offset, g.positions.length, 'all quads included once');
for (const q of quads) {
  const index = commands.findIndex((c) => c.structure && c.tx === q.tx && c.ty === q.ty);
  for (let dy = 0; dy < q.span; dy++)
    for (let dx = 0; dx < q.span; dx++) {
      const tileIndex = commands.findIndex(
        (c) => !c.structure && c.tx === q.tx + dx && c.ty === q.ty + dy,
      );
      assert.ok(
        tileIndex >= 0 && tileIndex < index,
        'entire footprint including adjacent chunk precedes sprite',
      );
    }
  assert.ok(
    commands.slice(index + 1).some((c) => !c.structure && c.depth > q.depth),
    'front high terrain is not forced behind all buildings',
  );
}
// A ground quad in the next chunk but behind a structure must precede it.
const building = quads.find((q) => q.kind === null)!;
const behind = commands.findIndex((c) => !c.structure && c.tx === x && c.ty === y - 1);
const structureIndex = commands.findIndex(
  (c) => c.structure && c.tx === building.tx && c.ty === building.ty,
);
assert.ok(behind < structureIndex, 'next-chunk back ground cannot paint over the building');
const qIndex = sd.quads.indexOf(building);
const bottom =
  tileToWorldY(building.tx + 2, building.ty + 2, world.sampleHeight(building.tx, building.ty)) + 16;
assert.equal(
  sd.positions[qIndex * 8 + 5] - 1,
  bottom,
  'one-pixel bottom gutter compensated without scaling',
);

const mesh = children[0];
for (let frame = 0; frame < 120; frame++) scene.update(ground, [structure]);
assert.equal(scene.rebuildCount, 1, 'idle/camera frames reuse scene');
assert.equal(children[0], mesh);
ground[0].setTile(1, 1, 0);
scene.update(ground, [structure]);
assert.equal(scene.rebuildCount, 2, 'single road UV update invalidates scene');
scene.setOpacity(0.22);
const packed = children[0].texture.source.resource;
assert.equal(
  packed.getContext('2d').getImageData(1, 1, 1, 1).data[3],
  255,
  'utility mode keeps ground opaque',
);
assert.ok(
  packed.getContext('2d').getImageData(1, 33, 1, 1).data[3] < 60,
  'utility mode dims structures only',
);
scene.setOpacity(1);
scene.update([ground[1]], []);
assert.equal(children.length, 1, 'removing visible sources replaces old scene');
scene.update([], []);
assert.deepEqual(
  [...children[0].geometry.indices],
  [0, 0, 0, 0, 0, 0],
  'empty/fogged view clears previous art',
);
delete (globalThis as any).document;
console.log(
  'PASS terrain scene: global cross-chunk order, footprint and front-cliff occlusion, exact ramp/wall vertices, ramp continuity, gutter anchor, idle reuse, UV invalidation, utility alpha and empty-view cleanup',
);
