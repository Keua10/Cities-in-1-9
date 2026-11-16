import { ConstructionPanel } from './ui/constructionPanel';
import { NatureLayer } from './render/natureLayer';
import { AlertPanel } from './ui/alertPanel';
import { lightingColor } from './render/dayNight';
import { audio } from './audio/audio';
import { Application } from 'pixi.js';
import { Camera } from './core/camera';
import { BASE_CHUNK_SPAN, CHUNK_SIZE, DEFAULT_ZOOM, TILE_HH, TILE_HW } from './core/constants';
import { attachInput } from './core/input';
import { chunkIndexOf, parseChunkKey, tileToWorldX, tileToWorldY, worldToTile } from './core/iso';
import { pickTile } from './core/pick';
import { claimOrigin, ClaimError, loadCity, loadClaimedOrigins } from './net/citySave';
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
import { MetroPanel } from './ui/metroPanel';
import { AssignmentTable } from './sim/assignment';
import { CongestionMap } from './sim/congestion';
import { MacroSim } from './sim/macro';
import { remainingAt } from './sim/resources';
import { CATCHUP_TICKS_PER_FRAME, START_MONEY } from './sim/simConstants';
import { installPedestrianSystemPatch } from './sim/pedestrianSystemPatch';
import { TrafficSim } from './sim/traffic/trafficSim';
import { installVehicleMotionPatch } from './sim/traffic/vehicleMotionPatch';
import { TransportSystem } from './sim/transportHubs';
import './style.css';
import { CityPanel } from './ui/cityPanel';
import { createHudUpdater } from './ui/gameHud';
import { Hud } from './ui/hud';
import { FacilityFinder } from './ui/facilityFinder';
import { requireSession } from './ui/loginScreen';
import { Minimap } from './ui/minimap';
import { SaveBadge } from './ui/saveBadge';
import { bindToolbar } from './ui/toolbar';
import { bindPlacementBar } from './ui/placementBar';
import { bindToolButtons, Tools } from './ui/tools';
import { TransportHubPanel } from './ui/transportHubPanel';
import {
  randomCitySeed,
  seedCityIfEmpty,
  SEEDED_CITY_MONEY,
  type SeededCity,
} from './world/citySeed';
import { findDryTileNearBase } from './world/spawn';
import { canStartAt, parseOriginKey, type Origin } from './world/sites';
import { pickStartOrigin } from './ui/startPicker';
import type { ChunkOverride } from './world/world';
import { World } from './world/world';
import { bindGameChrome } from './ui/gameChrome';
import './ui/gameChrome.css';

/** 카메라가 base 밖으로 나갈 수 있는 거리(청크). 이웃의 안개까지는 보이게 둔다. */
/** 탐사한 땅 바깥으로 카메라가 더 갈 수 있는 거리(청크). */
const ROAM_CHUNKS = 16;

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

  // 지도 v2: 기본 영역의 자리는 학생이 고른다. 아직 없으면(새 학생, 예전 지도에서
  // 초기화된 학생, 둘러보기) 시작 화면을 띄운다.
  let origin: Origin | null = city?.origin ? parseOriginKey(city.origin) : null;
  if (!origin) {
    if (loading) loading.textContent = '대륙 지도를 펼치는 중…';
    const online = !!(session && city);
    let claimed: Origin[] = [];
    if (online) {
      try {
        claimed = await loadClaimedOrigins();
      } catch (err) {
        console.warn('자리 목록을 읽지 못했습니다', err);
      }
    }
    origin = await pickStartOrigin({
      claimed,
      offline: !online,
      confirm: async (o) => {
        if (!online || !session) return { error: '' };
        try {
          await claimOrigin(session, o, (list) => canStartAt(o, list).reason);
          if (city) city.origin = `${o.cx},${o.cy}`;
          return { error: '' };
        } catch (err) {
          if (err instanceof ClaimError)
            return {
              error: `${err.message} · 방금 다른 도시가 자리를 잡았습니다. 다른 곳을 골라 주세요.`,
              claimed: await loadClaimedOrigins().catch(() => undefined),
            };
          throw err;
        }
      },
    });
  }

  if (loading) loading.textContent = '지형을 그리는 중…';
  const world = new World(origin);
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
  // 지도 v1 의 "예전 지형 보존" 목록은 지도 v2 초기화로 의미가 없어졌다.
  const terrainMigrated = Array.isArray(macro.legacyTerrainChunks);
  delete macro.legacyTerrainChunks;
  // 대도시는 **관리자 도구가 요청했을 때만** 만든다. 그 밖의 새 도시는 도로 한
  // 칸 없는 빈 땅에 시작 자금(START_MONEY)만 들고 시작한다 — 도시를 세우는 게
  // 이 게임이므로, 다 지어진 도시를 받아 들고 시작하면 배울 것이 남지 않는다.
  //
  // 요청은 새로고침을 한 번 건너야 한다. 관리자 도구가 도시를 지우고 새로고침
  // 하면 그 다음 부팅인 여기서 생성기가 돈다. 로그인한 학생은 요청이
  // macro.metropolisRequest 로 서버에 실려 가고, 저장이 없는 둘러보기 모드에서는
  // macro 가 새로고침마다 새로 만들어지므로 sessionStorage 쪽 씨앗으로 받는다.
  const tabSeed = takeMetropolisRequest();
  const requestedSeed = macro.metropolisRequest
    ? (macro.genSeed ?? tabSeed ?? randomCitySeed())
    : tabSeed;
  let seedChanged = false;
  let seededCenter: SeededCity | null = null;
  if (requestedSeed !== undefined) {
    seededCenter = seedCityIfEmpty(world, Math.floor(macro.tick / 24), requestedSeed);
    // 요청은 한 번만 쓰인다. 지우지 않으면 다음 새로고침마다 대도시를 다시
    // 만들려 든다(빈 도시 검사에 걸려 실패할 뿐이지만, 그 상태가 저장에 남는다).
    if (macro.metropolisRequest !== undefined) {
      delete macro.metropolisRequest;
      seedChanged = true;
    }
    if (seededCenter) {
      if (macro.genSeed !== seededCenter.seed) {
        macro.genSeed = seededCenter.seed;
        seedChanged = true;
      }
      if (macro.money < SEEDED_CITY_MONEY) {
        macro.money = SEEDED_CITY_MONEY;
        seedChanged = true;
      }
    }
  }

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
  if (terrainMigrated || seedChanged) saver.noteMacroChange();
  if (loadFailed) badge.set('error', '불러오기 실패 — 저장되지 않습니다');

  const hud = new Hud();
  const minimap = new Minimap(world, camera);
  let cursor: { tx: number; ty: number } | null = null;

  const sim = new MacroSim(world, macro);
  // 영토 규칙: 지구는 내 땅·개척지, 공공 시설은 내 땅에만.
  world.landRule = sim.territory.landRule;
  renderer.territory = sim.territory;
  minimap.territory = sim.territory;
  // 자원 매장지 지도: 남은 양으로 진하기를 정한다.
  const remaining = (cx: number, cy: number) => remainingAt(macro, cx, cy);
  renderer.resourceLayer.remaining = remaining;
  renderer.resourceLayer.revision = () =>
    Object.values(macro.mined ?? {}).reduce((a, b) => a + b, 0);
  minimap.resourceRemaining = remaining;
  const constructionPanel = new ConstructionPanel(sim.construction);
  const natureLayer = new NatureLayer(world, sim);
  renderer.root.addChild(natureLayer.graphics);
  const weatherStatus = document.createElement('div');
  weatherStatus.className = 'weather-status';
  document.body.append(weatherStatus);
  renderer.metro = sim.metro;
  renderer.waterField = sim.water;
  renderer.powerField = sim.power;
  sim.onMacroChange = () => saver.noteMacroChange();
  const transport = new TransportSystem(world, macro, sim, () => saver.noteMacroChange());

  const congestion = new CongestionMap();
  const assignment = new AssignmentTable();
  sim.attachTraffic(congestion, assignment);
  sim.primeCatchup(Date.now());
  // 도시마다 한 번: 스타트 버닝(플레이 시간 10분 동안 건설 ×10 · 수입 ×10).
  const boostGranted = sim.grantStartBoost();
  transport.update();

  const traffic = new TrafficSim(world, sim, congestion, assignment);
  installVehicleMotionPatch(traffic);
  installPedestrianSystemPatch(traffic);
  renderer.attachTraffic(traffic, vehicleAtlas);
  renderer.attachDisasters(sim.disasters);
  renderer.attachMacro(sim);

  /*
   * 구조물이 서거나 헐리면 화면과 소리로 알린다 (수정사항 2).
   * 시뮬레이션이 스스로 세운 건물도 여기로 들어온다 — 도시가 자라는 게 보인다.
   */
  world.onStructureEvent = (e) => {
    renderer.effects.push(e, performance.now());
    audio.play(e.kind === 'demolish' ? 'demolish' : 'grow');
  };
  // 브라우저는 사용자가 한 번 누르기 전에는 소리를 내주지 않는다.
  const wakeAudio = () => audio.resume();
  window.addEventListener('pointerdown', wakeAudio, { once: false });
  window.addEventListener('keydown', wakeAudio, { once: false });

  const cityPanel = new CityPanel();
  cityPanel.world = world;
  /** 수도 이전: 패널에서 버튼을 누르면 다음 탭 한 번이 새 수도 자리가 된다. */
  let pickCapital = false;
  cityPanel.onCapitalMove = () => {
    pickCapital = true;
    tools.setTool('select');
    tools.announce('새 수도의 가운데가 될 곳을 지도에서 누르세요 · 내 영토 안이어야 합니다');
  };
  const facilityFinder = new FacilityFinder(world, sim, (f) => {
    renderer.setFacilityFocus(f);
    if (!f) return;
    cursor = { tx: f.tx, ty: f.ty };
    renderer.setCursorTile(cursor);
    const center = (f.span - 1) / 2;
    camera.centerOnWorld(
      tileToWorldX(f.tx + center, f.ty + center),
      tileToWorldY(f.tx + center, f.ty + center, world.sampleHeight(f.tx, f.ty)),
    );
  });
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
  const alertPanel = new AlertPanel();
  // 확정 바의 Escape 처리가 건설 메뉴·패널 닫기보다 먼저 와야 한다.
  const placementBar = bindPlacementBar(tools);
  const metroPanel = new MetroPanel(sim.metro, tools);
  const transportPanel = new TransportHubPanel(world, transport);

  attachInput(app.canvas, camera, {
    onTap: (wx, wy) => {
      const alert = tools.tool === 'select' ? renderer.alertAt(wx, wy) : null;
      if (alert) {
        chrome.closePanels();
        transportPanel.hide();
        alertPanel.show(alert);
        return;
      }
      alertPanel.hide();
      cursor = pickTile(world, wx, wy);
      renderer.setCursorTile(cursor);
      if (pickCapital) {
        pickCapital = false;
        const target = sim.territory.moveTarget(chunkIndexOf(cursor.tx), chunkIndexOf(cursor.ty));
        const why = sim.territory.startMove(target);
        tools.announce(
          why ? `수도를 옮길 수 없습니다 · ${why}` : '수도 이전 시작 · 실제 5분 뒤 완료',
        );
        return;
      }
      if (tools.tool === 'select' && sim.construction.at(cursor.tx, cursor.ty)) {
        chrome.closePanels();
        constructionPanel.show(cursor.tx, cursor.ty);
        return;
      }
      constructionPanel.hide();
      if (tools.metroMode) {
        metroPanel.selectStation(`${cursor.tx},${cursor.ty}`);
        return;
      }
      /*
       * 건설 도구를 든 탭은 **점을 찍는 동작**이다(onPaintStart 가 받는다).
       * 그 탭으로 건물 정보 패널까지 열리면, 두 점을 찍는 내내 패널이 떴다
       * 닫혔다 하면서 지도를 가린다.
       */
      if (tools.tool !== 'select') return;
      const station = sim.metro.stationAtSurface(cursor.tx, cursor.ty);
      if (station) {
        tools.setTool('metroView');
        metroPanel.selectStation(station);
        return;
      }
      if (cursor) {
        chrome.closePanels();
        const transportSelected = transportPanel.showAt(cursor.tx, cursor.ty);
        if (!transportSelected && world.buildingCovering(cursor.tx, cursor.ty))
          chrome.showInspection();
      }
    },
    onHover: (wx, wy) => {
      cursor = pickTile(world, wx, wy);
      renderer.setCursorTile(cursor);
      tools.hoverTile(cursor);
    },
    onHoverEnd: () => {
      cursor = null;
      renderer.setCursorTile(null);
      tools.hoverTile(null);
    },
    isPainting: () => tools.isPainting(),
    // 모든 건설 도구가 'tap' 이므로 여기는 짧은 탭에서만 불린다.
    // 드래그는 언제나 지도 이동으로 간다.
    onPaintStart: (wx, wy) => {
      cursor = pickTile(world, wx, wy);
      renderer.setCursorTile(cursor);
      tools.hoverTile(cursor);
      tools.tapAtWorld(wx, wy);
    },
  });

  app.renderer.on('resize', (w: number, h: number) => {
    camera.resize(w, h);
  });

  bindToolbar({
    nature: sim.nature,
    mapCenter: () => worldToTile(camera.x, camera.y),
    centerCamera,
    renderer,
    saver,
    loggedIn: Boolean(session),
    getMoney: () => sim.money,
    setMoney: async (amount) => {
      if (saver.status === 'saving' || saver.status === 'conflict')
        throw new Error('저장 중이거나 다른 기기와 충돌했습니다. 저장 상태를 확인하세요.');
      macro.money = amount;
      saver.noteMacroChange();
      await saver.saveNow();
      if (session && saver.status !== 'saved' && saver.status !== 'idle')
        throw new Error(
          '자금은 현재 화면에 적용됐지만 서버 저장은 완료되지 않았습니다. 저장 상태를 확인하세요.',
        );
    },
    resetCity: async (mode) => {
      if (saver.status === 'saving' || saver.status === 'conflict')
        throw new Error('저장 중이거나 다른 기기와 충돌했습니다. 저장 상태를 확인하세요.');
      app.ticker.stop();
      transportPanel.hide();
      world.clearBuilt();
      // transport 를 비우는 것까지 여기서 하지 않는다. resetState 가 선택 필드를
      // 전부 **키째로** 지운다. `= undefined` 로 두면 Firestore 가 그 저장을
      // 거부하고, 그러면 초기화가 서버에 안 실려서 새로고침 뒤에 예전 도시가
      // 그대로 돌아온다. genSeed·metropolisRequest 도 거기서 지워지므로,
      // 대도시 요청은 반드시 resetState **뒤에** 적는다.
      sim.resetState(mode === 'metropolis' ? SEEDED_CITY_MONEY : START_MONEY, Date.now());
      if (mode === 'metropolis') {
        // 새 씨앗. 이게 없으면 다시 눌러도 똑같은 도시가 만들어진다.
        // sessionStorage 에도 적어 둔다 — 둘러보기 모드에는 저장이 없다.
        const seed = randomCitySeed();
        macro.genSeed = seed;
        macro.metropolisRequest = true;
        rememberMetropolisRequest(seed);
      } else forgetMetropolisRequest();
      try {
        await saver.saveNow();
        if (session && saver.status !== 'saved' && saver.status !== 'idle')
          throw new Error('새 도시 초기화 상태를 서버에 저장하지 못했습니다.');
      } catch (err) {
        // 조용히 새로고침하면 학생은 "버튼이 안 먹는다" 로만 본다. 실제로
        // 무슨 일이 있었는지 알려주고 나서 화면을 서버 상태에 맞춘다.
        console.error('초기화 저장 실패', err);
        app.ticker.start();
        throw err;
      }
      location.reload();
    },
  });
  bindToolButtons(tools);
  const chrome = bindGameChrome(camera, tools, centerCamera);
  constructionPanel.onCancel = (tx, ty) => tools.cancelConstruction(tx, ty);
  if (boostGranted)
    tools.announce('🔥 스타트 버닝 시작! 10분(플레이 시간) 동안 건설 속도 ×10 · 수입 ×10');
  sim.territory.onChange = (gained, lost) => {
    if (lost.length)
      tools.announce(
        `영토 ${lost.length}청크를 잃었습니다 · 본 도시와 길이 끊긴 지 10분이 지났습니다`,
      );
    else if (gained.length)
      tools.announce(`영토 +${gained.length}청크 · 지금 영토 ${sim.territory.count}청크`);
  };
  let roamRevision = -1;

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

  let lastFrameAt = performance.now();
  app.ticker.add((ticker) => {
    const now = performance.now();
    const gameDelta = Math.min(ticker.deltaMS, 100) * chrome.speed;
    // 스타트 버닝은 실제 플레이 시간으로 줄인다. 느린 기기(프레임 100ms 이상)에서도
    // 버닝이 덜 들어가지 않게 1초까지는 그대로 센다. 탭이 숨겨졌다 돌아온 큰 공백은 뺀다.
    // (Pixi 의 deltaMS 는 프레임당 100ms 로 잘리므로 실제 시계로 직접 잰다.)
    const playDelta = Math.min(Math.max(0, now - lastFrameAt), 1000);
    lastFrameAt = now;
    if (chrome.speed > 0) {
      sim.update(gameDelta, CATCHUP_TICKS_PER_FRAME, playDelta);
      transport.update();
    } else sim.holdClock();
    if (sim.territory.revision !== roamRevision) {
      roamRevision = sim.territory.revision;
      camera.limit = roamLimit(world);
    }

    const camTile = worldToTile(camera.x, camera.y);
    traffic.setActiveChunk(
      chunkIndexOf(camTile.tx),
      chunkIndexOf(camTile.ty),
      camTile.tx,
      camTile.ty,
    );
    if (chrome.speed > 0) traffic.update(gameDelta);
    camera.update(ticker.deltaMS);
    camera.applyTo(renderer.root);
    renderer.setFacilityPreview(cursor ? tools.facilityPreviewAt(cursor.tx, cursor.ty) : null);
    renderer.setPlacement(tools.placementPreview());
    placementBar.update();
    renderer.utilityMode = tools.utilityMode;
    minimap.showResources = tools.utilityMode === 'resources';
    renderer.metroMode = tools.metroMode && tools.tool !== 'metroStation';
    renderer.metroSelection = tools.metroSelection;
    setPedestrianRenderZoom(camera.zoom);
    renderer.update(camera, now);
    renderer.setWorldTint(lightingColor(traffic.daytimeState, sim.nature.weather.cloud));
    natureLayer.draw(camera);
    constructionPanel.update();
    const weather = sim.nature.weather;
    weatherStatus.textContent =
      (weather.precipitation === 'rain' ? '비' : weather.precipitation === 'snow' ? '눈' : '맑음') +
      ' · ' +
      weather.temperature.toFixed(0) +
      '°C · 바람 ' +
      weather.windSpeed.toFixed(1) +
      'm/s' +
      (sim.nature.state.hazard ? ' · 재해 진행 중' : '');
    renderer.flush();
    minimap.update(
      now,
      tools.tool === 'facility' ? { field: sim.services, kind: tools.facilityKind } : null,
    );

    transportPanel.update();
    metroPanel.update();
    cityPanel.update(now, sim);
    chrome.update(now, sim, traffic.daytimeState);
    facilityFinder.update(now);
    updateHud(now, ticker.FPS);
  });

  document.getElementById('loading')?.classList.add('done');
}

/**
 * 관리자 도구의 "대도시 생성" 요청을 새로고침 너머로 넘긴다.
 *
 * 값이 있다는 것 자체가 곧 요청이고, 값은 그 도시를 만들 씨앗이다. 로그인한
 * 학생은 요청이 `macro.metropolisRequest` 로 서버에 저장되므로 이게 없어도
 * 되지만, 저장이 없는 둘러보기 모드에서는 macro 가 새로고침마다 새로 만들어져
 * 요청이 사라진다 — 그러면 버튼을 눌러도 빈 도시만 나온다.
 *
 * sessionStorage 는 탭을 닫으면 사라지고 쓸 수 없는 환경(사생활 보호 모드)도
 * 있으므로, 실패해도 조용히 넘어간다. 값은 한 번만 쓰고 지운다.
 */
const METROPOLIS_SEED_KEY = 'cities19.metropolisSeed';

function rememberMetropolisRequest(seed: number): void {
  try {
    sessionStorage.setItem(METROPOLIS_SEED_KEY, String(seed));
  } catch {
    /* 저장할 수 없으면 서버에 실린 macro.metropolisRequest 쪽으로 간다 */
  }
}

function forgetMetropolisRequest(): void {
  try {
    sessionStorage.removeItem(METROPOLIS_SEED_KEY);
  } catch {
    /* 지울 수 없어도 요청은 부팅 때 한 번 읽히고 사라진다 */
  }
}

function takeMetropolisRequest(): number | undefined {
  try {
    const raw = sessionStorage.getItem(METROPOLIS_SEED_KEY);
    sessionStorage.removeItem(METROPOLIS_SEED_KEY);
    const seed = Number(raw);
    return raw !== null && Number.isFinite(seed) ? seed >>> 0 : undefined;
  } catch {
    return undefined;
  }
}

function roamLimit(world: World): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  // 탐사한 땅 전체 + 둘레 ROAM_CHUNKS. 영토가 넓어지면 같이 넓어진다.
  let minCx = world.baseCx;
  let minCy = world.baseCy;
  let maxCx = world.baseCx + BASE_CHUNK_SPAN - 1;
  let maxCy = world.baseCy + BASE_CHUNK_SPAN - 1;
  for (const key of world.exploredKeys()) {
    const { cx, cy } = parseChunkKey(key);
    minCx = Math.min(minCx, cx);
    minCy = Math.min(minCy, cy);
    maxCx = Math.max(maxCx, cx);
    maxCy = Math.max(maxCy, cy);
  }
  const t0x = (minCx - ROAM_CHUNKS) * CHUNK_SIZE;
  const t0y = (minCy - ROAM_CHUNKS) * CHUNK_SIZE;
  const t1x = (maxCx + 1 + ROAM_CHUNKS) * CHUNK_SIZE;
  const t1y = (maxCy + 1 + ROAM_CHUNKS) * CHUNK_SIZE;
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
