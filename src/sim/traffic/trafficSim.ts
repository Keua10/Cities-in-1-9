import { MAX_ACTIVE_VEHICLES, SIM_RADIUS_CHUNKS, WORLD_SEED } from '../../core/constants';
import { chunkIndexOf } from '../../core/iso';
import { Build, DIRS, roadMask } from '../../world/build';
import type { World } from '../../world/world';
import type { AssignmentTable } from '../assignment';
import { simHash } from '../buildings';
import { CitizenPool, TripPurpose, type Trip } from '../citizens';
import type { CongestionMap } from '../congestion';
import type { MacroSim } from '../macro';
import { edgeNeighbors } from '../roadGraph';
import {
  ACCEL_TILES_PER_SEC2,
  DECEL_TILES_PER_SEC2,
  DESIRED_GAP_TILES,
  INTERSECTION_STOP_T,
  MAX_SPAWNS_PER_SEC,
  MIN_GAP_TILES,
  REROUTE_LOOKAHEAD,
  REROUTE_THRESHOLD,
  ROUTE_BUDGET_PER_FRAME,
  SPAWN_HEADWAY_MAX_MS,
  SPAWN_HEADWAY_MIN_MS,
  TRUCK_SPEED_MUL,
  VEHICLE_SPEED_TILES_PER_SEC,
} from '../simConstants';
import { sessionDaytimeAt, type DaytimeSnapshot } from '../time';
import { canEnter, hasSignal } from './signals';
import { Router, type Route } from './router';
import { VehicleKind, type Vehicle } from './vehicles';

type ReadySpawn = { trip: Trip; route: Route; readyAtMs: number };
const enum SpawnResult { Spawned = 0, Blocked = 1, Handled = 2 }

export class TrafficSim {
  private router: Router;
  private citizens: CitizenPool;
  private vehicles: Vehicle[] = [];
  private trips = new Map<Vehicle, Trip>();
  private byChunk = new Map<string, Vehicle[]>();
  private activeCx = 0;
  private activeCy = 0;
  private initialized = false;
  private timeMs = 0;
  private sampleMs = 0;
  private daytime: DaytimeSnapshot = sessionDaytimeAt(0, 0);
  private spawnTokens = 0;
  private readySpawns: ReadySpawn[] = [];
  private nextSpawnMs = 0;
  private spawnSequence = 0;
  private generation = 0;
  private lastMacroTick = -1;

  constructor(
    private world: World,
    private macro: MacroSim,
    private congestion: CongestionMap,
    assignment: AssignmentTable,
  ) {
    this.router = new Router(world, congestion);
    this.citizens = new CitizenPool(world, assignment);
  }

  setActiveChunk(cx: number, cy: number): void {
    if (this.initialized && cx === this.activeCx && cy === this.activeCy) return;
    for (const pending of this.readySpawns) this.citizens.onTripFailed(pending.trip);
    this.readySpawns = [];
    this.initialized = true;
    this.activeCx = cx;
    this.activeCy = cy;
    this.generation++;
    this.nextSpawnMs = this.timeMs;
    this.citizens.setActiveRegion(cx, cy, SIM_RADIUS_CHUNKS);
    this.congestion.setActiveRegion(cx, cy, SIM_RADIUS_CHUNKS);
    const kept: Vehicle[] = [];
    for (const vehicle of this.vehicles) {
      if (this.vehicleInside(vehicle)) kept.push(vehicle);
      else this.failVehicle(vehicle);
    }
    this.vehicles = kept;
    this.rebuildChunks();
  }

  update(dtMs: number): void {
    if (!this.initialized) return;
    this.timeMs += dtMs;
    this.sampleMs += dtMs;
    this.spawnTokens = Math.min(
      MAX_SPAWNS_PER_SEC,
      this.spawnTokens + (dtMs * MAX_SPAWNS_PER_SEC) / 1000,
    );

    this.router.update(ROUTE_BUDGET_PER_FRAME);
    if (this.macro.tick !== this.lastMacroTick) {
      this.lastMacroTick = this.macro.tick;
      this.congestion.decayOutside(
        this.world,
        this.activeCx,
        this.activeCy,
        SIM_RADIUS_CHUNKS,
      );
    }

    this.retryReadySpawns();

    const room = Math.max(
      0,
      MAX_ACTIVE_VEHICLES - this.vehicles.length - this.readySpawns.length,
    );
    // A*가 프레임당 5건이므로 발생 쪽도 작은 묶음만 넘긴다. 출근 시각 한 틱에
    // 수백 명이 잡혀도 scanCursor가 다음 프레임부터 이어서 처리한다.
    const tripBudget = Math.min(room, ROUTE_BUDGET_PER_FRAME * 2);
    const lifeDelta = Math.min(dtMs, 250);
    this.daytime = sessionDaytimeAt(this.timeMs, this.macro.day);
    const trips = this.citizens.collectTrips(this.daytime, lifeDelta, tripBudget);
    for (const trip of trips) this.queueTrip(trip);

    this.moveVehicles(Math.min(dtMs / 1000, 0.05));

    for (const vehicle of this.vehicles) {
      const [tx, ty] = tileAt(vehicle);
      this.congestion.sample(tx, ty);
    }
    this.congestion.finishSampleFrame();
    if (this.sampleMs >= 1000) {
      this.sampleMs %= 1000;
      this.congestion.commitSamples(this.world);
      this.router.invalidateCache();
    }

    if (this.vehicles.length > MAX_ACTIVE_VEHICLES) {
      this.vehicles.sort(
        (a, b) => dist2(b, this.activeCx, this.activeCy) - dist2(a, this.activeCx, this.activeCy),
      );
      while (this.vehicles.length > MAX_ACTIVE_VEHICLES) {
        const vehicle = this.vehicles.shift();
        if (vehicle) this.failVehicle(vehicle);
      }
    }
    this.rebuildChunks();
  }

  vehiclesInChunk(cx: number, cy: number): readonly Vehicle[] {
    return this.byChunk.get(`${cx},${cy}`) ?? EMPTY;
  }

  get activeCount(): number { return this.vehicles.length; }
  get daytimeState(): DaytimeSnapshot { return this.daytime; }
  /** 렌더러의 신호등 색과 차량 판정이 같은 시계를 보게 한다. */
  get signalTimeMs(): number { return this.timeMs; }

  private queueTrip(trip: Trip): void {
    const sourceInfo = this.world.buildingCovering(trip.fromTx, trip.fromTy);
    const start = entryRoad(this.world, trip.fromTx, trip.fromTy, sourceInfo?.span ?? 1);
    const destInfo = this.world.buildingCovering(trip.toTx, trip.toTy);
    const dest = entryRoad(this.world, trip.toTx, trip.toTy, destInfo?.span ?? 1);
    if (!start || !dest) {
      this.citizens.onTripFailed(trip);
      return;
    }
    const generation = this.generation;
    this.router.request(start[0], start[1], dest[0], dest[1], trip.tier, (route) => {
      if (generation !== this.generation) {
        this.citizens.onTripFailed(trip);
        return;
      }
      if (!route) {
        this.citizens.onTripFailed(trip);
        return;
      }
      // 경로가 계산된 프레임에 바로 튀어나오지 않는다. 같은 출퇴근 시각에 잡힌
      // 차량도 0~한 headway 만큼 흩어서 대기열에 넣는다.
      const jitter = this.spawnJitterMs(trip, this.spawnSequence++);
      this.readySpawns.push({ trip, route, readyAtMs: this.timeMs + jitter });
    });
  }

  private retryReadySpawns(): void {
    if (this.readySpawns.length === 0) return;
    if (this.timeMs < this.nextSpawnMs || this.spawnTokens < 1) return;

    // 첫 차량의 진입로가 막혔다고 도시 전체 스폰을 막지 않는다. 한 headway에
    // 최대 한 대만 꺼내되, 준비된 다른 진입로를 몇 개 훑는다.
    const checks = Math.min(this.readySpawns.length, 12);
    for (let i = 0; i < checks; i++) {
      const pending = this.readySpawns[i];
      if (pending.readyAtMs > this.timeMs) continue;
      const result = this.spawnRoute(pending.trip, pending.route);
      if (result === SpawnResult.Blocked) continue;
      this.readySpawns.splice(i, 1);
      if (result === SpawnResult.Spawned) {
        this.spawnTokens -= 1;
        this.nextSpawnMs = this.timeMs + this.spawnHeadwayMs(pending.trip, this.spawnSequence++);
      }
      return;
    }
  }

  private spawnRoute(trip: Trip, route: Route): SpawnResult {
    if (this.vehicles.length >= MAX_ACTIVE_VEHICLES) return SpawnResult.Blocked;
    let startIndex = 0;
    if (!this.tileInside(route.tiles[0], route.tiles[1])) {
      startIndex = -1;
      for (let i = 0; i < route.tiles.length; i += 2) {
        if (this.tileInside(route.tiles[i], route.tiles[i + 1])) {
          startIndex = i / 2;
          break;
        }
      }
      if (startIndex < 0) {
        this.citizens.onTripFailed(trip);
        return SpawnResult.Handled;
      }
    }

    const sx = route.tiles[startIndex * 2];
    const sy = route.tiles[startIndex * 2 + 1];
    const sliced = startIndex === 0 ? route : this.router.sliceRoute(route, startIndex);
    const dir = sliced.tiles.length >= 4
      ? dirBetween(sliced.tiles[0], sliced.tiles[1], sliced.tiles[2], sliced.tiles[3])
      : 0;
    if (this.spawnBlocked(sx, sy, dir)) return SpawnResult.Blocked;

    const kind = trip.purpose === TripPurpose.Freight ? VehicleKind.Truck : VehicleKind.Car;
    const vehicle: Vehicle = {
      kind,
      tier: trip.tier,
      purpose: trip.purpose,
      route: sliced,
      routeIdx: 0,
      tileT: 0,
      lane: 0,
      speed: 0,
      dir,
      destTx: trip.toTx,
      destTy: trip.toTy,
    };
    this.vehicles.push(vehicle);
    this.trips.set(vehicle, trip);
    return SpawnResult.Spawned;
  }

  private spawnBlocked(tx: number, ty: number, dir: number): boolean {
    for (const vehicle of this.vehicles) {
      const [x, y] = tileAt(vehicle);
      if (x !== tx || y !== ty) continue;
      if (!vehicleUsesDirection(vehicle, dir)) continue;
      // 스폰점 바로 앞을 지나가는 차가 충분히 빠져나간 뒤 생성한다.
      if (vehicle.tileT < DESIRED_GAP_TILES) return true;
    }
    return false;
  }

  private moveVehicles(dt: number): void {
    const occupancy = buildLaneOccupancy(this.vehicles);
    // 교차로 하나에는 동시에 한 차량만 진입시킨다. 신호 위상과 별개로 좌/우회전
    // 궤적 충돌을 막는 reservation 역할을 한다.
    const intersectionOwner = new Map<string, Vehicle>();
    for (const vehicle of this.vehicles) {
      const [tx, ty] = tileAt(vehicle);
      if (hasSignal(this.world, tx, ty)) intersectionOwner.set(`${tx},${ty}`, vehicle);
    }

    const remove = new Set<Vehicle>();
    for (const vehicle of this.vehicles) {
      const points = vehicle.route.tiles.length / 2;
      if (vehicle.routeIdx >= points - 1) {
        this.completeVehicle(vehicle);
        remove.add(vehicle);
        continue;
      }

      const curX = vehicle.route.tiles[vehicle.routeIdx * 2];
      const curY = vehicle.route.tiles[vehicle.routeIdx * 2 + 1];
      const nextX = vehicle.route.tiles[(vehicle.routeIdx + 1) * 2];
      const nextY = vehicle.route.tiles[(vehicle.routeIdx + 1) * 2 + 1];
      const nextDir = dirBetween(curX, curY, nextX, nextY);
      const nextIsIntersection = hasSignal(this.world, nextX, nextY);
      let target = VEHICLE_SPEED_TILES_PER_SEC *
        (vehicle.kind === VehicleKind.Truck ? TRUCK_SPEED_MUL : 1);

      const gap = this.gapAhead(vehicle, occupancy, nextX, nextY, nextDir);
      if (Number.isFinite(gap)) {
        const usable = Math.max(0, gap - MIN_GAP_TILES);
        // 속도가 높아도 앞차를 관통하지 않도록 제동거리로 가능한 속도를 제한한다.
        target = Math.min(target, Math.sqrt(2 * DECEL_TILES_PER_SEC2 * usable));
        if (gap < DESIRED_GAP_TILES) {
          target *= Math.max(0, usable / Math.max(0.001, DESIRED_GAP_TILES - MIN_GAP_TILES));
        }
      }

      let stopAtIntersection = false;
      if (nextIsIntersection) {
        const owner = intersectionOwner.get(`${nextX},${nextY}`);
        const red = !canEnter(nextX, nextY, nextDir, this.timeMs);
        stopAtIntersection = red || (owner !== undefined && owner !== vehicle);
        if (stopAtIntersection) target = 0;
      }

      const accel = target > vehicle.speed ? ACCEL_TILES_PER_SEC2 : DECEL_TILES_PER_SEC2;
      vehicle.speed = approach(vehicle.speed, target, accel * dt);
      let advance = vehicle.speed * dt;

      if (Number.isFinite(gap)) {
        advance = Math.min(advance, Math.max(0, gap - MIN_GAP_TILES));
      }
      if (stopAtIntersection) {
        advance = Math.min(advance, Math.max(0, INTERSECTION_STOP_T - vehicle.tileT));
        if (vehicle.tileT + advance >= INTERSECTION_STOP_T - 0.001) vehicle.speed = 0;
      }

      // 첫 차량이 이번 프레임에 교차로를 건너갈 예정이면 즉시 예약한다. 같은 프레임
      // 뒤쪽 차량이 동일 교차로로 겹쳐 들어오는 것을 막는다.
      if (nextIsIntersection && !stopAtIntersection && vehicle.tileT + advance >= 1) {
        intersectionOwner.set(`${nextX},${nextY}`, vehicle);
      }

      vehicle.tileT += advance;
      while (vehicle.tileT >= 1 && vehicle.routeIdx < points - 1) {
        vehicle.tileT -= 1;
        vehicle.routeIdx++;
        if (vehicle.routeIdx >= points - 1) break;
        const x = vehicle.route.tiles[vehicle.routeIdx * 2];
        const y = vehicle.route.tiles[vehicle.routeIdx * 2 + 1];
        const nx = vehicle.route.tiles[(vehicle.routeIdx + 1) * 2];
        const ny = vehicle.route.tiles[(vehicle.routeIdx + 1) * 2 + 1];
        vehicle.dir = dirBetween(x, y, nx, ny);
        if (!this.tileInside(x, y)) {
          this.completeVehicle(vehicle);
          remove.add(vehicle);
          break;
        }
      }

      // 재탐색은 교차로 중심에서 거의 정지한 시점에만 요청한다. 이동 중 경로를
      // 갈아끼워 tileT가 0으로 튀는 현상을 없앤다.
      if (
        !remove.has(vehicle) &&
        vehicle.routeIdx < points - 1 &&
        vehicle.tileT <= 0.08
      ) {
        const [x, y] = tileAt(vehicle);
        if (pop4(roadMask(this.world, x, y)) >= 3 && this.shouldReroute(vehicle)) {
          this.reroute(vehicle);
        }
      }

      if (vehicle.routeIdx >= points - 1 && !remove.has(vehicle)) {
        this.completeVehicle(vehicle);
        remove.add(vehicle);
      }
    }

    if (remove.size) this.vehicles = this.vehicles.filter((vehicle) => !remove.has(vehicle));
  }

  private gapAhead(
    vehicle: Vehicle,
    occupancy: Map<string, Vehicle[]>,
    nextX: number,
    nextY: number,
    travelDir: number,
  ): number {
    const [x, y] = tileAt(vehicle);
    let best = Infinity;
    for (const other of occupancy.get(laneKey(x, y, travelDir)) ?? []) {
      if (other === vehicle) continue;
      const d = other.tileT - vehicle.tileT;
      if (d > 0) best = Math.min(best, d);
    }
    for (const other of occupancy.get(laneKey(nextX, nextY, travelDir)) ?? []) {
      if (other === vehicle) continue;
      best = Math.min(best, 1 - vehicle.tileT + other.tileT);
    }
    return best;
  }

  private shouldReroute(vehicle: Vehicle): boolean {
    let current = 0;
    let count = 0;
    const start = vehicle.routeIdx + 1;
    for (
      let i = start;
      i < Math.min(vehicle.route.tiles.length / 2, start + REROUTE_LOOKAHEAD);
      i++
    ) {
      current += this.congestion.at(vehicle.route.tiles[i * 2], vehicle.route.tiles[i * 2 + 1]);
      count++;
    }
    const planned = this.router.plannedCongestion(vehicle.route, start, count);
    return count > 0 && current - planned >= REROUTE_THRESHOLD;
  }

  private reroute(vehicle: Vehicle): void {
    const [sx, sy] = tileAt(vehicle);
    const destInfo = this.world.buildingCovering(vehicle.destTx, vehicle.destTy);
    const dest = entryRoad(this.world, vehicle.destTx, vehicle.destTy, destInfo?.span ?? 1);
    if (!dest) return;
    const oldRoute = vehicle.route;
    const oldIdx = vehicle.routeIdx;
    this.router.request(sx, sy, dest[0], dest[1], vehicle.tier, (route) => {
      // 요청 뒤 이미 다음 타일로 진행했다면 지금 경로를 유지한다. 움직이는 차를 뒤로
      // 순간이동시키지 않는 쪽이 우회보다 우선이다.
      if (!route || vehicle.route !== oldRoute || vehicle.routeIdx !== oldIdx || vehicle.tileT > 0.12) {
        return;
      }
      vehicle.route = route;
      vehicle.routeIdx = 0;
      // 현재 교차로 중심의 진행도를 그대로 보존한다.
      if (route.tiles.length >= 4) {
        vehicle.dir = dirBetween(route.tiles[0], route.tiles[1], route.tiles[2], route.tiles[3]);
      }
    });
  }

  private spawnJitterMs(trip: Trip, seq: number): number {
    return simHash(WORLD_SEED, trip.fromTx, trip.fromTy, trip.toTx ^ trip.toTy ^ seq) %
      Math.max(1, SPAWN_HEADWAY_MAX_MS);
  }

  private spawnHeadwayMs(trip: Trip, seq: number): number {
    const span = Math.max(0, SPAWN_HEADWAY_MAX_MS - SPAWN_HEADWAY_MIN_MS);
    const jitter = simHash(WORLD_SEED, trip.fromTx, trip.toTx, trip.fromTy ^ trip.toTy ^ seq) %
      (span + 1);
    return SPAWN_HEADWAY_MIN_MS + jitter;
  }

  private completeVehicle(vehicle: Vehicle): void {
    const trip = this.trips.get(vehicle);
    if (trip) this.citizens.onTripComplete(trip);
    this.trips.delete(vehicle);
  }

  private failVehicle(vehicle: Vehicle): void {
    const trip = this.trips.get(vehicle);
    if (trip) this.citizens.onTripFailed(trip);
    this.trips.delete(vehicle);
  }

  private tileInside(tx: number, ty: number): boolean {
    const cx = chunkIndexOf(tx);
    const cy = chunkIndexOf(ty);
    return Math.abs(cx - this.activeCx) <= SIM_RADIUS_CHUNKS &&
      Math.abs(cy - this.activeCy) <= SIM_RADIUS_CHUNKS;
  }

  private vehicleInside(vehicle: Vehicle): boolean {
    const [x, y] = tileAt(vehicle);
    return this.tileInside(x, y);
  }

  private rebuildChunks(): void {
    this.byChunk.clear();
    for (const vehicle of this.vehicles) {
      const [x, y] = tileAt(vehicle);
      const key = `${chunkIndexOf(x)},${chunkIndexOf(y)}`;
      let list = this.byChunk.get(key);
      if (!list) {
        list = [];
        this.byChunk.set(key, list);
      }
      list.push(vehicle);
    }
  }
}

const EMPTY: readonly Vehicle[] = [];

function entryRoad(world: World, tx: number, ty: number, span: number): [number, number] | null {
  for (const point of edgeNeighbors(tx, ty, span)) {
    if (world.getBuild(point[0], point[1]) === Build.Road) return point;
  }
  return null;
}

function tileAt(vehicle: Vehicle): [number, number] {
  return [vehicle.route.tiles[vehicle.routeIdx * 2], vehicle.route.tiles[vehicle.routeIdx * 2 + 1]];
}

function incomingDir(vehicle: Vehicle): number {
  if (vehicle.routeIdx <= 0) return vehicle.dir;
  const i = vehicle.routeIdx * 2;
  return dirBetween(
    vehicle.route.tiles[i - 2],
    vehicle.route.tiles[i - 1],
    vehicle.route.tiles[i],
    vehicle.route.tiles[i + 1],
  );
}

function vehicleUsesDirection(vehicle: Vehicle, dir: number): boolean {
  return vehicle.dir === dir || incomingDir(vehicle) === dir;
}

function buildLaneOccupancy(vehicles: readonly Vehicle[]): Map<string, Vehicle[]> {
  const occupancy = new Map<string, Vehicle[]>();
  for (const vehicle of vehicles) {
    const [x, y] = tileAt(vehicle);
    const dirs = incomingDir(vehicle) === vehicle.dir
      ? [vehicle.dir]
      : [vehicle.dir, incomingDir(vehicle)];
    for (const dir of dirs) {
      const key = laneKey(x, y, dir);
      let list = occupancy.get(key);
      if (!list) {
        list = [];
        occupancy.set(key, list);
      }
      list.push(vehicle);
    }
  }
  for (const list of occupancy.values()) list.sort((a, b) => b.tileT - a.tileT);
  return occupancy;
}

function dirBetween(x: number, y: number, nx: number, ny: number): number {
  for (let i = 0; i < DIRS.length; i++) {
    if (x + DIRS[i][0] === nx && y + DIRS[i][1] === ny) return i;
  }
  return 0;
}

function pop4(mask: number): number {
  return (mask & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1) + ((mask >> 3) & 1);
}

function approach(value: number, target: number, delta: number): number {
  return value < target ? Math.min(target, value + delta) : Math.max(target, value - delta);
}

function dist2(vehicle: Vehicle, cx: number, cy: number): number {
  const [x, y] = tileAt(vehicle);
  const dx = chunkIndexOf(x) - cx;
  const dy = chunkIndexOf(y) - cy;
  return dx * dx + dy * dy;
}

function laneKey(tx: number, ty: number, dir: number): string {
  return `${tx},${ty},${dir}`;
}
