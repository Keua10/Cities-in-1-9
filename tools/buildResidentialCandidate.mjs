import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const source = await loadImage('public/sprites/buildings.png');
const canvas = createCanvas(64, 64);
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

// The legacy first residential cell already has the requested detail. Move it one pixel
// upward so its bottom anchor no longer touches the atlas edge; do not scale or recolor it.
ctx.drawImage(source, 0, 0, 64, 64, 0, -1, 64, 64);

const pixels = ctx.getImageData(0, 0, 64, 64).data;
let minX = 64,
  minY = 64,
  maxX = -1,
  maxY = -1,
  partialAlpha = 0;
for (let y = 0; y < 64; y++)
  for (let x = 0; x < 64; x++) {
    const alpha = pixels[(y * 64 + x) * 4 + 3];
    if (alpha !== 0 && alpha !== 255) partialAlpha++;
    if (!alpha) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
assert.equal(partialAlpha, 0, 'candidate uses binary alpha');
assert.deepEqual([minX, minY, maxX, maxY], [2, 10, 60, 62], 'normalized visible bounds');
for (let i = 0; i < 64; i++) {
  assert.equal(pixels[i * 4 + 3], 0, 'top gutter');
  assert.equal(pixels[(63 * 64 + i) * 4 + 3], 0, 'bottom gutter');
  assert.equal(pixels[i * 64 * 4 + 3], 0, 'left gutter');
  assert.equal(pixels[(i * 64 + 63) * 4 + 3], 0, 'right gutter');
}

mkdirSync('public/sprites/candidates', { recursive: true });
writeFileSync('public/sprites/candidates/residential-l1-a.png', canvas.toBuffer('image/png'));
console.log('built residential-l1-a.png: 64x64, bounds 2,10..60,62, binary alpha');
