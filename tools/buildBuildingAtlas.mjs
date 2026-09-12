import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const candidates = [
  ...JSON.parse(readFileSync('public/sprites/candidates/manifest.json', 'utf8')),
  ...JSON.parse(readFileSync('public/sprites/candidates/generated-manifest.json', 'utf8')),
];
assert.equal(candidates.length, 36, 'building atlas needs all 36 R/C/I variants');

const atlas = createCanvas(2304, 384),
  ctx = atlas.getContext('2d');
ctx.imageSmoothingEnabled = false;

const seen = new Set();
for (const candidate of candidates) {
  const { id, level, zone, variant } = candidate,
    key = `${level}:${zone}:${variant}`,
    size = level * 64,
    bandY = level === 1 ? 0 : level === 2 ? 64 : 192,
    image = await loadImage(`public/sprites/candidates/${id}.png`);
  assert.ok(!seen.has(key), `${id}: unique level/zone/variant slot`);
  assert.equal(image.width, size, `${id}: native width`);
  assert.equal(image.height, size, `${id}: native height`);
  seen.add(key);
  ctx.drawImage(image, (zone * 4 + variant) * size, bandY);
}
assert.equal(seen.size, 36, 'all 36 atlas slots filled');
writeFileSync('public/sprites/buildings-v2.png', atlas.toBuffer('image/png'));
console.log('built public/sprites/buildings-v2.png: 2304x384, 36 native pixel-art cells');
