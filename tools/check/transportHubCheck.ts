import { strict as assert } from 'node:assert';
import { CHUNK_SIZE } from '../../src/core/constants';
import {
  AIRPORT_SPECS,
  HARBOR_SPECS,
} from '../../src/sim/config/transport';
import {
  FAC_AIRPORT,
  FAC_AIRPORT_L2,
  FAC_AIRPORT_L3,
  FAC_HARBOR,
  FAC_HARBOR_CARGO,
  FAC_HARBOR_HYBRID_L2,
  FAC_HARBOR_HYBRID_L3,
} from '../../src/sim/config/special';
import { airportAirfieldStatus, normalizeHarborAllocation } from '../../src/sim/transportHubs';
import { Build, canPlaceAirfieldSurface } from '../../src/world/build';
import { Terrain } from '../../src/world/terrain';
import { World } from '../../src/world/world';

assert.deepEqual(
  [HARBOR_SPECS[FAC_HARBOR].maxShips, HARBOR_SPECS[FAC_HARBOR_HYBRID_L2].maxShips, HARBOR_SPECS[FAC_HARBOR_HYBRID_L3].maxShips],
  [2, 5, 13],
  '항구 3/5/7칸 선박 상한',
);
assert.equal(HARBOR_SPECS[FAC_HARBOR].mode, 'passenger');
assert.equal(HARBOR_SPECS[FAC_HARBOR_CARGO].mode, 'cargo');
assert.equal(HARBOR_SPECS[FAC_HARBOR_HYBRID_L2].mode, 'hybrid');
assert.equal(HARBOR_SPECS[FAC_HARBOR_HYBRID_L3].mode, 'hybrid');
assert.deepEqual(
  [AIRPORT_SPECS[FAC_AIRPORT].maxPlanes, AIRPORT_SPECS[FAC_AIRPORT_L2].maxPlanes, AIRPORT_SPECS[FAC_AIRPORT_L3].maxPlanes],
  [2, 6, 14],
  '공항 단계별 항공기 상한',
);
assert.deepEqual(
  [AIRPORT_SPECS[FAC_AIRPORT].minRunwayTiles, AIRPORT_SPECS[FAC_AIRPORT_L2].minRunwayTiles, AIRPORT_SPECS[FAC_AIRPORT_L3].minRunwayTiles],
  [6, 10, 14],
  '공항 단계별 최소 활주로',
);

assert.deepEqual(normalizeHarborAllocation(3, 2, 5, 'passenger'), { passenger: 3, cargo: 2 });
assert.deepEqual(
  normalizeHarborAllocation(5, 4, 5, 'passenger'),
  { passenger: 5, cargo: 0 },
  '여객 조절 중 초과하면 화물부터 줄인다',
);
assert.deepEqual(
  normalizeHarborAllocation(5, 4, 5, 'cargo'),
  { passenger: 1, cargo: 4 },
  '화물 조절 중 초과하면 여객부터 줄인다',
);
assert.deepEqual(normalizeHarborAllocation(99, -3, 13, 'passenger'), { passenger: 13, cargo: 0 });

const world = new World(0);
const x = world.baseCx * CHUNK_SIZE + 24;
const y = world.baseCy * CHUNK_SIZE + 24;
for (let dy = -5; dy < 20; dy++)
  for (let dx = -5; dx < 28; dx++) {
    world.setTile(x + dx, y + dy, Terrain.Grass);
    world.setHeight(x + dx, y + dy, 0);
  }

assert.equal(canPlaceAirfieldSurface(world, x + 4, y + 1, Build.Taxiway).ok, true);
world.setBuild(x + 3, y + 1, Build.Taxiway, false);
for (let i = 0; i < 5; i++) world.setBuild(x + 4 + i, y + 1, Build.Runway, false);
let status = airportAirfieldStatus(world, x, y, 3, 6);
assert.equal(status.taxiwayConnected, true);
assert.equal(status.longestRunway, 5);
assert.equal(status.ready, false);
world.setBuild(x + 9, y + 1, Build.Runway, false);
status = airportAirfieldStatus(world, x, y, 3, 6);
assert.equal(status.connectedRunwayTiles, 6);
assert.equal(status.longestRunway, 6);
assert.equal(status.ready, true);

console.log('교통 허브: 항구 배분 상한, 3단계 용량, 유도로-활주로 연결/최소길이 판정 통과');
