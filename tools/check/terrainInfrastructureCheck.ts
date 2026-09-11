import { strict as assert } from 'node:assert';
import { BASE_CHUNK_SPAN, CHUNK_SIZE } from '../../src/core/constants';
import { World } from '../../src/world/world';
import {
  generateChunk,
  heightAt,
  isWater,
  outerTerrainAt,
  terrainAt,
} from '../../src/world/terrain';
import { utilityPenalty } from '../../src/sim/config/infrastructure';
import { satisfaction } from '../../src/sim/satisfaction';
import { NEEDS_PENALTY_MAX, SATISFACTION_FLOOR } from '../../src/sim/simConstants';
import { ZONE_R } from '../../src/sim/buildings';

const counts = [0, 0, 0],
  legacy = [0, 0, 0];
let total = 0;
for (let y = -2048; y < 2048; y += 8)
  for (let x = -2048; x < 2048; x += 8) {
    if (x >= 0 && x < 128 && y >= 0 && y < 128) continue;
    const t = outerTerrainAt(x, y);
    counts[isWater(t.tile) ? 2 : t.height >= 5 ? 1 : 0]++;
    legacy[isWater(terrainAt(x, y)) ? 2 : heightAt(x, y) >= 5 ? 1 : 0]++;
    if (isWater(t.tile)) assert.equal(t.height, 0);
    total++;
  }
const percentages = counts.map((v) => (v / total) * 100);
for (let i = 0; i < 3; i++) assert.ok(Math.abs(percentages[i] - [60, 30, 10][i]) < 3);
console.log('Flat/mountain/water:', {
  before: legacy.map((v) => +((v / total) * 100).toFixed(2)),
  after: percentages.map((v) => +v.toFixed(2)),
});

for (const city of [0, 1, 7]) {
  const world = new World(city);
  for (let dy = 0; dy < BASE_CHUNK_SPAN; dy++)
    for (let dx = 0; dx < BASE_CHUNK_SPAN; dx++) {
      const cx = world.baseCx + dx,
        cy = world.baseCy + dy;
      const base = world.getChunk(cx, cy),
        old = generateChunk(cx, cy);
      assert.deepEqual(base.tiles, old.tiles, 'base terrain unchanged');
      assert.deepEqual(base.heights, old.heights, 'base heights unchanged');
    }
  const cx = world.baseCx + 3,
    cy = world.baseCy - 2;
  for (let y = 0; y < 64; y += 9)
    for (let x = 0; x < 64; x += 9) {
      const tx = cx * 64 + x,
        ty = cy * 64 + y;
      const sampled = world.sampleHeight(tx, ty);
      assert.equal(sampled, world.getHeight(tx, ty), 'unloaded and rendered heights agree');
      assert.equal(world.getTile(tx, ty), outerTerrainAt(tx, ty).tile);
    }
  const snapshot = world.getChunk(cx, cy).heights.slice();
  world.unloadChunk(cx, cy);
  assert.deepEqual(world.getChunk(cx, cy).heights, snapshot, 'regeneration deterministic');
  const metadata = JSON.parse(JSON.stringify({ legacyTerrainChunks: [`${cx},${cy}`] }));
  world.preserveTerrainChunks(metadata.legacyTerrainChunks);
  assert.deepEqual(
    world.getChunk(cx, cy).tiles,
    generateChunk(cx, cy).tiles,
    'saved explored land preserved',
  );
  assert.deepEqual(world.getChunk(cx, cy).heights, generateChunk(cx, cy).heights);
  world.setHeight(cx * CHUNK_SIZE, cy * CHUNK_SIZE, 7);
  world.unloadChunk(cx, cy);
  assert.equal(world.sampleHeight(cx * CHUNK_SIZE, cy * CHUNK_SIZE), 7, 'user override wins');
}

// Identical commute and parks: isolate infrastructure sensitivity from terrain/building size.
const clean = { supply: 1, drainage: 1, contamination: 0 };
const shortage = { supply: 0, drainage: 0, contamination: 0 };
const occupancy = (tier: number, water: typeof clean, power: number) => {
  const gap = Math.min(NEEDS_PENALTY_MAX, utilityPenalty(tier, water, power, 1, 1, 1));
  const sat = satisfaction(ZONE_R, 0, 0, 0, gap, 0.12);
  return Math.max(
    0,
    Math.min(1, (sat - SATISFACTION_FLOOR[tier - 1]) / (1 - SATISFACTION_FLOOR[tier - 1])),
  );
};
for (const tier of [1, 2, 3]) {
  assert.equal(utilityPenalty(tier, clean, 1, 1, 1, 1), 0);
  assert.equal(utilityPenalty(tier, shortage, 0, 1, 0, 0), 0, 'existing time grace preserved');
  assert.equal(occupancy(tier, clean, 1), 1, 'restored infrastructure recovers occupancy');
}
assert.ok(occupancy(1, shortage, 0) > 0.5, 'L1 remains habitable');
assert.ok(occupancy(3, shortage, 0) < 0.001, 'parks cannot replace missing L3 utilities');
assert.ok(occupancy(3, clean, 0) < 0.001, 'L3 cannot sustain a complete power cut');
assert.ok(utilityPenalty(3, clean, 0.5, 1, 1, 1) > 4 * utilityPenalty(1, clean, 0.5, 1, 1, 1));
assert.equal(
  utilityPenalty(1, { ...clean, contamination: 1 }, 1, 0, 0, 0),
  0.2,
  'contamination is not discounted for low income',
);
console.log(
  'STEP 4.7/4.8 smoke passed: proportions, unchanged bases, saved land, unloaded heights, overrides, tier shortages, grace and recovery.',
);
