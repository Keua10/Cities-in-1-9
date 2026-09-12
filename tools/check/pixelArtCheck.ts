import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { buildingArt, BUILDING_ART_VARIANTS, BUILDING_NAMES } from '../../src/render/buildingArt';
import { facilityArt } from '../../src/render/facilityArt';
import { PixelArt, PIXEL_PALETTE } from '../../src/render/pixelArt';
import { FACILITY_SPECS } from '../../src/sim/facilities';
import {
  BUILDING_ATLAS_W,
  BUILDING_ATLAS_H,
  drawBuildingAtlas,
} from '../../src/render/buildingAtlas';
import {
  FACILITY_ATLAS_W,
  FACILITY_ATLAS_H,
  drawFacilityAtlas,
} from '../../src/render/facilityAtlas';

const palette = new Set(Object.values(PIXEL_PALETTE).map((s) => parseInt(s.slice(1), 16)));
const seen = new Set<string>();
function verify(a: PixelArt, label: string): void {
  let count = 0,
    bottom = -1,
    minBottom = a.size,
    maxBottom = -1;
  assert.equal(a.clippedPixels, 0, `${label}: no clipped roof/props/footprint`);
  for (let y = 0; y < a.size; y++)
    for (let x = 0; x < a.size; x++) {
      const i = (y * a.size + x) * 4,
        alpha = a.data[i + 3];
      assert.ok(alpha === 0 || alpha === 255, `${label}: binary alpha`);
      if (!alpha) continue;
      assert.ok(x > 0 && y > 0 && x < a.size - 1 && y < a.size - 1, `${label}: transparent gutter`);
      assert.ok(
        palette.has((a.data[i] << 16) + (a.data[i + 1] << 8) + a.data[i + 2]),
        `${label}: shared palette`,
      );
      count++;
      if (y > bottom) {
        bottom = y;
        minBottom = x;
        maxBottom = x;
      } else if (y === bottom) {
        minBottom = Math.min(x, minBottom);
        maxBottom = Math.max(x, maxBottom);
      }
    }
  assert.ok(count > a.size * a.size * 0.18, `${label}: visible art`);
  assert.ok(bottom >= a.size - 4, `${label}: ground anchor`);
  assert.ok(
    Math.abs((minBottom + maxBottom) / 2 - a.size / 2) <= 2,
    `${label}: centered ground anchor`,
  );
  const hash = createHash('sha256').update(a.data).digest('hex');
  assert.ok(!seen.has(hash), `${label}: distinct artwork`);
  seen.add(hash);
}
for (let zone = 0; zone < 3; zone++)
  for (let level = 1; level <= 3; level++)
    for (let v = 0; v < BUILDING_ART_VARIANTS; v++) {
      const a = buildingArt(level, zone, v);
      verify(a, BUILDING_NAMES[zone][level - 1][v]);
      assert.deepEqual(a.data, buildingArt(level, zone, v).data, 'redraw is deterministic');
    }
for (const spec of FACILITY_SPECS) {
  const a = facilityArt(spec.kind);
  verify(a, spec.name);
  assert.deepEqual(a.data, facilityArt(spec.kind).data);
}
// The same prop is exactly the same pixels across parcel sizes; no scaled sprites.
for (const size of [128, 192, 320, 448]) {
  const small = new PixelArt(64),
    large = new PixelArt(size);
  small.tree(0.5, 0.6);
  large.tree(0.5, 0.6);
  const delta = (size - 64) / 2;
  for (let y = 1; y < 63; y++)
    for (let x = 1; x < 63; x++)
      assert.deepEqual(
        [...small.data.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)],
        [
          ...large.data.slice(
            ((y + delta) * size + x + delta) * 4,
            ((y + delta) * size + x + delta) * 4 + 4,
          ),
        ],
      );
}
mkdirSync('.check', { recursive: true });
for (const [name, w, h, draw] of [
  ['buildings', BUILDING_ATLAS_W, BUILDING_ATLAS_H, drawBuildingAtlas],
  ['facilities', FACILITY_ATLAS_W, FACILITY_ATLAS_H, drawFacilityAtlas],
] as const) {
  const canvas = createCanvas(w, h);
  draw(canvas.getContext('2d') as unknown as CanvasRenderingContext2D);
  writeFileSync(`.check/${name}-pixel.png`, canvas.toBuffer('image/png'));
}
console.log(
  `PASS pixel art: ${seen.size} distinct sprites, deterministic, fixed-scale props, shared ${palette.size}-color palette, binary alpha, transparent gutters, centered anchors`,
);
