/* Facility balance table. Existing IDs 0~20 stay in place; transport upgrades append at 21~25. */

export const FACILITY_SPAN: readonly number[] = [
  2, 2, 3, 3, 1, 2, 3, 2, 2, 2, 3, 2, 3, 3, 3, 2, 3, 1, 3, 3, 3, 3, 5, 7, 5, 7, 1,
];

export const FACILITY_NAMES: readonly string[] = [
  '소방서',
  '경찰서',
  '병원',
  '학교',
  '소공원',
  '공원',
  '체육시설',
  '지하수 펌프',
  '하천 취수장',
  '직접 방류구',
  '하수처리장',
  '풍력 발전소',
  '가스 발전소',
  '태양광 발전소',
  '쓰레기 소각시설',
  '화장시설',
  '공동묘지',
  '통신탑',
  '소형 공항',
  '소형 여객항',
  '교도소',
  '소형 화물항',
  '중형 복합항',
  '대형 복합항',
  '중형 공항',
  '대형 공항',
  '지하철역',
];

export const FACILITY_COST: readonly number[] = [
  4_500, 4_000, 14_000, 10_000, 600, 4_600, 6_000, 3_000, 8_000, 2_000, 12_000, 5_000, 18_000,
  22_000, 10_000, 6_500, 3_000, 2_000, 60_000, 35_000, 25_000, 35_000, 90_000, 210_000, 150_000,
  360_000, 18_000,
];

export const FACILITY_UPKEEP_PER_DAY: readonly number[] = [
  170, 160, 360, 300, 15, 110, 135, 90, 180, 50, 240, 100, 650, 180, 280, 140, 70, 0, 950, 600, 420,
  600, 1_600, 4_200, 2_400, 6_200, 0,
];

/** Road-BFS range for service facilities; transport hubs have no service field. */
export const FACILITY_RANGE: readonly number[] = [
  40, 34, 55, 30, 8, 16, 14, 0, 0, 0, 0, 0, 0, 0, 64, 64, 64, 0, 0, 0, 34, 0, 0, 0, 0, 0, 0,
];

export const FACILITY_NEEDS_ROAD: readonly boolean[] = [
  true,
  true,
  true,
  true,
  false,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  false,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
];

/** Service capacities. Transport hubs deliberately use zero: their effects live in TransportSystem. */
export const FACILITY_CAPACITY: readonly number[] = [
  220, 3_000, 5_000, 2_500, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10_000, 6_000, 5_000, 0, 0, 0, 1_200, 0,
  0, 0, 0, 0, 0,
];

export const FACILITY_CAPACITY_IS_BUILDINGS: readonly boolean[] = [
  true,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
];

export const OVERLOAD_SLOPE = 0.8;

/**
 * 시설 부하를 갱신할 때 **직전 부하에서 목표 부하 쪽으로 움직이는 비율** (수정사항 7).
 *
 * 1.0(= 즉시 대입)이 기본이었는데, 그 값에서는 품질이 한 평가 늦게 반영되는
 * 구조와 맞물려 2주기 진동이 생긴다.
 *
 *   입주 높음 -> 부하 높음 -> 품질 낮음 -> 입주 낮음 -> 부하 낮음 -> 품질 높음 -> ...
 *
 * 실제로 같은 도시의 입주율이 평가마다 48% 와 95% 를 오갔다. 비율을 1 보다
 * 작게 두면 되먹임 이득이 1 아래로 내려가 진동이 스스로 잦아든다.
 */
export const LOAD_SMOOTH = 0.3;

export const FACILITY_STRENGTH: readonly number[] = [
  0, 0, 0, 0, 0.65, 1.5, 1.6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];

export const SERVICE_WEIGHT: readonly (readonly number[])[] = [
  [0.1, 0.12, 0.16],
  [0.14, 0.16, 0.06],
  [0.16, 0.06, 0.04],
  [0.18, 0.02, 0.0],
];

export const TIER_SERVICE_MUL: readonly number[] = [0.7, 1.0, 1.35];
export const SERVICE_PENALTY_MAX = 0.45;
export const SERVICE_GRACE_POP = 400;
export const SERVICE_FULL_POP = 2_000;
/**
 * grace 를 직전 평가값에서 목표값 쪽으로 움직이는 비율 (수정사항 7).
 *
 * grace 는 인구의 함수이고 인구는 grace 의 함수라 되먹임 고리가 닫혀 있다.
 * 1.0 이면 고리 이득이 1 을 넘어 **2주기 진동** 이 생긴다 — 같은 도시의 인구가
 * 하루 만에 1,891 명과 975 명을 오갔다. 이득을 낮추면 평형점은 그대로 둔 채
 * 진동만 잦아든다. 하강 나선의 바닥(음의 되먹임)은 그대로 남는다.
 */
export const GRACE_SMOOTH = 0.25;
export const SERVICE_FIELD_MAX_DIST = 64;

export const AMENITY_NEED_BY_TIER: readonly number[] = [0.35, 0.9, 1.8];
export const AMENITY_GAP_MAX = 0.24;
export const AMENITY_SURPLUS_MAX = 0.12;
export const AMENITY_HALF = 1.2;
export const ZONE_AMENITY_MUL: readonly number[] = [1.0, 0.42, 0.12];
export const AMENITY_SCORE_SCALE = 40;
export const AMENITY_FIELD_MAX_RANGE = 16;
export const NEEDS_PENALTY_MAX = 0.5;
