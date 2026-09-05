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
  MAX_SPAWNS_PER_FRAME,
  MIN_GAP_TILES,
  REROUTE_LOOKAHEAD,
  REROUTE_THRESHOLD,
  ROUTE_BUDGET_PER_FRAME,
  SPAWN_BURST_TOKENS,
  SPAWN_GATE_HEADWAY_MS,
  SPAWN_QUEUE_SPREAD_MS,
  SPAWN_RATE_PER_SEC,
  SPAWN_READY_JITTER_MAX_MS,
  SPAWN_SPREAD_MAX_MS,
  TRUCK_SPEED_MUL,
  VEHICLE_SPEED_TILES_PER_SEC,
  VEHICLE_BODY_LENGTH_TILES,
} from '../simConstants';
import { sessionDaytimeAt, type DaytimeSnapshot } from '../time';
import {
  isTurnNode,
  movementsConflict,
  nodeMovement,
  routeSegmentDir,
} from './laneGeometry';
import { canEnter, hasSignal } from './signals';
import { Router, type Route } from './router';
import { VehicleKind, type Vehicle } from './vehicles';

type ReadySpawn = { trip: Trip; route: Route; readyAtMs: number };
const enum SpawnResult { Spawned = 0, Blocked = 1, Handled = 2 }

/** 앞차를 몇 타일 앞까지 보는가. 제동거리(속도^2/2a)보다 넉넉해야 한다. */
const GAP_LOOKAHEAD_TILES = 3;
/** 한 프레임에 훑는 준비 대기열 최대 길이. 막힌 진입로 때문에 무한정 돌지 않게 한다. */
const SPAWN_SCAN_LIMIT = 64;

/** 교차로 타일 하나를 지금 쓰고 있는 움직임. */
interface MovementClaim {
  vehicle: Vehicle;
  inDir: number;
  outDir: number;
}

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
  private nextGateSpawnMs = new Map<string, number>();
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
    this.nextGateSpawnMs.clear();
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
    // 토큰 버킷. 상한이 작아야 "조용하다가 한꺼번에" 가 구조적으로 불가능하다.
    this.spawnTokens = Math.min(
      SPAWN_BURST_TOKENS,
      this.spawnTokens + (dtMs * SPAWN_RATE_PER_SEC) / 1000,
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

    this.spawnDueVehicles();

    const room = Math.max(
      0,
      MAX_ACTIVE_VEHICLES - this.vehicles.length - this.readySpawns.length,
    );
    // A*가 프레임당 5건이므로 발생 쪽도 작은 묶음만 넘긴다. 출근 시각 한 틱에
    // 수백 명이 잡혀도 scanCursor가 다음 프레임부터 이어서 처리한다.
    const tripBudget = Math.min(room, ROUTE_BUDGET_PER_FRAME);
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
      this.insertReady({ trip, route, readyAtMs: this.timeMs + jitter });
    });
  }

  /** readyAtMs 오름차순을 유지하며 넣는다. 매번 sort 하면 출근 피크에 O(n log n)이 반복된다. */
  private insertReady(entry: ReadySpawn): void {
    let lo = 0;
    let hi = this.readySpawns.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.readySpawns[mid].readyAtMs <= entry.readyAtMs) lo = mid + 1;
      else hi = mid;
    }
    this.readySpawns.splice(lo, 0, entry);
  }

  /**
   * 준비된 차량을 꺼낸다.
   *
   * 예전에는 프레임당 한 대, 그것도 전역 380~850ms 대기를 걸었다. 그러면 실제
   * 상한이 초당 1.6대라 출근 시각의 수백 건이 큐에 남아 하루 종일 한 줄로
   * 흘러나온다. 지금은 평균 속도(토큰 버킷)만 제한하고, 뭉침은 진입로별
   * 700ms 간격과 대기열 분산이 막는다.
   */
  private spawnDueVehicles(): void {
    if (this.readySpawns.length === 0) return;
    let spawned = 0;
    let scanned = 0;
    let i = 0;
    while (
      i < this.readySpawns.length &&
      spawned < MAX_SPAWNS_PER_FRAME &&
      scanned < SPAWN_SCAN_LIMIT &&
      this.spawnTokens >= 1
    ) {
      const pending = this.readySpawns[i];
      // 정렬돼 있으므로 아직 시간이 안 된 항목을 만나면 뒤도 전부 아직이다.
      if (pending.readyAtMs > this.timeMs) break;
      scanned++;
      const result = this.spawnRoute(pending.trip, pending.route);
      if (result === SpawnResult.Blocked) {
        i++;
        continue;
      }
      this.readySpawns.splice(i, 1);
      if (result === SpawnResult.Spawned) {
        this.spawnTokens -= 1;
        spawned++;
      }
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
    const gateKey = `${sx},${sy},${dir}`;
    if ((this.nextGateSpawnMs.get(gateKey) ?? 0) > this.timeMs) return SpawnResult.Blocked;
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
    const gateJitter = simHash(
      WORLD_SEED,
      trip.fromTx ^ trip.toTx,
      trip.fromTy ^ trip.toTy,
      this.spawnSequence++,
    ) % 251;
    this.nextGateSpawnMs.set(gateKey, this.timeMs + SPAWN_GATE_HEADWAY_MS + gateJitter);
    return SpawnResult.Spawned;
  }

  private spawnBlocked(tx: number, ty: number, dir: number): boolean {
    const desiredCenterGap = VEHICLE_BODY_LENGTH_TILES + DESIRED_GAP_TILES;
    const next = DIRS[dir] ?? DIRS[0];
    const nx = tx + next[0];
    const ny = ty + next[1];
    for (const vehicle of this.vehicles) {
      const [x, y] = tileAt(vehicle);
      if (!vehicleUsesDirection(vehicle, dir)) continue;
      // 차체 길이까지 포함한 중심점 간격으로 막는다. 기존에는 0.55타일만 보고
      // 새 차를 만들어 32px fallback 차량이 서로 포개질 수 있었다.
      if (x === tx && y === ty && vehicle.tileT < desiredCenterGap) return true;
      if (x === nx && y === ny && 1 + vehicle.tileT < desiredCenterGap) return true;
    }
    return false;
  }

  private moveVehicles(dt: number): void {
    const occupancy = buildLaneOccupancy(this.vehicles);
    /*
     * 교차로/코너 예약.
     *
     * 예전에는 "교차로 타일 하나에 차 한 대" 였다. 그러면 코너에서 반대 차선
     * 차까지 서로 막아 통행량이 반토막 나고, 우측통행이 화면에서 확인되지 않는
     * 원인이 되기도 했다(양쪽이 번갈아 정지하니 어느 차선인지 읽히지 않는다).
     * 지금은 타일마다 "지금 지나가는 움직임(진입방향 -> 진출방향)" 목록을 두고,
     * 궤적이 실제로 교차할 때만 막는다.
     */
    const claims = new Map<string, MovementClaim[]>();
    const claim = (key: string, entry: MovementClaim): void => {
      const list = claims.get(key);
      if (list) list.push(entry);
      else claims.set(key, [entry]);
    };
    for (const vehicle of this.vehicles) {
      const [tx, ty] = tileAt(vehicle);
      if (!isConflictNode(this.world, vehicle, vehicle.routeIdx)) continue;
      const [inDir, outDir] = nodeMovement(vehicle.route, vehicle.routeIdx);
      claim(`${tx},${ty}`, { vehicle, inDir, outDir });
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
      const nextNodeIndex = vehicle.routeIdx + 1;
      const nextHasSignal = hasSignal(this.world, nextX, nextY);
      const nextIsConflict = nextHasSignal || isTurnNode(vehicle.route, nextNodeIndex);
      let target = VEHICLE_SPEED_TILES_PER_SEC *
        (vehicle.kind === VehicleKind.Truck ? TRUCK_SPEED_MUL : 1);

      const gap = this.gapAhead(vehicle, occupancy);
      const minCenterGap = VEHICLE_BODY_LENGTH_TILES + MIN_GAP_TILES;
      const desiredCenterGap = VEHICLE_BODY_LENGTH_TILES + DESIRED_GAP_TILES;
      if (Number.isFinite(gap)) {
        const usable = Math.max(0, gap - minCenterGap);
        // 속도가 높아도 앞차를 관통하지 않도록 제동거리로 가능한 속도를 제한한다.
        target = Math.min(target, Math.sqrt(2 * DECEL_TILES_PER_SEC2 * usable));
        if (gap < desiredCenterGap) {
          target *= Math.max(
            0,
            usable / Math.max(0.001, desiredCenterGap - minCenterGap),
          );
        }
      }

      let stopAtIntersection = false;
      const nextKey = `${nextX},${nextY}`;
      const [nextInDir, nextOutDir] = nodeMovement(vehicle.route, nextNodeIndex);
      if (nextIsConflict) {
        const red = nextHasSignal && !canEnter(nextX, nextY, nextDir, this.timeMs);
        let crossed = false;
        for (const held of claims.get(nextKey) ?? []) {
          if (held.vehicle === vehicle) continue;
          if (movementsConflict(nextInDir, nextOutDir, held.inDir, held.outDir)) {
            crossed = true;
            break;
          }
        }
        stopAtIntersection = red || crossed;
        if (stopAtIntersection) target = 0;
      }

      const accel = target > vehicle.speed ? ACCEL_TILES_PER_SEC2 : DECEL_TILES_PER_SEC2;
      vehicle.speed = approach(vehicle.speed, target, accel * dt);
      let advance = vehicle.speed * dt;

      if (Number.isFinite(gap)) {
        advance = Math.min(advance, Math.max(0, gap - minCenterGap));
      }
      if (stopAtIntersection) {
        advance = Math.min(advance, Math.max(0, INTERSECTION_STOP_T - vehicle.tileT));
        if (vehicle.tileT + advance >= INTERSECTION_STOP_T - 0.001) vehicle.speed = 0;
      }

      // 첫 차량이 이번 프레임에 교차로를 건너갈 예정이면 즉시 예약한다. 같은 프레임
      // 뒤쪽 차량이 동일 교차로로 겹쳐 들어오는 것을 막는다.
      if (nextIsConflict && !stopAtIntersection && vehicle.tileT + advance >= 1) {
        claim(nextKey, { vehicle, inDir: nextInDir, outDir: nextOutDir });
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

  /**
   * 같은 차선에서 앞차까지의 중심점 간격(타일).
   *
   * 예전에는 현재 타일과 바로 다음 타일까지만 봤다. 원하는 간격(차체 0.50 +
   * 여유 0.55 = 1.05타일)에 제동거리를 더하면 2타일을 넘기므로, 신호 앞에
   * 줄이 늘어설 때 뒤차가 앞차를 파고들 수 있었다. 지금은 3타일 앞까지 본다.
   */
  private gapAhead(vehicle: Vehicle, occupancy: Map<string, Vehicle[]>): number {
    const route = vehicle.route;
    const points = route.tiles.length / 2;
    const [x, y] = tileAt(vehicle);
    let best = Infinity;

    // 같은 타일 위, 나보다 앞선 차.
    const ownDir = routeSegmentDir(route, vehicle.routeIdx);
    for (const other of occupancy.get(laneKey(x, y, ownDir)) ?? []) {
      if (other === vehicle) continue;
      const d = other.tileT - vehicle.tileT;
      if (d > 0) best = Math.min(best, d);
    }

    // 앞 타일들. 그 타일에 서 있는 차는 "그 타일로 들어온 방향" 으로 등록돼 있다.
    for (let step = 1; step <= GAP_LOOKAHEAD_TILES; step++) {
      const idx = vehicle.routeIdx + step;
      if (idx > points - 1) break;
      const tx = route.tiles[idx * 2];
      const ty = route.tiles[idx * 2 + 1];
      const inDir = routeSegmentDir(route, idx - 1);
      for (const other of occupancy.get(laneKey(tx, ty, inDir)) ?? []) {
        if (other === vehicle) continue;
        best = Math.min(best, step - vehicle.tileT + other.tileT);
      }
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

  /**
   * 준비 대기열에 넣을 때 흩는 시간.
   * 큐가 깊을수록(=같은 시각에 몰릴수록) 분산 창을 넓힌다. 출근 한 틱에 300건이
   * 잡히면 1.8초가 아니라 9초에 걸쳐 나간다.
   */
  private spawnJitterMs(trip: Trip, seq: number): number {
    const spread = Math.min(
      SPAWN_SPREAD_MAX_MS,
      SPAWN_READY_JITTER_MAX_MS + this.readySpawns.length * SPAWN_QUEUE_SPREAD_MS,
    );
    return simHash(WORLD_SEED, trip.fromTx, trip.fromTy, trip.toTx ^ trip.toTy ^ seq) %
      Math.max(1, spread);
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

function isConflictNode(world: World, vehicle: Vehicle, nodeIndex: number): boolean {
  const points = vehicle.route.tiles.length / 2;
  if (nodeIndex < 0 || nodeIndex >= points) return false;
  const x = vehicle.route.tiles[nodeIndex * 2];
  const y = vehicle.route.tiles[nodeIndex * 2 + 1];
  return hasSignal(world, x, y) || isTurnNode(vehicle.route, nodeIndex);
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
