import { strict as assert } from 'node:assert';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { drawPlaceholder, VEHICLE_ATLAS_W, VEHICLE_ATLAS_H } from '../../src/render/vehicleAtlas';
import { drawPixelWalker } from '../../src/render/pedestrianLayer';
import { drawSignalHead } from '../../src/render/signalLayer';
import { SignalState } from '../../src/sim/traffic/signals';
import type { Graphics } from 'pixi.js';

const canvas = createCanvas(VEHICLE_ATLAS_W, VEHICLE_ATLAS_H);
const ctx = canvas.getContext('2d');
drawPlaceholder(ctx as unknown as CanvasRenderingContext2D);
const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
for (let i = 3; i < data.length; i += 4)
  assert.ok(data[i] === 0 || data[i] === 255, 'binary pixel alpha');
for (let row = 0; row < 2; row++)
  for (let col = 0; col < 16; col++) {
    let count = 0;
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++) {
        const a = data[((row * 32 + y) * canvas.width + col * 32 + x) * 4 + 3];
        if (a) count++;
        if (x === 0 || y === 0 || x === 31 || y === 31)
          assert.equal(a, 0, 'cell borders must not clip art');
      }
    assert.ok(count > 30, 'every view and variant is populated');
  }
const source = await loadImage('public/sprites/vehicles-pixel.png');
ctx.clearRect(0, 0, canvas.width, canvas.height);
ctx.drawImage(source, 0, 0);
assert.deepEqual(
  ctx.getImageData(0, 0, canvas.width, canvas.height).data,
  data,
  'shipped atlas matches painter',
);
const shapes: number[][] = [];
const fills: unknown[] = [];
const fake = {
  rect(...args: number[]) {
    shapes.push(args);
    return this;
  },
  fill(color: unknown) {
    fills.push(color);
    return this;
  },
} as unknown as Graphics;
for (const stride of [0, 1]) drawPixelWalker(fake, 32, 32, 0x7394ad, stride);
for (const state of [SignalState.Red, SignalState.Yellow, SignalState.Green]) {
  fills.length = 0;
  drawSignalHead(fake, 32, 32, state);
  assert.equal(
    fills.filter((c) => [0xe77c69, 0xe9c678, 0x82c893].includes(c as number)).length,
    1,
    'only current lamp lit',
  );
}
assert.ok(
  shapes.every((r) => r.every(Number.isInteger)),
  'walker and signal geometry uses integer pixels',
);
console.log(
  'Moving pixel art passed: 32 cells, binary alpha, borders, reproducible atlas, integer figures and one active lamp.',
);
