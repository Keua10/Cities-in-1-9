/**
 * 필수 인프라 게이트 (수정사항 1 · 13).
 *
 * STEP 4 까지 전기·상수·하수는 **만족도 감점** 에 지나지 않았다. 그래서 발전소를
 * 하나도 짓지 않아도 도시가 멀쩡히 자랐다. 도시 건설 게임에서 그건 규칙이 아니라
 * 장식이다. 여기서 필수 인프라는 **입주 자체의 상한** 이 된다.
 *
 *   - 전기가 아예 안 닿는 건물에는 아무도 살지 않는다(입주 상한 0).
 *   - 상수가 안 닿는 건물도 마찬가지다.
 *   - 하수가 안 닿으면 살 수는 있지만 절반 이상 차지 않는다.
 *   - 용량이 모자라면(공급 비율 < 1) 그 비율만큼 상한이 내려간다.
 *
 * 그리고 이 상한은 **신축에도 걸린다.** 전기·물이 안 들어오는 땅에는 수요가
 * 있어도 건물이 서지 않는다. 짓자마자 공실이 될 건물을 짓는 건 플레이어에게
 * 아무 정보도 주지 않는다.
 *
 * 저장되는 값이 아니므로 밸런스는 여기서만 만지면 된다.
 */

/** 도시 초반 유예(게임일). 이 기간에는 게이트가 전혀 작동하지 않는다. */
export const ESSENTIAL_GRACE_DAYS = 10;
/** 유예가 끝난 뒤 게이트가 100% 로 차오르는 데 걸리는 기간(게임일). */
export const ESSENTIAL_RAMP_DAYS = 10;

/** 하수가 전혀 없을 때 허용되는 입주 상한. 0 이 아니라 "살기 힘든 동네". */
export const NO_SEWER_CEILING = 0.35;
/** 연결만 되어 있으면 보장되는 최소 상한. 용량 부족을 즉사로 만들지 않는다. */
export const CONNECTED_FLOOR = 0.25;

/** 신축이 허용되는 최소 인프라 준비도. 이보다 낮은 땅에는 건물이 서지 않는다. */
export const BUILD_READINESS_MIN = 0.5;

export interface EssentialSupply {
  /** 급수 비율 0~1. 0 은 미연결. */
  supply: number;
  /** 하수 처리 비율 0~1. 0 은 미연결. */
  drainage: number;
}

/**
 * 게이트 강도. 0 이면 무시, 1 이면 완전 적용.
 * `days` 는 인프라가 열린 뒤 흐른 게임일이다.
 */
export function essentialGate(days: number): number {
  return Math.max(0, Math.min(1, (days - ESSENTIAL_GRACE_DAYS) / ESSENTIAL_RAMP_DAYS));
}

/** 연결 비율 하나를 입주 상한으로 바꾼다. 0(미연결)은 그대로 0 이다. */
function ceilingOf(ratio: number): number {
  if (ratio <= 0) return 0;
  return Math.min(1, CONNECTED_FLOOR + (1 - CONNECTED_FLOOR) * ratio);
}

/**
 * 필수 인프라만으로 결정되는 입주 상한(0~1).
 * 유예 중에는 항상 1 이고, 게이트가 차오를수록 실제 상한으로 내려간다.
 */
export function essentialCeiling(water: EssentialSupply, power: number, gate: number): number {
  if (gate <= 0) return 1;
  const sewer = water.drainage <= 0 ? NO_SEWER_CEILING : ceilingOf(water.drainage);
  const raw = Math.min(ceilingOf(power), ceilingOf(water.supply), sewer);
  return 1 - gate * (1 - raw);
}

/**
 * 빈 땅의 인프라 준비도(0~1). 신축 가능 여부를 여기서 본다.
 * 아직 건물이 없으므로 배관·전선 **커버리지** 로 본다.
 */
export function essentialReadiness(water: EssentialSupply, power: number, gate: number): number {
  return essentialCeiling(water, power, gate);
}
