import { strict as assert } from 'node:assert';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { FACILITY_SPECS } from '../../src/sim/facilities';
import {
  FACILITY_ATLAS_COLUMN,
  FACILITY_ATLAS_W,
  FACILITY_ATLAS_H,
  facilityBandY,
  facilityCellSize,
} from '../../src/render/facilityAtlas';

const image = await loadImage('public/sprites/facilities.png');
assert.equal(image.width, FACILITY_ATLAS_W);
assert.equal(image.height, FACILITY_ATLAS_H);
const c = createCanvas(image.width, image.height),
  ctx = c.getContext('2d');
ctx.drawImage(image, 0, 0);
const p = ctx.getImageData(0, 0, image.width, image.height).data;
let empty = 0;
for (let y = 0; y < image.height; y++)
  for (let x = 0; x < image.width; x++) {
    const used = y < 64 ? x < 64 : y < 192 ? x < 384 : true;
    if (!used) {
      assert.equal(p[(y * image.width + x) * 4 + 3], 0, `unused cell ${x},${y}`);
      empty++;
    }
  }
for (const spec of FACILITY_SPECS) {
  const k = spec.kind,
    size = facilityCellSize(spec.span),
    x0 = FACILITY_ATLAS_COLUMN[k] * size,
    y0 = facilityBandY(spec.span);
  let count = 0,
    bottomX = -1,
    bottomY = -1;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      if (!p[((y0 + y) * image.width + x0 + x) * 4 + 3]) continue;
      count++;
      if (y >= bottomY) {
        bottomY = y;
        bottomX = x;
      }
    }
  assert.ok(count > size * size * 0.15, `facility ${k} contains artwork`);
  assert.ok(bottomY >= size - 2, `facility ${k} bottom aligned`);
  assert.ok(Math.abs(bottomX - size / 2) <= 3, `facility ${k} centered anchor (${bottomX})`);
  console.log(
    `  OK   ${spec.name}: ${size}x${size}, bottom=${bottomX},${bottomY}, visible=${count}`,
  );
}
assert.ok(empty > 50000);
console.log('시설 아틀라스: 576x384, 7종, 투명 빈 셀·바닥 정렬 통과');
