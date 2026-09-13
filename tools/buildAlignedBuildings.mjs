import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  readRaster,
  encodeRaster,
  describe,
  alignFootprint,
  restorePalette,
} from './art/footprintMath.mjs';

const candidates = ['manifest', 'generated-manifest'].flatMap((name) =>
  JSON.parse(readFileSync(`public/sprites/candidates/${name}.json`, 'utf8')),
);
mkdirSync('public/sprites/aligned', { recursive: true });
const manifest = [];
for (const { id, level, zone, variant } of candidates) {
  const referencePath = `public/sprites/candidates/${id}.png`,
    original = await readRaster(referencePath);
  const repairPath = `tools/art/footprint-repairs/${id}.png`;
  let raster,
    projection = null,
    mode;
  if (id === 'residential-l3-a') {
    raster = await readRaster('public/sprites/review/residential-l3-a-footprint-v2.png');
    mode = 'approved-mansion-v2';
  } else {
    const repaired = existsSync(repairPath);
    const source = repaired ? restorePalette(await readRaster(repairPath), original) : original;
    ({ raster, projection } = alignFootprint(source));
    mode = repaired ? 'restored-clipped-source' : 'original-pixel-projection';
  }
  const result = describe(raster),
    before = describe(original);
  const paletteOutsideOriginal = [...result.palette].filter((c) => !before.palette.has(c)).length;
  assert.equal(paletteOutsideOriginal, 0, `${id}: original RGB only`);
  assert.equal(result.border, 0, `${id}: transparent borders`);
  assert.equal(result.partial, 0, `${id}: binary alpha`);
  const output = `public/sprites/aligned/${id}.png`;
  writeFileSync(output, encodeRaster(raster));
  manifest.push({
    id,
    level,
    zone,
    variant,
    mode,
    reference: referencePath,
    output,
    sourceHash: createHash('sha256').update(readFileSync(referencePath)).digest('hex'),
    ...(mode === 'restored-clipped-source' ? { repairSource: repairPath } : {}),
    projection,
    bounds: result.bounds,
    paletteOutsideOriginal,
    opaque: result.opaque,
    colors: result.palette.size,
  });
}
writeFileSync('public/sprites/aligned/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(
  `Prepared ${manifest.length} aligned sprites. Original RGB palette only; originals remain intact.`,
);
