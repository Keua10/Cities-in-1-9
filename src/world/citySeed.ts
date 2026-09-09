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
 * 대도시 생성 도로를 학생 도로와 같은 "명시적 연결" 방식으로 바꾸는 래퍼.
 *
 * cityGen 은 생성 도로를 setBuild(..., false) 로 놓는다. 그대로 두면 과거 생성도시
 * 호환 규칙 때문에 roadLinks=255가 되어, 붙어 있는 도로가 전부 연결된다.
 * 생성 중 도로만 roadLinks=0에서 시작시킨 뒤 도시 생성이 끝났을 때 도로 형상을
 * 읽어 필요한 연결만 만든다.
 */
export function seedCityIfEmpty(world: World, bornDay = 0): SeededCity | null {
  if (world.developedParcels().length > 0) return null;

  const originalSetBuild = world.setBuild.bind(world);
  world.setBuild = ((tx: number, ty: number, value: number, byUser = true): void => {
    const generatedRoad = value === Build.Road && byUser === false;
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

/**
 * 2칸 폭 도로 판정에 쓰는 길이.
 *
 * 한 칸 위/아래만 보고 "평행 차선" 을 판단하면 교차로 근처나 구불구불한 도로에서
 * 오판이 많다. 두 칸짜리 띠가 최소 3행/3열 이상 이어질 때만 실제 2차선 도로로 본다.
 */
const PARALLEL_SUPPORT_MIN = 2;
const PARALLEL_SCAN = 4;
/** 실제로 다른 도로가 진입한다고 보려면 바깥쪽으로 이만큼 연속돼야 한다. */
const APPROACH_RUN_MIN = 2;

/**
 * 생성된 도로망에 명시적 연결을 만든다.
 *
 * 핵심 규칙:
 * - 1칸 폭 도로: 맞닿은 진행 방향을 정상 연결.
 * - 2칸 폭 도로: 각 차선의 진행 방향은 연결하되 차선 사이 "사다리 연결" 은 막음.
 * - 교차/T자/넓은 도로 코너: 바깥에서 실제 도로가 2칸 이상 들어오는 지점만 횡연결.
 *
 * 즉 단순히 "옆에 도로가 있다" 가 아니라 주변 4칸까지의 연속성을 보고 판정한다.
 */
function connectGeneratedRoadNetwork(world: World): void {
  for (const parcel of world.developedParcels()) {
    const build = parcel.build;
    if (!build) continue;

    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const i = ly * CHUNK_SIZE + lx;
        if (build[i] !== Build.Road) continue;

        const tx = parcel.cx * CHUNK_SIZE + lx;
        const ty = parcel.cy * CHUNK_SIZE + ly;

        tryConnect(world, tx, ty, tx + 1, ty);
        tryConnect(world, tx, ty, tx, ty + 1);
      }
    }
  }
}

function tryConnect(world: World, ax: number, ay: number, bx: number, by: number): void {
  if (!isRoad(world, bx, by)) return;
  if (!shouldConnect(world, ax, ay, bx, by)) return;
  if (!canConnectRoads(world, ax, ay, bx, by).ok) return;
  world.connectRoads(ax, ay, bx, by);
}

/** 두 인접 도로 사이의 실제 연결이 필요한가. */
function shouldConnect(world: World, ax: number, ay: number, bx: number, by: number): boolean {
  if (ay === by) {
    // 좌우로 맞닿은 두 칸이 세로 2차선 도로의 양 차선이면 보통 연결하지 않는다.
    if (!isVerticalLanePair(world, Math.min(ax, bx), ay)) return true;
    return hasHorizontalApproach(world, Math.min(ax, bx), ay);
  }

  // 위아래로 맞닿은 두 칸이 가로 2차선 도로의 양 차선이면 보통 연결하지 않는다.
  if (!isHorizontalLanePair(world, ax, Math.min(ay, by))) return true;
  return hasVerticalApproach(world, ax, Math.min(ay, by));
}

/** (x,y)-(x+1,y)가 세로 방향으로 함께 이어지는 2칸 폭 띠인가. */
function isVerticalLanePair(world: World, x: number, y: number): boolean {
  let support = 0;
  for (let step = 1; step <= PARALLEL_SCAN; step++) {
    if (isRoad(world, x, y - step) && isRoad(world, x + 1, y - step)) support++;
    else break;
  }
  for (let step = 1; step <= PARALLEL_SCAN; step++) {
    if (isRoad(world, x, y + step) && isRoad(world, x + 1, y + step)) support++;
    else break;
  }
  return support >= PARALLEL_SUPPORT_MIN;
}

/** (x,y)-(x,y+1)가 가로 방향으로 함께 이어지는 2칸 폭 띠인가. */
function isHorizontalLanePair(world: World, x: number, y: number): boolean {
  let support = 0;
  for (let step = 1; step <= PARALLEL_SCAN; step++) {
    if (isRoad(world, x - step, y) && isRoad(world, x - step, y + 1)) support++;
    else break;
  }
  for (let step = 1; step <= PARALLEL_SCAN; step++) {
    if (isRoad(world, x + step, y) && isRoad(world, x + step, y + 1)) support++;
    else break;
  }
  return support >= PARALLEL_SUPPORT_MIN;
}

/**
 * 세로 2차선 띠를 좌우로 가로지르는 실제 도로가 있는가.
 * 한 칸짜리 돌출이나 옆 차선의 우연한 접촉은 교차로로 취급하지 않는다.
 */
function hasHorizontalApproach(world: World, x: number, y: number): boolean {
  return (
    roadRun(world, x - 1, y, -1, 0, APPROACH_RUN_MIN) ||
    roadRun(world, x + 2, y, 1, 0, APPROACH_RUN_MIN)
  );
}

/** 가로 2차선 띠를 위아래로 가로지르는 실제 도로가 있는가. */
function hasVerticalApproach(world: World, x: number, y: number): boolean {
  return (
    roadRun(world, x, y - 1, 0, -1, APPROACH_RUN_MIN) ||
    roadRun(world, x, y + 2, 0, 1, APPROACH_RUN_MIN)
  );
}

function roadRun(
  world: World,
  sx: number,
  sy: number,
  dx: number,
  dy: number,
  length: number,
): boolean {
  for (let step = 0; step < length; step++) {
    if (!isRoad(world, sx + dx * step, sy + dy * step)) return false;
  }
  return true;
}

function isRoad(world: World, tx: number, ty: number): boolean {
  return world.sampleBuild(tx, ty) === Build.Road;
}
