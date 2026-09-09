import { CHUNK_SIZE } from '../core/constants';
import { Build, canConnectRoads } from './build';
import {
  seedCityIfEmpty as seedCityIfEmptyOriginal,
  SEEDED_CITY_MONEY,
  type SeededCity,
} from './cityGen';
import type { World } from './world';

export { SEEDED_CITY_MONEY };

/**
 * 대도시 자동 생성 도로만 명시적 연결 방식으로 바꾼다.
 *
 * 생성 도로를 roadLinks=0에서 시작시킨 뒤, 모든 도로가 놓인 다음 주변 도로의
 * "주 진행축"을 계산해서 필요한 방향만 연결한다. 학생이 직접 만든 도로와
 * 기존 저장 도로의 규칙은 건드리지 않는다.
 */
export function seedCityIfEmpty(world: World, bornDay = 0): SeededCity | null {
  if (world.developedParcels().length > 0) return null;

  const originalSetBuild = world.setBuild.bind(world);
  world.setBuild = ((tx: number, ty: number, value: number, byUser = true): void => {
    const generatedRoad = value === Build.Road && byUser === false;
    // 생성 도로만 0비트에서 시작시킨다. 이후 아래에서 필요한 연결만 연다.
    originalSetBuild(tx, ty, value, generatedRoad ? true : byUser);
  }) as World['setBuild'];

  let center: SeededCity | null;
  try {
    center = seedCityIfEmptyOriginal(world, bornDay);
  } finally {
    world.setBuild = originalSetBuild as World['setBuild'];
  }

  if (center) connectGeneratedRoadNetwork(world);
  return center;
}

const enum Axis {
  None = 0,
  Horizontal = 1,
  Vertical = 2,
  Junction = 3,
}

/** 한 방향의 연속 도로를 이 거리까지만 본다. */
const ORIENTATION_SCAN = 7;
/** 이 길이 이상 이어지면 그 축의 실제 도로 흐름으로 인정한다. */
const AXIS_SUPPORT_MIN = 2;
/** 한 축이 다른 축보다 이만큼 길면 주 진행축으로 확정한다. */
const AXIS_DOMINANCE_MARGIN = 2;

interface Flow {
  left: number;
  right: number;
  up: number;
  down: number;
  horizontal: number;
  vertical: number;
  axis: Axis;
}

/**
 * 생성된 도로망을 실제 흐름 방향에 따라 연결한다.
 *
 * 핵심은 "인접했다 = 연결"이 아니다.
 * - 긴 가로 도로는 좌우만 연결한다.
 * - 긴 세로 도로는 상하만 연결한다.
 * - 2칸 폭 큰길의 평행한 두 줄은 서로의 주 진행축과 직각이므로 연결되지 않는다.
 * - 다른 축의 도로가 실제로 들어오는 교차/T자/코너에서만 두 축 연결을 허용한다.
 */
function connectGeneratedRoadNetwork(world: World): void {
  const flowCache = new Map<string, Flow>();

  for (const parcel of world.developedParcels()) {
    const build = parcel.build;
    if (!build) continue;

    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const i = ly * CHUNK_SIZE + lx;
        if (build[i] !== Build.Road) continue;

        const tx = parcel.cx * CHUNK_SIZE + lx;
        const ty = parcel.cy * CHUNK_SIZE + ly;

        // 각 쌍은 한 번만 본다.
        tryConnect(world, flowCache, tx, ty, tx + 1, ty, Axis.Horizontal);
        tryConnect(world, flowCache, tx, ty, tx, ty + 1, Axis.Vertical);
      }
    }
  }
}

function tryConnect(
  world: World,
  cache: Map<string, Flow>,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  edgeAxis: Axis.Horizontal | Axis.Vertical,
): void {
  if (!isRoad(world, bx, by)) return;

  const a = flowAt(world, cache, ax, ay);
  const b = flowAt(world, cache, bx, by);
  if (!edgeBelongsToRoad(a, b, edgeAxis)) return;
  if (!canConnectRoads(world, ax, ay, bx, by).ok) return;
  world.connectRoads(ax, ay, bx, by);
}

/**
 * 이 인접쌍이 실제 도로 흐름에 속하는가.
 *
 * 평행 차선 사이 횡연결은 양 끝 타일이 모두 반대 축을 주 진행축으로 가지므로
 * 여기서 확실히 막힌다. 반대로 교차로(Junction)는 양 축 모두 허용한다.
 */
function edgeBelongsToRoad(a: Flow, b: Flow, edgeAxis: Axis.Horizontal | Axis.Vertical): boolean {
  const otherAxis = edgeAxis === Axis.Horizontal ? Axis.Vertical : Axis.Horizontal;

  // 두 칸 모두 명백히 반대 방향 도로면 평행 차선끼리 맞닿은 것이다.
  if (a.axis === otherAxis && b.axis === otherAxis) return false;

  // 양쪽 중 하나라도 이 방향을 주 진행축으로 가지면 정상 진행 연결이다.
  if (a.axis === edgeAxis || b.axis === edgeAxis) return true;

  // 실제 교차/분기 중심은 두 축을 모두 연결한다.
  if (a.axis === Axis.Junction || b.axis === Axis.Junction) {
    return axisSupported(a, edgeAxis) && axisSupported(b, edgeAxis);
  }

  // 짧은 막다른 길·코너처럼 지배축을 정할 수 없는 경우. 인접쌍의 양쪽에서
  // 해당 축의 연속성이 보일 때만 연결해서 한 칸짜리 우연한 접촉은 막는다.
  return axisSupported(a, edgeAxis) && axisSupported(b, edgeAxis);
}

function axisSupported(flow: Flow, axis: Axis.Horizontal | Axis.Vertical): boolean {
  if (axis === Axis.Horizontal) {
    return flow.horizontal >= AXIS_SUPPORT_MIN || flow.left >= 1 || flow.right >= 1;
  }
  return flow.vertical >= AXIS_SUPPORT_MIN || flow.up >= 1 || flow.down >= 1;
}

function flowAt(world: World, cache: Map<string, Flow>, tx: number, ty: number): Flow {
  const key = `${tx},${ty}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const left = run(world, tx, ty, -1, 0);
  const right = run(world, tx, ty, 1, 0);
  const up = run(world, tx, ty, 0, -1);
  const down = run(world, tx, ty, 0, 1);
  const horizontal = left + right;
  const vertical = up + down;

  let axis = Axis.None;
  const hStrong = horizontal >= AXIS_SUPPORT_MIN;
  const vStrong = vertical >= AXIS_SUPPORT_MIN;

  if (hStrong && vStrong) {
    if (horizontal >= vertical + AXIS_DOMINANCE_MARGIN) axis = Axis.Horizontal;
    else if (vertical >= horizontal + AXIS_DOMINANCE_MARGIN) axis = Axis.Vertical;
    else axis = Axis.Junction;
  } else if (hStrong) {
    axis = Axis.Horizontal;
  } else if (vStrong) {
    axis = Axis.Vertical;
  } else if (horizontal > vertical) {
    axis = Axis.Horizontal;
  } else if (vertical > horizontal) {
    axis = Axis.Vertical;
  }

  const flow = { left, right, up, down, horizontal, vertical, axis };
  cache.set(key, flow);
  return flow;
}

function run(world: World, tx: number, ty: number, dx: number, dy: number): number {
  let n = 0;
  for (let step = 1; step <= ORIENTATION_SCAN; step++) {
    if (!isRoad(world, tx + dx * step, ty + dy * step)) break;
    n++;
  }
  return n;
}

function isRoad(world: World, tx: number, ty: number): boolean {
  return world.sampleBuild(tx, ty) === Build.Road;
}
