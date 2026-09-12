import type { Camera } from '../core/camera';
import { WORLD_SEED } from '../core/constants';
import { BUILDING_NAMES, BUILDING_ART_VARIANTS } from '../render/buildingArt';
import { chunkIndexOf } from '../core/iso';
import type { WorldRenderer } from '../render/worldRenderer';
import { TIER_NAMES, ZONE_NAMES, simHash } from '../sim/buildings';
import type { CongestionMap } from '../sim/congestion';
import { DISASTER_NAMES } from '../sim/disasters';
import type { MacroSim } from '../sim/macro';
import { SEASON_NAMES, WEEKDAY_NAMES } from '../sim/time';
import type { TrafficSim } from '../sim/traffic/trafficSim';
import { Build, hasRoadAccess, isZone } from '../world/build';
import type { World } from '../world/world';
import { describeAmenity, describeFacility, describeService } from './cursorDetails';
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

/** Bind once; query the world only when the HUD is due to paint. */
export function createHudUpdater(deps: GameHudDeps): (now: number, fps: number) => void {
  const { hud, world, sim, camera, tools, renderer, traffic, congestion, cityLabel } = deps;
  return (now, fps) => {
    hud.update(now, () => {
      const cursor = deps.cursor();
      const cursorBuild = cursor ? world.getBuild(cursor.tx, cursor.ty) : null;
      const here = cursor ? world.buildingCovering(cursor.tx, cursor.ty) : null;
      const occupancy = cursor ? sim.occupancyAt(cursor.tx, cursor.ty) : null;
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
            ? describeFacility(sim, here.tx, here.ty, here.kind)
            : `${BUILDING_NAMES[here.zone][here.level - 1][simHash(WORLD_SEED, here.tx, here.ty, here.level) % BUILDING_ART_VARIANTS]} · ${ZONE_NAMES[here.zone]} L${here.level} (${TIER_NAMES[here.level - 1]}) · ` +
              `${occupancy === null || occupancy <= 0 ? '공실' : `입주 ${Math.round(occupancy * 100)}%`} · ` +
              `${sim.day - here.born}일 됨 · 전력 ${Math.round(sim.power.supplyAt(here.tx, here.ty) * 100)}% · 급수 ${Math.round(sim.water.statusAt(here.tx, here.ty).supply * 100)}% · 하수 ${Math.round(sim.water.statusAt(here.tx, here.ty).drainage * 100)}%${sim.water.contaminationAt(here.tx, here.ty) > 0 ? ' · 수질 오염' : ''}`
          : null,
        service:
          cursor && here?.kind == null ? describeService(sim, cursor.tx, cursor.ty, here) : null,
        amenity:
          cursor && here?.kind == null ? describeAmenity(sim, cursor.tx, cursor.ty, here) : null,
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
