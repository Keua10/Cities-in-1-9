import { strict as assert } from 'node:assert';
import { createCanvas, loadImage } from '@napi-rs/canvas';

export async function readRaster(path) {
  const image = await loadImage(path),
    canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return {
    width: image.width,
    height: image.height,
    data: ctx.getImageData(0, 0, image.width, image.height).data,
  };
}
export function encodeRaster(raster) {
  const canvas = createCanvas(raster.width, raster.height),
    ctx = canvas.getContext('2d');
  const image = ctx.createImageData(raster.width, raster.height);
  image.data.set(raster.data);
  ctx.putImageData(image, 0, 0);
  return canvas.toBuffer('image/png');
}
export const rgbKey = (d, i) => (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
export function describe(r) {
  const { width: w, height: h, data: d } = r;
  const bounds = [w, h, -1, -1],
    palette = new Set(),
    edge = new Array(w).fill(-1);
  let opaque = 0,
    partial = 0,
    border = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (!d[i + 3]) continue;
      opaque++;
      if (d[i + 3] !== 255) partial++;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border++;
      bounds[0] = Math.min(x, bounds[0]);
      bounds[1] = Math.min(y, bounds[1]);
      bounds[2] = Math.max(x, bounds[2]);
      bounds[3] = Math.max(y, bounds[3]);
      palette.add(rgbKey(d, i));
      edge[x] = y;
    }
  return { bounds, palette, edge, opaque, partial, border };
}

function leastSquares(points) {
  const mx = points.reduce((n, p) => n + p[0], 0) / points.length;
  const my = points.reduce((n, p) => n + p[1], 0) / points.length;
  const m =
    points.reduce((n, p) => n + (p[0] - mx) * (p[1] - my), 0) /
    points.reduce((n, p) => n + (p[0] - mx) ** 2, 0);
  return { m, b: my - m * mx };
}
// Fit the visible straight front edges; exclude the clipped flat apex and sparse props.
// The manifest retains inliers/residuals so this is auditable, not a silhouette verdict.
export function fitFront(r) {
  const { edge, bounds } = describe(r),
    w = r.width;
  const fit = (side) => {
    const points = edge
      .map((y, x) => [x, y])
      .filter(
        ([x, y]) =>
          y >= 0 &&
          y < bounds[3] - 1 &&
          x >= w * (side ? 0.57 : 0.07) &&
          x <= w * (side ? 0.93 : 0.43),
      );
    let best = [];
    for (let a = 0; a < points.length; a++)
      for (let b = a + 1; b < points.length; b++) {
        const p = points[a],
          q = points[b];
        if (q[0] - p[0] < w * 0.1) continue;
        const m = (q[1] - p[1]) / (q[0] - p[0]),
          intercept = p[1] - m * p[0];
        if (Math.abs(m) < 0.3 || Math.abs(m) > 0.9 || (side ? m >= 0 : m <= 0)) continue;
        const inliers = points.filter(([x, y]) => Math.abs(y - m * x - intercept) <= 1.15);
        if (inliers.length > best.length) best = inliers;
      }
    assert.ok(
      best.length >= Math.max(6, w * 0.13),
      'front edge needs enough visible ground samples',
    );
    const line = leastSquares(best);
    return {
      ...line,
      inliers: best.length,
      residual: Math.max(...best.map(([x, y]) => Math.abs(y - line.m * x - line.b))),
    };
  };
  const left = fit(0),
    right = fit(1),
    cx = (right.b - left.b) / (left.m - right.m);
  return { left, right, cx, cy: left.m * cx + left.b };
}

// Pixel colors are never interpolated. The affine projection straightens BOTH ground
// axes and keeps vertical lines vertical. It resamples rows; it is not a 3D reconstruction.
export function alignFootprint(source) {
  const s = source.width,
    before = describe(source),
    fit = fitFront(source);
  assert.equal(s, source.height);
  const scaleY = 1 / (fit.left.m - fit.right.m),
    shearY = 0.5 - scaleY * fit.left.m;
  const dx = Math.max(
    1 - before.bounds[0],
    Math.min(s - 2 - before.bounds[2], Math.round((s - 1) / 2 - fit.cx)),
  );
  let shiftY = s - 3 - scaleY * fit.cy - shearY * fit.cx;
  let minY = Infinity,
    maxFront = -Infinity;
  for (let y = 0; y < s; y++)
    for (let x = 0; x < s; x++)
      if (source.data[(y * s + x) * 4 + 3]) {
        const yy = scaleY * y + shearY * x + shiftY;
        minY = Math.min(minY, yy);
        maxFront = Math.max(maxFront, yy + Math.abs(x + dx - (s - 1) / 2) * 0.5);
      }
  shiftY -= Math.max(0, Math.ceil(maxFront - (s - 2.75)));
  assert.ok(
    minY + shiftY - (s - 3 - scaleY * fit.cy - shearY * fit.cx) >= 0.5,
    'projection would clip the roof; requires art repair',
  );
  const result = { width: s, height: s, data: new Uint8ClampedArray(s * s * 4) };
  // Sample the existing front paving/grass strip for a narrow, textured lot perimeter.
  // No new RGB colors and no blank colored backing rectangle.
  const center = (s - 1) / 2,
    bottom = s - 2;
  // Keep the original setback instead of widening small gardens into large blank slabs.
  const half = Math.min(
    s / 2 - 2,
    Math.ceil(Math.max(fit.cx - before.bounds[0], before.bounds[2] - fit.cx)),
  );
  for (let y = 1; y < s - 1; y++)
    for (let x = 1; x < s - 1; x++) {
      const distance = Math.abs(x - center),
        step = Math.ceil((distance - 0.5) * 0.5);
      const front = bottom - step,
        back = Math.max(bottom - half + step, front - 3);
      if (distance <= half && y >= back && y <= front) {
        const sx = Math.max(before.bounds[0], Math.min(before.bounds[2], x - dx));
        const depth = Math.min(3, Math.max(0, front - y));
        let sy = before.edge[sx] - depth;
        while (sy < before.edge[sx] && (sy < 0 || !source.data[(sy * s + sx) * 4 + 3])) sy++;
        if (sy >= 0)
          result.data.set(
            source.data.slice((sy * s + sx) * 4, (sy * s + sx) * 4 + 4),
            (y * s + x) * 4,
          );
      }
    }
  let outsideSourceSamples = 0;
  for (let y = 1; y < s - 1; y++)
    for (let x = 1; x < s - 1; x++) {
      const sx = x - dx,
        sy = Math.round((y - shearY * sx - shiftY) / scaleY);
      if (sx < 0 || sx >= s || sy < 0 || sy >= s) continue;
      const i = (sy * s + sx) * 4;
      if (source.data[i + 3]) result.data.set(source.data.slice(i, i + 4), (y * s + x) * 4);
    }
  for (let y = 0; y < s; y++)
    for (let x = 0; x < s; x++)
      if (source.data[(y * s + x) * 4 + 3]) {
        const xx = x + dx,
          yy = Math.round(scaleY * y + shearY * x + shiftY);
        if (xx < 1 || xx >= s - 1 || yy < 1 || yy >= s - 1) outsideSourceSamples++;
      }
  assert.equal(outsideSourceSamples, 0, 'all source geometry stays inside the cell');
  return {
    raster: result,
    projection: { scaleY, shearY, dx, shiftY, sourceFront: fit, outsideSourceSamples },
  };
}

const material = ([r, g, b]) =>
  g > r * 1.02 && g > b * 1.2
    ? 'green'
    : b > r * 1.07 && b > g * 1.01
      ? 'blue'
      : r > g * 1.3 && g > b * 1.15
        ? 'brick'
        : r > g * 1.2 && b > g * 1.1
          ? 'flower'
          : 'neutral';
function colorGroups(r) {
  const groups = new Map();
  for (let i = 0; i < r.data.length; i += 4) {
    if (!r.data[i + 3]) continue;
    const rgb = [...r.data.slice(i, i + 3)],
      group = material(rgb),
      key = rgbKey(r.data, i);
    if (!groups.has(group)) groups.set(group, new Map());
    const colors = groups.get(group);
    if (!colors.has(key)) colors.set(key, { key, rgb, count: 0 });
    colors.get(key).count++;
  }
  return new Map(
    [...groups].map(([group, colors]) => {
      const sorted = [...colors.values()].sort(
        (a, b) =>
          a.rgb[0] * 0.2126 +
            a.rgb[1] * 0.7152 +
            a.rgb[2] * 0.0722 -
            b.rgb[0] * 0.2126 -
            b.rgb[1] * 0.7152 -
            b.rgb[2] * 0.0722 || a.key - b.key,
      );
      const count = sorted.reduce((n, c) => n + c.count, 0),
        mean = [0, 1, 2].map((k) => sorted.reduce((n, c) => n + c.rgb[k] * c.count, 0) / count);
      let sum = 0;
      for (const c of sorted) {
        c.q = (sum + c.count / 2) / count;
        sum += c.count;
      }
      return [group, { sorted, mean }];
    }),
  );
}
export function restorePalette(input, reference) {
  const source = colorGroups(input),
    target = colorGroups(reference),
    map = new Map();
  for (const [group, value] of source) {
    const original = target.get(group) ?? target.get('neutral');
    for (const c of value.sorted) {
      const corrected = c.rgb.map((v, k) => v + original.mean[k] - value.mean[k]);
      let score = Infinity,
        chosen;
      for (const p of original.sorted) {
        const cost =
          60000 * (p.q - c.q) ** 2 + p.rgb.reduce((n, v, k) => n + (v - corrected[k]) ** 2, 0);
        if (cost < score) {
          score = cost;
          chosen = p.rgb;
        }
      }
      map.set(c.key, chosen);
    }
  }
  const result = { ...input, data: input.data.slice() };
  for (let i = 0; i < result.data.length; i += 4)
    if (result.data[i + 3]) result.data.set(map.get(rgbKey(input.data, i)), i);
  return result;
}
