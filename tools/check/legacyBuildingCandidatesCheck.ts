import { strict as assert } from 'node:assert';
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
] as const;
const source = await loadImage('public/sprites/buildings.png');
const bandY = (level: number) => (level === 1 ? 0 : level === 2 ? 64 : 192);

function pixelsOf(image: Awaited<ReturnType<typeof loadImage>>, size: number): Uint8ClampedArray {
  const canvas = createCanvas(size, size),
    ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, size, size).data;
}

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
    candidate = await loadImage(`public/sprites/candidates/${id}.png`),
    candidatePixels = pixelsOf(candidate, size);
  assert.equal(candidate.width, size, `${id}: width`);
  assert.equal(candidate.height, size, `${id}: height`);

  let sourceOpaque = 0,
    candidateOpaque = 0,
    sourceMinX = size,
    sourceMaxX = -1,
    sourceMaxY = -1,
    minX = size,
    minY = size,
    maxX = -1,
    maxY = -1;
  const sourceColors = new Set<string>(),
    candidateColors = new Set<string>();
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4,
        sourceAlpha = sourcePixels[i + 3],
        candidateAlpha = candidatePixels[i + 3];
      assert.ok(sourceAlpha === 0 || sourceAlpha === 255, `${id}: source binary alpha`);
      assert.ok(candidateAlpha === 0 || candidateAlpha === 255, `${id}: candidate binary alpha`);
      if (sourceAlpha) {
        sourceOpaque++;
        sourceColors.add(`${sourcePixels[i]},${sourcePixels[i + 1]},${sourcePixels[i + 2]}`);
        sourceMinX = Math.min(sourceMinX, x);
        sourceMaxX = Math.max(sourceMaxX, x);
        sourceMaxY = Math.max(sourceMaxY, y);
      }
      if (!candidateAlpha) continue;
      candidateOpaque++;
      candidateColors.add(
        `${candidatePixels[i]},${candidatePixels[i + 1]},${candidatePixels[i + 2]}`,
      );
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  assert.equal(candidateOpaque, sourceOpaque, `${id}: exact opaque pixel count`);
  assert.equal(candidateColors.size, sourceColors.size, `${id}: exact source color count`);
  assert.ok(minX >= 1 && maxX <= size - 2, `${id}: horizontal transparent gutter`);
  assert.ok(minY >= 1 && maxY === size - 2, `${id}: vertical transparent gutter`);
  const bottom = [];
  for (let x = 0; x < size; x++) if (candidatePixels[(maxY * size + x) * 4 + 3]) bottom.push(x);
  const center = (Math.min(...bottom) + Math.max(...bottom)) / 2;
  assert.ok(Math.abs(center - (size / 2 - 0.5)) <= 0.5, `${id}: centered bottom anchor`);

  const sourceBottom = [];
  for (let x = sourceMinX; x <= sourceMaxX; x++)
    if (sourcePixels[(sourceMaxY * size + x) * 4 + 3]) sourceBottom.push(x);
  const sourceCenter = (Math.min(...sourceBottom) + Math.max(...sourceBottom)) / 2,
    dx = Math.round(size / 2 - 0.5 - sourceCenter),
    dy = size - 2 - sourceMaxY;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const sourceIndex = (y * size + x) * 4;
      if (!sourcePixels[sourceIndex + 3]) continue;
      const candidateIndex = ((y + dy) * size + x + dx) * 4;
      assert.deepEqual(
        [...candidatePixels.slice(candidateIndex, candidateIndex + 4)],
        [...sourcePixels.slice(sourceIndex, sourceIndex + 4)],
        `${id}: exact translated RGBA at ${x},${y}`,
      );
    }
}
console.log(
  'PASS legacy candidates: 9 representative R/C/I sprites preserve exact source pixels and colors at native 64/128/192 sizes with binary alpha, transparent gutters and centered anchors',
);
