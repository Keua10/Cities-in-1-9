import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';

interface CandidateManifest {
  id: string;
  level: number;
  zone: number;
  variant: number;
  mode: 'source-preserved' | 'restored' | 'new-pixel';
  colors: number;
  bounds: [number, number, number, number];
  centerError: number;
  sourceSize?: [number, number];
}

const legacy = JSON.parse(
    readFileSync('public/sprites/candidates/manifest.json', 'utf8'),
  ) as CandidateManifest[],
  created = JSON.parse(
    readFileSync('public/sprites/candidates/generated-manifest.json', 'utf8'),
  ) as CandidateManifest[],
  candidates = [...legacy, ...created];

assert.equal(legacy.length, 18, '18 restored/source-preserved A/B candidates');
assert.equal(created.length, 18, '18 new C/D pixel-art candidates');
assert.equal(candidates.length, 36, 'complete 3 zones x 3 levels x 4 variants');

function imagePixels(image: Awaited<ReturnType<typeof loadImage>>): {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
} {
  const canvas = createCanvas(image.width, image.height),
    ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, 0, 0);
  return {
    width: image.width,
    height: image.height,
    pixels: ctx.getImageData(0, 0, image.width, image.height).data,
  };
}

const slots = new Set<string>(),
  hashes = new Set<string>(),
  loaded = new Map<string, Uint8ClampedArray>();
for (const candidate of candidates) {
  const { id, level, zone, variant, colors, bounds, centerError } = candidate,
    size = level * 64,
    slot = `${level}:${zone}:${variant}`,
    image = await loadImage(`public/sprites/candidates/${id}.png`),
    { pixels } = imagePixels(image);
  assert.ok(level >= 1 && level <= 3, `${id}: valid level`);
  assert.ok(zone >= 0 && zone <= 2, `${id}: valid zone`);
  assert.ok(variant >= 0 && variant <= 3, `${id}: valid variant`);
  assert.ok(!slots.has(slot), `${id}: unique atlas slot`);
  slots.add(slot);
  assert.equal(image.width, size, `${id}: native width`);
  assert.equal(image.height, size, `${id}: native height`);

  let minX = size,
    minY = size,
    maxX = -1,
    maxY = -1;
  const palette = new Set<string>();
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4,
        alpha = pixels[i + 3];
      assert.ok(alpha === 0 || alpha === 255, `${id}: binary alpha`);
      if (!alpha) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      palette.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
      if (candidate.mode === 'new-pixel')
        for (const channel of [pixels[i], pixels[i + 1], pixels[i + 2]])
          assert.ok(channel === 255 || channel % 32 === 0, `${id}: quantized pixel palette`);
    }
  assert.deepEqual([minX, minY, maxX, maxY], bounds, `${id}: manifest bounds`);
  assert.equal(palette.size, colors, `${id}: manifest color count`);
  assert.ok(minX >= 1 && maxX <= size - 2, `${id}: side gutters prevent clipping`);
  assert.ok(minY >= 1 && maxY === size - 2, `${id}: vertical gutters and ground line`);
  const bottomX: number[] = [];
  for (let x = 0; x < size; x++) if (pixels[(maxY * size + x) * 4 + 3]) bottomX.push(x);
  const measuredError = Math.abs(
    (Math.min(...bottomX) + Math.max(...bottomX)) / 2 - (size / 2 - 0.5),
  );
  assert.equal(measuredError, centerError, `${id}: manifest center error`);
  assert.ok(centerError <= 0.5, `${id}: centered parcel anchor`);
  const hash = createHash('sha256').update(pixels).digest('hex');
  assert.ok(!hashes.has(hash), `${id}: visually distinct raster`);
  hashes.add(hash);
  loaded.set(id, pixels);

  if (candidate.mode === 'new-pixel') {
    assert.deepEqual(candidate.sourceSize, [size, size], `${id}: canonical source is native size`);
    const source = await loadImage(`tools/art/building-variants/${id}-source.png`),
      sourceData = imagePixels(source);
    assert.equal(sourceData.width, size, `${id}: canonical source width`);
    assert.equal(sourceData.height, size, `${id}: canonical source height`);
    assert.deepEqual(sourceData.pixels, pixels, `${id}: no resampling after canonicalization`);
  }
}
assert.equal(slots.size, 36, 'all 36 atlas slots are unique');
assert.equal(hashes.size, 36, 'all 36 sprites are distinct');

const atlasImage = await loadImage('public/sprites/buildings-v2.png'),
  atlas = imagePixels(atlasImage);
assert.equal(atlas.width, 2304, 'building atlas width');
assert.equal(atlas.height, 384, 'building atlas height');
for (const candidate of candidates) {
  const { id, level, zone, variant } = candidate,
    size = level * 64,
    x0 = (zone * 4 + variant) * size,
    y0 = level === 1 ? 0 : level === 2 ? 64 : 192,
    pixels = loaded.get(id)!;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const candidateIndex = (y * size + x) * 4,
        atlasIndex = ((y0 + y) * atlas.width + x0 + x) * 4;
      assert.deepEqual(
        atlas.pixels.slice(atlasIndex, atlasIndex + 4),
        pixels.slice(candidateIndex, candidateIndex + 4),
        `${id}: exact atlas RGBA at ${x},${y}`,
      );
    }
}
for (let y = 0; y < 192; y++) {
  const usedWidth = y < 64 ? 768 : 1536;
  for (let x = usedWidth; x < atlas.width; x++)
    assert.equal(atlas.pixels[(y * atlas.width + x) * 4 + 3], 0, `unused atlas alpha ${x},${y}`);
}

console.log(
  'PASS building variants: 36 distinct native 64/128/192 pixel sprites, binary alpha, clipping gutters, centered anchors, 18 idempotent C/D sources, exact 2304x384 atlas packing',
);
