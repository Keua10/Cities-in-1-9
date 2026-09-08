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
import { loadFacilityAtlas } from './render/facilityAtlas';
import { loadVehicleAtlas } from './render/vehicleAtlas';
import { WorldRenderer } from './render/worldRenderer';
import { MacroSim } from './sim/macro';
import { AssignmentTable } from './sim/assignment';
import { CongestionMap } from './sim/congestion';
import { TrafficSim } from './sim/traffic/trafficSim';
import { CATCHUP_TICKS_PER_FRAME, START_MONEY } from './sim/simConstants';
import { TIER_NAMES, ZONE_NAMES } from './sim/buildings';
import { FACILITY_SPECS } from './sim/facilities';
import { SERVICE_KIND_COUNT } from './sim/services';
import { DISASTER_NAMES } from './sim/disasters';
import { AMENITY_NEED_BY_TIER, FACILITY_NAMES } from './sim/simConstants';
import { SEASON_NAMES, WEEKDAY_NAMES } from './sim/time';
import { CityPanel } from './ui/cityPanel';
import { Hud } from './ui/hud';
import { Minimap } from './ui/minimap';
import { requireSession } from './ui/loginScreen';
import { SaveBadge } from './ui/saveBadge';
import { bindToolButtons, Tools, TOOL_LABELS } from './ui/tools';
import { Build, hasRoadAccess, isZone } from './world/build';
import { findDryTileNearBase } from './world/spawn';
import { World } from './world/world';
import { seedTestCityIfEmpty } from './world/testCity';

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
  // 테스트가 빈 맵에서 시작하지 않게 한다. 기존 도시가 있으면 절대 손대지 않는다.
  const testCityCenter = seedTestCityIfEmpty(world, Math.floor((city?.macro.tick ?? 0) / 24));

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
  const facilityAtlas = await loadFacilityAtlas();
  const renderer = new WorldRenderer(world, atlas, buildingAtlas, facilityAtlas);
  app.stage.addChild(renderer.root);

  const camera = new Camera();
  camera.resize(app.screen.width, app.screen.height);
  camera.zoom = DEFAULT_ZOOM;
  camera.limit = roamLimit(world);

  const start = testCityCenter ?? findDryTileNearBase(world);
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
  renderer.attachDisasters(sim.disasters);

  const cityPanel = new CityPanel();
  let incidentFocusIndex = 0;
  cityPanel.onIncidentFocus = () => {
    const events = sim.disasters.active.filter(e => sim.disasters.at(e.tx, e.ty, world));
    if (!events.length) return;
    const e = events[incidentFocusIndex++ % events.length];
    camera.centerOnWorld(tileToWorldX(e.tx, e.ty), tileToWorldY(e.tx, e.ty, world.sampleHeight(e.tx, e.ty)));
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
    // 시설 도구를 든 동안 커서 아래 footprint 를 미리 보여준다.
    renderer.setFacilityPreview(
      cursor ? tools.facilityPreviewAt(cursor.tx, cursor.ty) : null,
    );
    renderer.update(camera, now);
    renderer.flush();
    // 시설 도구를 든 동안에만 미니맵에 커버리지/복지 레이어를 얹는다.
    minimap.update(
      now,
      tools.tool === 'facility'
        ? { field: sim.services, kind: tools.facilityKind }
        : null,
    );

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
        ? here.kind !== null
          ? describeFacility(sim, here.tx, here.ty, here.kind)
          : `${ZONE_NAMES[here.zone]} ${here.level}단계 (${TIER_NAMES[here.level - 1]}) · ` +
            `${occupancy === null || occupancy <= 0 ? '공실' : `입주 ${Math.round(occupancy * 100)}%`} · ` +
            `${sim.day - here.born}일 됨`
        : null,
      service: cursor ? describeService(sim, cursor.tx, cursor.ty, here) : null,
      amenity: cursor ? describeAmenity(sim, cursor.tx, cursor.ty, here) : null,
      incident: cursor ? (() => {
        const e = sim.disasters.at(cursor.tx, cursor.ty, world);
        return e ? `${DISASTER_NAMES[e.kind]} · 발생 후 ${sim.tick - e.startedTick}시간` : null;
      })() : null,
      visibleBuildings: renderer.stats.visibleBuildings,
      visibleFacilities: renderer.stats.visibleFacilities,
      activeVehicles: traffic.activeCount,
      averageCongestion: congestion.average(),
      daytimeHour: traffic.daytimeState.hour,
      daytimeIsDay: traffic.daytimeState.isDay,
      sunriseHour: traffic.daytimeState.sunriseHour,
      sunsetHour: traffic.daytimeState.sunsetHour,
      season: SEASON_NAMES[traffic.daytimeState.season] ?? '—',
      weekday: WEEKDAY_NAMES[traffic.daytimeState.weekday] ?? '—',
      gametimeDay: sim.day,
      gametimeHour: sim.hourOfDay,
      parcels: world.parcelCount(),
      visibleChunks: renderer.stats.visibleChunks,
      loadedMeshes: renderer.stats.loadedMeshes,
      placeholderArt: atlas.placeholder,
      city: cityLabel,
    });
  });

  document.getElementById('loading')?.classList.add('done');
}

/* ---------------------------------------------------------------- *
 * 3.3단계: 타일 정보 — 학생이 "왜 여기에 안 들어서는지" 를 읽는 자리
 * ---------------------------------------------------------------- */

/**
 * 시설 칸을 찍었을 때. 담당 범위·부하·유지비를 보여준다.
 * 복지는 정원이 없으므로 반경·세기·유지비를 대신 적는다.
 */
function describeFacility(sim: MacroSim, tx: number, ty: number, kind: number): string {
  const spec = FACILITY_SPECS[kind];
  const upkeep = `하루 ₩${spec.upkeepPerDay.toLocaleString('ko-KR')}`;

  if (spec.welfare) {
    return `${spec.name} · 반경 ${spec.range}타일(직선) · 세기 ${spec.strength} · ${upkeep}`;
  }

  const record = sim.services
    .facilityList()
    .find((f) => f.tx === tx && f.ty === ty && f.kind === kind);
  if (!record) return `${spec.name} · ${upkeep}`;

  const load = Math.round(sim.services.loadOf(record.index));
  const unit = spec.capacityIsBuildings ? '건물' : '인구';
  const over = load > spec.capacity ? ' — 과부하' : '';
  const dead = spec.needsRoad && !record.hasRoad ? ' · 도로 미연결(담당 없음)' : '';
  return (
    `${spec.name} · 반경 ${spec.range}칸(도로) · ` +
    `담당 ${unit} ${load.toLocaleString('ko-KR')}/${spec.capacity.toLocaleString('ko-KR')}${over} · ` +
    `${upkeep}${dead}`
  );
}

/** 필수 서비스 4종의 상태. 종류마다 담당 시설과 부하를 함께 적는다. */
function describeService(
  sim: MacroSim,
  tx: number,
  ty: number,
  here: { tx: number; ty: number; span: number; kind: number | null } | null,
): string {
  // 건물 위면 그 건물의 footprint 로, 빈 땅이면 그 칸 하나로 본다.
  const bx = here && here.kind === null ? here.tx : tx;
  const by = here && here.kind === null ? here.ty : ty;
  const span = here && here.kind === null ? here.span : 1;

  const parts: string[] = [];
  for (let kind = 0; kind < SERVICE_KIND_COUNT; kind++) {
    const owner = sim.services.ownerFor(bx, by, span, kind);
    if (owner < 0) {
      parts.push(`${FACILITY_NAMES[kind]} 없음`);
      continue;
    }
    const spec = FACILITY_SPECS[kind];
    const load = Math.round(sim.services.loadOf(owner));
    const quality = sim.services.qualityOf(owner);
    const over = load > spec.capacity ? ' 과부하' : '';
    parts.push(
      `${FACILITY_NAMES[kind]} ${dots(quality)}(${load.toLocaleString('ko-KR')}/${spec.capacity.toLocaleString('ko-KR')}${over})`,
    );
  }
  return parts.join('   ');
}

/**
 * 복지 상태. **점수와 요구량을 나란히** 보여준다.
 *
 * 이 한 줄이 "이 자리에 고급 아파트가 왜 안 들어서는지" 를 학생에게 직접
 * 알려준다. 같은 자리라도 건물 등급이 달라지면 요구량이 달라지므로, 요구량
 * 옆에 계층 이름을 같이 적는다.
 *
 * 종류별로 쪼개지는 않는다 — 필요한 정보는 "충족했나" 하나지, 그게 소공원
 * 덕인지 체육시설 덕인지가 아니다. 대신 괄호에 반경 안의 복지 시설을 가까운
 * 순으로 두어 개 적어준다.
 */
function describeAmenity(
  sim: MacroSim,
  tx: number,
  ty: number,
  here: { tx: number; ty: number; span: number; level: number; kind: number | null } | null,
): string {
  const building = here && here.kind === null ? here : null;
  const bx = building ? building.tx : tx;
  const by = building ? building.ty : ty;
  const span = building ? building.span : 1;
  // 빈 땅에서는 중산층 기준으로 보여준다. 학생이 "여기에 뭘 지을 수 있나" 를
  // 가늠하는 자리라 가운데 계층이 기준으로 맞다.
  const tier = building ? building.level - 1 : 1;

  const score = sim.services.amenityForBuilding(bx, by, span);
  const need = AMENITY_NEED_BY_TIER[tier];
  const fulfil = Math.min(1, score / need);
  const state = fulfil >= 1 ? '충족' : '부족';

  const near = sim.services
    .nearbyWelfare(bx, by, 2)
    .map((f) => {
      const d = Math.round(Math.hypot(bx - f.tx, by - f.ty));
      return `${FACILITY_NAMES[f.kind]} ${d}칸`;
    })
    .join(', ');

  return (
    `${dots(fulfil)} ${score.toFixed(2)} / ${need.toFixed(2)} 필요 ` +
    `(${TIER_NAMES[tier]}) — ${state}` +
    (near ? `   가까운 곳: ${near}` : '')
  );
}

/** 0~1 을 네 칸짜리 막대로. 숫자보다 한눈에 읽힌다. */
function dots(v: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, v)) * 4);
  return '●'.repeat(filled) + '○'.repeat(4 - filled);
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
