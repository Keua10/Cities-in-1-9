import {
  ACCEL_TILES_PER_SEC2,
  DECEL_TILES_PER_SEC2,
  DESIRED_GAP_TILES,
  FREEZE_BACKOFF_TILES,
  FREEZE_BREAK_MS,
  INTERSECTION_STOP_T,
  MIN_GAP_TILES,
  STUCK_GIVEUP_MS,
  TRUCK_SPEED_MUL,
  VEHICLE_BODY_LENGTH_TILES,
  VEHICLE_SPEED_TILES_PER_SEC,
} from '../simConstants';
import { dirBetween, laneHeading, lanePosition } from './laneGeometry';
import type { TrafficSim } from './trafficSim';
import { VehicleKind, type Vehicle } from './vehicles';

/**
 * 목적지/신호 정지에만 쓰는 편안한 감속도.
 * 앞차 충돌 방지와 겹침 방지는 기존 DECEL_TILES_PER_SEC2를 그대로 쓴다.
 */
const ARRIVAL_DECEL_TILES_PER_SEC2 = 5.5;
const SIGNAL_DECEL_TILES_PER_SEC2 = 7.0;
/** 마지막 경로 노드 바로 위에서 사라지지 않도록 이만큼 전에 정차한다. */
const ARRIVAL_STOP_OFFSET_TILES = 0.08;
/** 완전히 멈춘 모습이 눈에 보인 뒤 제거되는 시간. */
const ARRIVAL_DWELL_MS = 650;
const ARRIVAL_POSITION_EPS = 0.003;
const ARRIVAL_SPEED_EPS = 0.08;
/** 서로 충돌 판정으로 동시에 frozen 된 차량을 같은 교착 쌍으로 보는 거리. */
const DEADLOCK_PAIR_DIST_TILES = VEHICLE_BODY_LENGTH_TILES + DESIRED_GAP_TILES;

interface MotionFrame {
  vehicle: Vehicle;
  x: number;
  y: number;
  hx: number;
  hy: number;
  advance: number;
  px: number;
  py: number;
  phx: number;
  phy: number;
  nextIdx: number;
  nextT: number;
  frozen: boolean;
}

interface JunctionPathLike {
  entryIndex: number;
}

/**
 * TrafficSim의 기존 교차로 예약·충돌·우측통행 로직은 그대로 두고 이동 단계만 교체한다.
 *
 * private 메서드는 TypeScript의 접근 제한일 뿐 런타임에서는 일반 메서드이므로,
 * 인스턴스의 moveVehicles만 덮어쓴다. 다른 TrafficSim API와 저장 데이터에는 영향이 없다.
 */
export function installVehicleMotionPatch(traffic: TrafficSim): void {
  const sim = traffic as unknown as Record<string, unknown>;
  if (sim.__vehicleMotionPatched === true) return;
  sim.__vehicleMotionPatched = true;

  const arrivalDwell = new WeakMap<Vehicle, number>();
  sim.moveVehicles = ((dt: number, dtMs: number): void => {
    moveVehiclesPatched(traffic, arrivalDwell, dt, dtMs);
  }) as unknown;
}

function moveVehiclesPatched(
  traffic: TrafficSim,
  arrivalDwell: WeakMap<Vehicle, number>,
  dt: number,
  dtMs: number,
): void {
  // 이 파일은 기존 이동 루프의 구조를 그대로 유지한다. private 접근만 한 곳에서 묶는다.
  const sim = traffic as unknown as {
    vehicles: Vehicle[];
    frames: MotionFrame[];
    grid: { clear(): void; insert(i: number, x: number, y: number): void };
    control: {
      release(vehicle: Vehicle): void;
      hasReservation(vehicle: Vehicle): boolean;
      reservationOf(vehicle: Vehicle): { entryIndex: number } | null;
    };
    refreshJunctions(): void;
    updateJunctionRights(frames: readonly MotionFrame[], dtMs: number): void;
    gapAhead(vehicle: Vehicle, occupancy: Map<string, Vehicle[]>): number;
    nearestAhead(frames: readonly MotionFrame[], selfIndex: number): number;
    holdProgress(vehicle: Vehicle, frameIndex: number): number | null;
    junctionPathFor(vehicle: Vehicle): JunctionPathLike | null;
    project(frame: MotionFrame): void;
    resolveOverlaps(frames: MotionFrame[]): void;
    tileInside(tx: number, ty: number): boolean;
    completeVehicle(vehicle: Vehicle): void;
    dropVehicle(vehicle: Vehicle): void;
    atRoadFork(vehicle: Vehicle): boolean;
    shouldReroute(vehicle: Vehicle): boolean;
    reroute(vehicle: Vehicle): void;
  };

  sim.refreshJunctions();

  const frames = sim.frames;
  frames.length = 0;
  for (const vehicle of sim.vehicles) {
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

  sim.grid.clear();
  for (let i = 0; i < frames.length; i++) sim.grid.insert(i, frames[i].x, frames[i].y);

  const occupancy = buildLaneOccupancy(sim.vehicles);
  sim.updateJunctionRights(frames, dtMs);

  // 1) 목표 속도와 이동량.
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const vehicle = f.vehicle;
    const points = vehicle.route.tiles.length / 2;
    const progress = vehicle.routeIdx + vehicle.tileT;
    const baseTarget =
      VEHICLE_SPEED_TILES_PER_SEC * (vehicle.kind === VehicleKind.Truck ? TRUCK_SPEED_MUL : 1);

    const minCenterGap = VEHICLE_BODY_LENGTH_TILES + MIN_GAP_TILES;
    const desiredCenterGap = VEHICLE_BODY_LENGTH_TILES + DESIRED_GAP_TILES;

    // (a) 앞차/실제 차체 충돌 방지는 기존 강한 제동을 그대로 유지한다.
    const gap = sim.gapAhead(vehicle, occupancy);
    const near = sim.nearestAhead(frames, i);
    const limit = Math.min(gap, near);
    let safetyTarget = baseTarget;
    if (Number.isFinite(limit)) {
      const usable = Math.max(0, limit - minCenterGap);
      safetyTarget = Math.min(safetyTarget, Math.sqrt(2 * DECEL_TILES_PER_SEC2 * usable));
      if (limit < desiredCenterGap) {
        safetyTarget *= Math.max(
          0,
          usable / Math.max(0.001, desiredCenterGap - minCenterGap),
        );
      }
    }

    let target = safetyTarget;
    let softDecel: number | null = null;

    // (b) 적신호/정지선.
    // 기존에는 같은 48의 감속도를 써서 정지선 직전에 급하게 서는 느낌이 났다.
    // 실제 교차로 정지선 때문에 멈추는 경우에만 편안한 감속도를 적용한다.
    const hold = sim.holdProgress(vehicle, i);
    let room = Infinity;
    if (hold !== null) {
      room = Math.max(0, hold - progress);
      const path = sim.junctionPathFor(vehicle);
      const junctionStop = path ? path.entryIndex - 1 + INTERSECTION_STOP_T : Number.NaN;
      const junctionHold = Number.isFinite(junctionStop) && Math.abs(hold - junctionStop) <= 0.02;
      const brake = junctionHold ? SIGNAL_DECEL_TILES_PER_SEC2 : DECEL_TILES_PER_SEC2;
      const holdTarget = Math.sqrt(2 * brake * room);
      if (holdTarget < target) {
        target = holdTarget;
        softDecel = junctionHold ? SIGNAL_DECEL_TILES_PER_SEC2 : null;
      }
    }

    // (c) 목적지 접근.
    // 마지막 노드에 닿은 뒤 지우는 대신, 마지막 노드 직전에서 실제 차량처럼 감속한다.
    const arrivalStop = Math.max(0, points - 1 - ARRIVAL_STOP_OFFSET_TILES);
    const arrivalRoom = Math.max(0, arrivalStop - progress);
    const arrivalTarget = Math.sqrt(2 * ARRIVAL_DECEL_TILES_PER_SEC2 * arrivalRoom);
    if (arrivalTarget < target) {
      target = arrivalTarget;
      softDecel = ARRIVAL_DECEL_TILES_PER_SEC2;
    }

    // 앞차가 더 강하게 제한하고 있으면 안전 제동을 우선한다.
    if (safetyTarget <= target + 1e-6 && safetyTarget < vehicle.speed) softDecel = null;

    const accel =
      target > vehicle.speed
        ? ACCEL_TILES_PER_SEC2
        : (softDecel ?? DECEL_TILES_PER_SEC2);
    vehicle.speed = approach(vehicle.speed, target, accel * dt);

    let advance = vehicle.speed * dt;
    if (Number.isFinite(limit)) {
      advance = Math.min(advance, Math.max(0, limit - minCenterGap));
    }
    if (Number.isFinite(room)) {
      advance = Math.min(advance, room);
      if (room <= 0.001) vehicle.speed = 0;
    }
    advance = Math.min(advance, arrivalRoom);
    if (arrivalRoom <= ARRIVAL_POSITION_EPS) vehicle.speed = 0;
    if (vehicle.routeIdx >= points - 1) advance = 0;
    f.advance = Math.max(0, advance);
  }

  // 2) 기존 이동 투영/겹침 방지 로직을 그대로 사용한다.
  for (const f of frames) sim.project(f);
  sim.resolveOverlaps(frames);

  // 동시에 서로를 frozen 시킨 가까운 두 차량은 둘 다 같은 양으로 물러나면
  // 상대 위치가 거의 유지되어 교착이 반복될 수 있다. 한 쌍당 한 대만 양보자로
  // 골라 비대칭으로 물러나게 하면 상대 차량이 빠져나갈 공간이 생긴다.
  const deadlockYielders = selectDeadlockYielders(frames, sim.control);

  // 3) 반영.
  const remove = new Set<Vehicle>();
  for (const f of frames) {
    const vehicle = f.vehicle;
    const points = vehicle.route.tiles.length / 2;

    if (f.frozen) {
      vehicle.speed = 0;
      vehicle.frozenMs += dtMs;
      if (vehicle.frozenMs > FREEZE_BREAK_MS) {
        const paired = hasFrozenPartner(frames, f);
        // 교착 쌍에서는 선택된 한 대만 물러난다. 단독 frozen은 기존 동작 유지.
        if (!paired || deadlockYielders.has(vehicle)) {
          const back = Math.max(0, vehicle.routeIdx + vehicle.tileT - FREEZE_BACKOFF_TILES);
          vehicle.routeIdx = Math.floor(back);
          vehicle.tileT = back - vehicle.routeIdx;
          const reserved = sim.control.reservationOf(vehicle);
          if (reserved && vehicle.routeIdx < reserved.entryIndex) sim.control.release(vehicle);
        }
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

    // 목적지에서는 즉시 complete/remove 하지 않는다.
    // 완전히 멈춘 상태를 잠깐 유지해 뒤차도 실제로 감속/대기하게 만든다.
    const arrivalStop = Math.max(0, points - 1 - ARRIVAL_STOP_OFFSET_TILES);
    const progress = vehicle.routeIdx + vehicle.tileT;
    const atArrival =
      arrivalStop - progress <= ARRIVAL_POSITION_EPS &&
      vehicle.speed <= ARRIVAL_SPEED_EPS &&
      !f.frozen;

    if (atArrival) {
      vehicle.speed = 0;
      vehicle.stuckMs = 0; // 정상적인 목적지 정차를 교착으로 세지 않는다.
      const dwell = (arrivalDwell.get(vehicle) ?? 0) + dtMs;
      arrivalDwell.set(vehicle, dwell);
      if (dwell >= ARRIVAL_DWELL_MS) {
        sim.completeVehicle(vehicle);
        sim.control.release(vehicle);
        remove.add(vehicle);
        continue;
      }
    } else {
      arrivalDwell.delete(vehicle);
    }

    if (vehicle.routeIdx < points - 1) {
      const x = vehicle.route.tiles[vehicle.routeIdx * 2];
      const y = vehicle.route.tiles[vehicle.routeIdx * 2 + 1];
      const nx = vehicle.route.tiles[(vehicle.routeIdx + 1) * 2];
      const ny = vehicle.route.tiles[(vehicle.routeIdx + 1) * 2 + 1];
      vehicle.dir = dirBetween(x, y, nx, ny);
      if (!sim.tileInside(x, y)) {
        sim.completeVehicle(vehicle);
        sim.control.release(vehicle);
        remove.add(vehicle);
        continue;
      }
    } else {
      // 안전망. 정상 경로에서는 위의 목적지 정차 지점 때문에 여기까지 바로 오지 않는다.
      sim.completeVehicle(vehicle);
      sim.control.release(vehicle);
      remove.add(vehicle);
      continue;
    }

    if (vehicle.stuckMs > STUCK_GIVEUP_MS) {
      arrivalDwell.delete(vehicle);
      sim.dropVehicle(vehicle);
      remove.add(vehicle);
      continue;
    }

    // 기존 재탐색 규칙 유지. 코너 자체를 이유로 속도를 낮추는 코드는 추가하지 않는다.
    if (
      vehicle.tileT <= 0.08 &&
      !sim.control.hasReservation(vehicle) &&
      sim.atRoadFork(vehicle) &&
      sim.shouldReroute(vehicle)
    ) {
      sim.reroute(vehicle);
    }
  }

  if (remove.size) {
    for (const vehicle of remove) sim.control.release(vehicle);
    sim.vehicles = sim.vehicles.filter((vehicle) => !remove.has(vehicle));
  }
}

/** 가까운 frozen 차량이 있는지 확인한다. 같은 차선의 정상 신호대기는 frozen이 아니므로 여기 안 걸린다. */
function hasFrozenPartner(frames: readonly MotionFrame[], self: MotionFrame): boolean {
  if (!self.frozen) return false;
  const maxD2 = DEADLOCK_PAIR_DIST_TILES * DEADLOCK_PAIR_DIST_TILES;
  for (const other of frames) {
    if (other === self || !other.frozen) continue;
    const dx = other.x - self.x;
    const dy = other.y - self.y;
    if (dx * dx + dy * dy <= maxD2) return true;
  }
  return false;
}

/**
 * 동시에 frozen 된 가까운 차량 쌍마다 한 대만 양보자로 고른다.
 * 예약을 가진 차를 우선 통과시키고, 둘 다 같은 상태면 교차로 안쪽으로 더 진행한
 * 차량을 우선한다. 끝까지 같으면 목적지 좌표로 결정적으로 타이브레이크한다.
 */
function selectDeadlockYielders(
  frames: readonly MotionFrame[],
  control: {
    hasReservation(vehicle: Vehicle): boolean;
  },
): Set<Vehicle> {
  const yielders = new Set<Vehicle>();
  const maxD2 = DEADLOCK_PAIR_DIST_TILES * DEADLOCK_PAIR_DIST_TILES;

  for (let i = 0; i < frames.length; i++) {
    const a = frames[i];
    if (!a.frozen) continue;
    for (let j = i + 1; j < frames.length; j++) {
      const b = frames[j];
      if (!b.frozen) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (dx * dx + dy * dy > maxD2) continue;
      yielders.add(deadlockLoser(a.vehicle, b.vehicle, control));
    }
  }
  return yielders;
}

function deadlockLoser(
  a: Vehicle,
  b: Vehicle,
  control: { hasReservation(vehicle: Vehicle): boolean },
): Vehicle {
  const ar = control.hasReservation(a);
  const br = control.hasReservation(b);
  if (ar !== br) return ar ? b : a;

  const ap = a.routeIdx + a.tileT;
  const bp = b.routeIdx + b.tileT;
  if (Math.abs(ap - bp) > 0.02) return ap > bp ? b : a;

  if (a.waitMs !== b.waitMs) return a.waitMs > b.waitMs ? b : a;

  // 객체 배열 순서에 의존하지 않는 결정적 타이브레이크.
  const ak = ((a.destTx * 73856093) ^ (a.destTy * 19349663) ^ (a.route.tiles.length * 83492791)) >>> 0;
  const bk = ((b.destTx * 73856093) ^ (b.destTy * 19349663) ^ (b.route.tiles.length * 83492791)) >>> 0;
  return ak <= bk ? b : a;
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

function laneKey(tx: number, ty: number, dir: number): string {
  return `${tx},${ty},${dir}`;
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

function approach(value: number, target: number, delta: number): number {
  return value < target ? Math.min(target, value + delta) : Math.max(target, value - delta);
}
