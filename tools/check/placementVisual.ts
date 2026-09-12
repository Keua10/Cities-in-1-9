import { Application } from 'pixi.js';
import { Camera } from '../../src/core/camera';
import { CHUNK_SIZE } from '../../src/core/constants';
import { attachInput } from '../../src/core/input';
import { tileToWorldX, tileToWorldY } from '../../src/core/iso';
import { loadTileAtlas } from '../../src/render/atlas';
import { loadBuildingAtlas } from '../../src/render/buildingAtlas';
import { loadFacilityAtlas } from '../../src/render/facilityAtlas';
import { loadVehicleAtlas } from '../../src/render/vehicleAtlas';
import { WorldRenderer } from '../../src/render/worldRenderer';
import { AssignmentTable } from '../../src/sim/assignment';
import { ZONE_R } from '../../src/sim/buildings';
import { CongestionMap } from '../../src/sim/congestion';
import { MacroSim } from '../../src/sim/macro';
import { TrafficSim } from '../../src/sim/traffic/trafficSim';
import { Tools } from '../../src/ui/tools';
import { Build } from '../../src/world/build';
import { Terrain } from '../../src/world/terrain';
import { World } from '../../src/world/world';

const world = new World(),
  ox = world.baseCx * CHUNK_SIZE + 24,
  oy = world.baseCy * CHUNK_SIZE + 24;
const app = new Application();
await app.init({ resizeTo: window, background: 0x203026, antialias: false });
document.body.append(app.canvas);
const [a, b, c, v] = await Promise.all([
  loadTileAtlas('/sprites/terrain.png'),
  loadBuildingAtlas(),
  loadFacilityAtlas('/sprites/facilities.png'),
  loadVehicleAtlas(),
]);
const renderer = new WorldRenderer(world, a, b, c);
app.stage.addChild(renderer.root);
const macro = new MacroSim(world, { money: 100000, population: 0, tick: 0, tickedAt: Date.now() });
const traffic = new TrafficSim(world, macro, new CongestionMap(), new AssignmentTable());
renderer.attachTraffic(traffic, v);
const tools = new Tools(world, renderer, macro);
tools.setTool('road');
const point = (x: number, y: number) =>
  [tileToWorldX(ox + x, oy + y), tileToWorldY(ox + x, oy + y)] as const;
const drag = (x: number, y: number, nx: number, ny: number) => {
  tools.beginPaint(...point(x, y));
  tools.movePaint(...point(nx, ny));
  tools.endPaint();
};
function setup() {
  world.clearBuilt();
  for (let y = -16; y < 30; y++)
    for (let x = -16; x < 34; x++) {
      world.setTile(ox + x, oy + y, Terrain.Grass);
      world.setHeight(ox + x, oy + y, 0);
    }
  drag(0, 0, 12, 0);
  drag(0, 1, 12, 1);
  drag(0, 6, 12, 6);
  drag(0, 12, 12, 12);
  for (const [x, y, span] of [
    [1, 7, 2],
    [3, 7, 2],
    [7, 7, 2],
    [9, 7, 2],
    [1, 10, 1],
    [4, 10, 1],
    [7, 10, 1],
    [10, 10, 1],
  ]) {
    for (let dy = 0; dy < span; dy++)
      for (let dx = 0; dx < span; dx++) world.setBuild(ox + x + dx, oy + y + dy, Build.ZoneR);
    world.placeBuilding(ox + x, oy + y, ZONE_R, span, 0);
  }
  renderer.forceRedraw();
}
setup();
const camera = new Camera();
camera.zoom = 1.65;
camera.centerOnWorld(...point(6, 6));
// 실제 게임의 동일한 포인터 입력과 도로 도구를 사용한다.
attachInput(app.canvas, camera, {
  isPainting: () => tools.isPainting(),
  onPaintStart: (x, y) => tools.beginPaint(x, y),
  onPaintMove: (x, y) => tools.movePaint(x, y),
  onPaintEnd: () => tools.endPaint(),
});
document.getElementById('connect')!.onclick = () => drag(6, 0, 6, 1);
document.getElementById('restore')!.onclick = setup;
app.ticker.add((t) => {
  camera.resize(app.screen.width, app.screen.height);
  traffic.setActiveChunk(world.baseCx, world.baseCy);
  traffic.update(t.deltaMS);
  renderer.update(camera, performance.now());
  renderer.root.position.set(
    app.screen.width / 2 - camera.x * camera.zoom,
    app.screen.height / 2 - camera.y * camera.zoom,
  );
  renderer.root.scale.set(camera.zoom);
  document.getElementById('status')!.textContent =
    `평행 도로: ${world.roadsConnected(ox + 6, oy, ox + 6, oy + 1) ? '연결됨' : '분리됨'} · 표시 보행자 ${traffic.pedestrians.length}명`;
});
