import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  readRaster,
  describe,
  rgbKey,
  alignFootprint,
  restorePalette,
} from '../art/footprintMath.mjs';

const entries = JSON.parse(readFileSync('public/sprites/aligned/manifest.json', 'utf8'));
assert.equal(entries.length, 36);
const modes = {},
  hashes = new Set();
for (const entry of entries) {
  const { id, level, mode } = entry,
    size = level * 64;
  const original = await readRaster(entry.reference),
    output = await readRaster(entry.output);
  const before = describe(original),
    after = describe(output);
  assert.equal(output.width, size, `${id}: native width`);
  assert.equal(output.height, size, `${id}: native height`);
  assert.equal(after.partial, 0, `${id}: no antialias pixels`);
  assert.equal(after.border, 0, `${id}: no sprite touches the atlas border`);
  assert.equal(after.bounds[3], size - 2, `${id}: renderer bottom gutter contract`);
  assert.equal(
    createHash('sha256').update(readFileSync(entry.reference)).digest('hex'),
    entry.sourceHash,
    `${id}: original has not drifted`,
  );
  for (const rgb of after.palette)
    assert.ok(before.palette.has(rgb), `${id}: no new color or saturation boost`);
  const center = (size - 1) / 2;
  const bottomXs = after.edge.map((y, x) => (y === size - 2 ? x : -1)).filter((x) => x >= 0);
  assert.ok(bottomXs.length <= 4, `${id}: ground tip must not be a long clipped horizontal line`);
  assert.ok(Math.abs((bottomXs[0] + bottomXs.at(-1)) / 2 - center) <= 0.5, `${id}: centered tip`);
  for (let x = 0; x < size; x++) {
    if (after.edge[x] < 0) continue;
    // Conservative projected front half-plane: even a prop must not extend below it.
    // Half a native pixel is the rasterization tolerance (the approved mansion has
    // one stair-step sample 0.25px across the mathematical line).
    assert.ok(
      after.edge[x] + 0.5 + Math.abs(x + 0.5 - size / 2) * 0.5 <= size - 1 + 0.5,
      `${id}: stays behind the parcel's front boundary at x=${x}`,
    );
  }
  for (const side of [-1, 1]) {
    const samples = [];
    for (let distance = Math.ceil(size * 0.1); distance <= size * 0.29; distance++) {
      const x = Math.round(center + distance * side);
      if (after.edge[x] >= 0) samples.push([Math.abs(x - center), after.edge[x]]);
    }
    const mx = samples.reduce((n, p) => n + p[0], 0) / samples.length,
      my = samples.reduce((n, p) => n + p[1], 0) / samples.length;
    const slope =
      samples.reduce((n, p) => n + (p[0] - mx) * (p[1] - my), 0) /
      samples.reduce((n, p) => n + (p[0] - mx) ** 2, 0);
    assert.ok(
      Math.abs(slope + 0.5) < 0.035,
      `${id}: actual raster front edge slope ${slope}, expected -0.5`,
    );
  }
  if (mode === 'approved-mansion-v2') {
    const approved = await readRaster('public/sprites/review/residential-l3-a-footprint-v2.png');
    assert.deepEqual(output.data, approved.data, 'approved mansion is unchanged');
  } else {
    const source = entry.repairSource
      ? restorePalette(await readRaster(entry.repairSource), original)
      : original;
    const rebuilt = alignFootprint(source);
    assert.deepEqual(rebuilt.raster.data, output.data, `${id}: reproducible geometry and texture`);
    assert.equal(rebuilt.projection.outsideSourceSamples, 0, `${id}: no source geometry clipped`);
    const { scaleY, shearY, dx, shiftY, sourceFront } = entry.projection;
    assert.ok(Math.abs(sourceFront.left.m * scaleY + shearY - 0.5) < 1e-9);
    assert.ok(Math.abs(sourceFront.right.m * scaleY + shearY + 0.5) < 1e-9);
    let copied = 0;
    for (let y = 1; y < size - 1; y++)
      for (let x = 1; x < size - 1; x++) {
        const sx = x - dx,
          sy = Math.round((y - shearY * sx - shiftY) / scaleY);
        if (sx < 0 || sx >= size || sy < 0 || sy >= size) continue;
        const a = (sy * size + sx) * 4,
          b = (y * size + x) * 4;
        if (!source.data[a + 3]) continue;
        assert.equal(output.data[b + 3], 255, `${id}: source pixel alpha`);
        assert.equal(
          rgbKey(output.data, b),
          rgbKey(source.data, a),
          `${id}: source texture pixel unchanged`,
        );
        copied++;
      }
    assert.ok(
      copied > describe(source).opaque * Math.min(1, scaleY) * 0.95,
      `${id}: retains the textured building, not just its palette`,
    );
  }
  hashes.add(createHash('sha256').update(output.data).digest('hex'));
  modes[mode] = (modes[mode] ?? 0) + 1;
}
assert.equal(hashes.size, 36);
console.log(
  'PASS 36 building footprints: native pixels, original palettes, 2:1 front edges, parcel containment, intact source geometry, exact texture sampling, reproducible outputs.',
  modes,
);
