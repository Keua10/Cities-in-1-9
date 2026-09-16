import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { FACILITY_SPECS } from '../../src/sim/facilities';
import { FACILITY_COUNT } from '../../src/sim/buildings';
import {
  FACILITY_ATLAS_W,
  FACILITY_ATLAS_H,
  FACILITY_ATLAS_COLUMN,
  facilityBandY,
  facilityCellSize,
  loadFacilityAtlas,
  paintFacilityThumbnail,
} from '../../src/render/facilityAtlas';
// @ts-ignore Node-only raster tooling shares the geometry preparation implementation.
import { readRaster, describe } from '../art/footprintMath.mjs';
// @ts-ignore Node-only facility perimeter preparation.
import { alignFacilityFootprint } from '../art/facilityFootprint.mjs';

const entries = JSON.parse(
  readFileSync('public/sprites/facilities-detailed/manifest.json', 'utf8'),
);
assert.equal(entries.length, FACILITY_COUNT - 1);
const sheet = await loadImage('public/sprites/facilities-v2.png');
assert.equal(sheet.width, FACILITY_ATLAS_W);
assert.equal(sheet.height, FACILITY_ATLAS_H);
const canvas = createCanvas(sheet.width, sheet.height),
  ctx = canvas.getContext('2d');
ctx.drawImage(sheet, 0, 0);
const colors = new Set<number>(),
  hashes = new Set<string>(),
  occupied = new Set<number>();
for (const id of ['commercial-l3-a', 'residential-l3-a', 'industrial-l3-a'])
  for (const c of describe(await readRaster(`public/sprites/aligned/${id}.png`)).palette)
    colors.add(c);
for (const e of entries) {
  const spec = FACILITY_SPECS[e.kind],
    size = facilityCellSize(spec.span);
  assert.equal(e.name, spec.name);
  assert.equal(e.span, spec.span);
  assert.equal(e.size, size);
  assert.equal(e.x, FACILITY_ATLAS_COLUMN[e.kind] * size);
  assert.equal(e.y, facilityBandY(spec.span));
  const raster = await readRaster(`public/sprites/facilities-detailed/${e.id}.png`),
    source = await readRaster(e.source),
    r = describe(raster);
  assert.equal(raster.width, size);
  assert.equal(raster.height, size);
  assert.equal(r.partial, 0);
  assert.equal(r.border, 0);
  assert.equal(r.bounds[3], size - 2);
  assert.ok(r.opaque > size * size * 0.1, `${e.name}: visible detailed artwork`);
  for (const rgb of r.palette) assert.ok(colors.has(rgb), `${e.name}: approved city palette`);
  const tips = r.edge.flatMap((y: number, x: number) => (y === size - 2 ? [x] : []));
  assert.ok(tips.length > 0 && tips.length <= 4, `${e.name}: intact pointed base`);
  assert.ok(
    Math.abs((tips[0] + tips.at(-1)) / 2 - (size - 1) / 2) <= 0.5,
    `${e.name}: centered base`,
  );
  for (let x = 0; x < size; x++)
    if (r.edge[x] >= 0)
      assert.ok(
        r.edge[x] + 0.5 + Math.abs(x + 0.5 - size / 2) * 0.5 <= size - 0.5,
        `${e.name}: front boundary x=${x}`,
      );
  const rebuilt = alignFacilityFootprint(source);
  assert.ok(
    Math.abs(rebuilt.projection.sourceFront.cx + rebuilt.projection.dx - (size - 1) / 2) <= 0.75,
    `${e.name}: actual source apex is centered, not concealed by a synthetic border`,
  );
  const { scaleY, shearY, dx, shiftY } = rebuilt.projection;
  for (let y = 1; y < size - 1; y++)
    for (let x = 1; x < size - 1; x++) {
      const sx = x - dx,
        sy = Math.round((y - shearY * sx - shiftY) / scaleY);
      if (sx < 0 || sx >= size || sy < 0 || sy >= size) continue;
      const a = (sy * size + sx) * 4,
        b = (y * size + x) * 4;
      if (source.data[a + 3])
        assert.deepEqual(
          raster.data.slice(b, b + 4),
          source.data.slice(a, a + 4),
          `${e.name}: perimeter processing preserves the sampled source`,
        );
    }
  assert.equal(rebuilt.projection.outsideSourceSamples, 0, `${e.name}: no source clipping`);
  assert.deepEqual(
    raster.data,
    rebuilt.raster.data,
    `${e.name}: reproducible from canonical source`,
  );
  assert.equal(createHash('sha256').update(readFileSync(e.source)).digest('hex'), e.sourceHash);
  assert.deepEqual(
    ctx.getImageData(e.x, e.y, size, size).data,
    raster.data,
    `${e.name}: exact live atlas cell`,
  );
  for (let y = e.y; y < e.y + size; y++)
    for (let x = e.x; x < e.x + size; x++) {
      const p = y * sheet.width + x;
      assert.ok(!occupied.has(p), 'atlas cells do not overlap');
      occupied.add(p);
    }
  hashes.add(createHash('sha256').update(raster.data).digest('hex'));
}
assert.equal(hashes.size, FACILITY_COUNT - 1);

// Exercise the real async loader and catalog against native PNGs, plus missing-file fallback.
const oldDocument = globalThis.document,
  oldImage = globalThis.Image;
class TestImage {
  src = '';
  naturalWidth = 0;
  naturalHeight = 0;
  native: any;
  async decode() {
    this.native = await loadImage('public' + this.src.split('?')[0]);
    this.naturalWidth = this.native.width;
    this.naturalHeight = this.native.height;
  }
}
(globalThis as any).Image = TestImage;
(globalThis as any).document = {
  createElement: () => {
    const c = createCanvas(1, 1),
      context = c.getContext('2d'),
      draw = context.drawImage.bind(context);
    (context as any).drawImage = (image: any, ...args: any[]) =>
      draw(image.native ?? image, ...args);
    return c;
  },
};
try {
  const atlas = await loadFacilityAtlas();
  assert.equal(atlas.placeholder, false);
  const metroThumb = globalThis.document.createElement('canvas') as any;
  metroThumb.width = metroThumb.height = 64;
  await paintFacilityThumbnail(metroThumb.getContext('2d'), 26);
  const liveCanvas = atlas.texture.source.resource as any;
  assert.deepEqual(
    metroThumb.getContext('2d').getImageData(0, 0, 64, 64).data,
    liveCanvas.getContext('2d').getImageData(FACILITY_ATLAS_COLUMN[26] * 64, 0, 64, 64).data,
    'native metro station menu/city parity',
  );
  for (const e of entries) {
    assert.deepEqual(atlas.uv(e.kind), [
      e.x / sheet.width,
      e.y / sheet.height,
      (e.x + e.size) / sheet.width,
      (e.y + e.size) / sheet.height,
    ]);
    const thumb = globalThis.document.createElement('canvas') as any;
    thumb.width = thumb.height = e.size;
    await paintFacilityThumbnail(thumb.getContext('2d'), e.kind);
    assert.deepEqual(
      thumb.getContext('2d').getImageData(0, 0, e.size, e.size).data,
      ctx.getImageData(e.x, e.y, e.size, e.size).data,
      `${e.name}: menu matches city`,
    );
  }
  const warn = console.warn;
  try {
    console.warn = () => {};
    assert.equal((await loadFacilityAtlas('/sprites/intentionally-missing.png')).placeholder, true);
  } finally {
    console.warn = warn;
  }
} finally {
  (globalThis as any).document = oldDocument;
  (globalThis as any).Image = oldImage;
}
console.log(
  'PASS 26 detailed facilities: native sizes, city palette, transparent gutters, lot containment, no source clipping, exact atlas packing, menu/city parity and loader fallback.',
);
