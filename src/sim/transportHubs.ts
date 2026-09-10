import { CHUNK_SIZE } from '../core/constants';
import type { MacroState, HarborAllocation } from '../net/types';
import { Build, DIRS } from '../world/build';
import type { World } from '../world/world';
import {
  FACILITY_SPECS,
  touchesRoadTiles,
  touchesWater,
} from './facilities';
import {
  facilityKindOfCode,
  isFacilityAnchor,
  ZONE_C,
  ZONE_I,
  ZONE_R,
} from './buildings';
import type { MacroSim } from './macro';
import { normalizeProsperity } from './progression';
import {
  AIRPORT_SPECS,
  AIRPORT_REVENUE_PER_PLANE,
  AIRPORT_VISITORS_PER_PLANE,
  CARGO_EXPORT_PER_SHIP,
  CARGO_REVENUE_PER_SHIP,
  HARBOR_SPECS,
  PASSENGER_LOCAL_TRIPS_PER_SHIP,
  PASSENGER_REVENUE_PER_SHIP,
  PASSENGER_VISITORS_PER_SHIP,
} from './config/transport';
import {
  isAirportFacility,
  isHarborFacility,
  isHybridHarbor,
} from './config/special';

export interface AirfieldStatus {
  taxiwayConnected: boolean;
  connectedRunwayTiles: number;
  longestRunway: number;
  requiredRunway: number;
  ready: boolean;
}

export interface TransportHubStatus {
  kind: number;
  tx: number;
  ty: number;
  span: number;
  level: number;
  operational: boolean;
  road: boolean;
  power: number;
  water?: boolean;
  airport?: {
    maxPlanes: number;
    activePlanes: number;
    airfield: AirfieldStatus;
  };
  harbor?: {
    maxShips: number;
    passengerShips: number;
    cargoShips: number;
    hybrid: boolean;
  };
}

export interface TransportSummary {
  operationalAirports: number;
  operationalHarbors: number;
  activePlanes: number;
  passengerShips: number;
  /** Operational harbors with at least one passenger ship assigned. */
  passengerHarbors: number;
  cargoShips: number;
  visitorsPerDay: number;
  localPassengerTripsPerDay: number;
  cargoExportDemand: number;
  dailyRevenue: number;
}

const EMPTY_SUMMARY: TransportSummary = {
  operationalAirports: 0,
  operationalHarbors: 0,
  activePlanes: 0,
  passengerShips: 0,
  passengerHarbors: 0,
  cargoShips: 0,
  visitorsPerDay: 0,
  localPassengerTripsPerDay: 0,
  cargoExportDemand: 0,
  dailyRevenue: 0,
};

/**
 * Airport/harbor operational layer.
 *
 * Facility placement still lives in Build.Civic/bld. Only hybrid harbor allocation is saved in
 * MacroState, so no second facility storage layer is introduced.
 */
export class TransportSystem {
  private cached: TransportSummary = { ...EMPTY_SUMMARY };
  private lastTick = -1;
  private lastDay: number;

  constructor(
    private world: World,
    private macro: MacroState,
    private sim: MacroSim,
    private onChange: (() => void) | null = null,
  ) {
    this.lastDay = Math.floor(macro.tick / 24);
  }

  update(): void {
    const tick = this.sim.tick;
    if (tick === this.lastTick) return;
    this.lastTick = tick;

    this.cached = this.rebuildSummary();
    this.applyDemandFloor(this.cached);
    // MacroSim의 기본 재정 계산에는 교통 허브 수익이 없으므로 상태판 표시만 합산한다.
    // 실제 현금 반영은 하루 경계에서 applyDailyEffects가 딱 한 번 처리한다.
    this.sim.stats.dailyIncome = this.sim.financeEstimate().income + this.cached.dailyRevenue;

    const day = Math.floor(tick / 24);
    const crossed = Math.max(0, day - this.lastDay);
    if (crossed > 0) {
      this.applyDailyEffects(this.cached, crossed);
      this.lastDay = day;
    }
  }

  summary(): TransportSummary {
    return { ...this.cached };
  }

  statusAt(tx: number, ty: number): TransportHubStatus | null {
    const info = this.world.buildingCovering(tx, ty);
    if (!info || info.kind === null || (!isAirportFacility(info.kind) && !isHarborFacility(info.kind)))
      return null;
    return this.statusFor(info.tx, info.ty, info.kind, info.span);
  }

  allocationAt(tx: number, ty: number, kind: number): HarborAllocation | null {
    const spec = HARBOR_SPECS[kind];
    if (!spec) return null;
    if (spec.mode === 'passenger') return { passenger: spec.maxShips, cargo: 0 };
    if (spec.mode === 'cargo') return { passenger: 0, cargo: spec.maxShips };

    const saved = this.macro.transport?.harbors?.[hubKey(tx, ty)];
    if (saved) return clampAllocation(saved, spec.maxShips);
    return defaultHybridAllocation(spec.maxShips);
  }

  /** Hybrid only. The changed side wins and the other side is reduced first if the cap is exceeded. */
  setHarborAllocation(
    tx: number,
    ty: number,
    passenger: number,
    cargo: number,
    prefer: 'passenger' | 'cargo',
  ): HarborAllocation | null {
    const info = this.world.buildingCovering(tx, ty);
    if (!info || info.kind === null || !isHybridHarbor(info.kind)) return null;
    const max = HARBOR_SPECS[info.kind].maxShips;

    const allocation = normalizeHarborAllocation(passenger, cargo, max, prefer);
    const p = allocation.passenger;
    const c = allocation.cargo;

    this.macro.transport ??= {};
    this.macro.transport.harbors ??= {};
    this.macro.transport.harbors[hubKey(info.tx, info.ty)] = { passenger: p, cargo: c };
    this.cached = this.rebuildSummary();
    this.applyDemandFloor(this.cached);
    this.onChange?.();
    return { passenger: p, cargo: c };
  }

  private rebuildSummary(): TransportSummary {
    const out: TransportSummary = { ...EMPTY_SUMMARY };
    for (const hub of this.hubs()) {
      const status = this.statusFor(hub.tx, hub.ty, hub.kind, hub.span);
      if (!status.operational) continue;

      if (status.airport) {
        out.operationalAirports++;
        out.activePlanes += status.airport.activePlanes;
      }
      if (status.harbor) {
        out.operationalHarbors++;
        out.passengerShips += status.harbor.passengerShips;
        if (status.harbor.passengerShips > 0) out.passengerHarbors++;
        out.cargoShips += status.harbor.cargoShips;
      }
    }

    out.visitorsPerDay =
      out.activePlanes * AIRPORT_VISITORS_PER_PLANE +
      out.passengerShips * PASSENGER_VISITORS_PER_SHIP;
    // 도시 내 수상교통은 출발/도착 항구가 모두 있어야 성립한다. 항구 1개만 있을 때는
    // 외부 방문객 수송은 가능하지만 도시 안의 ferry 네트워크 효과는 주지 않는다.
    out.localPassengerTripsPerDay =
      out.passengerHarbors >= 2 ? out.passengerShips * PASSENGER_LOCAL_TRIPS_PER_SHIP : 0;
    out.cargoExportDemand = out.cargoShips * CARGO_EXPORT_PER_SHIP;
    out.dailyRevenue =
      out.activePlanes * AIRPORT_REVENUE_PER_PLANE +
      out.passengerShips * PASSENGER_REVENUE_PER_SHIP +
      out.cargoShips * CARGO_REVENUE_PER_SHIP;
    return out;
  }

  private statusFor(tx: number, ty: number, kind: number, span: number): TransportHubStatus {
    const road = touchesRoadTiles(this.world, tx, ty, span);
    const power = this.sim.power.supplyAt(tx, ty);

    const airport = AIRPORT_SPECS[kind];
    if (airport) {
      const airfield = airportAirfieldStatus(this.world, tx, ty, span, airport.minRunwayTiles);
      const operational = road && power >= 0.5 && airfield.ready;
      return {
        kind,
        tx,
        ty,
        span,
        level: airport.level,
        operational,
        road,
        power,
        airport: {
          maxPlanes: airport.maxPlanes,
          activePlanes: operational ? airport.maxPlanes : 0,
          airfield,
        },
      };
    }

    const harbor = HARBOR_SPECS[kind];
    const water = touchesWater(this.world, tx, ty, span);
    const allocation = this.allocationAt(tx, ty, kind) ?? { passenger: 0, cargo: 0 };
    const operational = Boolean(harbor) && road && water && power >= 0.5;
    return {
      kind,
      tx,
      ty,
      span,
      level: harbor?.level ?? 1,
      operational,
      road,
      power,
      water,
      harbor: harbor
        ? {
            maxShips: harbor.maxShips,
            passengerShips: operational ? allocation.passenger : 0,
            cargoShips: operational ? allocation.cargo : 0,
            hybrid: harbor.mode === 'hybrid',
          }
        : undefined,
    };
  }

  private hubs(): Array<{ tx: number; ty: number; kind: number; span: number }> {
    const out: Array<{ tx: number; ty: number; kind: number; span: number }> = [];
    for (const parcel of this.world.developedParcels()) {
      if (!parcel.bld) continue;
      for (let i = 0; i < parcel.bld.length; i++) {
        const code = parcel.bld[i];
        if (!isFacilityAnchor(code)) continue;
        const kind = facilityKindOfCode(code);
        if (!isAirportFacility(kind) && !isHarborFacility(kind)) continue;
        const tx = parcel.cx * CHUNK_SIZE + (i % CHUNK_SIZE);
        const ty = parcel.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
        out.push({ tx, ty, kind, span: FACILITY_SPECS[kind].span });
      }
    }
    return out;
  }

  private applyDemandFloor(summary: TransportSummary): void {
    // Airport visitors support shops; cargo ships support industry; passenger ships also make
    // waterfront commuting useful. Floors are idempotent and do not stack every frame.
    const commerce = clamp01(summary.visitorsPerDay / 5_000 + summary.localPassengerTripsPerDay / 12_000) * 0.35;
    const industry = clamp01(summary.cargoExportDemand / 2_500) * 0.45;
    const housing = clamp01(summary.localPassengerTripsPerDay / 18_000) * 0.12;

    if (this.sim.demand[ZONE_C]) {
      this.sim.demand[ZONE_C][0] = Math.max(this.sim.demand[ZONE_C][0], commerce);
      this.sim.demand[ZONE_C][1] = Math.max(this.sim.demand[ZONE_C][1], commerce * 0.75);
      this.sim.demand[ZONE_C][2] = Math.max(this.sim.demand[ZONE_C][2], commerce * 0.45);
    }
    if (this.sim.demand[ZONE_I]) {
      this.sim.demand[ZONE_I][0] = Math.max(this.sim.demand[ZONE_I][0], industry);
      this.sim.demand[ZONE_I][1] = Math.max(this.sim.demand[ZONE_I][1], industry * 0.8);
      this.sim.demand[ZONE_I][2] = Math.max(this.sim.demand[ZONE_I][2], industry * 0.5);
    }
    if (this.sim.demand[ZONE_R]) {
      this.sim.demand[ZONE_R][0] = Math.max(this.sim.demand[ZONE_R][0], housing * 0.45);
      this.sim.demand[ZONE_R][1] = Math.max(this.sim.demand[ZONE_R][1], housing * 0.8);
      this.sim.demand[ZONE_R][2] = Math.max(this.sim.demand[ZONE_R][2], housing);
    }
  }

  private applyDailyEffects(summary: TransportSummary, days: number): void {
    if (summary.dailyRevenue <= 0 && summary.visitorsPerDay <= 0 && summary.cargoExportDemand <= 0) return;
    this.macro.money = Math.round((this.macro.money + summary.dailyRevenue * days) * 100) / 100;
    const prosperityPerDay = Math.round(
      summary.visitorsPerDay / 250 +
        summary.cargoExportDemand / 500 +
        summary.localPassengerTripsPerDay / 800,
    );
    this.macro.prosperity = normalizeProsperity((this.macro.prosperity ?? 0) + prosperityPerDay * days);
    this.onChange?.();
  }
}

export function airportAirfieldStatus(
  world: World,
  tx: number,
  ty: number,
  span: number,
  requiredRunway: number,
): AirfieldStatus {
  const queue: Array<[number, number]> = [];
  const seen = new Set<string>();

  for (const [x, y] of footprintEdgeNeighbors(tx, ty, span)) {
    if (world.sampleBuild(x, y) !== Build.Taxiway) continue;
    const key = tileKey(x, y);
    if (!seen.has(key)) {
      seen.add(key);
      queue.push([x, y]);
    }
  }

  const taxiwayConnected = queue.length > 0;
  const runway = new Set<string>();
  let head = 0;
  while (head < queue.length && seen.size < 2_048) {
    const [x, y] = queue[head++];
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      const build = world.sampleBuild(nx, ny);
      if (build !== Build.Taxiway && build !== Build.Runway) continue;
      const key = tileKey(nx, ny);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push([nx, ny]);
      if (build === Build.Runway) runway.add(key);
    }
    if (world.sampleBuild(x, y) === Build.Runway) runway.add(tileKey(x, y));
  }

  const longestRunway = longestStraightRunway(runway);
  return {
    taxiwayConnected,
    connectedRunwayTiles: runway.size,
    longestRunway,
    requiredRunway,
    ready: taxiwayConnected && longestRunway >= requiredRunway,
  };
}

function longestStraightRunway(runway: Set<string>): number {
  let best = 0;
  for (const key of runway) {
    const [x, y] = parseKey(key);
    if (!runway.has(tileKey(x - 1, y))) {
      let n = 1;
      while (runway.has(tileKey(x + n, y))) n++;
      best = Math.max(best, n);
    }
    if (!runway.has(tileKey(x, y - 1))) {
      let n = 1;
      while (runway.has(tileKey(x, y + n))) n++;
      best = Math.max(best, n);
    }
  }
  return best;
}

function footprintEdgeNeighbors(tx: number, ty: number, span: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < span; i++) {
    out.push([tx + i, ty - 1], [tx + i, ty + span], [tx - 1, ty + i], [tx + span, ty + i]);
  }
  return out;
}

export function normalizeHarborAllocation(
  passenger: number,
  cargo: number,
  max: number,
  prefer: 'passenger' | 'cargo',
): HarborAllocation {
  const cap = Math.max(0, Math.floor(max));
  let p = clampInt(passenger, 0, cap);
  let c = clampInt(cargo, 0, cap);
  if (p + c > cap) {
    if (prefer === 'passenger') c = cap - p;
    else p = cap - c;
  }
  return { passenger: p, cargo: c };
}

function defaultHybridAllocation(max: number): HarborAllocation {
  const passenger = Math.ceil(max / 2);
  return { passenger, cargo: max - passenger };
}

function clampAllocation(value: HarborAllocation, max: number): HarborAllocation {
  return normalizeHarborAllocation(value.passenger, value.cargo, max, 'passenger');
}

function hubKey(tx: number, ty: number): string {
  return `${tx},${ty}`;
}

function tileKey(tx: number, ty: number): string {
  return `${tx},${ty}`;
}

function parseKey(key: string): [number, number] {
  const comma = key.indexOf(',');
  return [Number(key.slice(0, comma)), Number(key.slice(comma + 1))];
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(Number.isFinite(value) ? value : 0)));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
