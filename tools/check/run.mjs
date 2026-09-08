import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const checks = {
  service: 'tools/check/serviceCheck.ts', traffic: 'tools/check/trafficCheck.ts',
  lane: 'tools/check/laneCheck.ts', sim: 'tools/simcheck.ts',
  disaster: 'tools/check/disasterCheck.ts', atlas: 'tools/check/facilityAtlasCheck.ts',
};
mkdirSync('.check', { recursive: true });
for (const name of process.argv.length > 2 ? process.argv.slice(2) : Object.keys(checks)) {
  if (!checks[name]) throw new Error(`Unknown check: ${name}`);
  const outfile = resolve('.check', `${name}.mjs`);
  await build({ entryPoints: [checks[name]], outfile, bundle: true, platform: 'node',
    format: 'esm', alias: { 'pixi.js': resolve('tools/check/stub-pixi.ts') },
    external: ['@napi-rs/canvas'], logLevel: 'warning' });
  const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
