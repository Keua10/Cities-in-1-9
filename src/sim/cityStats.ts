import { FACILITY_COUNT, LEVEL_COUNT, ZONE_COUNT } from './buildings';
import { SERVICE_KIND_COUNT } from './services';
export interface TierStats {
  /** 정원(건물이 수용할 수 있는 최대). */
  capacity: number;
  /** 실제로 들어와 있는 인원. 만족도가 낮으면 정원보다 적다 = 공실. */
  filled: number;
}

export interface CityStats {
  /** [zone][tier] */
  tiers: TierStats[][];
  population: number;
  jobs: number;
  buildings: number;
  roads: number;
  /** 전체 입주율 0~1. 공실이 늘면 떨어진다. */
  occupancy: number;
  /** 도로에 닿지 않아 아무도 못 들어오는 건물 수. */
  strandedBuildings: number;
  /** 하루 수지. 표시용. */
  dailyIncome: number;
  dailyUpkeep: number;

  /* ---------- 3.3단계. 전부 파생값이고 저장하지 않는다. ---------- */
  /** 하루 시설 유지비 (필수 + 복지 전부). dailyUpkeep 안에 이미 포함돼 있다. */
  facilityUpkeep: number;
  /** 종류별 시설 수 (길이 FACILITY_COUNT = 7). */
  facilityCounts: number[];
  /** kind 0~3 의 커버율 0~1 (커버된 건물 수 / 전체 건물 수). */
  serviceCoverage: number[];
  /** loadRatio > 1 인 시설 수 (필수 서비스만). */
  overloadedFacilities: number;
  /** 도로에 안 닿은 시설 수 (needsRoad 인 것만 센다). */
  deadFacilities: number;
  /** 복지 요구를 채운 주거 건물 비율 0~1. 상태판 게이지가 이 값. */
  amenityFulfilled: number;
}

export function emptyTiers(): TierStats[][] {
  const out: TierStats[][] = [];
  for (let z = 0; z < ZONE_COUNT; z++) {
    const row: TierStats[] = [];
    for (let t = 0; t < LEVEL_COUNT; t++) row.push({ capacity: 0, filled: 0 });
    out.push(row);
  }
  return out;
}

export function emptyFacilityStats(): Pick<
  CityStats,
  | 'facilityUpkeep'
  | 'facilityCounts'
  | 'serviceCoverage'
  | 'overloadedFacilities'
  | 'deadFacilities'
  | 'amenityFulfilled'
> {
  return {
    facilityUpkeep: 0,
    facilityCounts: new Array<number>(FACILITY_COUNT).fill(0),
    serviceCoverage: new Array<number>(SERVICE_KIND_COUNT).fill(0),
    overloadedFacilities: 0,
    deadFacilities: 0,
    amenityFulfilled: 0,
  };
}

export function zeroDemand(): number[][] {
  return [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
}
