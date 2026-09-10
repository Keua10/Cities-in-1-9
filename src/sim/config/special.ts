/** STEP 4.6 special facilities. Values append after STEP 4.5 kind 16. */
export const FAC_COMM_TOWER = 17;
export const FAC_AIRPORT = 18;
export const FAC_HARBOR = 19;
export const FAC_PRISON = 20;
export const SPECIAL_FACILITY_BASE = FAC_COMM_TOWER;

export interface SpecialFacilitySpec {
  needsWater: boolean;
  /** Student-facing role text. This does not create a new save layer. */
  role: string;
}

export const SPECIAL_SPECS: Readonly<Record<number, SpecialFacilitySpec>> = {
  [FAC_COMM_TOWER]: {
    needsWater: false,
    role: 'STEP 5 예약 시설 · 현재 도시 기능 없음',
  },
  [FAC_AIRPORT]: {
    needsWater: false,
    role: '광역 교통 시설 · 현재는 배치·운영 기반만 제공',
  },
  [FAC_HARBOR]: {
    needsWater: true,
    role: '수변 광역 교통 시설 · 수역에 직접 닿아야 함',
  },
  [FAC_PRISON]: {
    needsWater: false,
    role: '경찰서와 별도인 교정 시설 · 경찰 서비스 보조',
  },
};

export function isSpecialFacility(kind: number): boolean {
  return kind >= FAC_COMM_TOWER && kind <= FAC_PRISON;
}
