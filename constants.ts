/**
 * 프로젝트 전역 상수.
 * 여기 있는 값은 클라이언트/서버(Vercel 함수) 양쪽이 똑같이 써야 한다.
 * 특히 WORLD_SEED 는 절대 바꾸면 안 된다 — 바꾸면 모든 학생의 지형이 갈아엎어진다.
 */

/* ---------- 아이소메트릭 타일 규격 ---------- */
export const TILE_W = 64; // 다이아몬드 가로
export const TILE_H = 32; // 다이아몬드 세로
export const TILE_HW = TILE_W / 2; // 32
export const TILE_HH = TILE_H / 2; // 16
export const HEIGHT_UNIT = 16; // 고도 1단계당 화면에서 올라가는 픽셀
export const MAX_HEIGHT = 8; // 고도 단계 0 ~ 8 (0 = 해수면)

/* ---------- 절벽(벽면) 규격 ---------- */
/** 벽면 그림 한 칸은 셀 안쪽 32x32 를 쓴다. 평행사변형이 그 안에 들어간다. */
export const WALL_ART = 32;

/* ---------- 월드 구조 ---------- */
export const CHUNK_SIZE = 64; // 청크 한 변의 타일 수
export const CHUNK_TILES = CHUNK_SIZE * CHUNK_SIZE; // 4096
export const BASE_CHUNK_SPAN = 4; // 도시 기본 영역 4x4 청크 (=256x256 타일)
export const BASE_SPACING_CHUNKS = 8; // 도시 간 육각 격자 간격
export const WORLD_SEED = 20260901;

/* ---------- 아틀라스 규격 ---------- */
/** 셀은 68x36. 가장자리 2px 는 투명 여백(블리딩 방지)이고 실제 그림은 안쪽 64x32. */
export const ATLAS_PAD = 2;
export const ATLAS_CELL_W = TILE_W + ATLAS_PAD * 2; // 68
export const ATLAS_CELL_H = TILE_H + ATLAS_PAD * 2; // 36
export const ATLAS_COLUMNS = 8;

/* ---------- 카메라 ---------- */
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 3;
export const DEFAULT_ZOOM = 1;
export const ZOOM_WHEEL_STEP = 0.0015;
export const PAN_FRICTION = 0.0038; // 관성 감쇠 계수 (1/ms)
export const PAN_MIN_SPEED = 0.02; // 이하로 떨어지면 관성 정지 (px/ms)

/* ---------- 렌더링 예산 ---------- */
export const RENDER_MARGIN_PX = 192; // 화면 밖으로 미리 채워두는 여유
export const CHUNK_MESH_BUDGET = 28; // 동시에 메모리에 올려두는 청크 메시 상한
export const SIM_RADIUS_CHUNKS = 1; // 마이크로 시뮬 반경 (카메라 기준 3x3)
export const MAX_ACTIVE_VEHICLES = 1000; // 4단계에서 사용
