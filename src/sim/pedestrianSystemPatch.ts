import { CHUNK_SIZE, WORLD_SEED } from '../core/constants';
import { chunkIndexOf } from '../core/iso';
import { Build, DIRS } from '../world/build';
import { isWater } from '../world/terrain';
import type { World } from '../world/world';
import {
  capacityOf,
  isAnchor,
  levelOfCode,
  simHash,
  ZONE_C,
  ZONE_I,
  ZONE_R,
  zoneOfCode,
} from './buildings';
import { PedestrianPool, type Pedestrian, type WalkPoint } from './pedestrians';
import { INTERSECTION_STOP_T } from './simConstants';
import type { TrafficSim } from './traffic/trafficSim';
import { lanePosition } from './traffic/laneGeometry';
import type { Junction, JunctionIndex } from './traffic/junctions';
import { SignalState, signalState } from './traffic/signals';
import type { Vehicle } from './traffic/vehicles';

/**
 * 화면 밖에서도 보행 흐름이 이어지는 반경.
 * 차량 마이크로 시뮬보다 한 겹 넓은 5x5 청크를 유지하되, 렌더러는 화면 안만 그린다.
 */
const PEDESTRIAN_SIM_RADIUS_CHUNKS = 2;
const PEDESTRIAN_KEEP_MARGIN_CHUNKS = 1;
const MAX_WALKERS = 140;
const SPAWN_RATE_PER_SEC = 5.0;
const MAX_SPAWNS_PER_UPDATE = 1;
const WALK_SPEED_MIN = 0.68;
const WALK_SPEED_MAX = 1.02;
const CROSSING_SPEED = 1.28;
const DEST_DWELL_MIN_MS = 250;
const DEST_DWELL_SPAN_MS = 850;
const SHORT_TRIP_MIN = 4;
const SHORT_TRIP_MAX = 17;
const LONG_TRIP_MIN = 18;
const LONG_TRIP_MAX = 58;
const LONG_TRIP_SHARE = 0.55;
const CROSSING_ROUTE_COST = 4.2;
const CROSSING_SEARCH_RADIUS = 1;
/** 달리는 차량은 이 거리 안에 있으면 횡단 시작을 미룬다. */
const CROSS_MOVING_CLEAR_TILES = 8.5;
/** 정지 차량도 횡단 바로 앞에 붙어 있으면 기다린다. */
const CROSS_STOPPED_CLEAR_TILES = 3.0;
const CROSS_HARD_CLEAR_TILES = 1.2;
const COLORS = [0xe8b85a, 0x78b9d1, 0xdb8b85, 0xb8c994, 0xc996d6, 0x8fc6a4];

type GridPoint = readonly [number, number];

interface ActivityNode {
  point: GridPoint;
  zone: number;
  weight: number;
  capacity: number;
}

interface WeightedGroup {
  items: ActivityNode[];
  cumulative: number[];
  total: number;
}

interface WalkerMeta {
  segment: number;
  segmentT: number;
  speed: number;
  dwellMs: number;
  bornMs: number;
  /** segment index -> 그 횡단을 허용한 신호 교차로. */
  crossings: Map<number, Junction>;
  /** 한번 건너기 시작했으면 신호가 바뀌어도 도로 한가운데서 멈추지 않는다. */
  crossingUntil: number;
}

interface PoolState {
  revision: number;
  region: string;
  cx: number;
  cy: number;
  groups: [WeightedGroup, WeightedGroup, WeightedGroup];
  all: WeightedGroup;
  residentCapacity: number;
  activity: number;
  spawnCredit: number;
  sequence: number;
  metas: WeakMap<Pedestrian, WalkerMeta>;
  /** 현재 실제로 횡단 중인 신호 교차로 id. 차량 정지선 양보에 사용한다. */
  activeCrossings: Set<number>;
}

interface TrafficInternals {
  citizens: { pedestrians: PedestrianPool };
  junctionIndex: JunctionIndex;
  vehicles: Vehicle[];
  timeMs: number;
  daytime: { hour: number };
  macro: { stats: { population: number } };
  holdProgress(vehicle: Vehicle, frameIndex: number): number | null;
  junctionPathFor(vehicle: Vehicle): { junctionId: number; entryIndex: number } | null;
}

const trafficByPool = new WeakMap<PedestrianPool, TrafficSim>();
const states = new WeakMap<PedestrianPool, PoolState>();
const originalUpdate = PedestrianPool.prototype.update;
let prototypePatched = false;

/**
 * 기존 근거리 왕복 표시기를 지속형 보행 흐름으로 교체한다.
 * 저장 데이터나 실제 시민/통행 수요를 바꾸지 않고 화면 표현만 바꾼다.
 */
export function installPedestrianSystemPatch(traffic: TrafficSim): void {
  const sim = traffic as unknown as TrafficInternals;
  const pool = sim.citizens?.pedestrians;
  if (!pool) return;
  trafficByPool.set(pool, traffic);
  installPedestrianVehicleYield(traffic, pool);

  if (prototypePatched) return;
  prototypePatched = true;
  PedestrianPool.prototype.update = function patchedPedestrianUpdate(
    this: PedestrianPool,
    dtMs: number,
    cx: number,
    cy: number,
    radius: number,
    focusX?: number,
    focusY?: number,
  ): void {
    const boundTraffic = trafficByPool.get(this);
    if (!boundTraffic) {
      originalUpdate.call(this, dtMs, cx, cy, radius, focusX, focusY);
      return;
    }
    updatePool(this, boundTraffic, dtMs, cx, cy);
  } as PedestrianPool['update'];
}

function updatePool(
  pool: PedestrianPool,
  traffic: TrafficSim,
  dtMs: number,
  cx: number,
  cy: number,
): void {
  const world = (pool as unknown as { world: World }).world;
  const sim = traffic as unknown as TrafficInternals;
  let state = states.get(pool);
  if (!state) {
    state = emptyState(cx, cy);
    states.set(pool, state);
  }

  const region = `${cx},${cy},${PEDESTRIAN_SIM_RADIUS_CHUNKS}`;
  if (state.revision !== world.walkRevision || state.region !== region) {
    rebuildActivity(state, world, cx, cy);
  }

  // 카메라가 움직여도 전부 지우지 않는다. 충분히 멀어진 사람만 자연스럽게 정리한다.
  const keep = PEDESTRIAN_SIM_RADIUS_CHUNKS + PEDESTRIAN_KEEP_MARGIN_CHUNKS;
  for (let i = pool.walkers.length - 1; i >= 0; i--) {
    const p = pool.walkers[i];
    const pcx = chunkIndexOf(p.x);
    const pcy = chunkIndexOf(p.y);
    if (Math.abs(pcx - cx) > keep || Math.abs(pcy - cy) > keep) pool.walkers.splice(i, 1);
  }

  const target = targetWalkerCount(state, sim);
  state.spawnCredit = Math.min(
    4,
    state.spawnCredit + (Math.min(dtMs, 100) / 1000) * SPAWN_RATE_PER_SEC,
  );
  let spawned = 0;
  while (
    pool.walkers.length < target &&
    state.spawnCredit >= 1 &&
    spawned < MAX_SPAWNS_PER_UPDATE
  ) {
    const walker = spawnWalker(state, world, traffic);
    state.spawnCredit -= 1;
    if (!walker) break;
    pool.walkers.push(walker.pedestrian);
    state.metas.set(walker.pedestrian, walker.meta);
    spawned++;
  }

  const dt = Math.min(dtMs, 100) / 1000;
  for (let i = pool.walkers.length - 1; i >= 0; i--) {
    const p = pool.walkers[i];
    const meta = state.metas.get(p);
    if (!meta) {
      pool.walkers.splice(i, 1);
      continue;
    }
    const alive = moveWalker(world, traffic, p, meta, dt, dtMs);
    if (!alive) pool.walkers.splice(i, 1);
  }
  refreshActiveCrossings(state, pool.walkers);
}

/**
 * 보행자가 이미 횡단 중이면 신호가 차량 초록으로 바뀌어도 차량은 정지선에서 기다린다.
 * 차량 이동 패치는 매 프레임 holdProgress()를 호출하므로 여기만 감싸면 기존
 * 교차로 예약/충돌/감속 로직을 그대로 재사용할 수 있다.
 */
function installPedestrianVehicleYield(traffic: TrafficSim, pool: PedestrianPool): void {
  const sim = traffic as unknown as TrafficInternals & Record<string, unknown>;
  if (sim.__pedestrianVehicleYieldPatched === true) return;
  sim.__pedestrianVehicleYieldPatched = true;

  const originalHold = sim.holdProgress.bind(traffic);
  sim.holdProgress = (vehicle: Vehicle, frameIndex: number): number | null => {
    const baseHold = originalHold(vehicle, frameIndex);
    const state = states.get(pool);
    if (!state || state.activeCrossings.size === 0) return baseHold;

    const path = sim.junctionPathFor(vehicle);
    if (!path || !state.activeCrossings.has(path.junctionId)) return baseHold;

    const progress = vehicle.routeIdx + vehicle.tileT;
    const stop = path.entryIndex - 1 + INTERSECTION_STOP_T;
    // 이미 교차로 안에 들어온 차량을 갑자기 세우면 더 위험하다. 진입 전 차량만 양보한다.
    if (progress > stop + 1e-3) return baseHold;
    return baseHold === null ? stop : Math.min(baseHold, stop);
  };
}

function refreshActiveCrossings(state: PoolState, walkers: readonly Pedestrian[]): void {
  state.activeCrossings.clear();
  for (const p of walkers) {
    const meta = state.metas.get(p);
    if (!meta || meta.crossingUntil < meta.segment) continue;
    const junction = meta.crossings.get(meta.segment);
    if (junction) state.activeCrossings.add(junction.id);
  }
}

function emptyState(cx: number, cy: number): PoolState {
  const empty = makeGroup([]);
  return {
    revision: -1,
    region: '',
    cx,
    cy,
    groups: [empty, makeGroup([]), makeGroup([])],
    all: makeGroup([]),
    residentCapacity: 0,
    activity: 0,
    spawnCredit: 3,
    sequence: 0,
    metas: new WeakMap(),
    activeCrossings: new Set(),
  };
}

function rebuildActivity(state: PoolState, world: World, cx: number, cy: number): void {
  const byZone: [ActivityNode[], ActivityNode[], ActivityNode[]] = [[], [], []];
  let residentCapacity = 0;
  let activity = 0;

  for (const parcel of world.developedParcels()) {
    if (
      Math.abs(parcel.cx - cx) > PEDESTRIAN_SIM_RADIUS_CHUNKS ||
      Math.abs(parcel.cy - cy) > PEDESTRIAN_SIM_RADIUS_CHUNKS ||
      !parcel.bld
    ) {
      continue;
    }
    const bx = parcel.cx * CHUNK_SIZE;
    const by = parcel.cy * CHUNK_SIZE;
    for (let i = 0; i < parcel.bld.length; i++) {
      const code = parcel.bld[i];
      if (!isAnchor(code)) continue;
      const zone = zoneOfCode(code);
      if (zone < ZONE_R || zone > ZONE_I) continue;
      const level = levelOfCode(code);
      const tx = bx + (i % CHUNK_SIZE);
      const ty = by + Math.floor(i / CHUNK_SIZE);
      const capacity = capacityOf(zone, level);
      // 예전 표시기와 같은 건물 모서리 진입점을 쓰되, 초점 거리로 정렬하지 않는다.
      const point: GridPoint = [tx + level, ty];
      const weight = capacity * (zone === ZONE_C ? 1.35 : zone === ZONE_I ? 0.5 : 1);
      byZone[zone].push({ point, zone, weight, capacity });
      if (zone === ZONE_R) residentCapacity += capacity;
      activity += capacity * (zone === ZONE_C ? 1.25 : zone === ZONE_I ? 0.22 : 0.38);
    }
  }

  state.revision = world.walkRevision;
  state.region = `${cx},${cy},${PEDESTRIAN_SIM_RADIUS_CHUNKS}`;
  state.cx = cx;
  state.cy = cy;
  state.groups = [makeGroup(byZone[0]), makeGroup(byZone[1]), makeGroup(byZone[2])];
  state.all = makeGroup([...byZone[0], ...byZone[1], ...byZone[2]]);
  state.residentCapacity = residentCapacity;
  state.activity = activity;
}

function makeGroup(items: ActivityNode[]): WeightedGroup {
  const cumulative: number[] = [];
  let total = 0;
  for (const item of items) {
    total += Math.max(1, item.weight);
    cumulative.push(total);
  }
  return { items, cumulative, total };
}

function targetWalkerCount(state: PoolState, sim: TrafficInternals): number {
  if (state.all.items.length < 2 || state.activity <= 0) return 0;
  const population = Math.max(0, sim.macro.stats.population);
  const occupancy =
    state.residentCapacity > 0 ? clamp(population / state.residentCapacity, 0.08, 1.15) : 0.35;
  const occupiedFactor = 0.35 + Math.sqrt(occupancy) * 0.65;
  const timeFactor = pedestrianTimeFactor(sim.daytime.hour);
  const raw = Math.sqrt(state.activity) * 0.48 * occupiedFactor * timeFactor;
  const min = timeFactor < 0.15 ? 0 : 3;
  return Math.round(clamp(raw, min, MAX_WALKERS));
}

function pedestrianTimeFactor(hour: number): number {
  if (hour < 5) return 0.06;
  if (hour < 6.5) return 0.22;
  if (hour < 9.5) return 0.82;
  if (hour < 16) return 0.7;
  if (hour < 19.5) return 1.0;
  if (hour < 22) return 0.78;
  return 0.24;
}

function spawnWalker(
  state: PoolState,
  world: World,
  traffic: TrafficSim,
): { pedestrian: Pedestrian; meta: WalkerMeta } | null {
  const sim = traffic as unknown as TrafficInternals;
  const relation = chooseRelation(sim.daytime.hour, rand(state, 1));
  const longTrip = rand(state, 2) < LONG_TRIP_SHARE;
  const minDist = longTrip ? LONG_TRIP_MIN : SHORT_TRIP_MIN;
  const maxDist = longTrip ? LONG_TRIP_MAX : SHORT_TRIP_MAX;

  let start: ActivityNode | null = null;
  let goal: ActivityNode | null = null;
  for (let attempt = 0; attempt < 36; attempt++) {
    start = pickFromZone(state, relation[0], rand(state, 10 + attempt * 2));
    goal = pickFromZone(state, relation[1], rand(state, 11 + attempt * 2));
    if (!start || !goal || start === goal) continue;
    const d = manhattan(start.point, goal.point);
    if (d < minDist || d > maxDist) continue;
    break;
  }
  if (!start || !goal || start === goal) return null;
  const endpointDistance = manhattan(start.point, goal.point);
  if (endpointDistance < minDist || endpointDistance > maxDist) return null;

  const path = findSignalWalkPath(world, traffic, start.point, goal.point);
  if (path.length < 2) return null;
  const crossings = mapCrossings(traffic, path);
  const pedestrian: Pedestrian = {
    x: path[0][0],
    y: path[0][1],
    color: COLORS[Math.floor(rand(state, 200) * COLORS.length) % COLORS.length],
    path,
    progress: 0,
  };
  const speed = WALK_SPEED_MIN + rand(state, 201) * (WALK_SPEED_MAX - WALK_SPEED_MIN);
  return {
    pedestrian,
    meta: {
      segment: 0,
      segmentT: 0,
      speed,
      dwellMs: 0,
      bornMs: sim.timeMs,
      crossings,
      crossingUntil: -1,
    },
  };
}

/** 주거-상업을 가장 흔하게 하고 주거-주거는 소수만 남긴다. */
function chooseRelation(hour: number, r: number): readonly [number, number] {
  if (hour >= 6 && hour < 10) {
    if (r < 0.58) return [ZONE_R, ZONE_C];
    if (r < 0.72) return [ZONE_R, ZONE_I];
    if (r < 0.84) return [ZONE_C, ZONE_R];
    if (r < 0.94) return [ZONE_C, ZONE_C];
    return [ZONE_R, ZONE_R];
  }
  if (hour >= 16 && hour < 22) {
    if (r < 0.36) return [ZONE_C, ZONE_R];
    if (r < 0.7) return [ZONE_R, ZONE_C];
    if (r < 0.86) return [ZONE_C, ZONE_C];
    if (r < 0.94) return [ZONE_I, ZONE_R];
    return [ZONE_R, ZONE_R];
  }
  if (r < 0.5) return [ZONE_R, ZONE_C];
  if (r < 0.68) return [ZONE_C, ZONE_R];
  if (r < 0.84) return [ZONE_C, ZONE_C];
  if (r < 0.92) return [ZONE_R, ZONE_I];
  return [ZONE_R, ZONE_R];
}

function pickFromZone(state: PoolState, zone: number, r: number): ActivityNode | null {
  const group = state.groups[zone] ?? state.all;
  return pickWeighted(group.total > 0 ? group : state.all, r);
}

function pickWeighted(group: WeightedGroup, r: number): ActivityNode | null {
  if (!group.items.length || group.total <= 0) return null;
  const value = r * group.total;
  let lo = 0;
  let hi = group.cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (group.cumulative[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return group.items[lo] ?? null;
}

function rand(state: PoolState, salt: number): number {
  const seq = state.sequence++;
  return simHash(WORLD_SEED ^ salt, seq, state.cx * 73856093, state.cy * 19349663) / 4294967296;
}

function moveWalker(
  world: World,
  traffic: TrafficSim,
  p: Pedestrian,
  meta: WalkerMeta,
  dt: number,
  dtMs: number,
): boolean {
  const lastSegment = p.path.length - 1;
  if (meta.segment >= lastSegment) {
    if (meta.dwellMs <= 0) {
      const h = simHash(WORLD_SEED, Math.floor(meta.bornMs), p.path.length, p.color);
      meta.dwellMs = DEST_DWELL_MIN_MS + (h % DEST_DWELL_SPAN_MS);
    }
    meta.dwellMs -= dtMs;
    return meta.dwellMs > 0;
  }

  let remaining = meta.speed * dt;
  let guard = 0;
  while (remaining > 1e-6 && meta.segment < lastSegment && guard++ < 8) {
    const crossing = meta.crossings.get(meta.segment);
    if (crossing && meta.segment > meta.crossingUntil) {
      if (!crossingSafeToStart(traffic, p.path[meta.segment], p.path[meta.segment + 1], crossing)) {
        return true;
      }
      meta.crossingUntil = crossingRunEnd(meta, p.path, meta.segment, crossing.id);
    }

    // 도로/건물이 편집돼 현재 경로 자체가 막혔으면 순간이동시키지 말고 이 보행만 끝낸다.
    if (
      !segmentStillWalkable(
        world,
        traffic,
        p.path[meta.segment],
        p.path[meta.segment + 1],
        crossing ?? null,
      )
    ) {
      return false;
    }

    const crossingNow = meta.segment <= meta.crossingUntil;
    const speedMul = crossingNow ? CROSSING_SPEED / meta.speed : 1;
    const stepRemaining = (1 - meta.segmentT) / speedMul;
    const used = Math.min(remaining, stepRemaining);
    meta.segmentT += used * speedMul;
    remaining -= used;
    p.progress += used * speedMul;

    const a = p.path[meta.segment];
    const b = p.path[meta.segment + 1];
    const t = Math.min(1, meta.segmentT);
    p.x = a[0] + (b[0] - a[0]) * t;
    p.y = a[1] + (b[1] - a[1]) * t;

    if (meta.segmentT >= 1 - 1e-6) {
      meta.segment++;
      meta.segmentT = 0;
      if (meta.segment > meta.crossingUntil) meta.crossingUntil = -1;
      if (meta.segment >= lastSegment) {
        p.x = p.path[lastSegment][0];
        p.y = p.path[lastSegment][1];
        break;
      }
    }
  }
  return true;
}

function crossingRunEnd(
  meta: WalkerMeta,
  path: readonly WalkPoint[],
  start: number,
  junctionId: number,
): number {
  let end = start;
  for (let i = start + 1; i < path.length - 1; i++) {
    if (meta.crossings.get(i)?.id !== junctionId) break;
    end = i;
  }
  return end;
}

function crossingSafeToStart(
  traffic: TrafficSim,
  a: WalkPoint,
  b: WalkPoint,
  junction: Junction,
): boolean {
  const sim = traffic as unknown as TrafficInternals;
  if (!junction.signalized) return false;

  const na = gridPoint(a);
  const nb = gridPoint(b);
  const pedestrianAxis = na[0] !== nb[0] ? 0 : 1;
  const crossedVehicleAxis = 1 - pedestrianAxis;
  if (signalState(junction, crossedVehicleAxis, sim.timeMs) !== SignalState.Red) return false;

  const mx = (a[0] + b[0]) * 0.5;
  const my = (a[1] + b[1]) * 0.5;
  for (const vehicle of sim.vehicles) {
    const [vx, vy] = lanePosition(vehicle.route, vehicle.routeIdx, vehicle.tileT);
    const dx = vx - mx;
    const dy = vy - my;
    const d2 = dx * dx + dy * dy;

    if (vehicle.speed <= 0.35) {
      // 빨간불을 받고 정지선 뒤에 서 있는 차는 보행자를 막는 위험 차량이 아니다.
      // 다만 교차로 안에 멈춘 차나 다른 축의 정지 차량은 그대로 위험으로 본다.
      const inside =
        vx >= junction.minX - 0.15 &&
        vx <= junction.maxX + 0.15 &&
        vy >= junction.minY - 0.15 &&
        vy <= junction.maxY + 0.15;
      if (!inside && (vehicle.dir & 1) === crossedVehicleAxis) continue;
      if (d2 < CROSS_HARD_CLEAR_TILES * CROSS_HARD_CLEAR_TILES) return false;
      if (d2 < CROSS_STOPPED_CLEAR_TILES * CROSS_STOPPED_CLEAR_TILES) return false;
      continue;
    }

    if (d2 < CROSS_HARD_CLEAR_TILES * CROSS_HARD_CLEAR_TILES) return false;
    if (d2 < CROSS_MOVING_CLEAR_TILES * CROSS_MOVING_CLEAR_TILES) return false;
  }
  return true;
}

/** 도로 횡단 구간을 신호 교차로와 묶어 둔다. 카메라가 이동해 색인이 갱신돼도 이미 걷는 사람은 유지된다. */
function mapCrossings(traffic: TrafficSim, path: readonly WalkPoint[]): Map<number, Junction> {
  const out = new Map<number, Junction>();
  for (let i = 0; i < path.length - 1; i++) {
    const pair = roadPair(path[i], path[i + 1]);
    if (!pair) continue;
    const world = worldFromTraffic(traffic);
    if (!isRoad(world, pair[0]) || !isRoad(world, pair[1])) continue;
    const junction = crossingJunction(traffic, pair[0], pair[1]);
    if (junction) out.set(i, junction);
  }
  return out;
}

function segmentStillWalkable(
  world: World,
  traffic: TrafficSim,
  a: WalkPoint,
  b: WalkPoint,
  knownCrossing: Junction | null,
): boolean {
  const na = gridPoint(a);
  const nb = gridPoint(b);
  if (!knownCrossing) {
    return Number.isFinite(edgeCost(world, traffic, na[0], na[1], nb[0], nb[1]));
  }

  // 카메라가 이동하면 차량용 JunctionIndex의 계산 사각형도 이동한다. 이미 출발한
  // 보행자는 경로를 만들 때 확보한 교차로 정보를 계속 쓰게 해 화면 이동만으로
  // 갑자기 사라지지 않게 한다. 실제 도로/지형이 없어졌는지만 다시 확인한다.
  const pair = roadPairFromGrid(na[0], na[1], nb[0], nb[1]);
  if (!pair || !isRoad(world, pair[0]) || !isRoad(world, pair[1])) return false;
  return physicalEdgeAllowed(world, pair[0], pair[1]);
}

function findSignalWalkPath(
  world: World,
  traffic: TrafficSim,
  start: GridPoint,
  goal: GridPoint,
): WalkPoint[] {
  const direct = manhattan(start, goal);
  if (direct > LONG_TRIP_MAX + 8) return [];
  const margin = 22;
  const x0 = Math.min(start[0], goal[0]) - margin;
  const y0 = Math.min(start[1], goal[1]) - margin;
  const x1 = Math.max(start[0], goal[0]) + margin;
  const y1 = Math.max(start[1], goal[1]) + margin;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (w <= 0 || h <= 0 || w > 128 || h > 128) return [];

  const n = w * h;
  const cost = new Float32Array(n);
  cost.fill(Infinity);
  const prev = new Int32Array(n);
  prev.fill(-1);
  const closed = new Uint8Array(n);
  const heap = new MinHeap();
  const startI = (start[1] - y0) * w + (start[0] - x0);
  const goalI = (goal[1] - y0) * w + (goal[0] - x0);
  cost[startI] = 0;
  heap.push(startI, direct);

  let expanded = 0;
  while (heap.size && expanded++ < 10_000) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goalI) break;
    const lx = cur % w;
    const ly = (cur - lx) / w;
    const x = x0 + lx;
    const y = y0 + ly;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < x0 || ny < y0 || nx > x1 || ny > y1) continue;
      const ni = (ny - y0) * w + (nx - x0);
      if (closed[ni]) continue;
      const step = edgeCost(world, traffic, x, y, nx, ny);
      if (!Number.isFinite(step)) continue;
      const next = cost[cur] + step;
      if (next >= cost[ni]) continue;
      cost[ni] = next;
      prev[ni] = cur;
      heap.push(ni, next + Math.abs(nx - goal[0]) + Math.abs(ny - goal[1]));
    }
  }
  if (!Number.isFinite(cost[goalI])) return [];

  const path: WalkPoint[] = [];
  let at = goalI;
  while (at >= 0) {
    const lx = at % w;
    const ly = (at - lx) / w;
    path.push([x0 + lx - 0.5, y0 + ly - 0.5]);
    if (at === startI) break;
    at = prev[at];
  }
  if (path[path.length - 1]?.[0] !== start[0] - 0.5 || path[path.length - 1]?.[1] !== start[1] - 0.5)
    return [];
  path.reverse();
  return path;
}

/** 기존 보행 경계 비용을 유지하되 도로 내부는 신호 교차로에서만 통과시킨다. */
function edgeCost(
  world: World,
  traffic: TrafficSim,
  x: number,
  y: number,
  nx: number,
  ny: number,
): number {
  if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) return Infinity;
  const pair = roadPairFromGrid(x, y, nx, ny);
  if (!pair) return Infinity;
  if (!physicalEdgeAllowed(world, pair[0], pair[1])) return Infinity;

  const ar = isRoad(world, pair[0]);
  const br = isRoad(world, pair[1]);
  if (ar !== br) return 1;
  if (ar && br) {
    return crossingJunction(traffic, pair[0], pair[1]) ? CROSSING_ROUTE_COST : Infinity;
  }
  return 1.35;
}


function physicalEdgeAllowed(world: World, a: GridPoint, b: GridPoint): boolean {
  const land = ([tx, ty]: GridPoint) =>
    world.isExplored(chunkIndexOf(tx), chunkIndexOf(ty)) && !isWater(world.getTile(tx, ty));
  const al = land(a);
  const bl = land(b);
  if (!al && !bl) return false;
  if (al && bl && Math.abs(world.sampleHeight(...a) - world.sampleHeight(...b)) > 1) return false;

  const ab = world.buildingCovering(...a);
  const bb = world.buildingCovering(...b);
  return !(ab && bb && ab.tx === bb.tx && ab.ty === bb.ty);
}

function crossingJunction(
  traffic: TrafficSim,
  a: GridPoint,
  b: GridPoint,
): Junction | null {
  const index = (traffic as unknown as TrafficInternals).junctionIndex;
  const directA = index.at(a[0], a[1]);
  if (directA?.signalized) return directA;
  const directB = index.at(b[0], b[1]);
  if (directB?.signalized) return directB;

  const mx = Math.round((a[0] + b[0]) * 0.5);
  const my = Math.round((a[1] + b[1]) * 0.5);
  let best: Junction | null = null;
  let bestD = Infinity;
  for (let dy = -CROSSING_SEARCH_RADIUS; dy <= CROSSING_SEARCH_RADIUS; dy++) {
    for (let dx = -CROSSING_SEARCH_RADIUS; dx <= CROSSING_SEARCH_RADIUS; dx++) {
      const junction = index.at(mx + dx, my + dy);
      if (!junction?.signalized) continue;
      const d = rectDistance(mx, my, junction);
      if (d < bestD) {
        best = junction;
        bestD = d;
      }
    }
  }
  return bestD <= CROSSING_SEARCH_RADIUS ? best : null;
}

function rectDistance(x: number, y: number, junction: Junction): number {
  const dx = x < junction.minX ? junction.minX - x : x > junction.maxX ? x - junction.maxX : 0;
  const dy = y < junction.minY ? junction.minY - y : y > junction.maxY ? y - junction.maxY : 0;
  return dx + dy;
}

function roadPair(a: WalkPoint, b: WalkPoint): readonly [GridPoint, GridPoint] | null {
  const ga = gridPoint(a);
  const gb = gridPoint(b);
  return roadPairFromGrid(ga[0], ga[1], gb[0], gb[1]);
}

function roadPairFromGrid(
  x: number,
  y: number,
  nx: number,
  ny: number,
): readonly [GridPoint, GridPoint] | null {
  if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) return null;
  if (x !== nx) {
    const lx = Math.min(x, nx);
    return [
      [lx, y - 1],
      [lx, y],
    ];
  }
  const ly = Math.min(y, ny);
  return [
    [x - 1, ly],
    [x, ly],
  ];
}

function gridPoint(p: WalkPoint): GridPoint {
  return [Math.round(p[0] + 0.5), Math.round(p[1] + 0.5)];
}

function isRoad(world: World, p: GridPoint): boolean {
  return world.getBuild(p[0], p[1]) === Build.Road;
}

function worldFromTraffic(traffic: TrafficSim): World {
  return (traffic as unknown as { world: World }).world;
}

function manhattan(a: GridPoint, b: GridPoint): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

class MinHeap {
  private items: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, key: number): void {
    this.items.push(item);
    this.keys.push(key);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(p, i);
      i = p;
    }
  }

  pop(): number {
    const top = this.items[0];
    const lastItem = this.items.pop() as number;
    const lastKey = this.keys.pop() as number;
    if (this.items.length) {
      this.items[0] = lastItem;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.items.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(m, i);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
  }
}
