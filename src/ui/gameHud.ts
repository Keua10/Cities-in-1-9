import type { Camera } from '../core/camera';
import { WORLD_SEED } from '../core/constants';
import { BUILDING_NAMES, BUILDING_ART_VARIANTS } from '../render/buildingArt';
import { chunkIndexOf } from '../core/iso';
import type { WorldRenderer } from '../render/worldRenderer';
import { TIER_NAMES, ZONE_NAMES, simHash } from '../sim/buildings';
import type { CongestionMap } from '../sim/congestion';
import { DISASTER_NAMES } from '../sim/disasters';
import type { EnvironmentParts } from '../sim/environment';
import type { MacroSim } from '../sim/macro';
import { SEASON_NAMES, WEEKDAY_NAMES } from '../sim/time';
import { DAYTIME_DAY_MS, GAMETIME_DAY_MS } from '../sim/simConstants';
import type { TrafficSim } from '../sim/traffic/trafficSim';
import { Build, hasRoadAccess, isZone } from '../world/build';
import type { World } from '../world/world';
import { buildingAmenity, buildingServices, facilityCard } from './cursorDetails';
import { FACILITY_SPECS } from '../sim/facilities';

const FACILITY_SPECS_NAME = (kind: number): string => FACILITY_SPECS[kind]?.name ?? '시설';
import type { InfoCard } from './infoCard';
import type { Hud } from './hud';
import { TOOL_LABELS, type Tools } from './tools';

interface GameHudDeps {
  hud: Hud;
  world: World;
  sim: MacroSim;
  camera: Camera;
  tools: Tools;
  renderer: WorldRenderer;
  traffic: TrafficSim;
  congestion: CongestionMap;
  placeholderArt: boolean;
  cityLabel: string;
  cursor: () => { tx: number; ty: number } | null;
}

/**
 * 환경도에서 깎아먹는 것만 (수정사항 4) — 플레이어가 고칠 것이 그것뿐이다.
 */
function environmentProblems(parts: EnvironmentParts | null): string[] {
  if (!parts) return [];
  const bad: string[] = [];
  if (parts.parks < 0.6) bad.push('공원 부족');
  if (parts.noise > 0.35) bad.push('소음');
  if (parts.pollution > 0.2) bad.push('오염');
  if (parts.traffic > 0.35) bad.push('정체');
  if (parts.access < 0.6) bad.push('접근성 낮음');
  return bad;
}

const BUILDING_HELP =
  '전력·급수·하수가 모두 닿아야 사람이 들어옵니다. 환경도는 공원·소음·오염·정체·접근성으로 정해지고, 소득이 높을수록 복지가 더 필요합니다.';

/** 구역 건물 카드: 이름·등급, 입주, 기반 시설 막대, 고칠 것, 서비스 칸. */
function buildingCard(
  sim: MacroSim,
  here: { tx: number; ty: number; span: number; zone: number; level: number; born: number },
  occupancy: number | null,
  environment: number | null,
  envParts: EnvironmentParts | null,
): InfoCard {
  const water = sim.water.statusAt(here.tx, here.ty);
  const amenity = buildingAmenity(sim, here.tx, here.ty, here.span, here.level);
  const problems = environmentProblems(envParts);
  if (sim.water.contaminationAt(here.tx, here.ty) > 0) problems.unshift('수질 오염');
  if (amenity.problem) problems.push(amenity.problem);
  const empty = occupancy === null || occupancy <= 0;
  return {
    title:
      BUILDING_NAMES[here.zone][here.level - 1][
        simHash(WORLD_SEED, here.tx, here.ty, here.level) % BUILDING_ART_VARIANTS
      ],
    sub: `${ZONE_NAMES[here.zone]} ${here.level}단계 · ${TIER_NAMES[here.level - 1]}`,
    status: empty ? { text: '공실', tone: 'warn' } : undefined,
    meters: [
      ...(empty ? [] : [{ label: '입주', value: occupancy! }]),
      { label: '전력', value: sim.power.supplyAt(here.tx, here.ty) },
      { label: '급수', value: water.supply },
      { label: '하수', value: water.drainage },
      ...(environment === null ? [] : [{ label: '환경', value: environment }]),
      { label: '복지', value: amenity.value },
    ],
    problems,
    services: buildingServices(sim, here.tx, here.ty, here.span),
    foot: buildingAge(sim.day - here.born),
    help: BUILDING_HELP,
  };
}

/** Bind once; query the world only when the HUD is due to paint. */
export function createHudUpdater(deps: GameHudDeps): (now: number, fps: number) => void {
  const { hud, world, sim, camera, tools, renderer, traffic, congestion, cityLabel } = deps;
  return (now, fps) => {
    hud.update(now, () => {
      const cursor = deps.cursor();
      const cursorBuild = cursor ? world.getBuild(cursor.tx, cursor.ty) : null;
      const here = cursor ? world.buildingCovering(cursor.tx, cursor.ty) : null;
      const occupancy = cursor ? sim.occupancyAt(cursor.tx, cursor.ty) : null;
      const environment = cursor ? sim.environmentAt(cursor.tx, cursor.ty) : null;
      const envParts = cursor ? sim.environmentPartsAt(cursor.tx, cursor.ty) : null;
      const incident = cursor ? sim.disasters.at(cursor.tx, cursor.ty, world) : null;

      return {
        fps,
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
        chunk: cursor ? { cx: chunkIndexOf(cursor.tx), cy: chunkIndexOf(cursor.ty) } : null,
        building: here
          ? here.kind !== null
            ? FACILITY_SPECS_NAME(here.kind)
            : `${ZONE_NAMES[here.zone]} L${here.level}`
          : null,
        card: here
          ? here.kind !== null
            ? facilityCard(sim, here.tx, here.ty, here.kind)
            : buildingCard(sim, here, occupancy, environment, envParts)
          : null,
        incident: incident
          ? `${DISASTER_NAMES[incident.kind]} · 발생 후 ${sim.tick - incident.startedTick}시간`
          : null,
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
        placeholderArt: deps.placeholderArt,
        city: cityLabel,
      };
    });
  };
}

/**
 * 건물 나이. `born` 은 시뮬레이션 날짜(1일 = 1분)로 저장되지만 화면 아래 시계는
 * 생활 날짜(1일 = 10분)다. 같은 화면에서 두 날짜가 섞이면 "6일차인데 51일 된
 * 건물" 이 나온다. 표시만 생활 날짜로 바꾼다.
 */
function buildingAge(simDays: number): string {
  const lifeDays = Math.floor((Math.max(0, simDays) * GAMETIME_DAY_MS) / DAYTIME_DAY_MS);
  return lifeDays < 1 ? '새로 지음' : `${lifeDays}일 됨`;
}
