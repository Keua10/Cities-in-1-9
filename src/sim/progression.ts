import type { MacroState } from '../net/types';
import type { World } from '../world/world';
import { facilityKindOfCode, isAnchor, isFacilityAnchor, levelOfCode } from './buildings';

export const CITY_LEVELS = [
  {
    points: 0,
    name: '마을',
    maxBuildingTier: 1,
    unlock: '저소득 · 기본 시설 · 지하수 펌프 · 직접 방류구 · 풍력 · 소각시설 · 공동묘지',
  },
  {
    points: 100,
    name: '소도시',
    maxBuildingTier: 2,
    unlock: '중산층 건물 · 공원 · 하천 취수장 · 가스 발전 · 화장시설 · 통신탑',
  },
  {
    points: 500,
    name: '성장 도시',
    maxBuildingTier: 2,
    unlock: '체육시설 · 하수처리장 · 태양광 발전 · 소형 공항 · 소형 여객항/화물항 · 교도소',
  },
  {
    points: 1500,
    name: '대도시',
    maxBuildingTier: 3,
    unlock: '고소득 건물 · 중형 공항 · 중형 복합항',
  },
  {
    points: 4000,
    name: '중심 도시',
    maxBuildingTier: 3,
    unlock: '대형 공항 · 대형 복합항 · 현재 최고 도시 레벨',
  },
] as const;

export const BUILDING_UNLOCK_LEVEL = [1, 2, 4] as const;
/** Existing 0~20 order stays fixed. New transport kinds 21~25 append only. */
export const FACILITY_UNLOCK_LEVEL: readonly number[] = [
  1, 1, 1, 1, 1, 2, 3, 1, 2, 1, 3, 1, 2, 3, 1, 2, 1,
  2, 3, 3, 3,
  3, 4, 5, 4, 5,
];

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

export function dailyProsperity(population: number, occupancy: number, netIncome: number): number {
  if (!Number.isFinite(population) || population < 1) return 0;
  const occupied = Number.isFinite(occupancy) ? Math.max(0, Math.min(1, occupancy)) : 0;
  return Math.max(
    1,
    Math.round(Math.sqrt(population) * (0.25 + 0.75 * occupied) * (netIncome >= 0 ? 1.1 : 0.9)),
  );
}

/** Legacy saves are only lifted high enough to keep already-built tiers/facilities unlocked. */
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
