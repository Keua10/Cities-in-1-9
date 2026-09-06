import { WORLD_SEED } from '../../core/constants';
import { simHash } from '../buildings';
import {
  AGGRESSIVE_EXIT_ROOM_TILES,
  DECEL_TILES_PER_SEC2,
  ENTRY_REQUEST_DIST_TILES,
  EXIT_ROOM_TILES,
  GRIDLOCK_RELIEF_MS,
  LEFT_YIELD_LOOKAHEAD_TILES,
  PRIORITY_AGING_PER_MS,
  PRIORITY_AGING_MAX,
  RED_RIGHT_STOP_DWELL_MS,
  RIGHT_ON_RED_GAP_TILES,
  YIELD_MOVING_SPEED,
} from '../simConstants';
import {
  MOVEMENT_CLEARANCE_TILES,
  movementPathAt,
  pathDistance,
  routeSegmentDir,
} from './laneGeometry';
import { JunctionIndex, TurnKind, turnKind, type Junction } from './junctions';
import type { Route } from './router';
import { SignalState, signalState } from './signals';
import type { Vehicle } from './vehicles';

/**
 * 교차로 통행권 관리.
 *
 * ── 예전 방식의 문제 ──────────────────────────────────────────────
 * 예전에는 매 프레임 "지금 이 타일을 쓰는 움직임" 목록을 새로 만들고, 다음 타일이
 * 겹치면 멈췄다. 이게 세 가지를 못 했다.
 *
 *  1. **우선순위가 없다.** 두 차가 동시에 요청하면 배열 순서가 승자를 정했다.
 *     순서는 매 프레임 바뀌므로 서로 양보하다 둘 다 못 가거나, 둘 다 가서 겹쳤다.
 *  2. **예약이 유지되지 않는다.** 교차로에 들어간 차가 다음 프레임에 통행권을
 *     잃을 수 있었다. 그래서 교차로 한복판에서 궤적이 겹쳤다.
 *  3. **타일 단위였다.** 4차로 교차로는 2x2 = 4칸이다. 칸마다 따로 판정하면
 *     같은 교차로 안에서 서로 다른 칸을 통과하는 두 궤적이 실제로는 교차하는데도
 *     각자 통과해 버린다.
 *
 * ── 지금 ──────────────────────────────────────────────────────────
 * 통행권은 **교차로 영역 전체에 대한 지속 예약**이다. 한 번 받으면 다 빠져나갈
 * 때까지 유지된다. 매 프레임 대기 중인 차들을 모아 **점수순으로 한 번에 배분**하고,
 * 이미 예약된 궤적과 실제로 교차하는 요청만 거절한다.
 *
 * 점수 = 신호 + 회전종류(직진 > 우회전 > 좌회전) + 큰길 우선 + 우측차량 우선
 *        + 대기시간 가산(굶주림 방지) + 결정적 타이브레이크
 *
 * 결정적이므로 프레임마다 승자가 바뀌지 않고(깜빡임 없음), 대기시간 가산이 있어
 * 영원히 못 들어가는 차가 없다.
 */

export interface JunctionPath {
  junctionId: number;
  /** 교차로 안 첫 노드의 경로 인덱스. */
  entryIndex: number;
  /** 교차로 안 마지막 노드의 경로 인덱스. */
  exitIndex: number;
  enterDir: number;
  leaveDir: number;
  turn: TurnKind;
  /** 통과 궤적. [tx, ty, inDir, outDir] 4개씩. */
  cells: number[];
}

/** 경로의 fromIdx 이후 첫 교차로 통과 구간을 만든다. 없으면 null. */
export function buildJunctionPath(
  route: Route,
  fromIdx: number,
  index: JunctionIndex,
): JunctionPath | null {
  const points = route.tiles.length / 2;
  let entry = -1;
  let id = -1;
  for (let i = Math.max(0, fromIdx); i < points; i++) {
    const jid = index.idAt(route.tiles[i * 2], route.tiles[i * 2 + 1]);
    if (jid >= 0) {
      entry = i;
      id = jid;
      break;
    }
  }
  if (entry < 0) return null;

  let exit = entry;
  while (
    exit + 1 < points &&
    index.idAt(route.tiles[(exit + 1) * 2], route.tiles[(exit + 1) * 2 + 1]) === id
  ) {
    exit++;
  }

  const cells: number[] = [];
  for (let i = entry; i <= exit; i++) {
    const inDir = i <= 0 ? routeSegmentDir(route, 0) : routeSegmentDir(route, i - 1);
    const outDir = i >= points - 1 ? inDir : routeSegmentDir(route, i);
    cells.push(route.tiles[i * 2], route.tiles[i * 2 + 1], inDir, outDir);
  }

  const enterDir = cells[2];
  const leaveDir = cells[cells.length - 1];
  return {
    junctionId: id,
    entryIndex: entry,
    exitIndex: exit,
    enterDir,
    leaveDir,
    turn: turnKind(enterDir, leaveDir),
    cells,
  };
}

/**
 * 두 통과 궤적이 서로 막아야 하는 사이인가.
 *
 * ── 왜 "같은 칸" 만 보면 안 되는가 ─────────────────────────────────
 * 4차로 x 4차로 교차로는 2x2 = 네 칸이다. 서로 다른 칸을 지나는 두 궤적도
 * 칸 경계에서는 바로 옆을 스쳐 간다. 차체 길이가 0.5타일이라 경계에 걸친 차는
 * 이웃 칸까지 넘어와 있다. 그래서 칸별로 나눠서 보면 "안 부딪힌다" 는 답이
 * 나오는데 화면에서는 두 대가 정확히 겹친다.
 *
 * 지금은 두 궤적의 모든 선분 쌍을 **타일 절대 좌표**에서 비교하고, 최단거리가
 * 차 폭보다 가까우면 충돌로 본다. 같은 칸에 같은 방향으로 들어오는 조합만
 * 예외다 — 그건 줄서서 가는 것이므로 앞차 간격이 처리한다.
 */
export function pathsConflict(a: JunctionPath, b: JunctionPath): boolean {
  if (a.junctionId !== b.junctionId) return false;
  for (let i = 0; i < a.cells.length; i += 4) {
    const ac = movementPathAt(a.cells[i], a.cells[i + 1], a.cells[i + 2], a.cells[i + 3]);
    for (let j = 0; j < b.cells.length; j += 4) {
      // 같은 칸에 같은 방향으로 들어오는 것은 줄서기다.
      if (
        a.cells[i + 2] === b.cells[j + 2] &&
        a.cells[i] === b.cells[j] &&
        a.cells[i + 1] === b.cells[j + 1]
      ) {
        continue;
      }
      // 같은 칸에서 같은 차선으로 빠져나가면 합류이므로 무조건 충돌이다.
      const bc = movementPathAt(b.cells[j], b.cells[j + 1], b.cells[j + 2], b.cells[j + 3]);
      if (pathDistance(ac, bc) < MOVEMENT_CLEARANCE_TILES) return true;
    }
  }
  return false;
}

/** 교차로 진입을 기다리는(또는 다가오는) 차량 한 대의 상태. */
export interface Approach {
  vehicle: Vehicle;
  path: JunctionPath;
  /** 정지선까지 남은 거리(타일). 음수면 이미 교차로 안이다. */
  distance: number;
  speed: number;
  /**
   * 교차로를 빠져나간 뒤 앞이 비어 있는 거리(타일). 꼬리물기 판정의 입력이다.
   * 막힌 차가 없으면 Infinity.
   */
  exitFree: number;
  /**
   * 나와 정지선 사이가 비어 있는 거리(타일).
   *
   * 이게 없으면 앞차에 막혀 정지선까지 갈 수도 없는 차가 통행권을 받아 쥐고
   * 교차로를 잠가 버린다.
   */
  clearAhead: number;
}

interface Reservation {
  vehicle: Vehicle;
  path: JunctionPath;
  grantedMs: number;
}

interface JunctionRuntime {
  reservations: Reservation[];
  /** 대기차가 있는데 아무도 못 들어간 시각. 교착 감지용. */
  jammedSinceMs: number;
}

export class IntersectionControl {
  private runtime = new Map<number, JunctionRuntime>();
  private byVehicle = new Map<Vehicle, Reservation>();

  reset(): void {
    this.runtime.clear();
    this.byVehicle.clear();
  }

  hasReservation(vehicle: Vehicle): boolean {
    return this.byVehicle.has(vehicle);
  }

  reservationOf(vehicle: Vehicle): JunctionPath | null {
    return this.byVehicle.get(vehicle)?.path ?? null;
  }

  release(vehicle: Vehicle): void {
    const held = this.byVehicle.get(vehicle);
    if (!held) return;
    this.byVehicle.delete(vehicle);
    const rt = this.runtime.get(held.path.junctionId);
    if (!rt) return;
    const i = rt.reservations.indexOf(held);
    if (i >= 0) rt.reservations.splice(i, 1);
  }

  /** 지금 교차로 안에 있는(예약을 쥔) 차량 수. */
  occupantCount(junctionId: number): number {
    return this.runtime.get(junctionId)?.reservations.length ?? 0;
  }

  /** 개발용 진단. 교차로별 [id, 점유 대수, 가장 오래된 예약의 나이(ms)]. */
  debugOccupancy(nowMs: number): Array<[number, number, number]> {
    const out: Array<[number, number, number]> = [];
    for (const [id, rt] of this.runtime) {
      if (rt.reservations.length === 0) continue;
      let oldest = 0;
      for (const r of rt.reservations) oldest = Math.max(oldest, nowMs - r.grantedMs);
      out.push([id, rt.reservations.length, Math.round(oldest)]);
    }
    return out.sort((a, b) => b[2] - a[2]);
  }

  /**
   * 한 프레임의 통행권 배분.
   *
   * approaches 에는 교차로에서 LEFT_YIELD_LOOKAHEAD_TILES 안에 있는 차량이 전부
   * 들어온다. 실제로 통행권을 요청하는 것은 정지선 가까이 온 차량뿐이지만,
   * 비보호 좌회전이 "마주 오는 직진차" 를 보려면 아직 멀리 있는 차도 알아야 한다.
   */
  arbitrate(
    timeMs: number,
    approaches: readonly Approach[],
    index: JunctionIndex,
  ): void {
    if (approaches.length === 0) return;

    const groups = new Map<number, Approach[]>();
    for (const a of approaches) {
      const list = groups.get(a.path.junctionId);
      if (list) list.push(a);
      else groups.set(a.path.junctionId, [a]);
    }

    for (const [junctionId, list] of groups) {
      const junction = index.byId(junctionId);
      if (!junction) continue;
      const rt = this.ensure(junctionId);

      const candidates: Approach[] = [];
      for (const a of list) {
        if (this.byVehicle.has(a.vehicle)) continue;
        if (a.distance > ENTRY_REQUEST_DIST_TILES) continue;
        // 정지선까지 가는 길이 막혀 있으면 통행권을 주지 않는다.
        if (a.distance > 0 && a.clearAhead < a.distance + 0.4) continue;
        candidates.push(a);
      }
      if (candidates.length === 0) {
        rt.jammedSinceMs = 0;
        continue;
      }

      // 교착이 길어지면 난폭운전(꼬리물기)을 잠시 끈다. 꼬리물기가 원인인
      // 교착을 꼬리물기로 더 키우지 않기 위해서다.
      if (rt.jammedSinceMs === 0) rt.jammedSinceMs = timeMs;
      const relief = timeMs - rt.jammedSinceMs > GRIDLOCK_RELIEF_MS;

      const scored: { approach: Approach; score: number }[] = [];
      for (const a of candidates) {
        const score = this.score(junction, a, list, timeMs);
        if (score !== null) scored.push({ approach: a, score });
      }
      scored.sort((p, q) => q.score - p.score);

      let grantedAny = false;
      for (const entry of scored) {
        const approach = entry.approach;
        const path = approach.path;
        let blocked = false;
        for (const held of rt.reservations) {
          if (pathsConflict(path, held.path)) { blocked = true; break; }
        }
        if (blocked) continue;
        // 꼬리물기 판정은 여기서 한다. 이 프레임에 방금 통행권을 준 차까지
        // 세어야 "둘이 같은 출구로 나가려다 둘 다 갇히는" 경우가 막힌다.
        // 아직 정지선을 넘지 않은 차만 꼬리물기 판정을 받는다. 이미 교차로 안에
        // 들어와 있는 차는 나가는 것 말고 할 수 있는 게 없다.
        // (거리 부호로 판정하면 정지선에 딱 붙어 -0.001 이 된 차가 판정을 건너뛰어
        //  출구가 막혔는데도 통행권을 쥐고 교차로를 잠근다. 실제로 그랬다.)
        if (
          approach.vehicle.routeIdx < path.entryIndex &&
          !this.exitHasRoom(rt, approach, relief)
        ) {
          continue;
        }
        const reservation: Reservation = {
          vehicle: approach.vehicle,
          path,
          grantedMs: timeMs,
        };
        rt.reservations.push(reservation);
        this.byVehicle.set(approach.vehicle, reservation);
        grantedAny = true;
      }
      if (grantedAny) rt.jammedSinceMs = 0;
    }
  }

  /**
   * 교차로를 나간 자리가 충분한가.
   *
   * 같은 출구로 나가기로 이미 통행권을 받은 차가 있으면 그만큼 더 필요하다.
   * 이 계산을 빼먹으면 앞뒤로 두 대가 같은 출구를 향해 들어가 뒤차가 교차로
   * 한가운데 갇힌다.
   */
  private exitHasRoom(rt: JunctionRuntime, a: Approach, relief: boolean): boolean {
    const path = a.path;
    let needed = EXIT_ROOM_TILES;
    const lastCell = path.cells.length - 4;
    for (const held of rt.reservations) {
      const other = held.path;
      const otherLast = other.cells.length - 4;
      if (other.leaveDir !== path.leaveDir) continue;
      if (other.cells[otherLast] !== path.cells[lastCell]) continue;
      if (other.cells[otherLast + 1] !== path.cells[lastCell + 1]) continue;
      needed += EXIT_ROOM_TILES;
    }
    if (a.exitFree >= needed) return true;
    // 난폭운전 차량만 무리해서 들어간다. 교착이 길어지면 그마저도 막는다.
    if (!a.vehicle.aggressive || relief) return false;
    return a.exitFree >= AGGRESSIVE_EXIT_ROOM_TILES;
  }

  /** 통행권 점수. null 이면 이번 프레임에는 자격 자체가 없다. */
  private score(
    junction: Junction,
    a: Approach,
    all: readonly Approach[],
    timeMs: number,
  ): number | null {
    const vehicle = a.vehicle;
    const path = a.path;

    // 이미 교차로 안에 들어와 있는 차(경계에서 생성됐거나 색인이 다시 만들어진
    // 경우)는 신호를 따질 대상이 아니다. 궤적이 비면 최우선으로 내보낸다.
    if (vehicle.routeIdx >= path.entryIndex) {
      return 5000 + (simHash(WORLD_SEED, vehicle.destTx, vehicle.destTy, path.entryIndex) % 97) * 0.01;
    }

    const state = signalState(junction, path.enterDir, timeMs);

    let base: number;
    if (state === SignalState.Green) {
      base = 1000;
    } else if (state === SignalState.Yellow) {
      // 딜레마 존: 지금 제동해도 정지선을 넘길 상황이면 그냥 통과한다.
      const stopDist = (a.speed * a.speed) / (2 * DECEL_TILES_PER_SEC2);
      if (a.distance > stopDist + 0.05) return null;
      base = 950;
    } else {
      // 적신호. 우회전만 예외다.
      if (path.turn !== TurnKind.Right) return null;
      // 실제 법: 정지선에서 **일시정지** 후, 진행 차량이 없고 보행자가 없으면 진행.
      if (vehicle.stoppedMs < RED_RIGHT_STOP_DWELL_MS) return null;
      if (pedestrianBlocking()) return null;
      // "차량 없으면" — 녹색을 받은 축에서 다가오는 차와 궤적이 겹치면 못 간다.
      for (const other of all) {
        if (other.vehicle === vehicle) continue;
        if (other.distance > RIGHT_ON_RED_GAP_TILES) continue;
        if (signalState(junction, other.path.enterDir, timeMs) === SignalState.Red) continue;
        if (pathsConflict(path, other.path)) return null;
      }
      base = 200;
    }

    // 비보호 좌회전: 마주 오는 직진/우회전에 양보한다.
    if (path.turn === TurnKind.Left) {
      const oncoming = (path.enterDir + 2) & 3;
      for (const other of all) {
        if (other.vehicle === vehicle) continue;
        if (other.path.enterDir !== oncoming) continue;
        if (other.path.turn === TurnKind.Left) continue; // 마주 보는 좌회전끼리는 서로 지나간다
        if (other.distance > LEFT_YIELD_LOOKAHEAD_TILES) continue;
        if (other.speed < YIELD_MOVING_SPEED && other.distance > ENTRY_REQUEST_DIST_TILES) continue;
        if (signalState(junction, other.path.enterDir, timeMs) === SignalState.Red) continue;
        if (pathsConflict(path, other.path)) return null;
      }
    }

    let score = base;

    // 직진 우선, 그다음 우회전, 좌회전이 마지막.
    if (path.turn === TurnKind.Straight) score += 60;
    else if (path.turn === TurnKind.Right) score += 45;
    else if (path.turn === TurnKind.Left) score += 10;

    if (!junction.signalized) {
      // 큰길 우선: 넓은 진입로에서 온 차가 먼저 간다.
      const leg = junction.legs.find((l) => l.enterDir === path.enterDir);
      if (leg && leg.width >= junction.maxLegWidth) score += 70;
      // 우측차량 우선: 내 오른쪽에서 오는 차가 있으면 내가 양보한다.
      // (4방향이 동시에 물리면 모두 같은 감점을 받아 대기시간으로 풀린다.)
      const fromMyRight = (path.enterDir + 3) & 3;
      for (const other of all) {
        if (other.vehicle === vehicle) continue;
        if (other.path.enterDir !== fromMyRight) continue;
        if (other.distance > ENTRY_REQUEST_DIST_TILES) continue;
        if (!pathsConflict(path, other.path)) continue;
        score -= 120;
        break;
      }
    }

    // 굶주림 방지. 오래 기다린 차가 결국 이긴다.
    score += Math.min(PRIORITY_AGING_MAX, vehicle.waitMs * PRIORITY_AGING_PER_MS);

    // 점수가 같을 때도 프레임마다 승자가 바뀌지 않도록 결정적으로 흔든다.
    score += (simHash(WORLD_SEED, vehicle.destTx, vehicle.destTy, path.entryIndex) % 97) * 0.01;
    return score;
  }

  private ensure(junctionId: number): JunctionRuntime {
    let rt = this.runtime.get(junctionId);
    if (!rt) {
      rt = { reservations: [], jammedSinceMs: 0 };
      this.runtime.set(junctionId, rt);
    }
    return rt;
  }
}

/**
 * 보행자 횡단 여부.
 *
 * 보행자 시뮬레이션이 아직 없으므로 항상 false 다. 보행 신호가 들어오면
 * 이 함수만 교차로/진입방향을 받아 판정하도록 바꾸면 되고, 호출부(적신호
 * 우회전 판정)는 그대로 둔다.
 */
function pedestrianBlocking(): boolean {
  return false;
}
