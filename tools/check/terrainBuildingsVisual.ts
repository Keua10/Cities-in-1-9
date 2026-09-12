import { Application } from 'pixi.js';
import { Camera } from '../../src/core/camera';
import { CHUNK_SIZE } from '../../src/core/constants';
import { tileToWorldX, tileToWorldY } from '../../src/core/iso';
import { loadTileAtlas } from '../../src/render/atlas';
import { loadBuildingAtlas } from '../../src/render/buildingAtlas';
import { loadFacilityAtlas } from '../../src/render/facilityAtlas';
import { loadVehicleAtlas } from '../../src/render/vehicleAtlas';
import { lanePosition } from '../../src/sim/traffic/laneGeometry';
import type { TrafficSim } from '../../src/sim/traffic/trafficSim';
import type { Vehicle } from '../../src/sim/traffic/vehicles';
import { WorldRenderer } from '../../src/render/worldRenderer';
import { Build } from '../../src/world/build';
import { Terrain } from '../../src/world/terrain';
import { World } from '../../src/world/world';

const scenario = new URLSearchParams(location.search).get('case') ?? 'flat';
const world = new World(0),
  x0 = (world.baseCx + 1) * CHUNK_SIZE,
  y0 = (world.baseCy + 1) * CHUNK_SIZE;
world.clearBuilt();
for (let y = -14; y <= 14; y++)
  for (let x = -14; x <= 14; x++) {
    world.setTile(x0 + x, y0 + y, Terrain.Grass);
    const height =
      scenario === 'flat' ? 0 : scenario === 'front' ? (y >= 3 ? 4 : 0) : x >= 0 ? 1 : 0;
    world.setHeight(x0 + x, y0 + y, height);
    world.setBuild(x0 + x, y0 + y, Build.None, false);
  }
for (const y of [-6, -1, 3, 7])
  for (let x = -12; x <= 12; x++) {
    world.setBuild(x0 + x, y0 + y, Build.Road, false);
    if (x > -12) world.connectRoads(x0 + x - 1, y0 + y, x0 + x, y0 + y);
  }
for (const [x, y, zone, level] of [
  [-3, -4, 0, 3],
  [1, -4, 1, 3],
  [-1, 0, 2, 1],
  [1, 0, 0, 1],
  [-4, 0, 1, 2],
  [5, 0, 2, 2],
  [-3, 4, 2, 3],
  [1, 4, 1, 3],
]) {
  for (let dy = 0; dy < level; dy++)
    for (let dx = 0; dx < level; dx++)
      world.setBuild(x0 + x + dx, y0 + y + dy, Build.ZoneR + zone, false);
  world.placeBuilding(x0 + x, y0 + y, zone, level, 0);
}
world.placeFacility(x0 - 1, y0 - 10, 2, 0);
const app = new Application();
await app.init({ resizeTo: window, antialias: false, background: 0x203026 });
document.body.append(app.canvas);
const [tiles, buildings, facilities, vehicleAtlas] = await Promise.all([
  loadTileAtlas(),
  loadBuildingAtlas(),
  loadFacilityAtlas(),
  loadVehicleAtlas(),
]);
const renderer = new WorldRenderer(world, tiles, buildings, facilities);
// Deliberately scripted routes isolate rendering from congestion and trip generation.
const cars: Vehicle[] = [-6, -1, 3, 7].flatMap((y, row) =>
  [0, 1].map((reverse) => ({
    kind: row % 2,
    tier: 0,
    purpose: 0,
    route: {
      tiles: new Int32Array(
        Array.from({ length: 25 }, (_, i) => [x0 + (reverse ? 12 - i : i - 12), y0 + y]).flat(),
      ),
      costAtPlan: 0,
    },
    routeIdx: 0,
    tileT: 0,
    lane: 0,
    speed: 1,
    dir: reverse ? 2 : 0,
    destTx: row,
    destTy: reverse,
    aggressive: false,
    waitMs: 0,
    stoppedMs: 0,
    stuckMs: 0,
    frozenMs: 0,
    jPath: null,
    jPathRoute: null,
    jPathRev: 0,
  })),
);
const traffic = {
  pedestrians: [],
  junctions: { junctions: [] },
  signalTimeMs: 0,
  vehiclesInChunk: (cx: number, cy: number) =>
    cars.filter((car) => {
      const [x, y] = lanePosition(car.route, car.routeIdx, car.tileT);
      return (
        Math.floor(Math.round(x) / CHUNK_SIZE) === cx &&
        Math.floor(Math.round(y) / CHUNK_SIZE) === cy
      );
    }),
} as unknown as TrafficSim;
renderer.attachTraffic(traffic, vehicleAtlas);
renderer.showFog = false;
app.stage.addChild(renderer.root);
const camera = new Camera();
camera.zoom = 2;
camera.centerOnWorld(tileToWorldX(x0, y0), tileToWorldY(x0, y0) - 40);
renderer.setCursorTile({ tx: x0 - 1, ty: y0 });
const started = performance.now();
app.ticker.add(() => {
  cars.forEach((car, i) => {
    const distance = ((performance.now() - started) / 900 + i * 2.5) % 24;
    car.routeIdx = Math.floor(distance);
    car.tileT = distance % 1;
  });
  camera.resize(app.screen.width, app.screen.height);
  camera.applyTo(renderer.root);
  renderer.update(camera, performance.now());
  renderer.flush();
  document.getElementById('result')!.textContent =
    ` · ${scenario} · 합성 ${renderer.stats.sceneRebuilds}회 · 마지막 ${renderer.stats.sceneBuildMs.toFixed(1)}ms`;
});
document.getElementById('result')!.textContent = ` · ${scenario}`;
