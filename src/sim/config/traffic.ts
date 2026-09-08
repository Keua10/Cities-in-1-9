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
export const CONGESTION_PENALTY_R = 0.3;
export const CONGESTION_PENALTY_W = 0.2;

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
export const VEHICLE_BODY_LENGTH_TILES = 0.5;
/** 차체 폭(타일). 차선 간격 계산과 스프라이트 크기가 같은 값을 본다. */
export const VEHICLE_WIDTH_TILES = 0.3;

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
export const MOVEMENT_CLEARANCE_TILES = 0.4;
/** 앞차 감지에서 "같은 차선" 으로 볼 가로 편차(타일). */
export const FOLLOW_LATERAL_TILES = 0.3;
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
  0, 0, 0, 0, 0, 0.05, 0.35, 0.8, 1.0, 0.6, 0.2, 0.05, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];
export const RUSH_TO_HOME: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.1, 0.5, 0.9, 1.0, 0.7, 0.3, 0.08, 0, 0,
];
export const RUSH_TO_SHOP: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.2, 0.35, 0.45, 0.4, 0.4, 0.45, 0.55, 0.7, 0.85, 1.0, 0.7, 0.3,
  0.05, 0,
];
export const FREIGHT_CURVE: readonly number[] = [
  0.1, 0.1, 0.1, 0.15, 0.25, 0.4, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0, 0.95, 1.0, 1.0, 0.9, 0.8, 0.7, 0.5,
  0.35, 0.25, 0.2, 0.15, 0.1,
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
export const INTERSECTION_STOP_T = 0.2;

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
export const SUNDAY_WORK_SHARE_C = 0.1;
export const SUNDAY_WORK_SHARE_I = 0.2;
/** 퇴근 뒤 바로 귀가하지 않고 상업지대를 들르는 비율. 금요일은 더 높다. */
export const AFTER_WORK_COMMERCIAL_SHARE = 0.3;
export const FRIDAY_AFTER_WORK_COMMERCIAL_SHARE = 0.46;
export const WEEKEND_AFTER_WORK_COMMERCIAL_SHARE = 0.2;
/** 상업지대 체류시간 범위. */
export const AFTER_WORK_STAY_MINUTES = 45;
export const AFTER_WORK_STAY_MAX_MINUTES = 90;
/** 생필품이 이 이하이면 장보기 후보가 된다. 0까지 기다리지 않는다. */
export const SHOP_SUPPLY_TRIGGER = 72;
/** 주말 화물 통행 감소 배율. */
export const WEEKEND_FREIGHT_MUL = 0.55;
