import {
  CHUNK_SIZE,
  MAX_ACTIVE_VEHICLES,
  SIM_RADIUS_CHUNKS,
  WORLD_SEED,
} from '../../core/constants';
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
  AGGRESSIVE_DRIVER_PERCENT,
  AGGRESSIVE_EXIT_ROOM_TILES,
  DECEL_TILES_PER_SEC2,
  DESIRED_GAP_TILES,
  EXIT_BLOCK_SPEED,
  EXIT_ROOM_TILES,
  FOLLOW_LATERAL_TILES,
  FOLLOW_LOOKAHEAD_TILES,
  FREEZE_BACKOFF_TILES,
  FREEZE_BREAK_MS,
  INTERSECTION_STOP_T,
  JUNCTION_MARGIN_TILES,
  LEFT_YIELD_LOOKAHEAD_TILES,
  MAX_SPAWNS_PER_FRAME,
  MERGE_CLEAR_TILES,
  MIN_GAP_TILES,
  REROUTE_LOOKAHEAD,
  REROUTE_THRESHOLD,
  RESERVATION_ABANDON_MS,
  ROUTE_BUDGET_PER_FRAME,
  SPAWN_BURST_TOKENS,
  SPAWN_GATE_HEADWAY_MS,
  SPAWN_QUEUE_SPREAD_MS,
  SPAWN_RATE_PER_SEC,
  SPAWN_READY_JITTER_MAX_MS,
  SPAWN_SPREAD_MAX_MS,
  STUCK_GIVEUP_MS,
  TRUCK_SPEED_MUL,
  VEHICLE_BODY_LENGTH_TILES,
  VEHICLE_SPEED_TILES_PER_SEC,
} from '../simConstants';
import { sessionDaytimeAt, type DaytimeSnapshot } from '../time';
import { bodiesOverlap, SpatialGrid, type Body } from './collision';
import {
  buildJunctionPath,
  IntersectionControl,
  type Approach,
  type JunctionPath,
} from './intersectionControl';
import { JunctionIndex } from './junctions';
import { dirBetween, isTurnNode, laneHeading, lanePosition, routeSegmentDir } from './laneGeometry';
import { Router, type Route } from './router';
import { SignalState, signalState } from './signals';
import { VehicleKind, type Vehicle } from './vehicles';

type ReadySpawn = { trip: Trip; route: Route; readyAtMs: number };
const enum SpawnResult {
  Spawned = 0,
  Blocked = 1,
  Handled = 2,
}

/** 앞차를 몇 타일 앞까지 보는가. 제동거리(속도^2/2a)보다 넉넉해야 한다. */
const GAP_LOOKAHEAD_TILES = 3;
/** 한 프레임에 훑는 준비 대기열 최대 길이. 막힌 진입로 때문에 무한정 돌지 않게 한다. */
const SPAWN_SCAN_LIMIT = 64;
/** 겹침 해소 반복 횟수. 마지막 회차는 양쪽을 모두 되돌린다. */
const OVERLAP_PASSES = 3;

/** 한 프레임 동안의 차량 상태. 이동 계산은 전부 이 배열 위에서 한다. */
interface Frame {
  vehicle: Vehicle;
  /** 프레임 시작 시점의 차선 위치/방향. 겹침 해소는 여기로 되돌린다. */
  x: number;
  y: number;
  hx: number;
  hy: number;
  advance: number;
  /** 이번 프레임에 갈 예정인 위치. */
  px: number;
  py: number;
  phx: number;
  phy: number;
  nextIdx: number;
  nextT: number;
  /** 겹침 때문에 이번 프레임 이동을 취소했는가. */
  frozen: boolean;
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

  private junctionIndex = new JunctionIndex();
  private control = new IntersectionControl();
  private junctionsBuiltFor = '';
  private junctionRoadStamp = -1;
  private grid = new SpatialGrid();
  private overlapGrid = new SpatialGrid();
  private frames: Frame[] = [];

  constructor(
    private world: World,
    private macro: MacroSim,
    private congestion: CongestionMap,
    assignment: AssignmentTable,
  ) {
    this.router = new Router(world, congestion);
    this.citizens = new CitizenPool(world, assignment);
    this.router.setJunctions(this.junctionIndex);
    this.congestion.setJunctions(this.junctionIndex);
  }

  /** 렌더러가 신호등을 그릴 때 쓰는 교차로 색인. */
  get junctions(): JunctionIndex {
    return this.junctionIndex;
  }

  /** 개발용 진단(tools/check). 게임 코드에서는 쓰지 않는다. */
  debugJunctions(): Array<[number, number, number]> {
    return this.control.debugOccupancy(this.timeMs);
  }

  /** 개발용 진단. 이 차량이 교차로 통행권을 쥐고 있는가. */
  debugHasRight(vehicle: Vehicle): boolean {
    return this.control.hasReservation(vehicle);
  }

  debugGrantSignal(vehicle: Vehicle): SignalState | null {
    return this.control.grantSignalOf(vehicle);
  }

  /** 개발용 진단. 이 차량이 지금 무엇 때문에 서 있는가. */
  debugWhy(vehicle: Vehicle): string {
    const i = this.frames.findIndex((f) => f.vehicle === vehicle);
    if (i < 0) return 'no-frame';
    const path = this.junctionPathFor(vehicle);
    const right = this.control.hasReservation(vehicle);
    const hold = this.holdProgress(vehicle, i);
    const near = this.nearestAhead(this.frames, i);
    const progress = vehicle.routeIdx + vehicle.tileT;
    if (!path) return `noJunction hold=${hold} near=${near.toFixed(2)}`;
    const j = this.junctionIndex.byId(path.junctionId)!;
    const st = signalState(j, path.enterDir, this.timeMs);
    const dist = path.entryIndex - 1 + INTERSECTION_STOP_T - progress;
    const free = this.exitFreeDistance(this.frames, i, path);
    return (
      `j=${path.junctionId} sig=${j.signalized ? st : 'none'} turn=${path.turn} ` +
      `dist=${dist.toFixed(2)} right=${right} exitFree=${free.toFixed(2)} ` +
      `near=${near.toFixed(2)} occ=${this.control.occupantCount(path.junctionId)} ` +
      `hold=${hold === null ? '-' : (hold - progress).toFixed(2)} ` +
      `entry=${path.entryIndex} idx=${vehicle.routeIdx} frozen=${this.frames[i].frozen}`
    );
  }

  setActiveChunk(cx: number, cy: number): void {
    if (this.initialized && cx === this.activeCx && cy === this.activeCy) {
      this.refreshJunctions();
      return;
    }
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
      else this.dropVehicle(vehicle);
    }
    this.vehicles = kept;
    this.refreshJunctions(true);
    this.rebuildChunks();
  }

  /**
   * 교차로 색인을 최신으로 유지한다.
   *
   * 도로를 놓거나 지울 때마다 다시 만들면 드래그 건설 한 번에 수백 번 돈다.
   * 그래서 활성 영역이 바뀌거나 영역 안 도로 타일 수가 바뀌었을 때만 다시 만든다.
   */
  private refreshJunctions(force = false): void {
    const key = `${this.activeCx},${this.activeCy}`;
    let stamp = 0;
    for (let dy = -SIM_RADIUS_CHUNKS; dy <= SIM_RADIUS_CHUNKS; dy++) {
      for (let dx = -SIM_RADIUS_CHUNKS; dx <= SIM_RADIUS_CHUNKS; dx++) {
        const parcel = this.world.peekParcel(this.activeCx + dx, this.activeCy + dy);
        stamp = (stamp * 31 + (parcel?.roadCount ?? 0)) | 0;
      }
    }
    if (!force && key === this.junctionsBuiltFor && stamp === this.junctionRoadStamp) return;
    this.junctionsBuiltFor = key;
    this.junctionRoadStamp = stamp;

    const half = (SIM_RADIUS_CHUNKS + 0.5) * CHUNK_SIZE;
    const centerX = this.activeCx * CHUNK_SIZE + CHUNK_SIZE / 2;
    const centerY = this.activeCy * CHUNK_SIZE + CHUNK_SIZE / 2;
    const margin = half + JUNCTION_MARGIN_TILES;
    this.junctionIndex.build(
      this.world,
      Math.floor(centerX - margin),
      Math.floor(centerY - margin),
      Math.ceil(centerX + margin),
      Math.ceil(centerY + margin),
    );
    // 교차로가 바뀌면 통행권과 경로 캐시를 전부 버린다. 남겨두면 사라진 교차로의
    // 예약을 영원히 쥔 차가 생긴다.
    this.control.reset();
    this.router.invalidateCache();
    for (const vehicle of this.vehicles) {
      vehicle.jPath = null;
      vehicle.jPathRoute = null;
      vehicle.jPathRev = -1;
    }
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
      this.congestion.decayOutside(this.world, this.activeCx, this.activeCy, SIM_RADIUS_CHUNKS);
    }

    this.spawnDueVehicles();

    const room = Math.max(0, MAX_ACTIVE_VEHICLES - this.vehicles.length - this.readySpawns.length);
    // A*가 프레임당 5건이므로 발생 쪽도 작은 묶음만 넘긴다. 출근 시각 한 틱에
    // 수백 명이 잡혀도 scanCursor가 다음 프레임부터 이어서 처리한다.
    const tripBudget = Math.min(room, ROUTE_BUDGET_PER_FRAME);
    const lifeDelta = Math.min(dtMs, 250);
    this.daytime = sessionDaytimeAt(this.timeMs, this.macro.day);
    const trips = this.citizens.collectTrips(this.daytime, lifeDelta, tripBudget);
    for (const trip of trips) this.queueTrip(trip);

    this.moveVehicles(Math.min(dtMs / 1000, 0.05), Math.min(dtMs, 50));

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
        if (vehicle) this.dropVehicle(vehicle);
      }
    }
    this.rebuildChunks();
  }

  vehiclesInChunk(cx: number, cy: number): readonly Vehicle[] {
    return this.byChunk.get(`${cx},${cy}`) ?? EMPTY;
  }

  get activeCount(): number {
    return this.vehicles.length;
  }
  get daytimeState(): DaytimeSnapshot {
    return this.daytime;
  }
  /** 렌더러의 신호등 색과 차량 판정이 같은 시계를 보게 한다. */
  get signalTimeMs(): number {
    return this.timeMs;
  }

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
    const dir =
      sliced.tiles.length >= 4
        ? dirBetween(sliced.tiles[0], sliced.tiles[1], sliced.tiles[2], sliced.tiles[3])
        : 0;
    const gateKey = `${sx},${sy},${dir}`;
    if ((this.nextGateSpawnMs.get(gateKey) ?? 0) > this.timeMs) return SpawnResult.Blocked;
    if (this.spawnBlocked(sliced)) return SpawnResult.Blocked;

    const kind = trip.purpose === TripPurpose.Freight ? VehicleKind.Truck : VehicleKind.Car;
    const aggressive =
      simHash(WORLD_SEED, trip.fromTx ^ trip.toTy, trip.fromTy ^ trip.toTx, 0x9e37) % 100 <
      AGGRESSIVE_DRIVER_PERCENT;
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
      aggressive,
      waitMs: 0,
      stoppedMs: 0,
      stuckMs: 0,
      frozenMs: 0,
      jPath: null,
      jPathRoute: null,
      jPathRev: -1,
    };
    this.vehicles.push(vehicle);
    this.trips.set(vehicle, trip);
    const gateJitter =
      simHash(WORLD_SEED, trip.fromTx ^ trip.toTx, trip.fromTy ^ trip.toTy, this.spawnSequence++) %
      251;
    this.nextGateSpawnMs.set(gateKey, this.timeMs + SPAWN_GATE_HEADWAY_MS + gateJitter);
    return SpawnResult.Spawned;
  }

  /**
   * 새 차를 놓을 자리가 비어 있는가.
   *
   * 예전에는 타일 번호와 tileT 만 비교했다. 그래서 차선이 다른데도 막히거나,
   * 반대로 다른 타일에 있는 차와 차체가 겹치는 자리에 차가 생겼다.
   * 지금은 실제 차선 좌표에서 차체 사각형이 겹치는지, 그리고 앞뒤로 한 대분
   * 여유가 있는지를 본다.
   */
  private spawnBlocked(route: Route): boolean {
    const [x, y] = lanePosition(route, 0, 0);
    const [hx, hy] = laneHeading(route, 0, 0);
    const body: Body = { x, y, hx, hy };
    const clearance = VEHICLE_BODY_LENGTH_TILES + DESIRED_GAP_TILES;
    for (const other of this.vehicles) {
      const [ox, oy] = lanePosition(other.route, other.routeIdx, other.tileT);
      const dx = ox - x;
      const dy = oy - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > clearance * clearance) continue;
      const along = dx * hx + dy * hy;
      const lateral = Math.abs(-dx * hy + dy * hx);
      // 같은 차선 앞뒤로 한 대분 여유가 없으면 막는다.
      if (lateral < FOLLOW_LATERAL_TILES && Math.abs(along) < clearance) return true;
      const [ohx, ohy] = laneHeading(other.route, other.routeIdx, other.tileT);
      if (bodiesOverlap(body, { x: ox, y: oy, hx: ohx, hy: ohy })) return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- *
   * 이동
   * ---------------------------------------------------------------- */

  private moveVehicles(dt: number, dtMs: number): void {
    this.refreshJunctions();

    const frames = this.frames;
    frames.length = 0;
    for (const vehicle of this.vehicles) {
      const [x, y] = lanePosition(vehicle.route, vehicle.routeIdx, vehicle.tileT);
      const [hx, hy] = laneHeading(vehicle.route, vehicle.routeIdx, vehicle.tileT);
      frames.push({
        vehicle,
        x,
        y,
        hx,
        hy,
        advance: 0,
        px: x,
        py: y,
        phx: hx,
        phy: hy,
        nextIdx: vehicle.routeIdx,
        nextT: vehicle.tileT,
        frozen: false,
      });
    }

    this.grid.clear();
    for (let i = 0; i < frames.length; i++) this.grid.insert(i, frames[i].x, frames[i].y);

    const occupancy = buildLaneOccupancy(this.vehicles);
    this.updateJunctionRights(frames, dtMs);

    // 1) 목표 속도와 이동량.
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const vehicle = f.vehicle;
      const points = vehicle.route.tiles.length / 2;
      let target =
        VEHICLE_SPEED_TILES_PER_SEC * (vehicle.kind === VehicleKind.Truck ? TRUCK_SPEED_MUL : 1);

      const minCenterGap = VEHICLE_BODY_LENGTH_TILES + MIN_GAP_TILES;
      const desiredCenterGap = VEHICLE_BODY_LENGTH_TILES + DESIRED_GAP_TILES;

      // (a) 같은 차선 앞차 — 경로를 따라 정확히 잰다.
      const gap = this.gapAhead(vehicle, occupancy);
      // (b) 차선이 달라도 실제로 앞을 막고 있는 차 — 합류/차선변경/교차로 잔류 차량.
      const near = this.nearestAhead(frames, i);
      const limit = Math.min(gap, near);
      if (Number.isFinite(limit)) {
        const usable = Math.max(0, limit - minCenterGap);
        target = Math.min(target, Math.sqrt(2 * DECEL_TILES_PER_SEC2 * usable));
        if (limit < desiredCenterGap) {
          target *= Math.max(0, usable / Math.max(0.001, desiredCenterGap - minCenterGap));
        }
      }

      // (c) 교차로 정지선 / 합류 대기.
      //
      // 정지선은 "여기서 target = 0" 이 아니라 **제동거리**로 다룬다. 0 으로
      // 두면 교차로가 경로 저 끝에 있어도 목표속도가 0이 되어 차가 출발조차
      // 하지 못한다(실제로 그렇게 멈춰 있었다). 남은 거리로 낼 수 있는 최대
      // 속도를 씌우면 멀리서는 제한이 없고 가까워질수록 자연스럽게 선다.
      const hold = this.holdProgress(vehicle, i);
      let room = Infinity;
      if (hold !== null) {
        room = Math.max(0, hold - (vehicle.routeIdx + vehicle.tileT));
        target = Math.min(target, Math.sqrt(2 * DECEL_TILES_PER_SEC2 * room));
      }

      const accel = target > vehicle.speed ? ACCEL_TILES_PER_SEC2 : DECEL_TILES_PER_SEC2;
      vehicle.speed = approach(vehicle.speed, target, accel * dt);
      let advance = vehicle.speed * dt;
      if (Number.isFinite(limit)) {
        advance = Math.min(advance, Math.max(0, limit - minCenterGap));
      }
      if (Number.isFinite(room)) {
        advance = Math.min(advance, room);
        if (room <= 0.001) vehicle.speed = 0;
      }
      if (vehicle.routeIdx >= points - 1) advance = 0;
      f.advance = Math.max(0, advance);
    }

    // 2) 이동 결과를 미리 계산한다(아직 반영하지 않는다).
    for (const f of frames) this.project(f);

    // 3) 겹침 해소. 프레임 시작 상태는 겹치지 않는다는 것이 불변식이므로,
    //    겹치는 쪽을 그 자리로 되돌리면 반드시 풀린다.
    this.resolveOverlaps(frames);

    // 4) 반영.
    const remove = new Set<Vehicle>();
    for (const f of frames) {
      const vehicle = f.vehicle;
      const points = vehicle.route.tiles.length / 2;
      if (f.frozen) {
        vehicle.speed = 0;
        vehicle.frozenMs += dtMs;
        // 서로를 세운 두 대를 푸는 마지막 장치. 한쪽이 조금 물러나면 풀린다.
        if (vehicle.frozenMs > FREEZE_BREAK_MS) {
          const back = Math.max(0, vehicle.routeIdx + vehicle.tileT - FREEZE_BACKOFF_TILES);
          vehicle.routeIdx = Math.floor(back);
          vehicle.tileT = back - vehicle.routeIdx;
          const reserved = this.control.reservationOf(vehicle);
          if (reserved && vehicle.routeIdx < reserved.entryIndex) this.control.release(vehicle);
        }
      } else {
        vehicle.frozenMs = 0;
        vehicle.routeIdx = f.nextIdx;
        vehicle.tileT = f.nextT;
      }

      if (f.advance <= 1e-4 || f.frozen) {
        vehicle.stoppedMs += dtMs;
        vehicle.stuckMs += dtMs;
      } else {
        vehicle.stoppedMs = 0;
        vehicle.stuckMs = 0;
      }

      if (vehicle.routeIdx < points - 1) {
        const x = vehicle.route.tiles[vehicle.routeIdx * 2];
        const y = vehicle.route.tiles[vehicle.routeIdx * 2 + 1];
        const nx = vehicle.route.tiles[(vehicle.routeIdx + 1) * 2];
        const ny = vehicle.route.tiles[(vehicle.routeIdx + 1) * 2 + 1];
        vehicle.dir = dirBetween(x, y, nx, ny);
        if (!this.tileInside(x, y)) {
          this.completeVehicle(vehicle);
          remove.add(vehicle);
          continue;
        }
      } else {
        this.completeVehicle(vehicle);
        remove.add(vehicle);
        continue;
      }

      // 영구 교착 안전밸브. 정상 주행에서는 절대 걸리지 않는 길이다.
      if (vehicle.stuckMs > STUCK_GIVEUP_MS) {
        this.dropVehicle(vehicle);
        remove.add(vehicle);
        continue;
      }

      // 재탐색은 교차로 중심에서 거의 정지한 시점에만 요청한다. 이동 중 경로를
      // 갈아끼워 tileT가 0으로 튀는 현상을 없앤다. 통행권을 쥐고 있는 동안에는
      // 경로를 바꾸지 않는다 — 예약한 궤적과 실제 궤적이 달라지면 겹친다.
      if (
        vehicle.tileT <= 0.08 &&
        !this.control.hasReservation(vehicle) &&
        this.atRoadFork(vehicle) &&
        this.shouldReroute(vehicle)
      ) {
        this.reroute(vehicle);
      }
    }

    if (remove.size) {
      for (const vehicle of remove) this.control.release(vehicle);
      this.vehicles = this.vehicles.filter((vehicle) => !remove.has(vehicle));
    }
  }

  /** 이동량을 반영했을 때의 경로 인덱스/진행도를 계산한다. 상태는 건드리지 않는다. */
  private project(f: Frame): void {
    const vehicle = f.vehicle;
    const points = vehicle.route.tiles.length / 2;
    let idx = vehicle.routeIdx;
    let t = vehicle.tileT + f.advance;
    while (t >= 1 && idx < points - 1) {
      t -= 1;
      idx++;
    }
    if (idx >= points - 1) t = Math.min(t, 0);
    f.nextIdx = idx;
    f.nextT = t;
    const [x, y] = lanePosition(vehicle.route, idx, t);
    const [hx, hy] = laneHeading(vehicle.route, idx, t);
    f.px = x;
    f.py = y;
    f.phx = hx;
    f.phy = hy;
  }

  /**
   * 겹침 해소.
   *
   * 이 함수가 "차가 차를 뚫고 지나가는" 모든 경우의 마지막 방어선이다.
   * 교차로 예약과 앞차 간격이 정상이면 여기서 할 일이 없지만, 꼬리물기로
   * 교차로에 갇힌 차, 차선 변경, 재탐색 직후처럼 예외 상황에서도 화면에
   * 두 차가 포개지는 일은 없어야 한다.
   *
   * 프레임 시작 상태(x, y)는 겹치지 않는다는 것이 불변식이다. 겹친 쪽을 시작
   * 상태로 되돌리면 그 쌍은 반드시 풀리고, 마지막 회차에 양쪽을 되돌리므로
   * 종료도 보장된다.
   */
  private resolveOverlaps(frames: Frame[]): void {
    if (frames.length < 2) return;
    this.repairPenetration(frames);
    const grid = this.overlapGrid;
    for (let pass = 0; pass < OVERLAP_PASSES; pass++) {
      grid.clear();
      for (let i = 0; i < frames.length; i++) grid.insert(i, frames[i].px, frames[i].py);

      let fixed = 0;
      const last = pass === OVERLAP_PASSES - 1;
      for (let i = 0; i < frames.length; i++) {
        const a = frames[i];
        if (a.advance <= 0) continue;
        const bodyA: Body = { x: a.px, y: a.py, hx: a.phx, hy: a.phy };
        let hit = -1;
        grid.forEachNear(a.px, a.py, (j) => {
          if (hit >= 0 || j === i) return;
          const b = frames[j];
          if (bodiesOverlap(bodyA, { x: b.px, y: b.py, hx: b.phx, hy: b.phy })) hit = j;
        });
        if (hit < 0) continue;

        const b = frames[hit];
        // 뒤따르는 쪽을 되돌린다. 앞뒤를 가릴 수 없는 마지막 회차에는 둘 다 세운다.
        const rel = (b.px - a.px) * a.phx + (b.py - a.py) * a.phy;
        if (rel >= 0 || last || b.advance <= 0) {
          this.freeze(a);
          fixed++;
        }
        if (last && b.advance > 0) {
          this.freeze(b);
          fixed++;
        }
      }
      if (fixed === 0) break;
    }
  }

  /**
   * 이미 겹쳐 있는 상태를 푼다.
   *
   * "프레임 시작 상태는 겹치지 않는다" 는 불변식이 깨지면 겹침 해소가 두 차를
   * 영원히 세워 놓는다(되돌릴 자리 자체가 겹친 자리라서). 실제로 경로 재탐색이
   * 차를 반대 차선으로 옮겨 그런 상태를 만들었고, 원인은 고쳤지만 안전망은
   * 남겨 둔다. 뒤쪽 차를 경로를 따라 조금씩 물려 겹침을 푼다.
   */
  private repairPenetration(frames: Frame[]): void {
    const grid = this.overlapGrid;
    grid.clear();
    for (let i = 0; i < frames.length; i++) grid.insert(i, frames[i].x, frames[i].y);

    for (let i = 0; i < frames.length; i++) {
      const a = frames[i];
      let hit = -1;
      grid.forEachNear(a.x, a.y, (j) => {
        if (hit >= 0 || j <= i) return;
        const b = frames[j];
        if (bodiesOverlap(a, b)) hit = j;
      });
      if (hit < 0) continue;

      const b = frames[hit];
      // 뒤에 있는 쪽을 물린다.
      const behind = (b.x - a.x) * a.hx + (b.y - a.y) * a.hy >= 0 ? b : a;
      for (let step = 0; step < 8; step++) {
        const progress = behind.vehicle.routeIdx + behind.vehicle.tileT - 0.06;
        if (progress <= 0) break;
        behind.vehicle.routeIdx = Math.floor(progress);
        behind.vehicle.tileT = progress - behind.vehicle.routeIdx;
        const [nx, ny] = lanePosition(
          behind.vehicle.route,
          behind.vehicle.routeIdx,
          behind.vehicle.tileT,
        );
        const [nhx, nhy] = laneHeading(
          behind.vehicle.route,
          behind.vehicle.routeIdx,
          behind.vehicle.tileT,
        );
        behind.x = nx;
        behind.y = ny;
        behind.hx = nhx;
        behind.hy = nhy;
        if (!bodiesOverlap(a, b)) break;
      }
      behind.vehicle.speed = 0;
      this.freeze(behind);
    }
  }

  private freeze(f: Frame): void {
    f.advance = 0;
    f.frozen = true;
    f.nextIdx = f.vehicle.routeIdx;
    f.nextT = f.vehicle.tileT;
    f.px = f.x;
    f.py = f.y;
    f.phx = f.hx;
    f.phy = f.hy;
  }

  /* ---------------------------------------------------------------- *
   * 교차로 통행권
   * ---------------------------------------------------------------- */

  private updateJunctionRights(frames: readonly Frame[], dtMs: number): void {
    const approaches: Approach[] = [];
    for (let i = 0; i < frames.length; i++) {
      const vehicle = frames[i].vehicle;

      const held = this.control.reservationOf(vehicle);
      if (held) {
        if (vehicle.routeIdx > held.exitIndex) {
          // 교차로를 다 빠져나갔다.
          this.control.release(vehicle);
          vehicle.waitMs = 0;
        } else if (
          // 아직 정지선을 넘지 않았을 때만 반납한다. 이미 정지선을 넘은 차의
          // 통행권을 뺏으면, 그 차는 통행권도 없이 적신호에 교차로로 들어가는
          // 상태가 된다(정지선 뒤가 아니라 앞에 있으므로 잡을 수도 없다).
          vehicle.routeIdx + vehicle.tileT <= held.entryIndex - 1 + INTERSECTION_STOP_T + 1e-3 &&
          vehicle.stoppedMs > RESERVATION_ABANDON_MS
        ) {
          // 통행권만 받아 쥔 채 정지선 앞에서 못 움직이고 있다. 반납해야
          // 다른 방향이 그 교차로를 쓸 수 있다. 이걸 빼먹으면 도시가 멈춘다.
          this.control.release(vehicle);
        } else {
          continue;
        }
      }

      const path = this.junctionPathFor(vehicle);
      if (!path) {
        vehicle.waitMs = 0;
        continue;
      }
      const distance =
        path.entryIndex - 1 + INTERSECTION_STOP_T - (vehicle.routeIdx + vehicle.tileT);
      if (distance > LEFT_YIELD_LOOKAHEAD_TILES) {
        vehicle.waitMs = 0;
        continue;
      }
      if (distance <= 0.02) vehicle.waitMs += dtMs;
      approaches.push({
        vehicle,
        path,
        distance,
        speed: vehicle.speed,
        exitFree: this.exitFreeDistance(frames, i, path),
        clearAhead: this.nearestAhead(frames, i),
      });
    }
    this.control.arbitrate(this.timeMs, approaches, this.junctionIndex);
  }

  /** 이 차량이 다음에 통과할 교차로 구간. 경로나 교차로 색인이 바뀌면 다시 만든다. */
  private junctionPathFor(vehicle: Vehicle): JunctionPath | null {
    const stale =
      vehicle.jPathRoute !== vehicle.route ||
      vehicle.jPathRev !== this.junctionIndex.revision ||
      (vehicle.jPath !== null && vehicle.routeIdx > vehicle.jPath.exitIndex);
    if (stale) {
      vehicle.jPath = buildJunctionPath(vehicle.route, vehicle.routeIdx, this.junctionIndex);
      vehicle.jPathRoute = vehicle.route;
      vehicle.jPathRev = this.junctionIndex.revision;
    }
    return vehicle.jPath;
  }

  /**
   * 교차로를 빠져나간 자리가 얼마나 비어 있는가(타일).
   *
   * 출구 바로 앞에 서 있는 차가 있으면, 지금 들어가면 교차로 안에 갇힌다.
   * 법대로라면 들어가지 않는 것이 맞다 — 난폭운전 차량만 이 값이 작아도
   * 밀고 들어간다(intersectionControl.exitHasRoom).
   */
  private exitFreeDistance(
    frames: readonly Frame[],
    selfIndex: number,
    path: JunctionPath,
  ): number {
    const vehicle = frames[selfIndex].vehicle;
    const points = vehicle.route.tiles.length / 2;
    if (path.exitIndex + 1 > points - 1) return Infinity; // 교차로를 나가면 곧 목적지다
    const [ex, ey] = lanePosition(vehicle.route, path.exitIndex, 1);
    const dir = DIRS[path.leaveDir] ?? DIRS[0];
    let free = Infinity;
    this.grid.forEachWithin(ex, ey, EXIT_ROOM_TILES + 2, (j) => {
      if (j === selfIndex) return;
      const other = frames[j];
      // 빠르게 지나가는 차는 곧 비켜 준다. 서 있는 차만 자리를 막는다.
      if (other.vehicle.speed > EXIT_BLOCK_SPEED) return;
      const dx = other.x - ex;
      const dy = other.y - ey;
      const along = dx * dir[0] + dy * dir[1];
      const lateral = Math.abs(-dx * dir[1] + dy * dir[0]);
      if (lateral >= FOLLOW_LATERAL_TILES) return;
      if (along < -0.35) return;
      if (along < free) free = along;
    });
    return free;
  }

  /**
   * 이 차량이 넘어가면 안 되는 진행도. null 이면 제한 없음.
   *
   *  - 교차로: 통행권을 받기 전에는 정지선을 넘지 않는다.
   *  - 합류/차선변경: 목표 차선이 비어야 넘어간다.
   */
  private holdProgress(vehicle: Vehicle, frameIndex: number): number | null {
    const progress = vehicle.routeIdx + vehicle.tileT;
    let hold = Infinity;

    const reserved = this.control.reservationOf(vehicle);
    if (!reserved) {
      // (1) 통행권을 받지 못한 교차로의 정지선.
      const path = this.junctionPathFor(vehicle);
      if (path) {
        const stop = path.entryIndex - 1 + INTERSECTION_STOP_T;
        // 이미 정지선을 넘어선 차(교차로 색인이 다시 만들어져 통행권을 잃은
        // 경우)는 잡지 않는다. 잡으면 교차로 한가운데서 영원히 멈춘다.
        if (progress <= stop + 1e-3) hold = Math.min(hold, stop);
      }
    } else if (vehicle.routeIdx < reserved.entryIndex) {
      // (1') 통행권이 있어도 **정지선을 넘는 순간**에 출구가 비어 있어야 한다.
      //
      // 진입 허가를 받을 때 한 번만 확인하면, 허가와 진입 사이에 앞 대기열이
      // 늘어나 그대로 교차로 안에 갇힌다. 그렇게 갇힌 차 몇 대가 서로의 교차로를
      // 막으면 도시 전체가 영원히 멈춘다(실제로 그렇게 됐다). 매 프레임 다시
      // 확인하면 그런 고리가 아예 만들어지지 않는다.
      const need = vehicle.aggressive ? AGGRESSIVE_EXIT_ROOM_TILES : EXIT_ROOM_TILES;
      if (this.exitFreeDistance(this.frames, frameIndex, reserved) < need) {
        const stop = reserved.entryIndex - 1 + INTERSECTION_STOP_T;
        if (progress <= stop + 1e-3) hold = Math.min(hold, stop);
      }
    }

    // (2) 교차로가 아닌 곳에서의 방향 전환 = 차선 변경(넓은 도로) 또는 단순 코너.
    //     목표 차선이 비어야 넘어간다. 여기서 안 막으면 옆 차선 차와 겹친다.
    const nextIdx = vehicle.routeIdx + 1;
    const points = vehicle.route.tiles.length / 2;
    if (
      nextIdx < points &&
      isTurnNode(vehicle.route, nextIdx) &&
      this.junctionIndex.idAt(
        vehicle.route.tiles[nextIdx * 2],
        vehicle.route.tiles[nextIdx * 2 + 1],
      ) < 0 &&
      !this.mergeClear(vehicle, nextIdx)
    ) {
      hold = Math.min(hold, vehicle.routeIdx + INTERSECTION_STOP_T);
    }

    return Number.isFinite(hold) ? hold : null;
  }

  /** 차선 변경 목표 지점이 비어 있는가. */
  private mergeClear(vehicle: Vehicle, nodeIndex: number): boolean {
    const [mx, my] = lanePosition(vehicle.route, nodeIndex, 0.15);
    const [sx, sy] = lanePosition(vehicle.route, vehicle.routeIdx, vehicle.tileT);
    let clear = true;
    this.grid.forEachWithin(mx, my, MERGE_CLEAR_TILES + 1, (j) => {
      if (!clear) return;
      const other = this.frames[j];
      if (!other || other.vehicle === vehicle) return;
      const dx = other.x - mx;
      const dy = other.y - my;
      if (dx * dx + dy * dy > MERGE_CLEAR_TILES * MERGE_CLEAR_TILES) return;
      // 내 뒤쪽에 있는 차는 상관없다.
      const bx = other.x - sx;
      const by = other.y - sy;
      if (bx * (mx - sx) + by * (my - sy) < 0) return;
      clear = false;
    });
    return clear;
  }

  /* ---------------------------------------------------------------- *
   * 간격
   * ---------------------------------------------------------------- */

  /**
   * 같은 차선에서 앞차까지의 중심점 간격(타일).
   * 경로를 따라가므로 코너에서도 정확하다.
   */
  private gapAhead(vehicle: Vehicle, occupancy: Map<string, Vehicle[]>): number {
    const route = vehicle.route;
    const points = route.tiles.length / 2;
    const [x, y] = tileAt(vehicle);
    let best = Infinity;

    const ownDir = routeSegmentDir(route, vehicle.routeIdx);
    for (const other of occupancy.get(laneKey(x, y, ownDir)) ?? []) {
      if (other === vehicle) continue;
      const d = other.tileT - vehicle.tileT;
      if (d > 0) best = Math.min(best, d);
    }

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

  /**
   * 차선 소속과 무관하게 "실제로 내 앞을 막고 있는 차" 까지의 거리.
   *
   * gapAhead 는 같은 경로 차선만 본다. 그래서 옆 차선에서 끼어드는 차,
   * 교차로에 갇혀 있는 차, 합류 지점에서 만나는 차를 놓친다. 그 셋이 예전에
   * 차가 차를 뚫고 지나가는 것처럼 보이던 원인이다.
   */
  private nearestAhead(frames: readonly Frame[], selfIndex: number): number {
    const a = frames[selfIndex];
    let best = Infinity;
    this.grid.forEachWithin(a.x, a.y, FOLLOW_LOOKAHEAD_TILES, (j) => {
      if (j === selfIndex) return;
      const b = frames[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const along = dx * a.hx + dy * a.hy;
      if (along <= 0 || along > FOLLOW_LOOKAHEAD_TILES) return;
      const lateral = Math.abs(-dx * a.hy + dy * a.hx);
      if (lateral >= FOLLOW_LATERAL_TILES) return;
      // 마주 오는 차는 앞차가 아니다. 정면으로 마주 보는 경우만 걸러낸다.
      const facing = b.hx * a.hx + b.hy * a.hy;
      if (facing < -0.5) return;
      if (along < best) best = along;
    });
    return best;
  }

  /** 갈림길 위인가. 여기서만 재탐색을 검토한다. */
  private atRoadFork(vehicle: Vehicle): boolean {
    const [tx, ty] = tileAt(vehicle);
    return pop4(roadMask(this.world, tx, ty)) >= 3;
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
      if (
        !route ||
        vehicle.route !== oldRoute ||
        vehicle.routeIdx !== oldIdx ||
        vehicle.tileT > 0.12 ||
        this.control.hasReservation(vehicle)
      ) {
        return;
      }
      // 새 경로의 첫 진행방향이 지금 방향과 다르면 갈아끼우지 않는다.
      //
      // 차선 위치는 "진행방향의 오른쪽" 으로 정해진다. 방향이 바뀌면 차가 그
      // 자리에서 도로 반대편 차선으로 순간이동하고, 하필 그 자리에 마주 오는
      // 차가 있으면 두 차체가 포개진 채 굳어 버린다. 그 한 대가 뒤쪽 대기열
      // 전체를 세워 도시가 멈췄다.
      const newDir =
        route.tiles.length >= 4
          ? dirBetween(route.tiles[0], route.tiles[1], route.tiles[2], route.tiles[3])
          : vehicle.dir;
      if (newDir !== vehicle.dir) return;
      vehicle.route = route;
      vehicle.routeIdx = 0;
      vehicle.jPath = null;
      vehicle.jPathRoute = null;
      vehicle.dir = newDir;
    });
  }

  private spawnJitterMs(trip: Trip, seq: number): number {
    const spread = Math.min(
      SPAWN_SPREAD_MAX_MS,
      SPAWN_READY_JITTER_MAX_MS + this.readySpawns.length * SPAWN_QUEUE_SPREAD_MS,
    );
    return (
      simHash(WORLD_SEED, trip.fromTx, trip.fromTy, trip.toTx ^ trip.toTy ^ seq) %
      Math.max(1, spread)
    );
  }

  private completeVehicle(vehicle: Vehicle): void {
    this.control.release(vehicle);
    const trip = this.trips.get(vehicle);
    if (trip) this.citizens.onTripComplete(trip);
    this.trips.delete(vehicle);
  }

  private dropVehicle(vehicle: Vehicle): void {
    this.control.release(vehicle);
    const trip = this.trips.get(vehicle);
    if (trip) this.citizens.onTripFailed(trip);
    this.trips.delete(vehicle);
  }

  private tileInside(tx: number, ty: number): boolean {
    const cx = chunkIndexOf(tx);
    const cy = chunkIndexOf(ty);
    return (
      Math.abs(cx - this.activeCx) <= SIM_RADIUS_CHUNKS &&
      Math.abs(cy - this.activeCy) <= SIM_RADIUS_CHUNKS
    );
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

function buildLaneOccupancy(vehicles: readonly Vehicle[]): Map<string, Vehicle[]> {
  const occupancy = new Map<string, Vehicle[]>();
  for (const vehicle of vehicles) {
    const [x, y] = tileAt(vehicle);
    const dirs =
      incomingDir(vehicle) === vehicle.dir ? [vehicle.dir] : [vehicle.dir, incomingDir(vehicle)];
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
