import { strict as assert } from 'node:assert';
import { createCanvas } from '@napi-rs/canvas';
import { CHUNK_SIZE, CHUNK_TILES } from '../../src/core/constants';
import { BLD_NONE, bldCode, facCode } from '../../src/sim/buildings';
import { World } from '../../src/world/world';
import type { Parcel } from '../../src/world/world';
import { Build } from '../../src/world/build';
import {
  collectStructures,
  combineStructureAtlas,
  StructureMesh,
} from '../../src/render/structureMesh';
import { findFacilities } from '../../src/ui/facilityFinder';
import { FACILITY_SPECS } from '../../src/sim/facilities';
import { StructureLayer, structuresInBucket } from '../../src/render/structureLayer';

// The old renderer unconditionally put ALL civic art above ALL zoned buildings.
// A park behind a tall office must precede it, while a fire station in front follows it.
const p = {
  cx: -1,
  cy: 2,
  bld: new Uint8Array(CHUNK_TILES).fill(BLD_NONE),
  bldRevision: 1,
} as Parcel;
p.bld![2 * CHUNK_SIZE + 2] = facCode(5);
p.bld![4 * CHUNK_SIZE + 2] = bldCode(1, 3);
p.bld![8 * CHUNK_SIZE + 8] = facCode(0);
assert.deepEqual(
  collectStructures(p).map((q) => q.kind),
  [5, null, 0],
);
const atlas: any = {
  texture: {},
  buildingUv: () => [0, 0, 0.25, 0.25],
  facilityUv: () => [0.5, 0.5, 0.75, 0.75],
};
const mesh = new StructureMesh(p, atlas, () => 0);
assert.deepEqual(mesh.counts, { buildings: 1, facilities: 2 });
const geometry = (mesh.mesh as any).geometry;
assert.equal(geometry.positions.length, 24);
assert.equal(geometry.indices.length, 18);
assert.deepEqual([geometry.uvs[0], geometry.uvs[8], geometry.uvs[16]], [0.5, 0, 0.5]);
assert.equal(mesh.needsRebuild(p), false);
assert.equal(mesh.needsRebuild({ ...p }), true);
p.bldRevision++;
assert.equal(mesh.needsRebuild(p), true);
const empty = new StructureMesh({ ...p, bld: null }, atlas, () => 0);
assert.equal(empty.count, 0);
assert.deepEqual([...(empty.mesh as any).geometry.indices], [0, 0, 0, 0, 0, 0]);

// Pixel coordinates and alpha survive packing; facility UVs use their vertical offset.
(globalThis as any).document = { createElement: () => createCanvas(1, 1) };
const b = createCanvas(64, 64),
  f = createCanvas(128, 128);
b.getContext('2d').fillStyle = '#c55345';
b.getContext('2d').fillRect(10, 12, 1, 1);
f.getContext('2d').fillStyle = '#4681a4';
f.getContext('2d').fillRect(20, 24, 1, 1);
const combined = combineStructureAtlas(
  { texture: { source: { resource: b } }, uv: () => [0, 0, 1, 1] } as any,
  { texture: { source: { resource: f } }, uv: () => [0, 0, 1, 1] } as any,
);
const packed = combined.texture.source.resource as any;
assert.deepEqual([packed.width, packed.height], [128, 192]);
assert.deepEqual([...packed.getContext('2d').getImageData(10, 12, 1, 1).data], [197, 83, 69, 255]);
assert.deepEqual([...packed.getContext('2d').getImageData(20, 88, 1, 1).data], [70, 129, 164, 255]);
assert.deepEqual(combined.buildingUv(1, 0, 0), [0, 0, 0.5, 1 / 3]);
assert.deepEqual(combined.facilityUv(0), [0, 1 / 3, 1, 1]);
delete (globalThis as any).document;

// Every cell of expanded facilities must support inspection and whole-facility removal,
// including the furthest tile across chunk boundaries (previous 3x3 search missed it).
for (const kind of [22, 23, 24, 25]) {
  const world = new World(0),
    x = world.baseCx * CHUNK_SIZE + CHUNK_SIZE - 2,
    y = world.baseCy * CHUNK_SIZE + CHUNK_SIZE - 2,
    span = FACILITY_SPECS[kind].span;
  world.placeFacility(x, y, kind, 0);
  for (let dy = 0; dy < span; dy++)
    for (let dx = 0; dx < span; dx++) {
      const info = world.buildingCovering(x + dx, y + dy);
      assert.ok(info);
      assert.deepEqual([info.tx, info.ty, info.kind], [x, y, kind]);
    }
  const sim: any = { services: { facilityList: () => [{ tx: x, ty: y, kind }] } };
  assert.equal(findFacilities(world, sim, kind).length, 1);
  assert.equal(world.removeFacilityAt(x + span - 1, y + span - 1), true);
  for (let dy = 0; dy < span; dy++)
    for (let dx = 0; dx < span; dx++) {
      assert.equal(world.getBld(x + dx, y + dy), BLD_NONE);
      assert.equal(world.getBuild(x + dx, y + dy), Build.None);
    }
  assert.equal(
    findFacilities(world, sim, kind).length,
    0,
    'finder rejects stale demolished records',
  );
}
// A hospital crossing the east chunk seam was covered by the next chunk's road mesh.
// Its anchor belongs to the back chunk, but its entire quad must be drawn in the front bucket.
{
  const world = new World(0),
    cx = world.baseCx,
    cy = world.baseCy;
  const x = cx * CHUNK_SIZE + CHUNK_SIZE - 1,
    y = cy * CHUNK_SIZE + 8;
  world.placeFacility(x, y, 2, 0);
  const parcels = [...world.developedParcels()];
  assert.equal(structuresInBucket(parcels, cx, cy).length, 0);
  assert.equal(structuresInBucket(parcels, cx + 1, cy).length, 1);
  const children: any[] = [];
  const parent: any = {
    addChild: (m: any) => children.push(m),
    removeChild: (m: any) => children.splice(children.indexOf(m), 1),
  };
  const layer = new StructureLayer(parent, world, atlas);
  const key = `${cx + 1},${cy}`;
  layer.ensure(key, cx + 1, cy);
  assert.equal(children.length, 1);
  assert.equal(children[0].zIndex, cx + 1 + cy + 0.5);
  const original = children[0];
  layer.ensure(key, cx + 1, cy);
  assert.equal(children[0], original, 'unchanged adjacent parcels reuse the mesh');
  layer.setOpacity(0.22);
  assert.equal(children[0].alpha, 0.22);
  assert.deepEqual(layer.counts(key), { buildings: 0, facilities: 1 });
  world.removeFacilityAt(x + 2, y + 2);
  layer.ensure(key, cx + 1, cy);
  assert.equal(
    children.length,
    0,
    'anchor revision in an adjacent parcel invalidates its front bucket',
  );
  assert.deepEqual(layer.counts(key), { buildings: 0, facilities: 0 });
}
console.log(
  'PASS visual regression: mixed structure depth/UVs/counts/cache, cross-chunk render ownership/invalidation, unscaled atlas packing, all cells of 5x5/7x7 facilities and cross-chunk demolition, stale finder records',
);
