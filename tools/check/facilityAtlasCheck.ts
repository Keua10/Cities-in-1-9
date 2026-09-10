import { strict as assert } from 'node:assert';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { FACILITY_SPECS } from '../../src/sim/facilities';
import {
  FACILITY_ATLAS_COLUMN,
  FACILITY_ATLAS_H,
  FACILITY_ATLAS_W,
  facilityBandY,
  facilityCellSize,
  drawPowerFacilities,
  drawSanitationFacilities,
  drawSpecialFacilities,
  drawWaterFacilities,
} from '../../src/render/facilityAtlas';

const image = await loadImage('public/sprites/facilities.png');
assert.ok(image.width === 576 || image.width === 2112 || image.width === FACILITY_ATLAS_W);
assert.ok(image.height === 384 || image.height === FACILITY_ATLAS_H);

// 기존 0~6 그림의 위치/기준점은 그대로여야 한다.
const raw = createCanvas(image.width, image.height);
const rawCtx = raw.getContext('2d');
rawCtx.drawImage(image, 0, 0);
const pixels = rawCtx.getImageData(0, 0, image.width, image.height).data;
for (const spec of FACILITY_SPECS.slice(0, 7)) {
  const size = facilityCellSize(spec.span);
  const x0 = FACILITY_ATLAS_COLUMN[spec.kind] * size;
  const y0 = facilityBandY(spec.span);
  let count = 0;
  let bottomX = -1;
  let bottomY = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!pixels[((y0 + y) * image.width + x0 + x) * 4 + 3]) continue;
      count++;
      if (y >= bottomY) {
        bottomY = y;
        bottomX = x;
      }
    }
  }
  assert.ok(count > size * size * 0.15, `facility ${spec.kind} contains artwork`);
  assert.ok(bottomY >= size - 2, `facility ${spec.kind} bottom aligned`);
  assert.ok(Math.abs(bottomX - size / 2) <= 3, `facility ${spec.kind} centered anchor`);
}

// 5x5/7x7 밴드를 포함하는 런타임 확장 아틀라스에서 모든 시설이 실제로 보이는지 확인한다.
const extended = createCanvas(FACILITY_ATLAS_W, FACILITY_ATLAS_H);
const ctx = extended.getContext('2d');
ctx.drawImage(image, 0, 0);
drawWaterFacilities(ctx as unknown as CanvasRenderingContext2D);
drawPowerFacilities(ctx as unknown as CanvasRenderingContext2D);
drawSanitationFacilities(ctx as unknown as CanvasRenderingContext2D);
drawSpecialFacilities(ctx as unknown as CanvasRenderingContext2D);
for (const spec of FACILITY_SPECS.slice(7)) {
  const size = facilityCellSize(spec.span);
  const data = ctx.getImageData(
    FACILITY_ATLAS_COLUMN[spec.kind] * size,
    facilityBandY(spec.span),
    size,
    size,
  ).data;
  let visible = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]) visible++;
  assert.ok(visible > size * size * 0.12, `${spec.name} runtime artwork is visible`);
}

assert.ok(FACILITY_ATLAS_H > 384, '5x5/7x7 시설 밴드가 기존 아틀라스 아래에 확장됨');
console.log(`시설 아틀라스: ${FACILITY_SPECS.length}종, 기존 셀 보존 + 5x5/7x7 교통시설 런타임 아트 통과`);
