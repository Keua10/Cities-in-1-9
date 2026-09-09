import type { MacroState } from '../net/types';
import type { World } from '../world/world';
import { facilityKindOfCode, isAnchor, isFacilityAnchor, levelOfCode } from './buildings';

/** 도시 레벨과 건물 계층(L1~L3)은 별개다. 후속 인프라도 이 표의 레벨을 사용한다. */
export const CITY_LEVELS = [
  { points: 0, name: '마을', maxBuildingTier: 1, unlock: '저소득 건물 · 기본 서비스 · 소공원' },
  { points: 100, name: '소도시', maxBuildingTier: 2, unlock: '중산층 건물 · 공원' },
  { points: 500, name: '성장 도시', maxBuildingTier: 2, unlock: '체육시설' },
  { points: 1500, name: '대도시', maxBuildingTier: 3, unlock: '고소득 건물' },
  { points: 4000, name: '중심 도시', maxBuildingTier: 3, unlock: '현재 최고 도시 레벨' },
] as const;

export const BUILDING_UNLOCK_LEVEL = [1, 2, 4] as const;
/** 기본 안전·교육 시설은 시작부터 제공해 성장에 필요한 서비스를 막지 않는다. */
export const FACILITY_UNLOCK_LEVEL: readonly number[] = [1, 1, 1, 1, 1, 2, 3];

export function normalizeProsperity(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1_000_000_000, Math.max(0, Math.floor(value)))
    : 0;
}

export function cityLevelFor(points: number): number {
  const score = normalizeProsperity(points);
  let level = 1;
  for (let i = 1; i < CITY_LEVELS.length; i++) {
    if (score >= CITY_LEVELS[i].points) level = i + 1;
  }
  return level;
}

/** 매 게임 하루에만 적립. 입주율은 서비스·만족도가 반영된 대리 지표다. */
export function dailyProsperity(population: number, occupancy: number, netIncome: number): number {
  if (!Number.isFinite(population) || population < 1) return 0;
  const occupied = Number.isFinite(occupancy) ? Math.max(0, Math.min(1, occupancy)) : 0;
  return Math.max(
    1,
    Math.round(Math.sqrt(population) * (0.25 + 0.75 * occupied) * (netIncome >= 0 ? 1.1 : 0.9)),
  );
}

/** 옛 저장본/자동 생성 도시만 최초 1회 보정. 기존 고급 건물과 시설을 다시 잠그지 않는다. */
export function initializeProsperity(macro: MacroState, world: World): void {
  if (
    typeof macro.prosperity === 'number' &&
    Number.isFinite(macro.prosperity) &&
    macro.prosperity >= 0
  ) {
    macro.prosperity = normalizeProsperity(macro.prosperity);
    return;
  }
  let points = Math.min(
    CITY_LEVELS[CITY_LEVELS.length - 1].points,
    normalizeProsperity(macro.population),
  );
  for (const parcel of world.developedParcels()) {
    if (!parcel.bld) continue;
    for (const code of parcel.bld) {
      const level = isAnchor(code)
        ? BUILDING_UNLOCK_LEVEL[levelOfCode(code) - 1]
        : isFacilityAnchor(code)
          ? FACILITY_UNLOCK_LEVEL[facilityKindOfCode(code)]
          : 1;
      points = Math.max(points, CITY_LEVELS[level - 1].points);
    }
  }
  macro.prosperity = points;
}
