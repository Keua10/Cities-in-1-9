import { DIRS } from '../../world/build';
import {
  LANE_CORNER_RADIUS_TILES,
  LANE_OFFSET_TILES,
} from '../simConstants';
import type { Route } from './router';

/**
 * 우측통행 차선 기하 (타일 좌표계가 유일한 기준이다)
 *
 * ── 왜 타일 좌표계인가 ─────────────────────────────────────────────
 * 아이소메트릭 투영은 각도를 보존하지 않는다. 화면 픽셀에서 "진행벡터의 법선"을
 * 구하면 방향마다 도로 밖으로 나가거나 중앙선에 붙는다. 지면(타일 평면)에서
 * 한 번만 계산하고, 렌더러는 그 결과를 그대로 투영하기만 한다.
 *
 * ── 진행방향의 오른쪽이 왜 (dir + 1) 인가 ─────────────────────────
 * iso.ts: +tx -> 화면 (+TILE_HW, +TILE_HH) = 오른쪽아래
 *         +ty -> 화면 (-TILE_HW, +TILE_HH) = 왼쪽아래
 * y가 아래로 증가하는 화면에서 진행방향 d의 오른손 방향은 d를 시계방향으로
 * 90도 돌린 쪽이다. +tx(오른쪽아래)를 시계방향으로 돌리면 아래->왼쪽아래이므로
 * +ty 가 된다. DIRS 순서가 +tx, +ty, -tx, -ty 이므로 오른쪽 = (dir + 1) & 3.
 *   dir 0(+tx) -> 1(+ty)   dir 1(+ty) -> 2(-tx)
 *   dir 2(-tx) -> 3(-ty)   dir 3(-ty) -> 0(+tx)
 * 이 한 줄이 우측통행의 전부다. 나머지는 이 오프셋을 매끄럽게 잇는 일이다.
 *
 * ── 코너 ──────────────────────────────────────────────────────────
 * 예전 구현은 코너에서 "진입 차선과 진출 차선의 교점"을 꺾은선으로 이었다.
 * 그래서 차가 직각으로 꺾이고, 우회전과 좌회전 궤적이 구분되지 않았다.
 * 지금은 교점을 2차 베지에의 제어점으로 쓴다. 제어점이 곧 교점이므로
 * 직선 구간과 접선이 정확히 이어지고, 우회전은 안쪽으로 짧게, 좌회전은
 * 바깥으로 넓게 돌아 나간다.
 */

export { LANE_OFFSET_TILES };

/** 코너 베지에가 차지하는 구간 길이(타일). 0.5 를 넘으면 이웃 코너와 겹친다. */
const CORNER_R = Math.min(0.5, Math.max(LANE_OFFSET_TILES + 0.05, LANE_CORNER_RADIUS_TILES));

/** 경로 세그먼트(노드 i -> i+1)의 진행 방향 인덱스. */
export function routeSegmentDir(route: Route, segmentIndex: number): number {
  const points = route.tiles.length / 2;
  if (points < 2) return 0;
  const i = Math.max(0, Math.min(points - 2, segmentIndex)) * 2;
  const x = route.tiles[i];
  const y = route.tiles[i + 1];
  const nx = route.tiles[i + 2];
  const ny = route.tiles[i + 3];
  for (let d = 0; d < DIRS.length; d++) {
    const dir = DIRS[d];
    if (x + dir[0] === nx && y + dir[1] === ny) return d;
  }
  return 0;
}

/** 노드에서 방향이 바뀌는가(=회전 노드인가). */
export function isTurnNode(route: Route, nodeIndex: number): boolean {
  const points = route.tiles.length / 2;
  if (nodeIndex <= 0 || nodeIndex >= points - 1) return false;
  return routeSegmentDir(route, nodeIndex - 1) !== routeSegmentDir(route, nodeIndex);
}

/** 노드에서의 (진입방향, 진출방향). 교차로 충돌 판정의 입력이다. */
export function nodeMovement(route: Route, nodeIndex: number): [number, number] {
  const points = route.tiles.length / 2;
  if (points < 2) return [0, 0];
  const incoming = nodeIndex <= 0
    ? routeSegmentDir(route, 0)
    : routeSegmentDir(route, nodeIndex - 1);
  const outgoing = nodeIndex >= points - 1
    ? incoming
    : routeSegmentDir(route, nodeIndex);
  return [incoming, outgoing];
}

/** 진행방향 기준 오른쪽으로 LANE_OFFSET_TILES 만큼의 벡터(타일 단위). */
export function rightOffset(dir: number): [number, number] {
  const d = DIRS[(dir + 1) & 3] ?? DIRS[1];
  return [d[0] * LANE_OFFSET_TILES, d[1] * LANE_OFFSET_TILES];
}

/**
 * 차량의 실제 위치(타일 좌표, 실수).
 *
 * routeIdx/tileT 는 그대로 "노드 i 에서 i+1 로 가는 진행도" 이지만,
 * 그 값이 가리키는 점은 도로 중앙선이 아니라 우측 차선 중심이다.
 * 시뮬레이션(간격/예약)과 렌더링이 같은 이 함수를 본다.
 */
export function lanePosition(
  route: Route,
  routeIdx: number,
  tileT: number,
): [number, number] {
  return laneSample(route, routeIdx, tileT).pos;
}

/** 차량이 향한 방향(타일 좌표 단위벡터). 코너에서는 베지에 접선이다. */
export function laneHeading(
  route: Route,
  routeIdx: number,
  tileT: number,
): [number, number] {
  return laneSample(route, routeIdx, tileT).tangent;
}

/** 접선에 가장 가까운 DIRS 인덱스. 스프라이트 한 칸을 고를 때 쓴다. */
export function laneFacing(route: Route, routeIdx: number, tileT: number): number {
  const [hx, hy] = laneHeading(route, routeIdx, tileT);
  let bestDir = 0;
  let bestDot = -Infinity;
  for (let d = 0; d < DIRS.length; d++) {
    const dot = hx * DIRS[d][0] + hy * DIRS[d][1];
    if (dot > bestDot) {
      bestDot = dot;
      bestDir = d;
    }
  }
  return bestDir;
}

interface LaneSample {
  pos: [number, number];
  tangent: [number, number];
}

function laneSample(route: Route, routeIdx: number, tileT: number): LaneSample {
  const points = route.tiles.length / 2;
  if (points <= 0) return { pos: [0, 0], tangent: [1, 0] };
  if (points === 1) {
    return { pos: [route.tiles[0], route.tiles[1]], tangent: [DIRS[0][0], DIRS[0][1]] };
  }

  // routeIdx + tileT 를 하나의 진행도로 보고 자른다. 마지막 노드(routeIdx = points-1)
  // 에서 tileT 를 그대로 쓰면 위치가 한 타일 뒤로 튄다.
  const progress = Math.max(0, Math.min(points - 1, routeIdx + Math.max(0, Math.min(1, tileT))));
  const i = Math.min(points - 2, Math.floor(progress));
  const u = progress - i;
  const d = routeSegmentDir(route, i);
  const nodeX = route.tiles[i * 2];
  const nodeY = route.tiles[i * 2 + 1];

  // 이 세그먼트의 끝(노드 i+1)이 회전이면 뒤쪽 CORNER_R 구간은 코너에 속한다.
  if (u > 1 - CORNER_R && i + 1 <= points - 2) {
    const e = routeSegmentDir(route, i + 1);
    if (e !== d) {
      const w = (u - (1 - CORNER_R)) / (2 * CORNER_R);
      return cornerSample(route, i + 1, d, e, w);
    }
  }
  // 이 세그먼트의 시작(노드 i)이 회전이면 앞쪽 CORNER_R 구간은 코너의 후반부다.
  if (u < CORNER_R && i - 1 >= 0) {
    const p = routeSegmentDir(route, i - 1);
    if (p !== d) {
      const w = 0.5 + u / (2 * CORNER_R);
      return cornerSample(route, i, p, d, w);
    }
  }

  const [rx, ry] = rightOffset(d);
  return {
    pos: [nodeX + rx + DIRS[d][0] * u, nodeY + ry + DIRS[d][1] * u],
    tangent: [DIRS[d][0], DIRS[d][1]],
  };
}

/**
 * 노드 `node` 에서 방향 dIn -> dOut 으로 도는 코너의 w(0~1) 지점.
 *
 * Q0 : 진입 차선에서 코너 시작점
 * C  : 진입 차선 직선과 진출 차선 직선의 교점 (= node + right(dIn) + right(dOut))
 * Q2 : 진출 차선에서 코너 끝점
 * 제어점이 두 직선의 교점이므로 접선이 직선 구간과 정확히 이어진다.
 */
function cornerSample(
  route: Route,
  node: number,
  dIn: number,
  dOut: number,
  w: number,
): LaneSample {
  const x = route.tiles[node * 2];
  const y = route.tiles[node * 2 + 1];
  const inDir = DIRS[dIn];
  const outDir = DIRS[dOut];
  const [rix, riy] = rightOffset(dIn);
  const [rox, roy] = rightOffset(dOut);

  const q0x = x - inDir[0] * CORNER_R + rix;
  const q0y = y - inDir[1] * CORNER_R + riy;
  const cx = x + rix + rox;
  const cy = y + riy + roy;
  const q2x = x + outDir[0] * CORNER_R + rox;
  const q2y = y + outDir[1] * CORNER_R + roy;

  const t = Math.max(0, Math.min(1, w));
  const s = 1 - t;
  const px = s * s * q0x + 2 * s * t * cx + t * t * q2x;
  const py = s * s * q0y + 2 * s * t * cy + t * t * q2y;
  let tx = 2 * (s * (cx - q0x) + t * (q2x - cx));
  let ty = 2 * (s * (cy - q0y) + t * (q2y - cy));
  const len = Math.hypot(tx, ty);
  if (len > 1e-6) {
    tx /= len;
    ty /= len;
  } else {
    tx = inDir[0];
    ty = inDir[1];
  }
  return { pos: [px, py], tangent: [tx, ty] };
}

/* ------------------------------------------------------------------ */
/* 교차로 충돌 판정                                                     */
/* ------------------------------------------------------------------ */

/**
 * 한 타일에서 (진입 dIn -> 진출 dOut) 움직임이 지나는 선분.
 * 타일 중심을 원점으로 한 상대 좌표다.
 *
 *   진입점 = 타일 경계에서 dIn 반대쪽 + 진입 차선 오프셋
 *   진출점 = 타일 경계에서 dOut 쪽    + 진출 차선 오프셋
 */
export function movementChord(dIn: number, dOut: number): [number, number, number, number] {
  const a = DIRS[dIn];
  const b = DIRS[dOut];
  const [rix, riy] = rightOffset(dIn);
  const [rox, roy] = rightOffset(dOut);
  return [-a[0] * 0.5 + rix, -a[1] * 0.5 + riy, b[0] * 0.5 + rox, b[1] * 0.5 + roy];
}

/**
 * 같은 타일 위 두 움직임이 서로 막아야 하는 사이인가.
 *
 * 우측통행이면 마주 오는 직진끼리, 마주 오는 좌회전끼리는 서로 지나갈 수 있다.
 * 예전 코드처럼 "교차로 타일 하나에 차 한 대" 로 잠그면 코너에서 반대 차선까지
 * 멈춰 서서 통행량이 반토막 난다. 그래서 실제 궤적(선분)이 만나는지로 판정한다.
 *
 *  - 진입 방향이 같으면: 같은 차선을 줄서서 가는 것이므로 예약이 아니라
 *    앞차 간격(gapAhead)이 처리한다.
 *  - 진출 방향이 같으면: 같은 차선으로 합류하므로 무조건 충돌이다.
 *  - 그 외에는 두 궤적 선분이 교차할 때만 충돌이다.
 */
export function movementsConflict(
  inA: number,
  outA: number,
  inB: number,
  outB: number,
): boolean {
  if (inA === inB) return false;
  if (outA === outB) return true;
  const [ax0, ay0, ax1, ay1] = movementChord(inA, outA);
  const [bx0, by0, bx1, by1] = movementChord(inB, outB);
  return segmentsCross(ax0, ay0, ax1, ay1, bx0, by0, bx1, by1);
}

function segmentsCross(
  ax0: number, ay0: number, ax1: number, ay1: number,
  bx0: number, by0: number, bx1: number, by1: number,
): boolean {
  const d1 = cross(bx1 - bx0, by1 - by0, ax0 - bx0, ay0 - by0);
  const d2 = cross(bx1 - bx0, by1 - by0, ax1 - bx0, ay1 - by0);
  const d3 = cross(ax1 - ax0, ay1 - ay0, bx0 - ax0, by0 - ay0);
  const d4 = cross(ax1 - ax0, ay1 - ay0, bx1 - ax0, by1 - ay0);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}
