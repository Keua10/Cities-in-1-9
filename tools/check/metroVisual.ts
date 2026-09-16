import { Application } from 'pixi.js';
import { Camera } from '../../src/core/camera';
import { attachInput } from '../../src/core/input';
import { pickTile } from '../../src/core/pick';
import { CHUNK_SIZE } from '../../src/core/constants';
import { tileToWorldX, tileToWorldY } from '../../src/core/iso';
import { World } from '../../src/world/world';
import { Build } from '../../src/world/build';
import { Terrain } from '../../src/world/terrain';
import { MacroSim } from '../../src/sim/macro';
import { loadTileAtlas } from '../../src/render/atlas';
import { loadBuildingAtlas } from '../../src/render/buildingAtlas';
import { loadFacilityAtlas } from '../../src/render/facilityAtlas';
import { WorldRenderer } from '../../src/render/worldRenderer';
import { Tools } from '../../src/ui/tools';
import { MetroPanel } from '../../src/ui/metroPanel';
const world = new World(0),
  x = world.baseCx * CHUNK_SIZE + 16,
  y = world.baseCy * CHUNK_SIZE + 16;
world.clearBuilt();
for (let dy = -14; dy <= 14; dy++)
  for (let dx = -14; dx <= 14; dx++) {
    world.setTile(x + dx, y + dy, Terrain.Grass);
    world.setHeight(x + dx, y + dy, 0);
    if (dy === 1) world.setBuild(x + dx, y + dy, Build.Road, false);
  }
const sim = new MacroSim(world, { money: 1000000, population: 0, tick: 0, tickedAt: 0 });
for (const dx of [-4, 0, 4]) sim.metro.edit(x + dx, y, 'station');
for (let dx = -4; dx <= 4; dx++) sim.metro.edit(x + dx, y, 'tunnel');
// Foreground and background structures use the same depth-sorted scene as stations.
for (const [dx, dy] of [
  [-3, -3],
  [2, 2],
]) {
  for (let b = 0; b < 2; b++)
    for (let a = 0; a < 2; a++) world.setBuild(x + dx + a, y + dy + b, Build.ZoneC, false);
  world.placeBuilding(x + dx, y + dy, 1, 2, 0);
}
const app = new Application();
await app.init({ resizeTo: window, antialias: false, background: 0x203026 });
document.body.append(app.canvas);
const [tiles, buildings, facilities] = await Promise.all([
  loadTileAtlas(),
  loadBuildingAtlas(),
  loadFacilityAtlas(),
]);
const renderer = new WorldRenderer(world, tiles, buildings, facilities);
renderer.metro = sim.metro;
renderer.showFog = false;
app.stage.addChild(renderer.root);
const tools = new Tools(world, renderer, sim),
  panel = new MetroPanel(sim.metro, tools),
  camera = new Camera();
camera.zoom = 2;
camera.centerOnWorld(tileToWorldX(x, y) + 65, tileToWorldY(x, y) - 30);
const surface = () => tools.setTool('select');
document.getElementById('surface')!.onclick = surface;
document.getElementById('cancel-build')!.onclick = surface;
document.getElementById('underground')!.onclick = () => tools.setTool('metroView');
document.getElementById('cut')!.onclick = () => sim.metro.edit(x + 2, y, 'erase');
document.getElementById('restore')!.onclick = () => sim.metro.edit(x + 2, y, 'tunnel');
attachInput(app.canvas, camera, {
  onTap: (wx, wy) => {
    const t = pickTile(world, wx, wy);
    const key = tools.metroMode ? t.tx + ',' + t.ty : sim.metro.stationAtSurface(t.tx, t.ty);
    if (key) {
      tools.setTool('metroView');
      panel.selectStation(key);
    }
  },
});
app.ticker.add(() => {
  camera.resize(app.screen.width, app.screen.height);
  camera.applyTo(renderer.root);
  renderer.metroMode = tools.metroMode;
  renderer.metroSelection = tools.metroSelection;
  renderer.update(camera, performance.now());
  renderer.flush();
  panel.update();
});
