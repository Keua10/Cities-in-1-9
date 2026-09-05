/**
 * 3.1단계 매크로 시뮬레이션의 조절값.
 *
 * 여기 있는 값은 **저장되지 않는다.** 전부 런타임 계산에만 쓰이므로 마음껏
 * 고쳐도 이미 저장된 도시가 깨지지 않는다. 밸런스를 만지려면 이 파일만 보면 된다.
 *
 * 반대로 src/sim/buildings.ts 의 ID 는 저장되므로 절대 순서를 바꾸면 안 된다.
 */

/* ---------------- 시간 ---------------- */

/** 실시간 1초 = 게임 1시간. 틱 하나가 곧 게임 1시간이다. */
export const MS_PER_TICK = 1000;
export const TICKS_PER_DAY = 24;

/**
 * 아무도 접속해 있지 않은 동안 시간이 흐르는 속도.
 *
 * 설계 원칙이 "아무도 없으면 시간이 느려지다가 멈춘다" 이므로, 오프라인
 * 실시간은 이 비율만큼만 게임 시간으로 환산한다.
 */
export const OFFLINE_SPEED = 0.1;

/**
 * 오프라인 따라잡기 상한(틱). 12게임일.
 *
 * 이 상한이 곧 "시간이 멈춘다" 의 구현이다. 학생이 방학 내내 안 들어와도
 * 첫 로그인이 몇 분씩 멈추면 안 되고, 안 들어온 사람이 그 사이 도시가 다
 * 자라 있는 것도 이상하다.
 */
export const MAX_CATCHUP_TICKS = TICKS_PER_DAY * 12;

/** 따라잡기를 한 프레임에 다 돌리면 화면이 언다. 이 개수씩 끊어서 돌린다. */
export const CATCHUP_TICKS_PER_FRAME = 24;

/** 통계·만족도·수요를 다시 계산하는 주기(틱). 하루 여덟 번. */
export const STATS_INTERVAL = 3;

/**
 * 도시가 "다 컸다" 고 보는 인구. 계층 구성비가 이 값에 다가갈수록 위쪽으로 쏠린다.
 * 작은 도시는 저소득 위주, 큰 도시는 중산층·고소득 비중이 커진다.
 */
export const PROSPERITY_FULL = 4_000;

/* ---------------- 돈 ---------------- */

export const START_MONEY = 60_000;

/** 건설비. 철거는 공짜다(학생이 실수를 되돌리는 걸 돈으로 막지 않는다). */
export const COST_ROAD = 12;
export const COST_ZONE = 8;

/** 하루치 도로 유지비(타일당). */
export const UPKEEP_ROAD_PER_DAY = 0.6;

/**
 * 세금. 건물 한 채가 하루에 내는 돈 = 입주 인원 x 아래 값.
 * 등급이 높을수록 1인당 세수가 크다.
 */
export const TAX_PER_RESIDENT: readonly number[] = [0.9, 1.8, 3.6];
export const TAX_PER_JOB: readonly number[] = [1.1, 2.2, 4.4];

/* ---------------- 수요 ---------------- */

/**
 * 수요는 -1 ~ +1 로 정규화한다.
 * 0 보다 크면 그 계층 건물이 새로 들어서고, 0 이하면 들어서지 않는다.
 */
export const DEMAND_SCALE = 240;

/** 도시가 비어 있을 때 밀어주는 초기 수요. 이게 없으면 아무것도 시작되지 않는다. */
export const SEED_DEMAND_R = 0.85;
export const SEED_DEMAND_C = 0.15;
export const SEED_DEMAND_I = 0.6;

/** 일자리 1개당 필요한 거주자 수. 1보다 크면 통근 여유가 생긴다. */
export const RESIDENTS_PER_JOB = 1.35;
/** 거주자 1명이 필요로 하는 상업 일자리. */
export const SHOP_JOBS_PER_RESIDENT = 0.18;
/** 상업 일자리 1개를 받치는 데 필요한 공업 일자리. */
export const INDUSTRY_PER_SHOP = 0.7;
/** 외부로 파는 몫. 도시가 작아도 공업이 굴러가게 하는 바닥값. */
export const INDUSTRY_EXPORT_BASE = 45;

/**
 * 도시 규모에 따라 늘어나는 수출 수요.
 *
 * 이게 없으면 도시가 절대 못 큰다. 집·상가·공장의 수요를 서로의 크기로만
 * 정의하면 완전히 닫힌 고리가 되고, 고리 이득이 1보다 작아서 아주 작은 도시에
 * 갇힌다(실제로 1,491명에서 멈췄다). 반대로 고리 이득을 1 이상으로 만들면
 * 무한히 폭주한다. 그래서 **도시 밖에서 오는 수요** 를 하나 넣는다.
 *
 * 제곱근을 쓰는 이유: 인구에 비례시키면 다시 폭주하고, 상수면 다시 갇힌다.
 * 제곱근이면 항상 수렴하면서도 도시가 클수록 계속 커진다.
 *
 * 실질적으로 이 값이 "학생이 지구를 더 지정하고 안개를 더 걷어야 하는 이유" 다.
 * 수요가 늘 땅보다 조금 앞서 있어야 도시가 계속 자라고, 청크가 꽉 차면
 * 재건축으로 넘어간다.
 */
export const EXPORT_PER_SQRT_POP = 120;

/** 수요는 매 틱 이 비율만큼만 목표값으로 움직인다. 급격히 튀는 걸 막는다. */
export const DEMAND_SMOOTH = 0.2;

/**
 * 성장 압력.
 *
 * 비율 계산(집 대 일자리)만으로는 도시가 금방 균형에 갇혀 멈춘다. 실제 도시가
 * 계속 커지는 건 "살 만한 곳이면 사람이 더 온다" 이기 때문이다.
 * 그래서 **입주율이 높을 때만** 수요를 위로 밀어주는 항을 하나 더한다.
 *
 * 이 항이 학생이 설계한 공실 규칙과 정확히 맞물린다.
 *   너무 많이 지으면 -> 공실 -> 입주율 하락 -> 성장 압력 소멸 -> 성장 정지
 * 건물을 헐지 않고도 과잉 건설이 저절로 벌을 받는다.
 */
export const GROWTH_PRESSURE = 0.6;
/** 이 입주율을 넘어야 성장 압력이 생긴다. */
export const OCCUPANCY_HEALTHY = 0.72;

/* ---------------- 만족도 / 입주율 ---------------- */

/**
 * 계층별 만족도 기준선. 위로 갈수록 까다롭다.
 * 만족도가 기준선을 밑돌면 사람이 빠져나가고, 넘으면 채워진다.
 * 건물은 그대로 남는다 — 하향 재건축이 없는 이유가 이것이다.
 */
export const SATISFACTION_FLOOR: readonly number[] = [0.25, 0.45, 0.62];

/**
 * 통근 만족도. 직장까지의 도로 거리(타일)가 이 값을 넘어가면 점수가 0 이 된다.
 * 도로가 아예 안 닿으면 통근 점수는 0 이다.
 */
export const COMMUTE_GOOD_DIST = 24;
export const COMMUTE_BAD_DIST = 140;

/** 공업 혐오. 반경 안에 공업 건물이 있으면 주거 만족도가 깎인다. */
export const INDUSTRY_NUISANCE_RADIUS = 6;
export const INDUSTRY_NUISANCE_MAX = 0.35;

/* ---------------- 성장 / 재건축 ---------------- */

/** 재개발 포화 판정 단위. 자기 섹터와 인접 8개 섹터를 함께 확인한다. */
export const REDEVELOPMENT_SECTOR_SIZE = 16;

/** 매 틱 한 청크에서 새로 지을 수 있는 건물 수 상한. */
export const MAX_BUILDS_PER_TICK = 2;
/** 매 틱 한 청크에서 재건축할 수 있는 건물 수 상한. */
export const MAX_REBUILDS_PER_TICK = 1;

/** 재건축 최소 나이(게임 일). 이보다 어린 건물은 절대 헐리지 않는다. */
export const REBUILD_MIN_AGE_DAYS = 30;

/**
 * 재건축이 걸리는 수요 격차.
 * (목표 계층 수요 - 현재 계층 수요) 가 이 값을 넘어야 재건축이 일어난다.
 * 수요가 엎치락뒤치락할 때 도시가 계속 갈아엎히는 걸 막는다.
 */
export const REBUILD_DEMAND_GAP = 0.35;

/** 한 틱에 훑는 재건축 후보 칸 수. 청크 전체를 매번 훑지 않기 위한 예산. */
export const REBUILD_SCAN_BUDGET = 512;

/* ---------------- 도로망 ---------------- */

/**
 * 통근 거리장을 다시 계산하는 주기(틱). 하루에 한 번이면 충분하다.
 * 도로를 놓는 순간 갱신하지 않는 이유: 드래그로 도로를 그으면 한 번 긋는 동안
 * 수백 번 다시 계산하게 된다.
 */
export const ROAD_FIELD_INTERVAL = TICKS_PER_DAY;

/** 거리장 BFS 가 퍼지는 최대 거리(타일). 넘어가면 "안 닿음" 으로 본다. */
export const ROAD_FIELD_MAX_DIST = 200;

/** 거리장에서 "안 닿음" 을 뜻하는 값. */
export const ROAD_DIST_UNREACHABLE = 0xffff;

/**
 * 건물이 들어서려면 도로가 이 거리 안에 있어야 한다(체비셰프 거리).
 *
 * 1(=도로에 딱 붙은 칸만)로 하면 블록 안쪽 땅이 영원히 죽는다. 학생이 도로를
 * 6칸 간격으로 깔면 가운데 3x3 이 통째로 개발 불가가 되고, 화면에는 지구 색만
 * 칠해진 빈 땅이 남는다.
 *
 * 2 로 두면 5칸 폭 블록이 통째로 개발된다. 실제 도시의 한 블록 크기와 맞고,
 * 그보다 넓게 지구를 칠하면 가운데가 안 자라는 것이 학생에게 **정보** 가 된다
 * ("도로를 더 깔아야 하는구나").
 */
export const ROAD_REACH = 2;

/** 도로가 바뀐 뒤 거리장을 다시 만들기까지 기다리는 최소 틱. 드래그 중 폭주 방지. */
export const ROAD_FIELD_MIN_INTERVAL = 3;

/* ---------------- 3.2단계: 배정 ---------------- */
export const COMMUTE_RANGE_BY_TIER: readonly number[] = [40, 80, 140];
export const SHOP_RANGE_BY_TIER: readonly number[] = [16, 28, 45];
export const SHOP_LINKS_MAX = 3;
export const JOB_FIT: readonly (readonly number[])[] = [
  [1.0, 0.6, 0.15],
  [0.5, 1.0, 0.7],
  [0.1, 0.6, 1.0],
];

/* ---------------- 3.2단계: 혼잡 ---------------- */
export const VEHICLES_PER_TILE = 4;
export const CONGESTION_ALPHA = 0.25;
export const CONGESTION_DECAY = 0.08;
export const CONGESTION_ESTIMATE_BIAS = 1.15;
export const ESTIMATE_CAPACITY = 260;
export const CONGESTION_PENALTY_R = 0.30;
export const CONGESTION_PENALTY_W = 0.20;

/* ---------------- 3.2단계: 생필품 ---------------- */
export const SUPPLY_USE_PER_HOUR: readonly number[] = [3, 5, 8];
export const SUPPLY_START = 160;

/* ---------------- 3.2단계: 경로 ---------------- */
export const BASE_TILE_COST = 10;
export const CONGESTION_WEIGHT: readonly number[] = [0.6, 1.2, 2.2];
export const SLOPE_COST_MUL = 1.25;
export const TURN_COST_STRAIGHT = 0;
export const TURN_COST_RIGHT = 3;
export const TURN_COST_LEFT = 9;
export const SIGNAL_WAIT_COST = 6;
export const ROUTE_BUDGET_PER_FRAME = 5;
export const REROUTE_LOOKAHEAD = 8;
export const REROUTE_THRESHOLD = 0.35;
export const ROUTE_MAX_NODES = 4000;

/* ---------------- 3.2단계: 차량 ---------------- */
export const VEHICLE_SPEED_TILES_PER_SEC = 2.6;
export const TRUCK_SPEED_MUL = 0.75;
export const ACCEL_TILES_PER_SEC2 = 3.0;
export const DECEL_TILES_PER_SEC2 = 5.0;
export const DESIRED_GAP_TILES = 0.55;
export const MIN_GAP_TILES = 0.22;

/* ---------------- 3.2단계: 신호등 ---------------- */
export const SIGNAL_CYCLE_MS = 16_000;
export const SIGNAL_GREEN_MS = 7_000;
export const SIGNAL_YELLOW_MS = 1_000;

/* ---------------- 3.2단계: 통행 발생 ---------------- */
export const RUSH_TO_WORK: readonly number[] = [
  0, 0, 0, 0, 0, 0.05, 0.35, 0.8, 1.0, 0.6, 0.2, 0.05,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];
export const RUSH_TO_HOME: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0.1, 0.5, 0.9, 1.0, 0.7, 0.3, 0.08, 0, 0,
];
export const RUSH_TO_SHOP: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.2, 0.35,
  0.45, 0.4, 0.4, 0.45, 0.55, 0.7, 0.85, 1.0, 0.7, 0.3, 0.05, 0,
];
export const FREIGHT_CURVE: readonly number[] = [
  0.1, 0.1, 0.1, 0.15, 0.25, 0.4, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0,
  0.95, 1.0, 1.0, 0.9, 0.8, 0.7, 0.5, 0.35, 0.25, 0.2, 0.15, 0.1,
];
export const MAX_SPAWNS_PER_SEC = 90;
