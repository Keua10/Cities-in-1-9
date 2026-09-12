import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const CANDIDATES = [];
for (let level = 1; level <= 3; level++)
  for (let zone = 0; zone < 3; zone++)
    for (let variant = 0; variant < 2; variant++)
      CANDIDATES.push({
        id: `${['residential', 'commercial', 'industrial'][zone]}-l${level}-${variant ? 'b' : 'a'}`,
        level,
        zone,
        variant,
      });

const REPAIRS = {
  'residential-l3-b': {
    path: 'tools/art/building-repairs/residential-l3-b-source.png',
    maxWidth: 180,
    maxHeight: 164,
  },
  'commercial-l3-a': {
    path: 'tools/art/building-repairs/commercial-l3-a-source.png',
    maxWidth: 180,
    maxHeight: 164,
  },
  'industrial-l3-a': {
    path: 'tools/art/building-repairs/industrial-l3-a-source.png',
    maxWidth: 180,
    maxHeight: 150,
  },
};
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
    bottomCenter: (Math.min(...bottom) + Math.max(...bottom)) / 2,
    colors: colors.size,
    opaque,
    partial,
  };
}

async function replacementCanvas(repair, size) {
  const image = await loadImage(repair.path),
    sourceCanvas = createCanvas(image.width, image.height),
    sourceCtx = sourceCanvas.getContext('2d');
  sourceCtx.drawImage(image, 0, 0);
  const sourceData = sourceCtx.getImageData(0, 0, image.width, image.height);
  for (let i = 3; i < sourceData.data.length; i += 4)
    sourceData.data[i] = sourceData.data[i] >= 96 ? 255 : 0;
  sourceCtx.putImageData(sourceData, 0, 0);
  const sourceMeasure = measure(sourceData.data, image.width),
    cropWidth = sourceMeasure.bounds[2] - sourceMeasure.bounds[0] + 1,
    cropHeight = sourceMeasure.bounds[3] - sourceMeasure.bounds[1] + 1,
    scale = Math.min(repair.maxWidth / cropWidth, repair.maxHeight / cropHeight),
    drawWidth = Math.max(1, Math.round(cropWidth * scale)),
    drawHeight = Math.max(1, Math.round(cropHeight * scale));

  const draw = (dx) => {
    const canvas = createCanvas(size, size),
      ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      sourceCanvas,
      sourceMeasure.bounds[0],
      sourceMeasure.bounds[1],
      cropWidth,
      cropHeight,
      dx,
      size - 1 - drawHeight,
      drawWidth,
      drawHeight,
    );
    const data = ctx.getImageData(0, 0, size, size);
    for (let i = 0; i < data.data.length; i += 4) {
      if (data.data[i + 3] < 128) {
        data.data[i + 3] = 0;
        continue;
      }
      data.data[i] = Math.min(255, Math.round(data.data[i] / 32) * 32);
      data.data[i + 1] = Math.min(255, Math.round(data.data[i + 1] / 32) * 32);
      data.data[i + 2] = Math.min(255, Math.round(data.data[i + 2] / 32) * 32);
      data.data[i + 3] = 255;
    }
    ctx.putImageData(data, 0, 0);
    return canvas;
  };
  const desiredCenter = size / 2 - 0.5,
    initialX = Math.round((size - drawWidth) / 2),
    initial = draw(initialX),
    initialMeasure = measure(initial.getContext('2d').getImageData(0, 0, size, size).data, size),
    anchorShift = Math.round(desiredCenter - initialMeasure.bottomCenter);
  return draw(initialX + anchorShift);
}

mkdirSync('public/sprites/candidates', { recursive: true });
const manifest = [];
for (const { id, level, zone, variant } of CANDIDATES) {
  const size = level * 64,
    repair = REPAIRS[id];
  let canvas,
    before,
    dx = 0,
    dy = 0;
  if (repair) {
    canvas = await replacementCanvas(repair, size);
  } else {
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
    before = measure(sourcePixels, size);
    const desiredCenter = size / 2 - 0.5;
    dx = Math.round(desiredCenter - before.bottomCenter);
    dy = size - 2 - before.bounds[3];
    canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sourceCanvas, dx, dy);
    const candidatePixels = ctx.getImageData(0, 0, size, size).data,
      after = measure(candidatePixels, size);
    assert.equal(before.partial, 0, `${id}: source binary alpha`);
    assert.equal(after.opaque, before.opaque, `${id}: no source pixels lost`);
    assert.equal(after.colors, before.colors, `${id}: source colors preserved`);
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
  }

  const candidatePixels = canvas.getContext('2d').getImageData(0, 0, size, size).data,
    after = measure(candidatePixels, size),
    desiredCenter = size / 2 - 0.5,
    centerError = Math.abs(after.bottomCenter - desiredCenter);
  assert.equal(after.partial, 0, `${id}: candidate binary alpha`);
  assert.ok(after.bounds[0] >= 1 && after.bounds[2] <= size - 2, `${id}: horizontal gutter`);
  assert.ok(after.bounds[1] >= 1 && after.bounds[3] === size - 2, `${id}: vertical gutter`);
  assert.ok(centerError <= 0.5, `${id}: centered bottom anchor`);
  writeFileSync(`public/sprites/candidates/${id}.png`, canvas.toBuffer('image/png'));
  manifest.push({
    id,
    level,
    zone,
    variant,
    mode: repair ? 'restored' : 'source-preserved',
    colors: after.colors,
    bounds: after.bounds,
    centerError,
    shift: repair ? null : [dx, dy],
  });
  console.log(
    `${id}: ${size}x${size}, ${repair ? 'restored' : `shift ${dx},${dy}`}, bounds ${after.bounds.join(',')}, center error ${centerError}, ${after.colors} colors`,
  );
}
writeFileSync('public/sprites/candidates/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
