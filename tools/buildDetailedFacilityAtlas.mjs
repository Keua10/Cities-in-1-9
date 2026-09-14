import { build } from 'esbuild';
import { createCanvas } from '@napi-rs/canvas';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { strict as assert } from 'node:assert';
import { readRaster, encodeRaster, describe } from './art/footprintMath.mjs';
import { alignFacilityFootprint } from './art/facilityFootprint.mjs';

mkdirSync('.check', { recursive: true });
await build({
  entryPoints: ['src/render/facilityAtlas.ts'],
  outfile: '.check/facility-layout.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: { 'pixi.js': resolve('tools/check/stub-pixi.ts') },
  logLevel: 'warning',
});
const layout = await import(pathToFileURL(resolve('.check/facility-layout.mjs')).href);
const specs = JSON.parse(readFileSync('tools/art/facility-review/specs.json', 'utf8'));
const atlas = createCanvas(layout.FACILITY_ATLAS_W, layout.FACILITY_ATLAS_H),
  ctx = atlas.getContext('2d');
const original = createCanvas(atlas.width, atlas.height),
  oc = original.getContext('2d');
layout.drawFacilityAtlas(oc);
mkdirSync('public/sprites/facilities-detailed/previous', { recursive: true });
const manifest = [];
for (const spec of specs) {
  const size = layout.facilityCellSize(spec.span),
    x = layout.FACILITY_ATLAS_COLUMN[spec.kind] * size,
    y = layout.facilityBandY(spec.span);
  const sourcePath = `tools/art/facility-sources/${spec.id}.png`,
    source = await readRaster(sourcePath);
  assert.equal(source.width, size);
  assert.equal(source.height, size);
  const { raster, projection } = alignFacilityFootprint(source),
    report = describe(raster);
  assert.equal(report.partial, 0);
  assert.equal(report.border, 0);
  const png = encodeRaster(raster);
  writeFileSync(`public/sprites/facilities-detailed/${spec.id}.png`, png);
  const image = ctx.createImageData(size, size);
  image.data.set(raster.data);
  ctx.putImageData(image, x, y);
  const old = { width: size, height: size, data: oc.getImageData(x, y, size, size).data };
  writeFileSync(`public/sprites/facilities-detailed/previous/${spec.id}.png`, encodeRaster(old));
  manifest.push({
    ...spec,
    size,
    x,
    y,
    colors: report.palette.size,
    bounds: report.bounds,
    source: sourcePath,
    sourceHash: createHash('sha256').update(readFileSync(sourcePath)).digest('hex'),
    projection,
  });
}
writeFileSync('public/sprites/facilities-v2.png', atlas.toBuffer('image/png'));
writeFileSync(
  'public/sprites/facilities-detailed/manifest.json',
  JSON.stringify(manifest, null, 2) + '\n',
);
console.log(
  `Packed ${manifest.length} detailed facilities: ${atlas.width}x${atlas.height}; IDs, spans and UV cells retained.`,
);
