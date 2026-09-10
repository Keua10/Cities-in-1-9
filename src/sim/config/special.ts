/** STEP 4.6+ special facilities. Saved IDs are append-only. */
export const FAC_COMM_TOWER = 17;
/** Legacy STEP 4.6 airport ID becomes the 3x3 level-1 airport. */
export const FAC_AIRPORT = 18;
/** Legacy STEP 4.6 harbor ID becomes the 3x3 passenger harbor. */
export const FAC_HARBOR = 19;
export const FAC_PRISON = 20;

/** New transport facilities append after the original 0~20 facility IDs. */
export const FAC_HARBOR_CARGO = 21;
export const FAC_HARBOR_HYBRID_L2 = 22;
export const FAC_HARBOR_HYBRID_L3 = 23;
export const FAC_AIRPORT_L2 = 24;
export const FAC_AIRPORT_L3 = 25;

export const SPECIAL_FACILITY_BASE = FAC_COMM_TOWER;
export const SPECIAL_FACILITY_LAST = FAC_AIRPORT_L3;

export interface SpecialFacilitySpec {
  needsWater: boolean;
  /** Student-facing role text. This does not create a new facility save layer. */
  role: string;
}

export const SPECIAL_SPECS: Readonly<Record<number, SpecialFacilitySpec>> = {
  [FAC_COMM_TOWER]: {
    needsWater: false,
    role: 'STEP 5 예약 시설 · 현재 도시 기능 없음',
  },
  [FAC_AIRPORT]: {
    needsWater: false,
    role: '소형 공항 · 유도로와 활주로가 연결되어야 운항',
  },
  [FAC_HARBOR]: {
    needsWater: true,
    role: '소형 여객항 · 도시 내 수상교통 및 방문객 수송',
  },
  [FAC_PRISON]: {
    needsWater: false,
    role: '경찰서와 별도인 교정 시설 · 경찰 서비스 보조',
  },
  [FAC_HARBOR_CARGO]: {
    needsWater: true,
    role: '소형 화물항 · 산업 화물 수출입 전용',
  },
  [FAC_HARBOR_HYBRID_L2]: {
    needsWater: true,
    role: '중형 복합항 · 여객선과 화물선을 함께 운용',
  },
  [FAC_HARBOR_HYBRID_L3]: {
    needsWater: true,
    role: '대형 복합항 · 여객선과 화물선을 함께 운용',
  },
  [FAC_AIRPORT_L2]: {
    needsWater: false,
    role: '중형 공항 · 확장된 항공기 운항 및 방문객 처리',
  },
  [FAC_AIRPORT_L3]: {
    needsWater: false,
    role: '대형 공항 · 최고 수준 항공기 운항 및 방문객 처리',
  },
};

export function isSpecialFacility(kind: number): boolean {
  return kind >= SPECIAL_FACILITY_BASE && kind <= SPECIAL_FACILITY_LAST;
}

export function isAirportFacility(kind: number): boolean {
  return kind === FAC_AIRPORT || kind === FAC_AIRPORT_L2 || kind === FAC_AIRPORT_L3;
}

export function isHarborFacility(kind: number): boolean {
  return (
    kind === FAC_HARBOR ||
    kind === FAC_HARBOR_CARGO ||
    kind === FAC_HARBOR_HYBRID_L2 ||
    kind === FAC_HARBOR_HYBRID_L3
  );
}

export function isHybridHarbor(kind: number): boolean {
  return kind === FAC_HARBOR_HYBRID_L2 || kind === FAC_HARBOR_HYBRID_L3;
}
