import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import {
  ATLAS_CELL_COUNT,
  CIVIC_CELL_BASE,
  CIVIC_CELL_COUNT,
  drawCivicCells,
  drawRoadCells,
  drawZoneCells,
  ROAD_CELL_BASE,
  ROAD_CELL_COUNT,
  ZONE_CELL_BASE,
  ZONE_CELL_COUNT,
} from '../../src/render/atlas';
import {
  ATLAS_CELL_H,
  ATLAS_CELL_W,
  ATLAS_COLUMNS,
  ATLAS_PAD,
  TILE_H,
  TILE_W,
} from '../../src/core/constants';

const rows = Math.ceil(ATLAS_CELL_COUNT / ATLAS_COLUMNS),
  canvas = createCanvas(ATLAS_COLUMNS * ATLAS_CELL_W, rows * ATLAS_CELL_H),
  ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;
drawRoadCells(ctx as unknown as CanvasRenderingContext2D);
drawZoneCells(ctx as unknown as CanvasRenderingContext2D);
drawCivicCells(ctx as unknown as CanvasRenderingContext2D);

function image(index: number) {
  const x = (index % ATLAS_COLUMNS) * ATLAS_CELL_W + ATLAS_PAD,
    y = Math.floor(index / ATLAS_COLUMNS) * ATLAS_CELL_H + ATLAS_PAD;
  return ctx.getImageData(x, y, TILE_W, TILE_H);
}
function hash(data: Uint8ClampedArray): string {
  return createHash('sha256').update(data).digest('hex');
}
function palette(data: Uint8ClampedArray): Set<string> {
  const colors = new Set<string>();
  for (let i = 0; i < data.length; i += 4) {
    assert.equal(data[i + 3], 255, 'surface cells use opaque integer pixels');
    colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
  }
  return colors;
}
function halfHash(index: number): string {
  const cell = createCanvas(TILE_W, TILE_H);
  cell.getContext('2d').putImageData(image(index), 0, 0);
  const half = createCanvas(TILE_W / 2, TILE_H / 2),
    halfCtx = half.getContext('2d');
  halfCtx.imageSmoothingEnabled = false;
  halfCtx.drawImage(cell, 0, 0, half.width, half.height);
  return hash(halfCtx.getImageData(0, 0, half.width, half.height).data);
}
const groups = [
  ['road', ROAD_CELL_BASE, ROAD_CELL_COUNT],
  ['zone', ZONE_CELL_BASE, ZONE_CELL_COUNT],
  ['civic', CIVIC_CELL_BASE, CIVIC_CELL_COUNT],
] as const;
for (const [name, base, count] of groups) {
  const native = [],
    half = [],
    colors = new Set<string>();
  for (let i = 0; i < count; i++) {
    const data = image(base + i).data;
    native.push(hash(data));
    half.push(halfHash(base + i));
    for (const color of palette(data)) colors.add(color);
  }
  assert.equal(new Set(native).size, count, `${name}: every native state is distinct`);
  assert.equal(
    new Set(half).size,
    count,
    `${name}: every state remains distinct at 50% nearest-neighbor scale`,
  );
  // Zone group includes three light/dark families plus shared connected/disconnected marks.
  assert.ok(
    colors.size <= (name === 'zone' ? 12 : 8),
    `${name}: restrained palette (${colors.size})`,
  );
}
writeFileSync('.check/surfaces-pixel.png', canvas.toBuffer('image/png'));
console.log(
  'PASS surface pixel art: 16 road masks, 6 zone states and 2 civic states are opaque, distinct at 100/50%, and use restrained palettes',
);
