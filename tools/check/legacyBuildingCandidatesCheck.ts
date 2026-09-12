import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';

interface CandidateManifest {
  id: string;
  level: number;
  zone: number;
  variant: number;
  mode: 'source-preserved' | 'restored';
  colors: number;
  bounds: [number, number, number, number];
  centerError: number;
  shift: [number, number] | null;
}

const candidates = JSON.parse(
  readFileSync('public/sprites/candidates/manifest.json', 'utf8'),
) as CandidateManifest[];
assert.equal(candidates.length, 18, 'all 18 legacy R/C/I tier variants are present');
const source = await loadImage('public/sprites/buildings.png');
const bandY = (level: number) => (level === 1 ? 0 : level === 2 ? 64 : 192);

function pixelsOf(image: Awaited<ReturnType<typeof loadImage>>, size: number): Uint8ClampedArray {
  const canvas = createCanvas(size, size),
    ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, size, size).data;
}

function maxBrightCutRun(pixels: Uint8ClampedArray, size: number): number {
  let longest = 0;
  for (const direction of [-1, 1])
    for (let x = 1; x < size - 1; x++) {
      let run = 0;
      for (let y = 1; y < size - 1; y++) {
        const i = (y * size + x) * 4,
          outside = (y * size + x + direction) * 4,
          luma = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114,
          exposedBrightPixel = pixels[i + 3] === 255 && pixels[outside + 3] === 0 && luma >= 96;
        run = exposedBrightPixel ? run + 1 : 0;
        longest = Math.max(longest, run);
      }
    }
  return longest;
}

for (const candidateInfo of candidates) {
  const { id, level, zone, variant, mode, colors, bounds, centerError, shift } = candidateInfo,
    size = level * 64,
    candidate = await loadImage(`public/sprites/candidates/${id}.png`),
    candidatePixels = pixelsOf(candidate, size);
  assert.equal(candidate.width, size, `${id}: width`);
  assert.equal(candidate.height, size, `${id}: height`);

  let candidateOpaque = 0,
    minX = size,
    minY = size,
    maxX = -1,
    maxY = -1;
  const candidateColors = new Set<string>();
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4,
        alpha = candidatePixels[i + 3];
      assert.ok(alpha === 0 || alpha === 255, `${id}: candidate binary alpha`);
      if (!alpha) continue;
      candidateOpaque++;
      candidateColors.add(
        `${candidatePixels[i]},${candidatePixels[i + 1]},${candidatePixels[i + 2]}`,
      );
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  assert.deepEqual([minX, minY, maxX, maxY], bounds, `${id}: manifest bounds`);
  assert.equal(candidateColors.size, colors, `${id}: manifest color count`);
  assert.ok(minX >= 1 && maxX <= size - 2, `${id}: horizontal transparent gutter`);
  assert.ok(minY >= 1 && maxY === size - 2, `${id}: vertical transparent gutter`);
  const bottom = [];
  for (let x = 0; x < size; x++) if (candidatePixels[(maxY * size + x) * 4 + 3]) bottom.push(x);
  const center = (Math.min(...bottom) + Math.max(...bottom)) / 2;
  assert.equal(Math.abs(center - (size / 2 - 0.5)), centerError, `${id}: center error`);
  assert.ok(centerError <= 0.5, `${id}: centered bottom anchor`);

  if (mode === 'restored') {
    assert.ok(colors >= 180 && colors <= 256, `${id}: repaired pixel-art palette density`);
    assert.ok(maxBrightCutRun(candidatePixels, size) <= 7, `${id}: no long bright vertical cut`);
    continue;
  }

  assert.ok(shift, `${id}: source-preserved candidate has an integer shift`);
  const sourceCanvas = createCanvas(size, size),
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
  const sourcePixels = sourceCtx.getImageData(0, 0, size, size).data;
  let sourceOpaque = 0;
  const sourceColors = new Set<string>();
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const sourceIndex = (y * size + x) * 4,
        alpha = sourcePixels[sourceIndex + 3];
      assert.ok(alpha === 0 || alpha === 255, `${id}: source binary alpha`);
      if (!alpha) continue;
      sourceOpaque++;
      sourceColors.add(
        `${sourcePixels[sourceIndex]},${sourcePixels[sourceIndex + 1]},${sourcePixels[sourceIndex + 2]}`,
      );
      const candidateIndex = ((y + shift[1]) * size + x + shift[0]) * 4;
      assert.deepEqual(
        [...candidatePixels.slice(candidateIndex, candidateIndex + 4)],
        [...sourcePixels.slice(sourceIndex, sourceIndex + 4)],
        `${id}: exact translated RGBA at ${x},${y}`,
      );
    }
  assert.equal(candidateOpaque, sourceOpaque, `${id}: exact opaque pixel count`);
  assert.equal(candidateColors.size, sourceColors.size, `${id}: exact source color count`);
}

console.log(
  'PASS legacy candidates: all 18 R/C/I tier variants use native 64/128/192 cells; 15 preserve exact source RGBA and 3 replace clipped props with complete binary-alpha pixel art; all have transparent gutters and centered anchors',
);
