import { strict as assert } from 'node:assert';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { FACILITY_SPECS } from '../../src/sim/facilities';
import {
  FACILITY_ATLAS_COLUMN,
  FACILITY_ATLAS_W,
  FACILITY_ATLAS_H,
  facilityBandY,
  facilityCellSize,
  drawWaterFacilities,
} from '../../src/render/facilityAtlas';

const image = await loadImage('public/sprites/facilities.png');
assert.equal(image.width, 576);
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
for (const spec of FACILITY_SPECS.slice(0, 7)) {
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
const extended = createCanvas(FACILITY_ATLAS_W, FACILITY_ATLAS_H);
const extendedCtx = extended.getContext('2d');
extendedCtx.drawImage(image, 0, 0);
drawWaterFacilities(extendedCtx as unknown as CanvasRenderingContext2D);
for (const spec of FACILITY_SPECS.slice(7)) {
  const size = facilityCellSize(spec.span);
  const data = extendedCtx.getImageData(
    FACILITY_ATLAS_COLUMN[spec.kind] * size,
    facilityBandY(spec.span),
    size,
    size,
  ).data;
  let pixels = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]) pixels++;
  assert.ok(pixels > size * size * 0.15, `${spec.name} runtime artwork is visible`);
}
console.log('상하수도 4종 런타임 아트 및 확장 아틀라스 통과');
