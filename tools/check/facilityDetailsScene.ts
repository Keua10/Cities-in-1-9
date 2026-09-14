import { Application } from 'pixi.js';
import { Camera } from '../../src/core/camera';
import { CHUNK_SIZE } from '../../src/core/constants';
import { tileToWorldX, tileToWorldY } from '../../src/core/iso';
import { loadTileAtlas } from '../../src/render/atlas';
import { loadBuildingAtlas } from '../../src/render/buildingAtlas';
import { loadFacilityAtlas } from '../../src/render/facilityAtlas';
import { WorldRenderer } from '../../src/render/worldRenderer';
import { FACILITY_SPECS } from '../../src/sim/facilities';
import { Build } from '../../src/world/build';
import { Terrain } from '../../src/world/terrain';
import { World } from '../../src/world/world';
const params = new URLSearchParams(location.search),
  select = document.querySelector<HTMLSelectElement>('#kind')!;
for (const s of FACILITY_SPECS) {
  const o = document.createElement('option');
  o.value = String(s.kind);
  o.textContent = s.name;
  select.append(o);
}
const parsed = Number(params.get('kind'));
const kind = Number.isInteger(parsed) && parsed >= 0 && parsed < FACILITY_SPECS.length ? parsed : 0;
select.value = String(kind);
const terrain = document.querySelector<HTMLSelectElement>('#terrain')!;
terrain.value = params.get('case') === 'slope' ? 'slope' : 'flat';
const navigate = () => {
  location.search = `?kind=${select.value}&case=${terrain.value}`;
};
select.onchange = terrain.onchange = navigate;
const spec = FACILITY_SPECS[kind],
  n = spec.span,
  world = new World(0),
  x0 = (world.baseCx + 1) * CHUNK_SIZE,
  y0 = (world.baseCy + 1) * CHUNK_SIZE;
world.clearBuilt();
for (let y = -12; y <= n + 12; y++)
  for (let x = -12; x <= n + 12; x++) {
    world.setTile(x0 + x, y0 + y, Terrain.Grass);
    world.setHeight(x0 + x, y0 + y, terrain.value === 'slope' && x >= n + 1 ? 1 : 0);
    world.setBuild(x0 + x, y0 + y, Build.None, false);
  }
for (const row of [-1, n])
  for (let x = -8; x <= n + 8; x++) {
    world.setBuild(x0 + x, y0 + row, Build.Road, false);
    if (x > -8) world.connectRoads(x0 + x - 1, y0 + row, x0 + x, y0 + row);
  }
world.placeFacility(x0, y0, kind, 0);
for (const [x, y, z, l] of [
  [-4, 0, 0, 3],
  [n + 2, 0, 1, 3],
  [-2, n + 2, 0, 1],
  [0, n + 2, 0, 1],
  [2, n + 2, 1, 1],
  [4, n + 2, 2, 1],
]) {
  for (let v = 0; v < l; v++)
    for (let u = 0; u < l; u++) world.setBuild(x0 + x + u, y0 + y + v, Build.ZoneR + z, false);
  world.placeBuilding(x0 + x, y0 + y, z, l, 0);
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
renderer.showFog = false;
app.stage.addChild(renderer.root);
const camera = new Camera();
camera.zoom = n >= 5 ? 1 : 2;
const zoom = document.querySelector<HTMLSelectElement>('#zoom')!;
zoom.value = String(camera.zoom);
zoom.onchange = () => {
  camera.zoom = Number(zoom.value);
};
camera.centerOnWorld(tileToWorldX(x0, y0), tileToWorldY(x0, y0) + (n - 1) * 16 - 32);
app.ticker.add(() => {
  camera.resize(app.screen.width, app.screen.height);
  camera.applyTo(renderer.root);
  renderer.update(camera, performance.now());
  renderer.flush();
});
document.querySelector('#result')!.textContent =
  `${spec.name} · ${n}×${n} 부지 · ${facilities.placeholder ? '기존 그림 대체 사용' : '새 시설 아틀라스 적용'} · 저장된 도시에 영향을 주지 않는 검수 장면`;
