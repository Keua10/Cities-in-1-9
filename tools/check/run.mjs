import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const checks = {
  pixel: 'tools/check/pixelArtCheck.ts',
  visual: 'tools/check/visualRegressionCheck.ts',
  advice: 'tools/check/cityAdviceCheck.ts',
  surface: 'tools/check/surfaceArtCheck.ts',
  candidate: 'tools/check/legacyBuildingCandidatesCheck.ts',
  infrastructure: 'tools/check/terrainInfrastructureCheck.ts',
  policies: 'tools/check/policySanitationCheck.ts',
  power: 'tools/check/powerCheck.ts',
  water: 'tools/check/waterCheck.ts',
  progression: 'tools/check/progressionCheck.ts',
  placement: 'tools/check/placementCheck.ts',
  service: 'tools/check/serviceCheck.ts',
  traffic: 'tools/check/trafficCheck.ts',
  lane: 'tools/check/laneCheck.ts',
  sim: 'tools/simcheck.ts',
  disaster: 'tools/check/disasterCheck.ts',
  atlas: 'tools/check/facilityAtlasCheck.ts',
  special: 'tools/check/specialFacilityCheck.ts',
  transport: 'tools/check/transportHubCheck.ts',
  structure: 'tools/check/structureCheck.ts',
  citygen: 'tools/check/cityGenCheck.ts',
};
mkdirSync('.check', { recursive: true });
for (const name of process.argv.length > 2 ? process.argv.slice(2) : Object.keys(checks)) {
  if (!checks[name]) throw new Error(`Unknown check: ${name}`);
  const outfile = resolve('.check', `${name}.mjs`);
  await build({
    entryPoints: [checks[name]],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    alias: { 'pixi.js': resolve('tools/check/stub-pixi.ts') },
    external: ['@napi-rs/canvas'],
    logLevel: 'warning',
  });
  const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
