import { Application } from 'pixi.js';
import { Camera } from './core/camera';
import { BASE_CHUNK_SPAN, CHUNK_SIZE, DEFAULT_ZOOM, TILE_HH, TILE_HW } from './core/constants';
import { attachInput } from './core/input';
import { chunkIndexOf, tileToWorldX, tileToWorldY, worldToTile } from './core/iso';
import { pickTile } from './core/pick';
import { loadCity } from './net/citySave';
import { OfflineSaveManager, SaveManager, type AnySaveManager } from './net/saveManager';
import type { CityDoc, MacroState } from './net/types';
import { loadTileAtlas } from './render/atlas';
import { loadBuildingAtlas } from './render/buildingAtlas';
import { loadFacilityAtlas } from './render/facilityAtlas';
import { loadVehicleAtlas } from './render/vehicleAtlas';
import {
  installPedestrianRenderPatch,
  setPedestrianRenderZoom,
} from './render/pedestrianRenderPatch';
import { WorldRenderer } from './render/worldRenderer';
import { AssignmentTable } from './sim/assignment';
import { CongestionMap } from './sim/congestion';
import { MacroSim } from './sim/macro';
import { CATCHUP_TICKS_PER_FRAME, START_MONEY } from './sim/simConstants';
import { installPedestrianSystemPatch } from './sim/pedestrianSystemPatch';
import { TrafficSim } from './sim/traffic/trafficSim';
import { installVehicleMotionPatch } from './sim/traffic/vehicleMotionPatch';
import { TransportSystem } from './sim/transportHubs';
import './style.css';
import { CityPanel } from './ui/cityPanel';
import { createHudUpdater } from './ui/gameHud';
import { Hud } from './ui/hud';
import { requireSession } from './ui/loginScreen';
import { Minimap } from './ui/minimap';
import { SaveBadge } from './ui/saveBadge';
import { bindToolbar } from './ui/toolbar';
import { bindToolButtons, Tools } from './ui/tools';
import { TransportHubPanel } from './ui/transportHubPanel';
import { seedCityIfEmpty, SEEDED_CITY_MONEY } from './world/citySeed';
import { findDryTileNearBase } from './world/spawn';
import type { ChunkOverride } from './world/world';
import { World } from './world/world';

/** 카메라가 base 밖으로 나갈 수 있는 거리(청크). 이웃의 안개까지는 보이게 둔다. */
const ROAM_CHUNKS = 8;

async function boot(): Promise<void> {
  const loading = document.getElementById('loading');

  if (loading) loading.textContent = '로그인을 기다리는 중…';
  const session = await requireSession();

  if (loading) loading.textContent = '도시를 불러오는 중…';
  let city: CityDoc | null = null;
  let overrides = new Map<string, ChunkOverride>();
  let loadFailed = false;
  if (session) {
    try {
      const loaded = await loadCity(session);
      city = loaded.city;
      overrides = loaded.overrides;
    } catch (err) {
      console.error('도시 불러오기 실패', err);
      loadFailed = true;
    }
  }

  if (loading) loading.textContent = '지형을 그리는 중…';
  const world = new World(city?.cityIndex ?? 0);
  revealBaseRing(world);
  if (city) {
    world.setExploredKeys(city.explored);
    world.setPersistedOverrides(overrides);
  }

  const macro: MacroState = city?.macro ?? {
    money: START_MONEY,
    population: 0,
    tick: 0,
    tickedAt: Date.now(),
  };
  const seededCenter = seedCityIfEmpty(world, Math.floor(macro.tick / 24));
  if (seededCenter && macro.money < SEEDED_CITY_MONEY) macro.money = SEEDED_CITY_MONEY;

  const app = new Application();
  await app.init({
    resizeTo: window,
    background: '#0e1418',
    antialias: false,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
    powerPreference: 'high-performance',
    preference: 'webgl',
  });
  document.body.appendChild(app.canvas);

  const [atlas, buildingAtlas, vehicleAtlas, facilityAtlas] = await Promise.all([
    loadTileAtlas(),
    loadBuildingAtlas(),
    loadVehicleAtlas(),
    loadFacilityAtlas(),
  ]);
  installPedestrianRenderPatch();
  const renderer = new WorldRenderer(world, atlas, buildingAtlas, facilityAtlas);
  app.stage.addChild(renderer.root);

  const camera = new Camera();
  camera.resize(app.screen.width, app.screen.height);
  camera.zoom = DEFAULT_ZOOM;
  camera.limit = roamLimit(world);

  const start = seededCenter ?? findDryTileNearBase(world);
  const centerCamera = (): void => {
    camera.zoom = DEFAULT_ZOOM;
    camera.centerOnWorld(
      tileToWorldX(start.tx, start.ty),
      tileToWorldY(start.tx, start.ty, world.getHeight(start.tx, start.ty)),
    );
  };
  centerCamera();

  const badge = new SaveBadge();
  const saver: AnySaveManager =
    session && city
      ? new SaveManager(world, session.uid, city.saveToken, city)
      : new OfflineSaveManager();
  saver.onStatus = (status, message) => badge.set(status, message);
  saver.start();
  if (loadFailed) badge.set('error', '불러오기 실패 — 저장되지 않습니다');

  const hud = new Hud();
  const minimap = new Minimap(world, camera);
  let cursor: { tx: number; ty: number } | null = null;

  const sim = new MacroSim(world, macro);
  renderer.waterField = sim.water;
  renderer.powerField = sim.power;
  sim.onMacroChange = () => saver.noteMacroChange();
  const transport = new TransportSystem(world, macro, sim, () => saver.noteMacroChange());

  const congestion = new CongestionMap();
  const assignment = new AssignmentTable();
  sim.attachTraffic(congestion, assignment);
  sim.primeCatchup(Date.now());
  transport.update();

  const traffic = new TrafficSim(world, sim, congestion, assignment);
  installVehicleMotionPatch(traffic);
  installPedestrianSystemPatch(traffic);
  renderer.attachTraffic(traffic, vehicleAtlas);
  renderer.attachDisasters(sim.disasters);

  const cityPanel = new CityPanel();
  let incidentFocusIndex = 0;
  cityPanel.onIncidentFocus = () => {
    const events = sim.disasters.active.filter((e) => sim.disasters.at(e.tx, e.ty, world));
    if (!events.length) return;
    const e = events[incidentFocusIndex++ % events.length];
    camera.centerOnWorld(
      tileToWorldX(e.tx, e.ty),
      tileToWorldY(e.tx, e.ty, world.sampleHeight(e.tx, e.ty)),
    );
  };

  const tools = new Tools(world, renderer, sim);
  const transportPanel = new TransportHubPanel(world, transport);

  attachInput(app.canvas, camera, {
    onTap: (wx, wy) => {
      cursor = pickTile(world, wx, wy);
      renderer.setCursorTile(cursor);
      if (cursor) transportPanel.showAt(cursor.tx, cursor.ty);
    },
    onHover: (wx, wy) => {
      cursor = pickTile(world, wx, wy);
      renderer.setCursorTile(cursor);
    },
    onHoverEnd: () => {
      cursor = null;
      renderer.setCursorTile(null);
    },
    isPainting: () => tools.isPainting(),
    onPaintStart: (wx, wy) => {
      cursor = pickTile(world, wx, wy);
      renderer.setCursorTile(cursor);
      tools.beginPaint(wx, wy);
    },
    onPaintMove: (wx, wy) => {
      cursor = pickTile(world, wx, wy);
      renderer.setCursorTile(cursor);
      tools.movePaint(wx, wy);
    },
    onPaintEnd: () => {
      tools.endPaint();
    },
  });

  app.renderer.on('resize', (w: number, h: number) => {
    camera.resize(w, h);
  });

  bindToolbar({
    centerCamera,
    renderer,
    saver,
    loggedIn: Boolean(session),
    resetCity: async () => {
      app.ticker.stop();
      transportPanel.hide();
      world.clearBuilt();
      macro.transport = undefined;
      sim.resetState(SEEDED_CITY_MONEY, Date.now());
      try {
        await saver.saveNow();
      } catch (err) {
        console.error('초기화 저장 실패', err);
      }
      location.reload();
    },
  });
  bindToolButtons(tools);

  const cityLabel = city
    ? `${city.cityName} (${city.cityIndex}번)`
    : session
      ? '불러오기 실패'
      : '둘러보기';

  const updateHud = createHudUpdater({
    hud,
    world,
    sim,
    camera,
    tools,
    renderer,
    traffic,
    congestion,
    placeholderArt: atlas.placeholder,
    cityLabel,
    cursor: () => cursor,
  });

  app.ticker.add((ticker) => {
    const now = performance.now();
    sim.update(ticker.deltaMS, CATCHUP_TICKS_PER_FRAME);
    transport.update();

    const camTile = worldToTile(camera.x, camera.y);
    traffic.setActiveChunk(
      chunkIndexOf(camTile.tx),
      chunkIndexOf(camTile.ty),
      camTile.tx,
      camTile.ty,
    );
    traffic.update(ticker.deltaMS);
    camera.update(ticker.deltaMS);
    camera.applyTo(renderer.root);
    renderer.setFacilityPreview(cursor ? tools.facilityPreviewAt(cursor.tx, cursor.ty) : null);
    renderer.utilityMode = tools.utilityMode;
    setPedestrianRenderZoom(camera.zoom);
    renderer.update(camera, now);
    renderer.flush();
    minimap.update(
      now,
      tools.tool === 'facility' ? { field: sim.services, kind: tools.facilityKind } : null,
    );

    transportPanel.update();
    cityPanel.update(now, sim);
    updateHud(now, ticker.FPS);
  });

  document.getElementById('loading')?.classList.add('done');
}

function revealBaseRing(world: World): void {
  for (let dy = -1; dy <= BASE_CHUNK_SPAN; dy++) {
    for (let dx = -1; dx <= BASE_CHUNK_SPAN; dx++) {
      world.explore(world.baseCx + dx, world.baseCy + dy);
    }
  }
}

function roamLimit(world: World): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const t0x = (world.baseCx - ROAM_CHUNKS) * CHUNK_SIZE;
  const t0y = (world.baseCy - ROAM_CHUNKS) * CHUNK_SIZE;
  const t1x = (world.baseCx + BASE_CHUNK_SPAN + ROAM_CHUNKS) * CHUNK_SIZE;
  const t1y = (world.baseCy + BASE_CHUNK_SPAN + ROAM_CHUNKS) * CHUNK_SIZE;
  return {
    minX: tileToWorldX(t0x, t1y) - TILE_HW,
    maxX: tileToWorldX(t1x, t0y) + TILE_HW,
    minY: tileToWorldY(t0x, t0y) - TILE_HH,
    maxY: tileToWorldY(t1x, t1y) + TILE_HH,
  };
}

boot().catch((err: unknown) => {
  console.error(err);
  const el = document.getElementById('loading');
  if (el) el.textContent = '지도를 불러오지 못했습니다. 새로고침 해주세요.';
});
