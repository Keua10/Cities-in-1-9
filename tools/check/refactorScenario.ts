import { createHash } from 'node:crypto';
import * as constants from '../../src/sim/simConstants';
import { CHUNK_SIZE } from '../../src/core/constants';
import { World } from '../../src/world/world';
import { seedCityIfEmpty } from '../../src/world/cityGen';
import { Build } from '../../src/world/build';
import { Terrain } from '../../src/world/terrain';
import { MacroSim } from '../../src/sim/macro';
import { AssignmentTable } from '../../src/sim/assignment';
import { CongestionMap } from '../../src/sim/congestion';

function digest(world: World): string {
  const hash = createHash('sha256');
  for (const p of [...world.developedParcels()].sort((a, b) => a.cy - b.cy || a.cx - b.cx)) {
    hash.update(p.key);
    for (const a of [p.tileOverride, p.heightOverride, p.build, p.bld, p.bornLo, p.bornHi])
      hash.update(a ?? 'null');
  }
  return hash.digest('hex');
}
const generated = [];
for (const cityIndex of [0, 3]) {
  const world = new World(cityIndex);
  generated.push({
    center: seedCityIfEmpty(world),
    digest: digest(world),
    second: seedCityIfEmpty(world),
  });
}
const world = new World(0),
  ox = world.baseCx * CHUNK_SIZE,
  oy = world.baseCy * CHUNK_SIZE;
for (let y = 0; y < 58; y++)
  for (let x = 0; x < 58; x++) {
    world.setTile(ox + x, oy + y, Terrain.Grass);
    world.setHeight(ox + x, oy + y, 0);
  }
for (let y = 1; y < 48; y++) {
  world.setBuild(ox + 1, oy + y, Build.Road, false);
  world.setBuild(ox + 43, oy + y, Build.Road, false);
}
for (let row = 0; row < 6; row++) {
  const y = 2 + row * 7;
  for (let x = 1; x < 50; x++) world.setBuild(ox + x, oy + y - 1, Build.Road, false);
  for (let col = 0; col < 6; col++) {
    const x = 2 + col * 7,
      zone = (col + row) % 3,
      level = (col % 3) + 1;
    for (let dy = 0; dy < level; dy++)
      for (let dx = 0; dx < level; dx++) world.setBuild(ox + x + dx, oy + y + dy, zone + 1, false);
    world.placeBuilding(ox + x, oy + y, zone, level, 0);
  }
}
for (let kind = 0; kind < 7; kind++) world.placeFacility(ox + 44, oy + 2 + kind * 6, kind, 0);
const macro = { money: 300000, population: 0, tick: 0, tickedAt: 1000 };
const sim = new MacroSim(world, macro),
  assignment = new AssignmentTable(),
  congestion = new CongestionMap();
sim.attachTraffic(congestion, assignment);
sim.primeCatchup(1000);
const history = [];
for (let tick = 0; tick < 1440; tick++) {
  sim.update(constants.MS_PER_TICK, 0);
  if (tick % 24 === 23)
    history.push({
      tick: sim.tick,
      money: sim.money,
      stats: structuredClone(sim.stats),
      demand: structuredClone(sim.demand),
      disasters: sim.disasters.snapshot(),
    });
}
export default {
  constants,
  generated,
  history,
  links: [...assignment.allLinks()],
  digest: digest(world),
};
