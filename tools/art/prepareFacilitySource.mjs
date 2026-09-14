import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readRaster, encodeRaster, describe, rgbKey } from './footprintMath.mjs';
import { alignFacilityFootprint } from './facilityFootprint.mjs';

// Prepare an ImageGen output for native-resolution game use. No Python or smooth resampling.
const [kindArg, input] = process.argv.slice(2);
const specs = JSON.parse(readFileSync('tools/art/facility-review/specs.json', 'utf8'));
const spec = specs[Number(kindArg)];
if (!spec || !input)
  throw new Error('Usage: node tools/art/prepareFacilitySource.mjs KIND INPUT.png');
const source = await readRaster(input),
  { width: w, height: h, data: d } = source;
const n = w * h,
  outside = new Uint8Array(n),
  queue = new Int32Array(n);
let head = 0,
  tail = 0;
const hasAlpha = describe(source).opaque < n * 0.96;
const matteFloor = [1, 22, 23].includes(spec.kind) ? 100 : 160;
const background = (i) =>
  d[i * 4 + 3] < 128 ||
  (!hasAlpha &&
    Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) >= matteFloor &&
    Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) -
      Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) <=
      22);
const visit = (i) => {
  if (i < 0 || i >= n || outside[i] || !background(i)) return;
  outside[i] = 1;
  queue[tail++] = i;
};
for (let x = 0; x < w; x++) {
  visit(x);
  visit((h - 1) * w + x);
}
for (let y = 0; y < h; y++) {
  visit(y * w);
  visit(y * w + w - 1);
}
while (head < tail) {
  const i = queue[head++],
    x = i % w;
  if (x) visit(i - 1);
  if (x < w - 1) visit(i + 1);
  visit(i - w);
  visit(i + w);
}
for (let i = 0; i < n; i++) d[i * 4 + 3] = outside[i] || d[i * 4 + 3] < 128 ? 0 : 255;
// Keep detached genuine props; never crop to a guessed diamond or delete isolated antennas.
const bounds = describe(source).bounds;
if (bounds[0] <= 0 || bounds[1] <= 0 || bounds[2] >= w - 1 || bounds[3] >= h - 1)
  throw new Error('Generated source touches frame: inspect and regenerate instead of cropping');
const size = spec.span * 64,
  cw = bounds[2] - bounds[0] + 1,
  ch = bounds[3] - bounds[1] + 1;
const palette = new Set();
for (const name of ['commercial-l3-a', 'residential-l3-a', 'industrial-l3-a']) {
  const r = await readRaster(`public/sprites/aligned/${name}.png`);
  for (const key of describe(r).palette) palette.add(key);
}
const colors = [...palette].map((k) => [k >> 16, (k >> 8) & 255, k & 255]);
const cache = new Map();
function mapped(i) {
  const key = rgbKey(d, i);
  if (!cache.has(key)) {
    const rgb = [d[i], d[i + 1], d[i + 2]];
    let best = colors[0],
      score = Infinity;
    for (const c of colors) {
      const dr = c[0] - rgb[0],
        dg = c[1] - rgb[1],
        db = c[2] - rgb[2];
      const dist =
        dr * dr + dg * dg + db * db + 0.5 * (0.2126 * dr + 0.7152 * dg + 0.0722 * db) ** 2;
      if (dist < score) {
        score = dist;
        best = c;
      }
    }
    cache.set(key, best);
  }
  return cache.get(key);
}
let native, projection;
const margins = [6, 10, 16, 24, 32, 48].filter((m) => m < size * 0.5);
for (const margin of margins) {
  native = { width: size, height: size, data: new Uint8ClampedArray(size * size * 4) };
  const scale = Math.min((size - margin) / cw, (size - margin) / ch),
    dw = Math.round(cw * scale),
    dh = Math.round(ch * scale);
  const left = Math.floor((size - dw) / 2),
    top = size - 4 - dh;
  for (let y = 0; y < dh; y++)
    for (let x = 0; x < dw; x++) {
      const sx = bounds[0] + Math.min(cw - 1, Math.floor(((x + 0.5) * cw) / dw)),
        sy = bounds[1] + Math.min(ch - 1, Math.floor(((y + 0.5) * ch) / dh)),
        i = (sy * w + sx) * 4;
      if (!d[i + 3]) continue;
      const j = ((top + y) * size + left + x) * 4;
      native.data.set([...mapped(i), 255], j);
    }
  try {
    projection = alignFacilityFootprint(native);
    const tip = projection.projection.sourceFront.cx + projection.projection.dx;
    if (Math.abs(tip - (size - 1) / 2) > 0.75)
      throw new Error(`${spec.id}: needs room to center the true lot apex without clipping`);
    break;
  } catch (e) {
    if (margin === margins.at(-1)) throw e;
  }
}
writeFileSync(`tools/art/facility-sources/${spec.id}.png`, encodeRaster(native));
writeFileSync(`public/sprites/facilities-detailed/${spec.id}.png`, encodeRaster(projection.raster));
const record = {
  ...spec,
  sourceFile: input.split(/[\\/]/).at(-1),
  sourceHash: createHash('sha256').update(readFileSync(input)).digest('hex'),
  sourceDimensions: [w, h],
  backgroundRemoval: hasAlpha ? 'source alpha' : 'edge-connected neutral matte removal',
  nativeSize: size,
  palette: 'union of approved commercial-l3-a, residential-l3-a, industrial-l3-a RGB palettes',
  projection: projection.projection,
};
writeFileSync(
  `tools/art/facility-review/${spec.id}-preparation.json`,
  JSON.stringify(record, null, 2) + '\n',
);
console.log(
  `${spec.kind} ${spec.name}: prepared ${size}px, source ${w}x${h}, ${record.backgroundRemoval}`,
);
