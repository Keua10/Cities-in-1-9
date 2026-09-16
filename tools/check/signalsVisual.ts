import { Application } from 'pixi.js';
import { Camera } from '../../src/core/camera';
import { CHUNK_SIZE } from '../../src/core/constants';
import { tileToWorldX, tileToWorldY } from '../../src/core/iso';
import { loadTileAtlas } from '../../src/render/atlas';
import { loadBuildingAtlas } from '../../src/render/buildingAtlas';
import { loadFacilityAtlas } from '../../src/render/facilityAtlas';
import { loadVehicleAtlas } from '../../src/render/vehicleAtlas';
import { WorldRenderer } from '../../src/render/worldRenderer';
import { MacroSim } from '../../src/sim/macro';
import { JunctionIndex } from '../../src/sim/traffic/junctions';
import type { TrafficSim } from '../../src/sim/traffic/trafficSim';
import { World } from '../../src/world/world';
import { Build } from '../../src/world/build';
import { Terrain } from '../../src/world/terrain';
import type { Pedestrian } from '../../src/sim/pedestrians';

const world = new World(0),
  x0 = (world.baseCx + 1) * CHUNK_SIZE,
  y0 = (world.baseCy + 1) * CHUNK_SIZE;
world.clearBuilt();
for (let y = -14; y <= 14; y++)
  for (let x = -14; x <= 14; x++) {
    world.setTile(x0 + x, y0 + y, Terrain.Grass);
    world.setHeight(x0 + x, y0 + y, 0);
    world.setBuild(
      x0 + x,
      y0 + y,
      x === 0 || y === 0 || x === 5 || y === 5 ? Build.Road : Build.None,
      false,
    );
  }
for (const [x, y, zone] of [
  [1, 1, 0],
  [-3, 1, 1],
  [1, -3, 1],
  [-3, -3, 0],
]) {
  for (let dy = 0; dy < 3; dy++)
    for (let dx = 0; dx < 3; dx++)
      world.setBuild(x0 + x + dx, y0 + y + dy, Build.ZoneR + zone, false);
  world.placeBuilding(x0 + x, y0 + y, zone, 3, 0);
}
const sim = new MacroSim(world, { money: 1000, population: 0, tick: 0, tickedAt: 0 });
const index = new JunctionIndex();
let revision = -1,
  paused = false,
  time = 0;
const refresh = () => {
  if (revision === world.signalRevision) return;
  revision = world.signalRevision;
  index.build(world, x0 - 14, y0 - 14, x0 + 14, y0 + 14);
};
sim.setRoadSignal(x0, y0, true);
sim.setRoadSignal(x0 + 5, y0 + 5, true);
const walkers: Pedestrian[] = [0, 1, 2, 3].map((i) => ({
  x: 0,
  y: 0,
  color: [0xc88465, 0x769bb5, 0xafa15f, 0x73a78b][i],
  path: [
    [x0 - 4, y0 - 0.48],
    [x0 + 4, y0 - 0.48],
  ],
  progress: i * 1.6,
}));
const traffic = {
  get junctions() {
    return index;
  },
  get signalTimeMs() {
    return time;
  },
  pedestrians: walkers,
  refreshRoadControls: refresh,
  vehiclesInChunk: () => [],
} as unknown as TrafficSim;
const app = new Application();
await app.init({ resizeTo: window, antialias: false, background: 0x203026 });
document.body.append(app.canvas);
const [tiles, buildings, facilities, cars] = await Promise.all([
  loadTileAtlas(),
  loadBuildingAtlas(),
  loadFacilityAtlas(),
  loadVehicleAtlas(),
]);
const renderer = new WorldRenderer(world, tiles, buildings, facilities);
renderer.attachTraffic(traffic, cars);
renderer.showFog = false;
app.stage.addChild(renderer.root);
const camera = new Camera();
camera.zoom = 3;
camera.centerOnWorld(tileToWorldX(x0 + 1, y0 + 1), tileToWorldY(x0 + 1, y0 + 1) - 35);
document.getElementById('install')!.onclick = () => sim.setRoadSignal(x0, y0, true);
document.getElementById('remove')!.onclick = () => sim.setRoadSignal(x0, y0, false);
document.getElementById('pause')!.onclick = () => {
  paused = !paused;
};
app.ticker.add((ticker) => {
  if (!paused) time += ticker.deltaMS;
  walkers.forEach((p, i) => {
    p.progress = (time / 2200 + i * 1.6) % 2;
    const t = p.progress <= 1 ? p.progress : 2 - p.progress;
    p.x = p.path[0][0] + 8 * t;
    p.y = p.path[0][1];
  });
  camera.resize(app.screen.width, app.screen.height);
  camera.applyTo(renderer.root);
  renderer.update(camera, performance.now());
  renderer.flush();
  document.getElementById('result')!.textContent =
    `중앙: ${index.at(x0, y0)?.signalized ? '설치됨' : '제거됨'} · 신호 ${index.junctions.filter((j) => j.signalized).length}곳 · ${paused ? '정지' : '재생'}`;
});
