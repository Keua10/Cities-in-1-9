import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const CANDIDATES = [
  ['residential-l1-a', 1, 0, 0],
  ['commercial-l1-a', 1, 1, 0],
  ['industrial-l1-a', 1, 2, 0],
  ['residential-l2-a', 2, 0, 0],
  ['commercial-l2-a', 2, 1, 0],
  ['industrial-l2-b', 2, 2, 1],
  ['residential-l3-a', 3, 0, 0],
  ['commercial-l3-a', 3, 1, 0],
  ['industrial-l3-a', 3, 2, 0],
];
const source = await loadImage('public/sprites/buildings.png');
const bandY = (level) => (level === 1 ? 0 : level === 2 ? 64 : 192);

function measure(pixels, size) {
  let minX = size,
    minY = size,
    maxX = -1,
    maxY = -1,
    opaque = 0,
    partial = 0;
  const colors = new Set();
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4,
        alpha = pixels[i + 3];
      if (alpha !== 0 && alpha !== 255) partial++;
      if (!alpha) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      opaque++;
      colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
    }
  const bottom = [];
  for (let x = 0; x < size; x++) if (pixels[(maxY * size + x) * 4 + 3]) bottom.push(x);
  return {
    bounds: [minX, minY, maxX, maxY],
    bottom: [Math.min(...bottom), Math.max(...bottom)],
    bottomCenter: (Math.min(...bottom) + Math.max(...bottom)) / 2,
    colors: colors.size,
    opaque,
    partial,
  };
}

mkdirSync('public/sprites/candidates', { recursive: true });
for (const [id, level, zone, variant] of CANDIDATES) {
  const size = level * 64,
    sourceCanvas = createCanvas(size, size),
    sourceCtx = sourceCanvas.getContext('2d');
  sourceCtx.imageSmoothingEnabled = false;
  sourceCtx.drawImage(
    source,
    (zone * 2 + variant) * size,
    bandY(level),
    size,
    size,
    0,
    0,
    size,
    size,
  );
  const sourcePixels = sourceCtx.getImageData(0, 0, size, size).data,
    before = measure(sourcePixels, size),
    desiredCenter = size / 2 - 0.5,
    dx = Math.round(desiredCenter - before.bottomCenter),
    dy = size - 2 - before.bounds[3],
    canvas = createCanvas(size, size),
    ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sourceCanvas, dx, dy);
  const candidatePixels = ctx.getImageData(0, 0, size, size).data,
    after = measure(candidatePixels, size);

  assert.equal(before.partial, 0, `${id}: source binary alpha`);
  assert.equal(after.partial, 0, `${id}: candidate binary alpha`);
  assert.equal(after.opaque, before.opaque, `${id}: no source pixels lost`);
  assert.equal(after.colors, before.colors, `${id}: source colors preserved`);
  assert.ok(after.bounds[0] >= 1 && after.bounds[2] <= size - 2, `${id}: horizontal gutter`);
  assert.ok(after.bounds[1] >= 1 && after.bounds[3] === size - 2, `${id}: vertical gutter`);
  assert.ok(
    Math.abs(after.bottomCenter - desiredCenter) <= 0.5,
    `${id}: bottom anchor within one integer-pixel choice`,
  );
  for (let y = before.bounds[1]; y <= before.bounds[3]; y++)
    for (let x = before.bounds[0]; x <= before.bounds[2]; x++) {
      const sourceIndex = (y * size + x) * 4;
      if (!sourcePixels[sourceIndex + 3]) continue;
      const targetIndex = ((y + dy) * size + x + dx) * 4;
      assert.deepEqual(
        [...candidatePixels.slice(targetIndex, targetIndex + 4)],
        [...sourcePixels.slice(sourceIndex, sourceIndex + 4)],
        `${id}: exact RGBA at ${x},${y}`,
      );
    }

  writeFileSync(`public/sprites/candidates/${id}.png`, canvas.toBuffer('image/png'));
  console.log(
    `${id}: ${size}x${size}, shift ${dx},${dy}, bounds ${after.bounds.join(',')}, center error ${Math.abs(after.bottomCenter - desiredCenter)}, ${after.colors} colors`,
  );
}
