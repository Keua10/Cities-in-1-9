import { Application } from 'pixi.js';
import { Camera } from './core/camera';
import { BASE_CHUNK_SPAN, CHUNK_SIZE, DEFAULT_ZOOM, TILE_HH, TILE_HW } from './core/constants';
import { attachInput } from './core/input';
import { chunkIndexOf, tileToWorldX, tileToWorldY, worldToTile } from './core/iso';
import { pickTile } from './core/pick';
import { loadCity } from './net/citySave';
import { OfflineSaveManager, SaveManager, type AnySaveManager } from './net/saveManager';
import type { CityDoc } from './net/types';
import { loadTileAtlas } from './render/atlas';
import { loadBuildingAtlas } from './render/buildingAtlas';
import { loadFacilityAtlas } from './render/facilityAtlas';
import { loadVehicleAtlas } from './render/vehicleAtlas';
import { WorldRenderer } from './render/worldRenderer';
import { AssignmentTable } from './sim/assignment';
import { CongestionMap } from './sim/congestion';
import { MacroSim } from './sim/macro';
import { CATCHUP_TICKS_PER_FRAME, START_MONEY } from './sim/simConstants';
import { TrafficSim } from './sim/traffic/trafficSim';
import './style.css';
import { CityPanel } from './ui/cityPanel';
import { createHudUpdater } from './ui/gameHud';
import { Hud } from './ui/hud';
import { requireSession } from './ui/loginScreen';
import { Minimap } from './ui/minimap';
import { SaveBadge } from './ui/saveBadge';
import { bindToolbar } from './ui/toolbar';
import { bindToolButtons, Tools } from './ui/tools';
import { seedCityIfEmpty, SEEDED_CITY_MONEY } from './world/cityGen';
import { findDryTileNearBase } from './world/spawn';
import type { ChunkOverride } from './world/world';
import { World } from './world/world';

/** 카메라가 base 밖으로 나갈 수 있는 거리(청크). 이웃의 안개까지는 보이게 둔다. */
const ROAM_CHUNKS = 8;

async function boot(): Promise<void> {
  const loading = document.getElementById('loading');

  // 1) 로그인. 서버 설정이 없거나 학생이 건너뛰면 session 이 null 이고,
  //    그 경우 0단계와 똑같이 저장 없는 상태로 돈다.
  if (loading) loading.textContent = '로그인을 기다리는 중…';
  const session = await requireSession();

  // 2) 도시 불러오기. 실패해도 게임은 떠야 한다 — 렌더러는 서버와 무관하다.
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

  // 3) 월드 생성. 지형은 여기서 새로 만들어지고, 저장된 건 "달라진 칸"뿐이다.
  if (loading) loading.textContent = '지형을 그리는 중…';
  const world = new World(city?.cityIndex ?? 0);
  if (city) {
    world.setExploredKeys(city.explored);
    world.setPersistedOverrides(overrides);
  }
  // 빈 맵에서 시작하지 않게 한다. 기존 도시가 있으면 절대 손대지 않는다.
  // 처음 접속(또는 맵 초기화 직후)에는 여기서 구역이 나뉜 대도시가 통째로 생긴다.
  const macro = city?.macro ?? {
    money: START_MONEY,
    population: 0,
    tick: 0,
    tickedAt: Date.now(),
  };
  const seededCenter = seedCityIfEmpty(world, Math.floor(macro.tick / 24));
  // 이미 다 자란 도시를 받아 든 셈이니 금고도 그에 맞춰 연다.
  if (seededCenter && macro.money < SEEDED_CITY_MONEY) macro.money = SEEDED_CITY_MONEY;

  const app = new Application();
  await app.init({
    resizeTo: window,
    background: '#0e1418',
    antialias: false,
    // 아이패드 레티나에서 해상도를 3배까지 올리면 픽셀 수가 9배가 된다. 2 로 자른다.
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

  // 4) 저장 연결. 서버가 없으면 아무것도 안 하는 껍데기가 들어간다.
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

  // 5) 3.1단계 매크로 시뮬레이션.
  //    city.macro 객체를 그대로 넘긴다. 시뮬레이션이 그 자리에서 고치므로
  //    SaveManager 가 따로 옮겨 담을 필요 없이 저장에 그대로 실린다.
  const sim = new MacroSim(world, macro);
  sim.onMacroChange = () => saver.noteMacroChange();
  const congestion = new CongestionMap();
  const assignment = new AssignmentTable();
  sim.attachTraffic(congestion, assignment);
  sim.primeCatchup(Date.now());
  const traffic = new TrafficSim(world, sim, congestion, assignment);
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

  // 6) 2단계 도구. 도로·지구 지정은 전부 여기를 지난다.
  const tools = new Tools(world, renderer, sim);

  attachInput(app.canvas, camera, {
    onTap: (wx, wy) => {
      cursor = pickTile(world, wx, wy);
      renderer.setCursorTile(cursor);
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
      // 시뮬레이션을 먼저 멈춘다. 도로가 사라진 세계 위에서 차량 경로가 한 틱
      // 더 도는 것을 막는다.
      app.ticker.stop();
      // 지운 뒤 **저장까지 끝내고** 새로고침한다. 새로 뜬 페이지가 빈 도시를
      // 읽고 seedCityIfEmpty 로 새 대도시를 만든다. 메시·도로망·경로·입주율
      // 캐시를 하나하나 무효화하는 것보다 이 편이 확실하다.
      world.clearBuilt();
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
    const camTile = worldToTile(camera.x, camera.y);
    traffic.setActiveChunk(chunkIndexOf(camTile.tx), chunkIndexOf(camTile.ty));
    traffic.update(ticker.deltaMS);
    camera.update(ticker.deltaMS);
    camera.applyTo(renderer.root);
    // 시설 도구를 든 동안 커서 아래 footprint 를 미리 보여준다.
    renderer.setFacilityPreview(cursor ? tools.facilityPreviewAt(cursor.tx, cursor.ty) : null);
    renderer.update(camera, now);
    renderer.flush();
    // 시설 도구를 든 동안에만 미니맵에 커버리지/복지 레이어를 얹는다.
    minimap.update(
      now,
      tools.tool === 'facility' ? { field: sim.services, kind: tools.facilityKind } : null,
    );

    cityPanel.update(now, sim);
    updateHud(now, ticker.FPS);
  });

  document.getElementById('loading')?.classList.add('done');
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
