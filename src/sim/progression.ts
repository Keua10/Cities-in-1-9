import type { MacroState } from '../net/types';
import type { World } from '../world/world';
import { facilityKindOfCode, isAnchor, isFacilityAnchor, levelOfCode } from './buildings';

/**
 * 도시 레벨 9단계 (군사 콘텐츠 1단계).
 *
 * 레벨이 오르려면 **번영도와 영토(청크 수)를 둘 다** 채워야 한다.
 * 도시 1~3 = 수도 1레벨, 4~6 = 수도 2레벨까지, 7~9 = 수도 3레벨까지 넓힐 수 있다.
 * 예전 5단계 시설은 1→1, 2→2~3, 3→4~5, 4→6~7, 5→8~9 로 옮겼다.
 */
export const CITY_LEVELS = [
  {
    points: 0,
    territory: 16,
    name: '마을',
    maxBuildingTier: 1,
    unlock: '저소득 · 기본 시설 · 지하수 펌프 · 직접 방류구 · 풍력 · 소각시설 · 공동묘지',
  },
  {
    points: 100,
    territory: 20,
    name: '소읍',
    maxBuildingTier: 2,
    unlock: '중산층 건물 · 공원 · 하천 취수장 · 과수원 · 목장',
  },
  {
    points: 250,
    territory: 28,
    name: '소도시',
    maxBuildingTier: 2,
    unlock: '가스 발전 · 화장시설 · 통신탑 · 양계장 · 어업 기지',
  },
  {
    points: 500,
    territory: 64,
    name: '성장 도시',
    maxBuildingTier: 2,
    unlock: '수도 2레벨(4×4) · 체육시설 · 하수처리장 · 교도소 · 온실 단지',
  },
  {
    points: 900,
    territory: 80,
    name: '지방 도시',
    maxBuildingTier: 2,
    unlock: '태양광 발전 · 소형 공항 · 소형 여객항/화물항 · 식품 가공 공장',
  },
  {
    points: 1500,
    territory: 100,
    name: '대도시',
    maxBuildingTier: 3,
    unlock: '고소득 건물 · 중형 공항',
  },
  {
    points: 2500,
    territory: 144,
    name: '광역 도시',
    maxBuildingTier: 3,
    unlock: '수도 3레벨(6×6) · 중형 복합항',
  },
  {
    points: 4000,
    territory: 170,
    name: '중심 도시',
    maxBuildingTier: 3,
    unlock: '대형 공항',
  },
  {
    points: 6000,
    territory: 200,
    name: '수도권',
    maxBuildingTier: 3,
    unlock: '대형 복합항 · 현재 최고 도시 레벨',
  },
] as const;

export const BUILDING_UNLOCK_LEVEL = [1, 2, 6] as const;
/** Existing 0~20 order stays fixed. New transport kinds 21~25 append only. */
export const FACILITY_UNLOCK_LEVEL: readonly number[] = [
  // 소방·경찰·병원·학교·소공원·공원·체육·지하수·하천취수·방류구
  1, 1, 1, 1, 1, 2, 4, 1, 2, 1,
  // 하수처리·풍력·가스·태양광·소각·화장·묘지·통신탑·소형공항·소형여객항·교도소
  4, 1, 3, 5, 1, 3, 1, 3, 5, 5, 4,
  // 소형화물항·중형복합항·대형복합항·중형공항·대형공항·지하철역
  5, 7, 9, 6, 8, 1,
  // 식량: 곡물·채소·과수·목장·양계·온실·어업·창고·가공
  1, 1, 2, 2, 3, 4, 3, 1, 5,
];

export function normalizeProsperity(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1_000_000_000, Math.max(0, Math.floor(value)))
    : 0;
}

/**
 * 번영도와 영토 청크 수로 정하는 도시 레벨. 둘 다 채운 가장 높은 단계다.
 * territory 를 주지 않으면 영토 조건을 보지 않는다(예전 저장 보정·점검 도구).
 */
export function cityLevelFor(points: number, territory = Infinity): number {
  const score = normalizeProsperity(points);
  let level = 1;
  for (let i = 1; i < CITY_LEVELS.length; i++) {
    if (score >= CITY_LEVELS[i].points && territory >= CITY_LEVELS[i].territory) level = i + 1;
    else break;
  }
  return level;
}

/** 번영도로만 따진 레벨(영토가 모자라 막힌 단계를 보여줄 때). */
export function prosperityLevelFor(points: number): number {
  return cityLevelFor(points);
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
