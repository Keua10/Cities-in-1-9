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
 * 대도시 생성기의 도로만 학생 도로와 같은 "명시적 연결" 규칙으로 바꾸는 래퍼.
 *
 * 기존 cityGen 은 setBuild(..., false) 로 도로를 만든다. World 는 이 경우 예전
 * 생성 도시 호환을 위해 roadLinks=255(인접 도로 자동 연결)로 기록한다. 그래서
 * 2칸 폭 간선도로가 옆 차선과 매 칸 연결되고, 서로 스치기만 한 도로도 전부
 * 교차로가 된다.
 *
 * 생성 중 도로 배치에 한해서 byUser=true 로 넘겨 roadLinks=0에서 시작하게 한 뒤,
 * 도시 생성이 끝나면 도로의 실제 모양을 보고 필요한 방향만 연결한다. World의
 * 기존 저장 호환 규칙과 학생이 직접 그리는 도로 동작은 수정하지 않는다.
 */
export function seedCityIfEmpty(world: World, bornDay = 0): SeededCity | null {
  if (world.developedParcels().length > 0) return null;

  const originalSetBuild = world.setBuild.bind(world);
  world.setBuild = ((tx: number, ty: number, value: number, byUser = true): void => {
    const explicitGeneratedRoad = value === Build.Road && byUser === false;
    originalSetBuild(tx, ty, value, explicitGeneratedRoad ? true : byUser);
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
 * 생성된 도로를 기하 형태에 따라 연결한다.
 *
 * 기본적으로 맞닿은 연속 도로는 연결하되, 두 도로가 나란히 달리는 상황에서는
 * 옆 차선 사이의 횡방향 연결을 만들지 않는다. 반대로 바깥쪽으로 도로가 이어지는
 * 실제 교차점/T자 구간에서는 연결을 허용한다.
 *
 * 이 규칙 덕분에 2칸 폭 큰길은 두 차선이 매 타일마다 사다리처럼 연결되지 않고,
 * 골목이나 다른 간선이 실제로 들어오는 곳에서만 교차로가 생긴다.
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

        if (
          isRoad(world, tx + 1, ty) &&
          shouldConnectHorizontal(world, tx, ty) &&
          canConnectRoads(world, tx, ty, tx + 1, ty).ok
        ) {
          world.connectRoads(tx, ty, tx + 1, ty);
        }
        if (
          isRoad(world, tx, ty + 1) &&
          shouldConnectVertical(world, tx, ty) &&
          canConnectRoads(world, tx, ty, tx, ty + 1).ok
        ) {
          world.connectRoads(tx, ty, tx, ty + 1);
        }
      }
    }
  }
}

/** +x 방향 두 도로가 같은 세로 큰길의 나란한 차선이면 연결하지 않는다. */
function shouldConnectHorizontal(world: World, tx: number, ty: number): boolean {
  const aRunsVertical = isRoad(world, tx, ty - 1) || isRoad(world, tx, ty + 1);
  const bRunsVertical = isRoad(world, tx + 1, ty - 1) || isRoad(world, tx + 1, ty + 1);
  if (!aRunsVertical || !bRunsVertical) return true;

  // 두 칸 바깥 중 하나라도 수평 도로가 계속되면 실제 교차/합류 구간이다.
  const horizontalContinues = isRoad(world, tx - 1, ty) || isRoad(world, tx + 2, ty);
  return horizontalContinues;
}

/** +y 방향 두 도로가 같은 가로 큰길의 나란한 차선이면 연결하지 않는다. */
function shouldConnectVertical(world: World, tx: number, ty: number): boolean {
  const aRunsHorizontal = isRoad(world, tx - 1, ty) || isRoad(world, tx + 1, ty);
  const bRunsHorizontal = isRoad(world, tx - 1, ty + 1) || isRoad(world, tx + 1, ty + 1);
  if (!aRunsHorizontal || !bRunsHorizontal) return true;

  // 두 칸 바깥 중 하나라도 수직 도로가 계속되면 실제 교차/합류 구간이다.
  const verticalContinues = isRoad(world, tx, ty - 1) || isRoad(world, tx, ty + 2);
  return verticalContinues;
}

function isRoad(world: World, tx: number, ty: number): boolean {
  return world.sampleBuild(tx, ty) === Build.Road;
}
