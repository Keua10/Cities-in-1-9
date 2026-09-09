import { chunkIndexOf } from '../core/iso';
import { Build, type PlaceResult } from '../world/build';
import { isWater } from '../world/terrain';
import type { World } from '../world/world';
import { BLD_NONE, FACILITY_COUNT, isWelfareKind } from './buildings';
import { edgeNeighbors } from './roadGraph';
import { FACILITY_UNLOCK_LEVEL } from './progression';
import {
  FACILITY_CAPACITY,
  FACILITY_CAPACITY_IS_BUILDINGS,
  FACILITY_COST,
  FACILITY_NAMES,
  FACILITY_NEEDS_ROAD,
  FACILITY_RANGE,
  FACILITY_SPAN,
  FACILITY_STRENGTH,
  FACILITY_UPKEEP_PER_DAY,
} from './simConstants';

/**
 * 3.3단계: 학생이 직접 놓는 서비스·복지 시설의 카탈로그와 배치 규칙.
 *
 * 지구 건물과 성격이 정반대다.
 *
 *                지구 건물            서비스 시설
 *   누가 놓나    시뮬레이션           **학생이 직접**
 *   레벨         수요에 따라 1~3      없음. 종류마다 크기 고정
 *   재건축       상향 재건축 있음     **없음.** 헐고 다시 짓는 것만
 *   인구·일자리  집계에 들어감        **안 들어감**
 *   정원의 의미  수용 인원            **담당 한계**
 *   유지비       없음                 있음. 하루마다 나간다
 *
 * 수치는 전부 simConstants.ts 에 있고 이 파일은 그것을 조립하기만 한다.
 * 수치의 출처는 항상 simConstants.ts 하나다.
 */

export const FAC_FIRE = 0;
export const FAC_POLICE = 1;
export const FAC_HOSPITAL = 2;
export const FAC_SCHOOL = 3;
export const FAC_MINIPARK = 4;
export const FAC_PARK = 5;
export const FAC_SPORTS = 6;

export interface FacilitySpec {
  unlockLevel: number;
  kind: number;
  name: string;
  span: number;
  cost: number;
  upkeepPerDay: number;
  /** false = 필수 서비스(0~3), true = 복지(4~6). isWelfareKind(kind) 와 같은 값. */
  welfare: boolean;
  /**
   * 반경. 가족에 따라 **단위가 다르다.**
   *   필수 서비스 — 도로 BFS 거리(칸). 이 밖은 커버되지 않는다.
   *   복지       — 유클리드 거리(타일). 이 밖은 효과가 0 이다.
   */
  range: number;

  /* --- 필수 서비스만 쓴다 (복지는 capacity = 0) --- */
  /** 담당 한계. capacityIsBuildings 가 true 면 건물 수, 아니면 인구. */
  capacity: number;
  capacityIsBuildings: boolean;

  /* --- 복지만 쓴다 (필수 서비스는 strength = 0) --- */
  /** 복지 점수 세기. 거리 감쇠를 곱해서 쌓인다. services.ts 5.5 참고. */
  strength: number;
  /** 도로에 닿아 있어야 놓을 수 있는가. 소공원만 false. */
  needsRoad: boolean;
}

function buildSpecs(): readonly FacilitySpec[] {
  const out: FacilitySpec[] = [];
  for (let kind = 0; kind < FACILITY_COUNT; kind++) {
    out.push({
      unlockLevel: FACILITY_UNLOCK_LEVEL[kind],
      kind,
      name: FACILITY_NAMES[kind],
      span: FACILITY_SPAN[kind],
      cost: FACILITY_COST[kind],
      upkeepPerDay: FACILITY_UPKEEP_PER_DAY[kind],
      welfare: isWelfareKind(kind),
      range: FACILITY_RANGE[kind],
      capacity: FACILITY_CAPACITY[kind],
      capacityIsBuildings: FACILITY_CAPACITY_IS_BUILDINGS[kind],
      strength: FACILITY_STRENGTH[kind],
      needsRoad: FACILITY_NEEDS_ROAD[kind],
    });
  }
  return out;
}

export const FACILITY_SPECS: readonly FacilitySpec[] = buildSpecs();

/** 종류 번호가 실제로 있는 시설인가. 저장본에서 읽은 코드를 믿기 전에 확인한다. */
export function isFacilityKind(kind: number): boolean {
  return Number.isInteger(kind) && kind >= 0 && kind < FACILITY_COUNT;
}

export function facilitySpan(kind: number): number {
  return isFacilityKind(kind) ? FACILITY_SPECS[kind].span : 1;
}

/* ---------------------------------------------------------------- *
 * 배치 규칙
 * ---------------------------------------------------------------- */

const OK: PlaceResult = { ok: true, reason: '' };

/**
 * 시설을 놓을 수 있는가. build.ts 의 canPlaceRoad / canPlaceZone 과 같은 모양이다.
 *
 * 거부 사유는 **학생이 읽을 문장으로** 돌려준다. 순서대로 검사한다.
 * 돈 검사(7번)는 여기서 하지 않는다 — 호출부가 MacroSim.spend 로 처리한다.
 */
export function canPlaceFacility(
  world: World,
  tx: number,
  ty: number,
  kind: number,
  cityLevel = 1,
): PlaceResult {
  if (!isFacilityKind(kind)) return { ok: false, reason: '없는 시설입니다' };
  const spec = FACILITY_SPECS[kind];
  if (cityLevel < spec.unlockLevel)
    return { ok: false, reason: `도시 레벨 ${spec.unlockLevel}에서 잠금해제됩니다` };
  const span = spec.span;

  /*
   * 1) 개척한 청크인가.
   *
   * footprint 가 청크를 걸칠 수 있으므로 **칸마다** 확인한다.
   * (지구 건물과 달리 시설에는 "한 청크 안에 들어가야 한다" 는 제약이 없다.
   *  World.placeFacility / demolishAt 가 칸마다 필지를 찾아 쓰고, 저장은
   *  citySave 의 runTransaction 이 걸친 청크를 한 번에 커밋하므로 반쪽짜리
   *  시설이 남지 않는다.)
   */
  const h = world.sampleHeight(tx, ty);
  for (let dy = 0; dy < span; dy++) {
    for (let dx = 0; dx < span; dx++) {
      const x = tx + dx;
      const y = ty + dy;
      if (!world.isExplored(chunkIndexOf(x), chunkIndexOf(y))) {
        return { ok: false, reason: '아직 개척하지 않은 땅입니다' };
      }
      // 3) 물이 아닌가
      if (isWater(world.getTile(x, y))) {
        return { ok: false, reason: '물 위에는 지을 수 없습니다' };
      }
      // 4) 고도가 같은가
      if (world.sampleHeight(x, y) !== h) {
        return { ok: false, reason: '평평한 땅에만 지을 수 있습니다' };
      }
      // 5) 도로·지구·건물·다른 시설이 없는가
      if (world.getBuild(x, y) !== Build.None) {
        return { ok: false, reason: '먼저 철거해야 합니다' };
      }
      if (world.getBld(x, y) !== BLD_NONE) {
        return { ok: false, reason: '먼저 철거해야 합니다' };
      }
    }
  }

  /*
   * 6) 도로 인접을 **배치 조건으로 강제** 한다. 지구와 다르다.
   *
   * 지구는 도로가 없어도 지정만 되고 색이 어두워지지만, 필수 시설은 도로에 안
   * 닿으면 담당 구역이 아예 0 이라 학생에게는 "돈만 나가는 건물" 이 된다.
   * 놓는 순간 막는 게 친절하다.
   *
   * 단 소공원만 needsRoad = false 다. 복지는 유클리드 거리로 효과를 주므로
   * 도로에 안 닿아도 제 역할을 다 한다. 이게 소공원의 존재 이유이기도 하다 —
   * 건물이 못 들어서는 블록 안쪽 자투리땅, 절벽 옆 한 칸에 놓아 쓸모를 만든다.
   */
  if (spec.needsRoad && !touchesRoadTiles(world, tx, ty, span)) {
    return { ok: false, reason: '도로에 닿아야 합니다' };
  }

  return OK;
}

/** footprint 테두리에 도로가 한 칸이라도 닿아 있는가. */
export function touchesRoadTiles(world: World, tx: number, ty: number, span: number): boolean {
  for (const [rx, ry] of edgeNeighbors(tx, ty, span)) {
    if (world.getBuild(rx, ry) === Build.Road) return true;
  }
  return false;
}
