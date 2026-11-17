/**
 * 전쟁 규칙 수치 (군사 4·5단계). 설계안 v0.2 Ⅷ 장.
 * 시간은 모두 실제 시간(ms)이고 공유 시계(sharedNow) 기준이다.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

/** 선전포고 뒤 준비 시간. 양쪽 모두 부대를 배치할 수 있다. */
export const WAR_PREP_MS = 5 * MIN;
/** 선전포고 거리: 상대 영토가 내 영토에서 이 청크 안. */
export const WAR_RANGE_CHUNKS = 24;
/** 소규모 전쟁 최소 수도 레벨. 대규모는 3. */
export const SMALL_WAR_CAPITAL = 2;
export const LARGE_WAR_CAPITAL = 3;
/** 부대 스냅숏을 보내는 간격. */
export const WAR_SYNC_MS = 2_500;
/** 상대 스냅숏이 이보다 오래되면 상대가 끊긴 것으로 보고 전쟁을 멈춘다. */
export const WAR_STALE_MS = 20_000;
/** 끊긴 채로 이만큼 지나면 피해 정도로 판정한다(확정). */
export const WAR_JUDGE_AFTER_MS = 24 * HOUR;
/** 양쪽 병력의 10% 이상이 붙은 전투가 이만큼 없으면 휴전. */
export const CEASEFIRE_QUIET_MS = 1 * HOUR;
export const BIG_BATTLE_SHARE = 0.1;
/** 휴전 뒤 전쟁 금지(확정). */
export const CEASEFIRE_PEACE_MS = 12 * HOUR;
/** 패전국에 대한 재선전포고 금지(패전국 회복 장치). */
export const DEFEAT_PEACE_MS = 48 * HOUR;
/** 점수 비율이 이 이상이면 승전, 아니면 종전 협정(배상 없음). */
export const WIN_RATIO = 1.5;
/** 점령한 청크 하나의 점수. */
export const OCCUPIED_CHUNK_SCORE = 2_000;
/** 배상 한도. */
export const REPARATION_MONEY = 0.25;
export const REPARATION_RESOURCES = 0.3;

/* ---------------- 기습 ---------------- */

export const SURPRISE_MIN_CITY_LEVEL = 5;
/** 직전 이 시간 안에 다른 전쟁이 없어야 한다. */
export const SURPRISE_QUIET_MS = 24 * HOUR;
/** 국경 몇 청크 안의 병력을 비교하나. */
export const SURPRISE_BORDER_CHUNKS = 2;
export const SURPRISE_RATIO = 1.5;
/** 기습한 도시의 대가: 이 시간 동안 동맹 신청 불가. */
export const SURPRISE_PENALTY_MS = 24 * HOUR;

/* ---------------- 동맹 (군사 5단계) ---------------- */

/** 동맹 보증금 선택지(만 원). 양쪽이 같은 금액을 건다. */
export const ALLIANCE_DEPOSITS = [0, 1_000, 5_000, 20_000] as const;
/** 동시에 맺을 수 있는 동맹(신청 중 포함). */
export const MAX_ALLIANCES = 3;
/** 배신(동맹에게 선전포고)한 도시는 이 시간 동안 새 동맹을 맺지 못한다. */
export const BETRAYAL_LOCK_MS = 24 * HOUR;

/* ---------------- 전시 경제 (설계안 Ⅸ) ---------------- */

/** 전쟁 중 식량 수입 가격 배율. */
export const WAR_FOOD_IMPORT_MUL = 1.5;
/** 전쟁 피로: 전쟁이 길어질수록 만족도가 시간당 이만큼 떨어진다(최대 WAR_FATIGUE_MAX). */
export const WAR_FATIGUE_PER_HOUR = 0.02;
export const WAR_FATIGUE_MAX = 0.15;
/** 승전 뒤 이 시간 동안 만족도 +VICTORY_MOOD. */
export const VICTORY_MOOD = 0.05;
export const POSTWAR_MS = 6 * HOUR;
/** 전후 복구: 종전 뒤 6시간 공사 속도(패전국 3배, 나머지 2배). */
export const REBUILD_MUL = 2;
export const REBUILD_MUL_LOSER = 3;
