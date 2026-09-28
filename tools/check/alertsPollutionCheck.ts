import assert from 'node:assert/strict';
import { groupAlerts } from '../../src/render/alertLayout';
import { groundPollutionFor } from '../../src/sim/groundPollution';
import { FAC_INCINERATOR, FAC_CREMATORIUM } from '../../src/sim/config/sanitation';
import { FAC_GAS, FAC_WIND } from '../../src/sim/config/power';
import { World } from '../../src/world/world';
import { ZONE_I } from '../../src/sim/buildings';
import { Terrain } from '../../src/world/terrain';

const points = Array.from({ length: 500 }, (_, i) => ({
  x: (i % 25) * 18,
  y: Math.floor(i / 25) * 18,
  alerts: ['water' as const, 'power' as const],
}));
for (const zoom of [0.2, 0.5, 1, 3]) {
  const groups = groupAlerts(
    points.map((p) => ({ ...p, x: p.x * zoom, y: p.y * zoom })),
    zoom,
  );
  assert.equal(
    groups.reduce((sum, g) => sum + g.count, 0),
    500,
    'No building discarded at the old 120-alert limit',
  );
  assert(
    groups.every((g) => g.alerts.includes('water') && g.alerts.includes('power')),
    'All issues retained',
  );
  for (let i = 0; i < groups.length; i++)
    for (let j = i + 1; j < groups.length; j++) {
      assert(
        Math.max(Math.abs(groups[i].x - groups[j].x), Math.abs(groups[i].y - groups[j].y)) >= 48,
        'Badge bounds cannot overlap',
      );
    }
}
assert.equal(
  groupAlerts(
    [
      { x: 47, y: 0, alerts: ['water'] },
      { x: 49, y: 0, alerts: ['sewer'] },
    ],
    1,
  ).length,
  1,
  'Merge across bin boundary',
);
assert(
  groupAlerts(points, 0.5).length < groupAlerts(points, 1).length,
  'Distant zoom clusters more',
);

const world = new World();
// Flat fixture isolates terrain from procedural generation, including a water strip.
world.getTile = (_x: number, y: number) => (y === 70 ? Terrain.WaterShallow : Terrain.Grass);
for (const kind of [FAC_INCINERATOR, FAC_CREMATORIUM, FAC_GAS]) {
  world.placeFacility(62, 62, kind, 0);
  const field = groundPollutionFor(world);
  assert(
    (field.at(61, 62)?.facility ?? 0) > 0,
    'Polluting facility creates actual environmental field',
  );
  assert((field.at(64, 63)?.value ?? 0) > 0, 'Plume crosses chunk boundary');
  assert.equal(
    field.at(62, 70),
    undefined,
    'Ground emissions do not contaminate water by decoration',
  );
  assert.equal(field.at(61, 62)?.value, field.at(62, 61)?.value, 'Symmetric footprint falloff');
  const revision = field.revision;
  groundPollutionFor(world);
  assert.equal(field.revision, revision, 'Unchanged field cached');
  world.demolishAt(62, 62);
  assert.equal(groundPollutionFor(world).tiles.size, 0, 'Demolition clears pollution');
}
world.placeFacility(40, 40, FAC_WIND, 0);
assert.equal(groundPollutionFor(world).tiles.size, 0, 'Clean energy does not pollute');
world.placeBuilding(20, 20, ZONE_I, 1, 0);
assert(
  (groundPollutionFor(world).at(21, 20)?.value ?? 0) > 0,
  'New industry invalidates renderer cache',
);
world.demolishAt(20, 20);
assert.equal(groundPollutionFor(world).tiles.size, 0);
console.log(
  'PASS: alert clustering/count conservation, overlap, issue retention, pollution sources, borders, cache invalidation and demolition',
);
