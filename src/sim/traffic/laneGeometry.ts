import { DIRS } from '../../world/build';
import {
  LANE_CORNER_RADIUS_TILES,
  LANE_OFFSET_TILES,
  MOVEMENT_CLEARANCE_TILES,
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

export { LANE_OFFSET_TILES, MOVEMENT_CLEARANCE_TILES };

/** 코너 베지에가 차지하는 구간 길이(타일). 0.5 를 넘으면 이웃 코너와 겹친다. */
const CORNER_R = Math.min(0.5, Math.max(LANE_OFFSET_TILES + 0.05, LANE_CORNER_RADIUS_TILES));

/** 인접한 두 타일 (x,y) -> (nx,ny) 사이의 이동 방향. 인접하지 않으면 0. */
export function dirBetween(x: number, y: number, nx: number, ny: number): number {
  for (let d = 0; d < DIRS.length; d++) {
    const dir = DIRS[d];
    if (x + dir[0] === nx && y + dir[1] === ny) return d;
  }
  return 0;
}

/** 경로 세그먼트(노드 i -> i+1)의 진행 방향 인덱스. */
export function routeSegmentDir(route: Route, segmentIndex: number): number {
  const points = route.tiles.length / 2;
  if (points < 2) return 0;
  const i = Math.max(0, Math.min(points - 2, segmentIndex)) * 2;
  return dirBetween(route.tiles[i], route.tiles[i + 1], route.tiles[i + 2], route.tiles[i + 3]);
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
  const incoming =
    nodeIndex <= 0 ? routeSegmentDir(route, 0) : routeSegmentDir(route, nodeIndex - 1);
  const outgoing = nodeIndex >= points - 1 ? incoming : routeSegmentDir(route, nodeIndex);
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
export function lanePosition(route: Route, routeIdx: number, tileT: number): [number, number] {
  return laneSample(route, routeIdx, tileT).pos;
}

/** 차량이 향한 방향(타일 좌표 단위벡터). 코너에서는 베지에 접선이다. */
export function laneHeading(route: Route, routeIdx: number, tileT: number): [number, number] {
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

/**
 * 현재 위치가 직선 차선이 아니라 교차로의 베지에 코너 위에 있는가.
 *
 * 렌더러는 회전 차량만 지형 청크보다 위에 따로 그린다. 지형은 64x64 타일을
 * 한 메시로 묶기 때문에 코너에서 차량의 실제 위치가 앞쪽 청크로 넘어가면 그
 * 청크의 도로가 차량을 덮을 수 있다. 코너 판정이 laneSample 과 달라지지 않도록
 * 같은 구간 규칙을 여기서 공유한다.
 */
export function laneIsTurning(route: Route, routeIdx: number, tileT: number): boolean {
  const points = route.tiles.length / 2;
  if (points < 3) return false;

  const progress = Math.max(0, Math.min(points - 1, routeIdx + Math.max(0, Math.min(1, tileT))));
  const i = Math.min(points - 2, Math.floor(progress));
  const u = progress - i;
  const d = routeSegmentDir(route, i);

  if (u > 1 - CORNER_R && i + 1 <= points - 2) {
    if (routeSegmentDir(route, i + 1) !== d) return true;
  }
  if (u < CORNER_R && i - 1 >= 0) {
    if (routeSegmentDir(route, i - 1) !== d) return true;
  }
  return false;
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
 * 궤적의 중간점(코너에서는 실제 베지에의 중점).
 *
 * 직선 하나로만 궤적을 나타내면 회전이 실제로 어느 쪽으로 부풀어 도는지가
 * 사라진다. L자 코너의 양방향은 곡선이 서로 **반대쪽으로** 부풀어 실제로는
 * 0.48타일 떨어져 지나가는데, 직선(현)으로 재면 0.35타일로 나와 서로 막게 된다.
 * 반대로 마주 보는 좌회전끼리는 곡선이 가운데로 파고들어 실제로는 0.21타일까지
 * 붙는데 현으로 재면 0.35타일로 나와 "지나가도 된다" 는 잘못된 답이 나온다.
 * 중간점 하나를 끼워 꺾은선으로 만들면 두 경우가 모두 맞는다.
 */
export function movementMid(dIn: number, dOut: number): [number, number] {
  const [rix, riy] = rightOffset(dIn);
  if (dIn === dOut) return [rix, riy];
  const a = DIRS[dIn];
  const b = DIRS[dOut];
  const [rox, roy] = rightOffset(dOut);
  const q0x = -a[0] * CORNER_R + rix;
  const q0y = -a[1] * CORNER_R + riy;
  const cx = rix + rox;
  const cy = riy + roy;
  const q2x = b[0] * CORNER_R + rox;
  const q2y = b[1] * CORNER_R + roy;
  return [0.25 * q0x + 0.5 * cx + 0.25 * q2x, 0.25 * q0y + 0.5 * cy + 0.25 * q2y];
}

/**
 * 한 칸에서의 궤적을 타일 절대 좌표의 꺾은선(점 3개)으로. 교차로가 여러 칸일 때
 * 칸별 상대 좌표로는 이웃 칸에 걸친 차를 볼 수 없어 절대 좌표가 필요하다.
 * 반환값은 [x0, y0, xm, ym, x1, y1].
 */
export function movementPathAt(
  tx: number,
  ty: number,
  dIn: number,
  dOut: number,
): [number, number, number, number, number, number] {
  const c = movementChord(dIn, dOut);
  const m = movementMid(dIn, dOut);
  return [tx + c[0], ty + c[1], tx + m[0], ty + m[1], tx + c[2], ty + c[3]];
}

/** 두 꺾은선 사이의 최단거리. */
export function pathDistance(a: readonly number[], b: readonly number[]): number {
  let best = Infinity;
  for (let i = 0; i + 3 < a.length; i += 2) {
    for (let j = 0; j + 3 < b.length; j += 2) {
      const d = segmentDistance(
        a[i],
        a[i + 1],
        a[i + 2],
        a[i + 3],
        b[j],
        b[j + 1],
        b[j + 2],
        b[j + 3],
      );
      if (d < best) best = d;
      if (best === 0) return 0;
    }
  }
  return best;
}

/**
 * 두 움직임이 서로 막아야 하는 사이인가(같은 타일 안에서).
 *
 * ── 왜 "교차하는가" 가 아니라 "얼마나 가까운가" 인가 ────────────────
 * 예전에는 두 선분이 실제로 **교차할 때만** 충돌로 봤다. 그런데 차에는 폭이
 * 있다. 선분이 교차하지 않아도 0.1타일 옆을 스쳐 가면 차체는 겹친다. 실제로
 * 넓은 교차로에서 "충돌하지 않는다" 고 판정된 두 대가 화면에서는 서로를 뚫고
 * 지나가려다 둘 다 굳어 버렸다(겹침 방지 장치가 둘 다 세워서).
 *
 * 그래서 두 궤적 사이의 **최단거리**가 차 폭보다 가까우면 충돌로 본다.
 *   - 마주 오는 직진끼리는 중심 간격이 0.5타일이라 그대로 통과한다.
 *   - 마주 보는 좌회전끼리는 0.354타일까지 붙는다. 차 폭이 0.30이므로 이건
 *     실제로 스치는 거리다. 예전에는 통과시켰지만 지금은 막는다.
 */
export function movementsConflict(inA: number, outA: number, inB: number, outB: number): boolean {
  if (inA === inB) return false;
  if (outA === outB) return true;
  return (
    pathDistance(movementPathAt(0, 0, inA, outA), movementPathAt(0, 0, inB, outB)) <
    MOVEMENT_CLEARANCE_TILES
  );
}

/** 두 선분 사이의 최단거리. */
export function segmentDistance(
  ax0: number,
  ay0: number,
  ax1: number,
  ay1: number,
  bx0: number,
  by0: number,
  bx1: number,
  by1: number,
): number {
  if (segmentsCross(ax0, ay0, ax1, ay1, bx0, by0, bx1, by1)) return 0;
  return Math.min(
    pointSegment(ax0, ay0, bx0, by0, bx1, by1),
    pointSegment(ax1, ay1, bx0, by0, bx1, by1),
    pointSegment(bx0, by0, ax0, ay0, ax1, ay1),
    pointSegment(bx1, by1, ax0, ay0, ax1, ay1),
  );
}

function pointSegment(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 1e-9 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
}

function segmentsCross(
  ax0: number,
  ay0: number,
  ax1: number,
  ay1: number,
  bx0: number,
  by0: number,
  bx1: number,
  by1: number,
): boolean {
  const d1 = cross(bx1 - bx0, by1 - by0, ax0 - bx0, ay0 - by0);
  const d2 = cross(bx1 - bx0, by1 - by0, ax1 - bx0, ay1 - by0);
  const d3 = cross(ax1 - ax0, ay1 - ay0, bx0 - ax0, by0 - ay0);
  const d4 = cross(ax1 - ax0, ay1 - ay0, bx1 - ax0, by1 - ay0);
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}
