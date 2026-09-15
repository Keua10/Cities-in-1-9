import { build } from 'esbuild';
import { createCanvas } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync('.check', { recursive: true });
const outfile = resolve('.check/vehicle-art.mjs');
await build({
  entryPoints: ['src/render/vehicleAtlas.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: { 'pixi.js': resolve('tools/check/stub-pixi.ts') },
});
const art = await import(pathToFileURL(outfile).href);
const canvas = createCanvas(art.VEHICLE_ATLAS_W, art.VEHICLE_ATLAS_H);
art.drawPlaceholder(canvas.getContext('2d'));
writeFileSync('public/sprites/vehicles-pixel.png', canvas.toBuffer('image/png'));
console.log('Generated 32 native vehicle sprites: 4 views × 4 palettes × 2 kinds.');
