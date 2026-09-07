/**
 * 3.1단계 매크로 시뮬레이션의 조절값.
 *
 * 여기 있는 값은 **저장되지 않는다.** 전부 런타임 계산에만 쓰이므로 마음껏
 * 고쳐도 이미 저장된 도시가 깨지지 않는다. 밸런스를 만지려면 이 파일만 보면 된다.
 *
 * 반대로 src/sim/buildings.ts 의 ID 는 저장되므로 절대 순서를 바꾸면 안 된다.
 */

/* ---------------- 시간 ---------------- */

/**
 * gametime: 성장·재정·수요처럼 빠르게 돌아야 하는 게임 규칙의 시간.
 * 실시간 60초 = gametime 1일, 즉 2.5초 = gametime 1시간.
 */
export const MS_PER_TICK = 2_500;
export const TICKS_PER_DAY = 24;
export const GAMETIME_DAY_MS = MS_PER_TICK * TICKS_PER_DAY; // 60,000ms
export const GAMETIME_DAYS_PER_MONTH = 30;
export const GAMETIME_MONTHS_PER_YEAR = 12;
export const GAMETIME_DAYS_PER_YEAR = GAMETIME_DAYS_PER_MONTH * GAMETIME_MONTHS_PER_YEAR;

/**
 * daytime: 밤낮·출퇴근·장보기처럼 화면에서 체감하는 실제시간 축.
 * 실시간 600초 = daytime 1일. 10분 플레이에 정확히 하루가 돈다.
 * gametime 1일(60초)과의 최소공배수도 정확히 600초(10분)다.
 */
export const DAYTIME_DAY_MS = 600_000;
export const DAYTIME_ALIGNMENT_MS = 600_000;

/** gametime 계절: 30일 x 3개월 = 계절 90일, 1년 360일. */
export const SEASON_DAYS = GAMETIME_DAYS_PER_MONTH * 3;
/** 춘분/추분 12시간, 하지 15시간, 동지 9시간이 되도록 ±3시간. */
export const DAYLIGHT_SWING_HOURS = 3;

/** 출근차가 늦게 도착해도 곧바로 다음날까지 직장에 묶이지 않게 하는 최소 근무시간. */
export const MIN_WORK_HOURS_AFTER_ARRIVAL = 2;
/** 극심한 정체로 늦게 도착했을 때도 자정 이후 퇴근 예약을 만들지 않는다. */
export const LATEST_HOME_DEPARTURE_HOUR = 22;

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
export const COMMUTE_RANGE_BY_TIER: readonly number[] = [28, 36, 44];
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
/**
 * 교차로가 아닌 칸에서 방향을 바꾸는 비용(= 넓은 도로 위의 차선 변경).
 *
 * 이게 없으면 A* 가 4차로 도로에서 한 칸 이득을 보려고 지그재그로 차선을
 * 갈아타는 경로를 만든다. 화면에서는 차가 이유 없이 좌우로 흔들리고, 그
 * 궤적이 마주 오는 차선을 가로질러 겹침의 원인이 된다. 6타일 값이면 정말
 * 필요할 때(목적지가 안쪽 차선에 붙어 있을 때)만 차선을 바꾼다.
 */
export const LANE_CHANGE_COST = 60;
export const ROUTE_BUDGET_PER_FRAME = 5;
export const REROUTE_LOOKAHEAD = 8;
export const REROUTE_THRESHOLD = 0.35;
export const ROUTE_MAX_NODES = 4000;

/* ---------------- 3.2단계: 차량 ---------------- */
export const VEHICLE_SPEED_TILES_PER_SEC = 6.0;
export const TRUCK_SPEED_MUL = 0.72;
export const ACCEL_TILES_PER_SEC2 = 16.0;
export const DECEL_TILES_PER_SEC2 = 48.0;
export const DESIRED_GAP_TILES = 0.55;
export const MIN_GAP_TILES = 0.22;
/** 차량 중심점 간격 계산에서 차체 길이를 따로 더한다. 기존 MIN/DESIRED는 범퍼 간격이다. */
export const VEHICLE_BODY_LENGTH_TILES = 0.50;
/** 차체 폭(타일). 차선 간격 계산과 스프라이트 크기가 같은 값을 본다. */
export const VEHICLE_WIDTH_TILES = 0.30;

/* ---------------- 3.2단계: 차선 기하 ---------------- */
/**
 * 도로 중앙선에서 우측 차선 중심까지의 거리(타일).
 *
 * 도로 폭은 1타일이므로 한 차선의 중심은 0.25 가 정답이다. 이보다 작으면
 * 마주 오는 차가 화면에서 겹쳐 보이고(예전 0.20 은 화면에서 14px 차이여서
 * 20px 스프라이트가 서로 덮었다), 크면 차가 도로 밖으로 나간다.
 * 차체 폭 0.30 이면 바깥쪽 끝이 0.25 + 0.15 = 0.40 으로 도로 안(0.5)에 들어온다.
 */
export const LANE_OFFSET_TILES = 0.25;
/** 코너 베지에가 차지하는 길이(타일). LANE_OFFSET 보다 커야 접선이 뒤집히지 않는다. */
export const LANE_CORNER_RADIUS_TILES = 0.45;

/* ---------------- 3.2단계: 신호등 ---------------- */
/** 교차로별 신호 오프셋을 흩는 범위. 실제 주기는 signals.ts 의 SIGNAL_PERIOD_MS 다. */
export const SIGNAL_CYCLE_MS = 16_000;
export const SIGNAL_GREEN_MS = 7_000;
export const SIGNAL_YELLOW_MS = 1_400;
/**
 * 전적색(all-red) 구간.
 *
 * 황색이 끝나는 순간 반대 축을 녹색으로 바꾸면, 황색 끝에 교차로로 들어간 차와
 * 막 출발한 차가 정확히 한가운데서 만난다. 실제 신호기와 같은 이유로 양쪽이
 * 모두 빨간 구간을 둔다. 이 구간 덕분에 "교차로 안에서 겹침" 이 구조적으로
 * 불가능해진다(예약과 이중 안전장치).
 */
export const SIGNAL_ALL_RED_MS = 1_200;

/* ---------------- 3.2단계: 교차로 판정 ---------------- */
/** 진입로로 인정하는 최소 도로 길이(타일). 1이면 차고지 진입/실수로 찍은 한 칸이다. */
export const JUNCTION_LEG_MIN_TILES = 2;
/** 진입로 길이를 재는 최대 거리. 넘어가면 그냥 "충분히 길다" 로 본다. */
export const JUNCTION_LEG_SCAN_MAX = 12;
/**
 * 교차로 색인을 만들 때 시뮬레이션 영역 바깥으로 더 훑는 여유(타일).
 *
 * 사각형 경계에서는 연속 구간이 잘려 도로 폭 판정이 흔들린다. 여유를 넉넉히
 * 두면 실제로 차가 다니는 구간에서는 판정이 정확하다.
 */
export const JUNCTION_MARGIN_TILES = 40;

/* ---------------- 3.2단계: 통행 우선순위 ---------------- */
/** 정지선에서 이만큼 안으로 들어온 차량만 통행권을 요청한다. */
export const ENTRY_REQUEST_DIST_TILES = 1.1;
/** 비보호 좌회전이 마주 오는 차를 살피는 거리(타일). */
export const LEFT_YIELD_LOOKAHEAD_TILES = 5.0;
/** 적신호 우회전이 "차량 없음" 을 확인하는 거리(타일). */
export const RIGHT_ON_RED_GAP_TILES = 4.0;
/** 이 속도 이상이면 "다가오는 중" 으로 보고 양보한다. */
export const YIELD_MOVING_SPEED = 0.4;
/** 적신호 우회전 전 일시정지 시간(ms). 실제 법의 "일시정지" 를 그대로 옮겼다. */
export const RED_RIGHT_STOP_DWELL_MS = 700;
/** 대기시간 1ms 당 우선순위 가산. */
export const PRIORITY_AGING_PER_MS = 0.05;
/** 대기시간 가산 상한. 신호를 뒤집을 만큼 커지면 안 된다. */
export const PRIORITY_AGING_MAX = 380;
/** 대기차가 있는데 이 시간 동안 아무도 못 들어가면 꼬리물기를 잠시 금지한다. */
export const GRIDLOCK_RELIEF_MS = 4_000;

/* ---------------- 3.2단계: 꼬리물기 / 겹침 ---------------- */
/**
 * 꼬리물기를 하는 차량의 비율(%).
 *
 * 0 이면 아무도 교차로에 갇히지 않는다(법대로). 100 이면 예전 동작이다.
 * 기본값은 "가끔 한 대가 무리하게 밀고 들어와 교차로가 잠깐 막히는" 정도다.
 */
export const AGGRESSIVE_DRIVER_PERCENT = 12;
/** 교차로를 빠져나간 자리에 이만큼 공간이 있어야 진입한다(타일). */
export const EXIT_ROOM_TILES = 1.05;
/**
 * 난폭운전 차량이 요구하는 최소 출구 공간(타일).
 *
 * 0 으로 두면 교차로가 완전히 막혔는데도 밀고 들어가 네 방향이 서로 물리는
 * 영구 교착(그리드락)이 만들어진다. 차 한 대가 절반쯤 빠져나갈 자리는 있어야
 * "무리하게 진입했다" 가 몇 초 뒤 풀린다.
 */
export const AGGRESSIVE_EXIT_ROOM_TILES = 0.6;
/**
 * 통행권을 받고도 이 시간 동안 교차로에 들어가지 못하면 통행권을 반납한다.
 *
 * 이게 없으면 정지선 앞에서 통행권만 받아 쥔 채 앞차에 막힌 차가 교차로 전체를
 * 인질로 잡는다. 실제로 이것 하나가 도시 전체를 멈춰 세웠다.
 */
export const RESERVATION_ABANDON_MS = 1_200;
/** 출구의 차가 이 속도보다 느리면 "막혔다" 로 본다. 빠르게 지나가는 차는 곧 비켜 준다. */
export const EXIT_BLOCK_SPEED = 3.0;
/** 차선 변경/합류 전에 목표 차선에서 확인하는 여유(타일). */
export const MERGE_CLEAR_TILES = 1.0;
/**
 * 겹침 방지 여유(타일).
 *
 * 차체 사각형을 이만큼 부풀려 판정한다. 범퍼가 화면에서 닿는 것까지 막는다.
 * MOVEMENT_CLEARANCE_TILES 보다 반드시 작아야 한다 — 통행권 판정이 "지나가도
 * 된다" 고 한 두 궤적을 겹침 방지 장치가 막으면 두 차가 서로를 세운 채 굳는다.
 */
export const VEHICLE_GUARD_MARGIN_TILES = 0.02;
/**
 * 두 궤적이 이보다 가까우면 동시에 통과시키지 않는다(타일).
 *
 * 차 폭 0.30 + 여유. 겹침 방지 장치가 요구하는 간격(폭 + 여유 x 2 = 0.34)보다
 * 넉넉해야 한다. 마주 오는 직진끼리의 간격 0.50 보다는 작아야 통행량이 산다.
 */
export const MOVEMENT_CLEARANCE_TILES = 0.40;
/** 앞차 감지에서 "같은 차선" 으로 볼 가로 편차(타일). */
export const FOLLOW_LATERAL_TILES = 0.30;
/** 앞차를 살피는 최대 거리(타일). */
export const FOLLOW_LOOKAHEAD_TILES = 2.6;
/**
 * 겹침 방지 장치에 이만큼 붙잡혀 있으면 경로를 조금 되돌려 빠져나온다.
 *
 * 통행권 판정과 겹침 판정이 아무리 맞물려 있어도, 두 대가 서로를 세우는 상태가
 * 원리적으로 불가능하다고 증명할 수는 없다. 그때 한쪽이 몇 십 센티만 물러나
 * 주면 반드시 풀린다. 정상 주행에서는 걸리지 않는 길이다.
 */
export const FREEZE_BREAK_MS = 1_200;
/** 교착을 풀 때 한 프레임에 물러나는 거리(타일). */
export const FREEZE_BACKOFF_TILES = 0.05;
/**
 * 이 시간 동안 전혀 못 움직인 차량은 통행을 포기한다(영구 교착 안전밸브).
 *
 * 신호 한 주기가 약 19초이므로 정상적인 신호 대기로는 절대 걸리지 않는다.
 * 3분 동안 한 뼘도 못 갔다면 그건 정체가 아니라 버그이고, 도시 전체가 그 한 대
 * 때문에 멈추는 것보다 그 통행 하나를 실패로 처리하는 편이 낫다.
 */
export const STUCK_GIVEUP_MS = 180_000;

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
/**
 * 도시 전체 평균 생성 속도(대/초).
 *
 * 예전에는 "한 프레임에 한 대 + 380~850ms 전역 대기" 였다. 이러면 실제 상한이
 * 초당 1.6대로 고정돼서, 출근 시각에 잡힌 수백 건이 큐에 쌓였다가 한 줄로 계속
 * 흘러나온다. 사람 눈에는 그게 "한꺼번에 생성" 으로 보인다.
 * 지금은 토큰 버킷으로 평균 속도를 정하고, 뭉침 방지는 아래 진입로별 간격과
 * 대기열 분산이 맡는다.
 */
export const SPAWN_RATE_PER_SEC = 14;
/**
 * 토큰 버킷 상한. 이 값이 곧 "한 번에 튀어나올 수 있는 최대 대수" 다.
 * 예전 MAX_SPAWNS_PER_SEC=90 은 버킷 상한도 90이어서, 잠깐 조용하다가
 * 큐가 차면 90대가 동시에 나갈 수 있는 구조였다.
 */
export const SPAWN_BURST_TOKENS = 3;
/** 한 프레임에 생성하는 최대 대수. 프레임 하나에 몰리는 것을 막는다. */
export const MAX_SPAWNS_PER_FRAME = 3;
/** 하위호환용. 비상 상한으로만 쓴다. */
export const MAX_SPAWNS_PER_SEC = 90;
/** A* 완료 시점도 차량 생성 시점이 되지 않도록 준비 대기열에서 한 번 더 흩는다. */
export const SPAWN_READY_JITTER_MAX_MS = 1_800;
/**
 * 대기열 깊이 1건당 늘어나는 추가 분산(ms).
 * 출근 피크처럼 한 틱에 수백 건이 잡히면 분산 창을 같이 넓혀서
 * 큐가 "끊기지 않는 한 줄" 이 되지 않게 한다.
 */
export const SPAWN_QUEUE_SPREAD_MS = 25;
/** 대기열 분산 창의 상한(ms). daytime 기준 하루가 600초라 10초면 충분히 길다. */
export const SPAWN_SPREAD_MAX_MS = 9_000;
/** 같은 건물/경계 진입로에서 연속 차량이 한 덩어리로 튀어나오지 않게 하는 최소 간격. */
export const SPAWN_GATE_HEADWAY_MS = 700;
/**
 * 교차로 정지선(진행도).
 *
 * 예전 값은 0.94 였다. 그런데 진행도 1.0 이 곧 **교차로 칸의 중심**이므로,
 * 0.94 에서 멈추면 차는 이미 교차로 안에 절반 넘게 들어가 서 있게 된다.
 * 화면에서 "교차로 한가운데 멈춰 있는 차" 로 보이던 것 중 하나가 이것이다.
 *
 * 교차로 칸의 경계는 진행도 0.5 다. 차체 절반(0.25)을 빼고 약간의 여유를 두면
 * 0.20 이 정지선이다. 이 값에서 멈추면 차의 앞 범퍼가 경계선에 딱 선다.
 */
export const INTERSECTION_STOP_T = 0.20;

/* ---------------- 3.2단계: 생활 스케줄 ---------------- */
/** daytime 생활 스케줄 해상도. 5분 단위로 통행을 분산하되 08:30 / 09:00은 정확히 유지한다. */
export const LIFE_SLOT_MINUTES = 5;
/** 직장인의 출근 시각 분포. 나머지는 09:00 출근이다. */
export const WORK_START_0830_SHARE = 0.45;
/** 08:30 -> 17:30, 09:00 -> 18:00. 점심 1시간을 포함한 체류시간이다. */
export const WORKPLACE_PRESENCE_MINUTES = 9 * 60;
/** 예상 통근시간에 더해 미리 출발하는 여유시간. */
export const COMMUTE_BUFFER_MINUTES = 10;
/** 같은 출근조가 한 슬롯에 몰리지 않도록 시민마다 이 범위만큼 추가로 일찍 출발한다. */
export const COMMUTE_EARLY_SPREAD_MINUTES = 20;
/** 공식 퇴근시각 뒤 실제 주차장/건물에서 빠져나오는 시간을 자연스럽게 분산한다. */
export const WORK_EXIT_SPREAD_MINUTES = 10;
/** 토/일 정상 출근 비율. 공업은 교대근무가 있어 상업보다 조금 높다. */
export const SATURDAY_WORK_SHARE_C = 0.22;
export const SATURDAY_WORK_SHARE_I = 0.32;
export const SUNDAY_WORK_SHARE_C = 0.10;
export const SUNDAY_WORK_SHARE_I = 0.20;
/** 퇴근 뒤 바로 귀가하지 않고 상업지대를 들르는 비율. 금요일은 더 높다. */
export const AFTER_WORK_COMMERCIAL_SHARE = 0.30;
export const FRIDAY_AFTER_WORK_COMMERCIAL_SHARE = 0.46;
export const WEEKEND_AFTER_WORK_COMMERCIAL_SHARE = 0.20;
/** 상업지대 체류시간 범위. */
export const AFTER_WORK_STAY_MINUTES = 45;
export const AFTER_WORK_STAY_MAX_MINUTES = 90;
/** 생필품이 이 이하이면 장보기 후보가 된다. 0까지 기다리지 않는다. */
export const SHOP_SUPPLY_TRIGGER = 72;
/** 주말 화물 통행 감소 배율. */
export const WEEKEND_FREIGHT_MUL = 0.55;

/* ---------------- 3.3단계: 시설 ---------------- */
/* 종류 수(FACILITY_COUNT = 7)와 복지 경계(FAC_WELFARE_BASE = 4)는 저장 코드 범위라서
   buildings.ts 에 있다. 여기 있는 것은 전부 밸런스 값이고, 순서는
   [소방, 경찰, 병원, 학교, 소공원, 공원, 체육시설] 로 고정이다.
   앞 4개 = 필수 서비스, 뒤 3개 = 복지. 배열 길이는 전부 7 이다. */

export const FACILITY_SPAN: readonly number[] = [2, 2, 3, 3, 1, 2, 3];
export const FACILITY_NAMES: readonly string[] =
  ['소방서', '경찰서', '병원', '학교', '소공원', '공원', '체육시설'];

/** 건설비. BUILD_COST(L3 = 6,200)·START_MONEY(60,000)와 같은 눈금이다. */
export const FACILITY_COST: readonly number[] =
  [4_500, 4_000, 14_000, 10_000, 600, 3_200, 8_000];

/** 하루 유지비. 도로(0.6/칸)와 달리 이쪽이 재정 압력의 주역이다. */
export const FACILITY_UPKEEP_PER_DAY: readonly number[] =
  [520, 480, 1_100, 900, 40, 260, 700];

/**
 * 반경. **앞 4개와 뒤 3개의 단위가 다르다.**
 *   0~3 필수 서비스 — 도로 BFS 거리 상한(칸). 병원은 구급차라 길고, 학교는 걸어서 간다.
 *   4~6 복지       — 유클리드 거리(타일). 공원이 가장 넓다.
 */
export const FACILITY_RANGE: readonly number[] = [40, 34, 55, 30, 8, 16, 12];

/** 도로에 닿아야 놓을 수 있는가. 소공원만 false — 자투리땅용이다. */
export const FACILITY_NEEDS_ROAD: readonly boolean[] =
  [true, true, true, true, false, true, true];

/* --- 필수 서비스(0~3)만 쓰는 값. 복지 자리는 0 이다. --- */

/** 담당 한계. 소방서만 건물 수, 나머지는 인구. */
export const FACILITY_CAPACITY: readonly number[] =
  [220, 3_000, 5_000, 2_500, 0, 0, 0];
export const FACILITY_CAPACITY_IS_BUILDINGS: readonly boolean[] =
  [true, false, false, false, false, false, false];

/** 정원을 넘었을 때 품질이 떨어지는 기울기. 1.0 이면 정원 2배에서 품질 0. */
export const OVERLOAD_SLOPE = 0.8;

/* --- 복지(4~6)만 쓰는 값. 필수 서비스 자리는 0 이다. --- */

/** 복지 점수 세기. 거리 감쇠(1 - d/range)를 곱해서 격자에 쌓인다. */
export const FACILITY_STRENGTH: readonly number[] =
  [0, 0, 0, 0, 0.35, 1.0, 0.9];

/** [kind][zone] 만족도 가중치. 합이 SERVICE_PENALTY_MAX 를 넘어도 된다(상한에서 잘린다). */
export const SERVICE_WEIGHT: readonly (readonly number[])[] = [
  [0.10, 0.12, 0.16], // 소방
  [0.14, 0.16, 0.06], // 경찰
  [0.16, 0.06, 0.04], // 병원
  [0.18, 0.02, 0.00], // 학교
];

/** 계층별 민감도. 고소득이 더 까다롭다. */
export const TIER_SERVICE_MUL: readonly number[] = [0.70, 1.00, 1.35];

/** 서비스 감점 상한. 통근·혼잡을 압도하지 못하게 막는 선. */
export const SERVICE_PENALTY_MAX = 0.45;

/** 유예 구간. 이 밑에서는 감점이 0 이고, 위 값에서 100% 가 된다. */
export const SERVICE_GRACE_POP = 400;
export const SERVICE_FULL_POP = 2_000;

/** BFS 상한. FACILITY_RANGE[0..3] 최대값 이상이어야 하고, dist 를 Uint8 에 담으므로 254 이하. */
export const SERVICE_FIELD_MAX_DIST = 64;

/* ---------------- 3.3단계: 복지 요구 ---------------- */

/**
 * 계층별로 요구하는 복지 점수. **이 배열이 복지 설계의 중심이다.**
 * FACILITY_STRENGTH 와 나란히 읽어라.
 *   0.35 = 소공원 바로 옆 한 채   (저소득이 요구하는 최소선)
 *   0.90 = 제대로 된 공원이 가까이  (중산층)
 *   1.80 = 공원 + 체육시설         (고소득)
 * 저소득 값을 0 으로 만들지 마라 — 그건 사람이 아무것도 기대하지 않는다는 뜻이다.
 */
export const AMENITY_NEED_BY_TIER: readonly number[] = [0.35, 0.90, 1.80];

/** 복지가 전혀 없을 때(fulfil = 0)의 감점. 주거 기준값이고 아래 배율이 곱해진다. */
export const AMENITY_GAP_MAX = 0.24;

/** 요구를 넘긴 초과분에 붙는 보너스 상한. 감점보다 작아야 한다 — 요구가 주인공이다. */
export const AMENITY_SURPLUS_MAX = 0.12;

/** 초과분 포화 곡선의 반값점. 초과가 이 값일 때 보너스가 상한의 절반. */
export const AMENITY_HALF = 1.2;

/** 용도별 배율. 감점과 보너스에 **똑같이** 곱한다. 공업도 0 은 아니다 — 거기서도 일한다. */
export const ZONE_AMENITY_MUL: readonly number[] = [1.0, 0.42, 0.12];

/**
 * 복지 점수를 Uint8 에 담을 때 곱하는 값.
 * 표현 가능한 최대 점수는 255/40 = 6.375 다. 고소득 요구(1.8)의 3.5배라 충분하고,
 * 그 위는 포화 곡선 때문에 거의 안 움직이므로 잘려도 무방하다.
 */
export const AMENITY_SCORE_SCALE = 40;

/** 스탬프 범위 상한. FACILITY_RANGE[4..6] 최대값 이상이어야 한다. */
export const AMENITY_FIELD_MAX_RANGE = 16;

/* ---------------- 3.3단계: 총 감점 상한 ---------------- */

/**
 * serviceGap + amenityGap 의 합에 걸리는 상한. **하강 나선의 바닥이다.**
 *
 * 6장 밸런스 표를 계산해보고 정한 값이다. 0.50 에서 "시설이 하나도 없어도 통근이
 * 보통이면 저소득 주거는 살아남는다"(만족도 0.305 > 기준선 0.25)가 성립한다.
 * 0.60 으로 올리면 0.205 가 되어 도시가 통째로 비기 시작한다.
 * **이 값만 따로 올리지 마라.** 올리려면 6장 표를 다시 계산해라.
 */
export const NEEDS_PENALTY_MAX = 0.50;
