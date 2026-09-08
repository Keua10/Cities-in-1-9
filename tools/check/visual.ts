import '../../src/style.css';
import { Application } from 'pixi.js';
import { Camera } from '../../src/core/camera';
import { CHUNK_SIZE } from '../../src/core/constants';
import { tileToWorldX, tileToWorldY } from '../../src/core/iso';
import { World } from '../../src/world/world';
import { Terrain } from '../../src/world/terrain';
import { Build } from '../../src/world/build';
import { loadTileAtlas } from '../../src/render/atlas';
import { loadBuildingAtlas } from '../../src/render/buildingAtlas';
import { loadFacilityAtlas } from '../../src/render/facilityAtlas';
import { WorldRenderer } from '../../src/render/worldRenderer';
import { CityPanel } from '../../src/ui/cityPanel';
import { MacroSim } from '../../src/sim/macro';
import { ZONE_R } from '../../src/sim/buildings';
import { MS_PER_TICK } from '../../src/sim/simConstants';
import type { Incident } from '../../src/sim/disasters';
import { AssignmentTable } from '../../src/sim/assignment';
import { CongestionMap } from '../../src/sim/congestion';
import { TrafficSim } from '../../src/sim/traffic/trafficSim';
import { loadVehicleAtlas } from '../../src/render/vehicleAtlas';

const world = new World(0),
  ox = world.baseCx * CHUNK_SIZE + 20,
  oy = world.baseCy * CHUNK_SIZE + 20;
for (let y = -4; y < 34; y++)
  for (let x = -4; x < 34; x++) {
    world.setTile(ox + x, oy + y, Terrain.Grass);
    world.setHeight(ox + x, oy + y, 0);
  }
for (const y of [4, 11, 19])
  for (let x = 2; x < 24; x++) world.setBuild(ox + x, oy + y, Build.Road, false);
for (let y = 4; y <= 19; y++) world.setBuild(ox + 2, oy + y, Build.Road, false);
const positions = [
  [5, 5],
  [10, 5],
  [15, 5],
  [5, 12],
  [10, 12],
  [13, 12],
  [18, 12],
];
positions.forEach(([x, y], kind) => world.placeFacility(ox + x, oy + y, kind, 0));
const active: Incident[] = [];
for (const [kind, x] of [
  [0, 8],
  [1, 13],
  [2, 18],
] as const) {
  const tx = ox + x,
    ty = oy + 20;
  for (let dy = 0; dy < 2; dy++)
    for (let dx = 0; dx < 2; dx++) world.setBuild(tx + dx, ty + dy, Build.ZoneR, false);
  world.placeBuilding(tx, ty, ZONE_R, 2, 0);
  active.push({ kind, tx, ty, code: world.getBld(tx, ty), born: 0, startedTick: 100 });
}
const macro = {
  money: 100000,
  population: 0,
  tick: 100,
  tickedAt: 1000,
  disasters: { version: 1 as const, active, started: [1, 1, 1], extinguished: 0, burned: 0 },
};
const sim = new MacroSim(world, macro);
sim.primeCatchup(1000);
const app = new Application();
await app.init({ resizeTo: window, antialias: false, background: 0x213327 });
document.body.append(app.canvas);
const [tileAtlas, buildings, facilities, vehicles] = await Promise.all([
  loadTileAtlas(),
  loadBuildingAtlas(),
  loadFacilityAtlas(),
  loadVehicleAtlas(),
]);
const renderer = new WorldRenderer(world, tileAtlas, buildings, facilities);
const traffic = new TrafficSim(world, sim, new CongestionMap(), new AssignmentTable());
renderer.attachTraffic(traffic, vehicles);
renderer.attachDisasters(sim.disasters);
renderer.showFog = false;
app.stage.addChild(renderer.root);
const camera = new Camera();
function overview() {
  camera.centerOnWorld(tileToWorldX(ox + 11, oy + 12), tileToWorldY(ox + 11, oy + 12, 0));
}
overview();
const panel = new CityPanel();
let focus = 0;
panel.onIncidentFocus = () => {
  const events = sim.disasters.active;
  if (!events.length) return;
  const e = events[focus++ % events.length];
  camera.centerOnWorld(tileToWorldX(e.tx, e.ty), tileToWorldY(e.tx, e.ty, 0));
  document.getElementById('result')!.textContent = `사건 위치 이동: ${e.tx},${e.ty}`;
};
document.getElementById('reset-view')!.onclick = overview;
document.getElementById('step')!.onclick = () => sim.update(MS_PER_TICK, 0);
app.ticker.add(() => {
  camera.resize(app.screen.width, app.screen.height);
  camera.applyTo(renderer.root);
  renderer.update(camera, performance.now());
  renderer.flush();
  panel.update(performance.now(), sim);
});
document.getElementById('result')!.textContent =
  `시설 ${positions.length}종 · 그림 placeholder=${facilities.placeholder}`;
