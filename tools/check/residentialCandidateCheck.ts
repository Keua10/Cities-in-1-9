import { strict as assert } from 'node:assert';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const image = await loadImage('public/sprites/candidates/residential-l1-a.png');
assert.equal(image.width, 64, 'candidate width');
assert.equal(image.height, 64, 'candidate height');
const canvas = createCanvas(64, 64),
  ctx = canvas.getContext('2d');
ctx.drawImage(image, 0, 0);
const pixels = ctx.getImageData(0, 0, 64, 64).data;
let minX = 64,
  minY = 64,
  maxX = -1,
  maxY = -1,
  partialAlpha = 0,
  colors = new Set<string>();
for (let y = 0; y < 64; y++)
  for (let x = 0; x < 64; x++) {
    const i = (y * 64 + x) * 4,
      alpha = pixels[i + 3];
    if (alpha !== 0 && alpha !== 255) partialAlpha++;
    if (!alpha) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
  }
assert.equal(partialAlpha, 0, 'binary alpha');
assert.deepEqual([minX, minY, maxX, maxY], [2, 10, 60, 62], 'normalized bounds');
assert.ok(colors.size >= 100, `preserves rich source palette (${colors.size})`);
const bottom = [];
for (let x = 0; x < 64; x++) if (pixels[(62 * 64 + x) * 4 + 3]) bottom.push(x);
assert.deepEqual([Math.min(...bottom), Math.max(...bottom)], [31, 32], 'centered bottom anchor');
for (let i = 0; i < 64; i++) {
  assert.equal(pixels[i * 4 + 3], 0, 'top gutter');
  assert.equal(pixels[(63 * 64 + i) * 4 + 3], 0, 'bottom gutter');
  assert.equal(pixels[i * 64 * 4 + 3], 0, 'left gutter');
  assert.equal(pixels[(i * 64 + 63) * 4 + 3], 0, 'right gutter');
}
console.log(
  `PASS residential candidate: 64x64, bounds 2,10..60,62, centered anchor, binary alpha, ${colors.size} colors`,
);
