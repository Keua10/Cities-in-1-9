import { strict as assert } from 'node:assert';
import { BASE_CHUNK_SPAN, CHUNK_SIZE } from '../../src/core/constants';
import { World } from '../../src/world/world';
import {
  CONTINENT_H,
  CONTINENT_W,
  CONTINENT_X0,
  CONTINENT_Y0,
  generateContinentChunk,
  quickSite,
  sampleSite,
} from '../../src/world/continent';
import { utilityPenalty } from '../../src/sim/config/infrastructure';
import { satisfaction } from '../../src/sim/satisfaction';
import { NEEDS_PENALTY_MAX, SATISFACTION_FLOOR } from '../../src/sim/simConstants';
import { ZONE_R } from '../../src/sim/buildings';

// 지도 v2: 대륙 육지의 평지/산/물 비율. 큰 강은 필요 없다는 결정에 따라 물길은
// 좁고(개울) 드물며, 산맥이 도시 사이를 가르는 주된 장애물이다.
const counts = [0, 0, 0];
let land = 0;
for (let y = CONTINENT_Y0 * CHUNK_SIZE; y < (CONTINENT_Y0 + CONTINENT_H) * CHUNK_SIZE; y += 16)
  for (let x = CONTINENT_X0 * CHUNK_SIZE; x < (CONTINENT_X0 + CONTINENT_W) * CHUNK_SIZE; x += 16) {
    const s = quickSite(x, y);
    if (s.water === 3) continue;
    land++;
    counts[s.water ? 2 : s.height >= 5 ? 1 : 0]++;
    if (s.water) assert.equal(s.height, 0);
  }
const percentages = counts.map((v) => (v / land) * 100);
assert.ok(percentages[0] > 62 && percentages[0] < 80, `평지 ${percentages[0]}`);
assert.ok(percentages[1] > 20 && percentages[1] < 34, `산 ${percentages[1]}`);
assert.ok(percentages[2] > 0.3 && percentages[2] < 6, `물길 ${percentages[2]}`);
console.log(
  'Continent land flat/mountain/water:',
  percentages.map((v) => +v.toFixed(2)),
);

for (const city of [0, 1, 7]) {
  const world = new World(city);
  for (let dy = 0; dy < BASE_CHUNK_SPAN; dy++)
    for (let dx = 0; dx < BASE_CHUNK_SPAN; dx++) {
      const cx = world.baseCx + dx,
        cy = world.baseCy + dy;
      const base = world.getChunk(cx, cy),
        gen = generateContinentChunk(cx, cy);
      assert.deepEqual(base.tiles, gen.tiles, 'base terrain = continent');
      assert.deepEqual(base.heights, gen.heights, 'base heights = continent');
    }
  const cx = world.baseCx + 3,
    cy = world.baseCy - 2;
  for (let y = 0; y < 64; y += 9)
    for (let x = 0; x < 64; x += 9) {
      const tx = cx * 64 + x,
        ty = cy * 64 + y;
      const sampled = world.sampleHeight(tx, ty);
      assert.equal(sampled, world.getHeight(tx, ty), 'unloaded and rendered heights agree');
      assert.equal(world.getTile(tx, ty), sampleSite(tx, ty).tile);
    }
  const snapshot = world.getChunk(cx, cy).heights.slice();
  world.unloadChunk(cx, cy);
  assert.deepEqual(world.getChunk(cx, cy).heights, snapshot, 'regeneration deterministic');
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
