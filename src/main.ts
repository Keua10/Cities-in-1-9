import './style.css';
import { Application } from 'pixi.js';
import {
  BASE_CHUNK_SPAN,
  CHUNK_SIZE,
  DEFAULT_ZOOM,
  TILE_HH,
  TILE_HW,
} from './core/constants';
import { Camera } from './core/camera';
import { attachInput } from './core/input';
import { chunkIndexOf, tileToWorldX, tileToWorldY, worldToTile } from './core/iso';
import { pickTile } from './core/pick';
import { signOut } from './net/auth';
import { loadCity } from './net/citySave';
import {
  OfflineSaveManager,
  SaveManager,
  type AnySaveManager,
} from './net/saveManager';
import type { ChunkOverride } from './world/world';
import type { CityDoc } from './net/types';
import { loadTileAtlas } from './render/atlas';
import { loadBuildingAtlas } from './render/buildingAtlas';
import { loadVehicleAtlas } from './render/vehicleAtlas';
import { WorldRenderer } from './render/worldRenderer';
import { MacroSim } from './sim/macro';
import { AssignmentTable } from './sim/assignment';
import { CongestionMap } from './sim/congestion';
import { TrafficSim } from './sim/traffic/trafficSim';
import { CATCHUP_TICKS_PER_FRAME, START_MONEY } from './sim/simConstants';
import { TIER_NAMES, ZONE_NAMES } from './sim/buildings';
import { CityPanel } from './ui/cityPanel';
import { Hud } from './ui/hud';
import { requireSession } from './ui/loginScreen';
import { SaveBadge } from './ui/saveBadge';
import { bindToolButtons, Tools, TOOL_LABELS } from './ui/tools';
import { Build, hasRoadAccess, isZone } from './world/build';
import { findDryTileNearBase, World } from './world/world';

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

  const atlas = await loadTileAtlas();
  const buildingAtlas = await loadBuildingAtlas();
  const vehicleAtlas = await loadVehicleAtlas();
  const renderer = new WorldRenderer(world, atlas, buildingAtlas);
  app.stage.addChild(renderer.root);

  const camera = new Camera();
  camera.resize(app.screen.width, app.screen.height);
  camera.zoom = DEFAULT_ZOOM;
  camera.limit = roamLimit(world);

  const start = findDryTileNearBase(world);
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
  let cursor: { tx: number; ty: number } | null = null;

  // 5) 3.1단계 매크로 시뮬레이션.
  //    city.macro 객체를 그대로 넘긴다. 시뮬레이션이 그 자리에서 고치므로
  //    SaveManager 가 따로 옮겨 담을 필요 없이 저장에 그대로 실린다.
  const sim = new MacroSim(
    world,
    city?.macro ?? { money: START_MONEY, population: 0, tick: 0, tickedAt: Date.now() },
  );
  sim.onMacroChange = () => saver.noteMacroChange();
  const congestion = new CongestionMap();
  const assignment = new AssignmentTable();
  sim.attachTraffic(congestion, assignment);
  sim.primeCatchup(Date.now());
  const traffic = new TrafficSim(world, sim, congestion, assignment);
  renderer.attachTraffic(traffic, vehicleAtlas);

  const cityPanel = new CityPanel();

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
  });
  bindToolButtons(tools);

  const cityLabel = city
    ? `${city.cityName} (${city.cityIndex}번)`
    : session
      ? '불러오기 실패'
      : '둘러보기';

  app.ticker.add((ticker) => {
    const now = performance.now();
    sim.update(ticker.deltaMS, CATCHUP_TICKS_PER_FRAME);
    const camTile = worldToTile(camera.x, camera.y);
    traffic.setActiveChunk(chunkIndexOf(camTile.tx), chunkIndexOf(camTile.ty));
    traffic.update(ticker.deltaMS);
    camera.update(ticker.deltaMS);
    camera.applyTo(renderer.root);
    renderer.update(camera, now);
    renderer.flush();

    const cursorBuild = cursor ? world.getBuild(cursor.tx, cursor.ty) : null;
    const here = cursor ? world.buildingCovering(cursor.tx, cursor.ty) : null;
    const occupancy = cursor ? sim.occupancyAt(cursor.tx, cursor.ty) : null;

    cityPanel.update(now, sim);

    hud.update(now, {
      fps: ticker.FPS,
      zoom: camera.zoom,
      tile: cursor,
      terrain: cursor ? world.getTile(cursor.tx, cursor.ty) : null,
      height: cursor ? world.getHeight(cursor.tx, cursor.ty) : null,
      tool: TOOL_LABELS[tools.tool],
      build: cursorBuild === Build.None ? null : cursorBuild,
      roadAccess:
        cursor && cursorBuild !== null && isZone(cursorBuild)
          ? hasRoadAccess(world, cursor.tx, cursor.ty)
          : null,
      message: tools.activeMessage(now),
      chunk: cursor
        ? { cx: chunkIndexOf(cursor.tx), cy: chunkIndexOf(cursor.ty) }
        : null,
      building: here
        ? `${ZONE_NAMES[here.zone]} ${here.level}단계 (${TIER_NAMES[here.level - 1]}) · ` +
          `${occupancy === null || occupancy <= 0 ? '공실' : `입주 ${Math.round(occupancy * 100)}%`} · ` +
          `${sim.day - here.born}일 됨`
        : null,
      visibleBuildings: renderer.stats.visibleBuildings,
      activeVehicles: traffic.activeCount,
      averageCongestion: congestion.average(),
      parcels: world.parcelCount(),
      visibleChunks: renderer.stats.visibleChunks,
      loadedMeshes: renderer.stats.loadedMeshes,
      placeholderArt: atlas.placeholder,
      city: cityLabel,
    });
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

interface ToolbarDeps {
  centerCamera: () => void;
  renderer: WorldRenderer;
  saver: AnySaveManager;
  loggedIn: boolean;
}

function bindToolbar(deps: ToolbarDeps): void {
  const { renderer } = deps;
  const fogBtn = document.getElementById('btn-fog');
  const gridBtn = document.getElementById('btn-grid');
  const centerBtn = document.getElementById('btn-center');
  const saveBtn = document.getElementById('btn-save');
  const logoutBtn = document.getElementById('btn-logout');

  fogBtn?.setAttribute('aria-pressed', String(renderer.showFog));
  gridBtn?.setAttribute('aria-pressed', String(renderer.showGrid));

  fogBtn?.addEventListener('click', () => {
    renderer.showFog = !renderer.showFog;
    fogBtn.setAttribute('aria-pressed', String(renderer.showFog));
  });
  gridBtn?.addEventListener('click', () => {
    renderer.showGrid = !renderer.showGrid;
    gridBtn.setAttribute('aria-pressed', String(renderer.showGrid));
    renderer.forceRedraw();
  });
  centerBtn?.addEventListener('click', deps.centerCamera);

  saveBtn?.addEventListener('click', () => {
    void deps.saver.saveNow();
  });

  if (!deps.loggedIn) {
    logoutBtn?.setAttribute('hidden', '');
    saveBtn?.setAttribute('hidden', '');
  }
  logoutBtn?.addEventListener('click', () => {
    void (async () => {
      await deps.saver.saveNow();
      await signOut();
      location.reload();
    })();
  });
}

boot().catch((err: unknown) => {
  console.error(err);
  const el = document.getElementById('loading');
  if (el) el.textContent = '지도를 불러오지 못했습니다. 새로고침 해주세요.';
});
