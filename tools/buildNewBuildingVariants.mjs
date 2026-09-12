import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const VARIANTS = [];
for (let level = 1; level <= 3; level++)
  for (let zone = 0; zone < 3; zone++)
    for (const variant of ['c', 'd'])
      VARIANTS.push({
        id: `${['residential', 'commercial', 'industrial'][zone]}-l${level}-${variant}`,
        level,
        zone,
        variant: variant === 'c' ? 2 : 3,
      });

function measure(pixels, width, height = width) {
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1,
    opaque = 0,
    partial = 0;
  const colors = new Set();
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4,
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
  for (let x = 0; x < width; x++) if (pixels[(maxY * width + x) * 4 + 3]) bottom.push(x);
  return {
    bounds: [minX, minY, maxX, maxY],
    bottomCenter: (Math.min(...bottom) + Math.max(...bottom)) / 2,
    colors: colors.size,
    opaque,
    partial,
  };
}

function removeLightCheckerboard(pixels, width, height) {
  const seen = new Uint8Array(width * height),
    queue = new Int32Array(width * height);
  let head = 0,
    tail = 0;
  const isBackground = (position) => {
    const i = position * 4,
      r = pixels[i],
      g = pixels[i + 1],
      b = pixels[i + 2];
    return Math.max(r, g, b) - Math.min(r, g, b) <= 18 && Math.min(r, g, b) >= 145;
  };
  const enqueue = (position) => {
    if (seen[position] || !isBackground(position)) return;
    seen[position] = 1;
    queue[tail++] = position;
  };
  for (let x = 0; x < width; x++) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }
  while (head < tail) {
    const position = queue[head++],
      x = position % width,
      y = Math.floor(position / width);
    pixels[position * 4 + 3] = 0;
    if (x > 0) enqueue(position - 1);
    if (x + 1 < width) enqueue(position + 1);
    if (y > 0) enqueue(position - width);
    if (y + 1 < height) enqueue(position + width);
  }
}

function keepLargestAlphaComponent(pixels, width, height) {
  const seen = new Uint8Array(width * height),
    queue = new Int32Array(width * height),
    components = [];
  for (let start = 0; start < width * height; start++) {
    if (seen[start] || !pixels[start * 4 + 3]) continue;
    let head = 0,
      tail = 0;
    const component = [];
    seen[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const position = queue[head++],
        x = position % width,
        y = Math.floor(position / width);
      component.push(position);
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
          if ((!ox && !oy) || x + ox < 0 || x + ox >= width || y + oy < 0 || y + oy >= height)
            continue;
          const next = position + oy * width + ox;
          if (seen[next] || !pixels[next * 4 + 3]) continue;
          seen[next] = 1;
          queue[tail++] = next;
        }
    }
    components.push(component);
  }
  components.sort((a, b) => b.length - a.length);
  const keep = new Uint8Array(width * height);
  for (const position of components[0] ?? []) keep[position] = 1;
  for (let position = 0; position < width * height; position++)
    if (!keep[position]) pixels[position * 4 + 3] = 0;
}

async function buildVariant(info) {
  const sourcePath = `tools/art/building-variants/${info.id}-source.png`,
    image = await loadImage(sourcePath),
    sourceCanvas = createCanvas(image.width, image.height),
    sourceCtx = sourceCanvas.getContext('2d');
  sourceCtx.drawImage(image, 0, 0);
  const sourceData = sourceCtx.getImageData(0, 0, image.width, image.height);
  let transparent = 0;
  for (let i = 3; i < sourceData.data.length; i += 4) if (sourceData.data[i] === 0) transparent++;
  if (!transparent) {
    removeLightCheckerboard(sourceData.data, image.width, image.height);
    keepLargestAlphaComponent(sourceData.data, image.width, image.height);
  }
  for (let i = 3; i < sourceData.data.length; i += 4)
    sourceData.data[i] = sourceData.data[i] >= 96 ? 255 : 0;
  sourceCtx.putImageData(sourceData, 0, 0);

  const before = measure(sourceData.data, image.width, image.height);
  assert.ok(before.opaque > 0, `${info.id}: source foreground found`);
  const cropWidth = before.bounds[2] - before.bounds[0] + 1,
    cropHeight = before.bounds[3] - before.bounds[1] + 1,
    size = info.level * 64,
    maxWidth = [0, 60, 110, 170][info.level],
    maxHeight = [0, 54, 104, 156][info.level],
    scale = Math.min(1, maxWidth / cropWidth, maxHeight / cropHeight),
    drawWidth = Math.max(1, Math.round(cropWidth * scale)),
    drawHeight = Math.max(1, Math.round(cropHeight * scale));

  const draw = (dx, dy = 0) => {
    const canvas = createCanvas(size, size),
      ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      sourceCanvas,
      before.bounds[0],
      before.bounds[1],
      cropWidth,
      cropHeight,
      dx,
      size - 1 - drawHeight + dy,
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
    initialPixels = initial.getContext('2d').getImageData(0, 0, size, size).data,
    initialMeasure = measure(initialPixels, size),
    anchorShift = Math.round(desiredCenter - initialMeasure.bottomCenter),
    bottomShift = size - 2 - initialMeasure.bounds[3],
    canvas = draw(initialX + anchorShift, bottomShift),
    pixels = canvas.getContext('2d').getImageData(0, 0, size, size).data,
    after = measure(pixels, size),
    centerError = Math.abs(after.bottomCenter - desiredCenter);
  assert.equal(after.partial, 0, `${info.id}: binary alpha`);
  assert.ok(after.bounds[0] >= 1 && after.bounds[2] <= size - 2, `${info.id}: horizontal gutter`);
  assert.ok(after.bounds[1] >= 1 && after.bounds[3] === size - 2, `${info.id}: vertical gutter`);
  assert.ok(centerError <= 0.5, `${info.id}: centered bottom anchor`);
  mkdirSync('public/sprites/candidates', { recursive: true });
  writeFileSync(`public/sprites/candidates/${info.id}.png`, canvas.toBuffer('image/png'));
  return {
    ...info,
    mode: 'new-pixel',
    colors: after.colors,
    bounds: after.bounds,
    centerError,
    sourceSize: [image.width, image.height],
  };
}

const built = [];
for (const info of VARIANTS) {
  const sourcePath = `tools/art/building-variants/${info.id}-source.png`;
  if (!existsSync(sourcePath)) continue;
  const result = await buildVariant(info);
  built.push(result);
  console.log(
    `${result.id}: ${result.level * 64}x${result.level * 64}, bounds ${result.bounds.join(',')}, center error ${result.centerError}, ${result.colors} colors`,
  );
}
writeFileSync(
  'public/sprites/candidates/generated-manifest.json',
  `${JSON.stringify(built, null, 2)}\n`,
);
