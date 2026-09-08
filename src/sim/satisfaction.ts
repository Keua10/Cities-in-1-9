import { ZONE_C, ZONE_R } from './buildings';
import {
  COMMUTE_BAD_DIST,
  COMMUTE_GOOD_DIST,
  CONGESTION_PENALTY_R,
  CONGESTION_PENALTY_W,
  ROAD_DIST_UNREACHABLE,
  SERVICE_FULL_POP,
  SERVICE_GRACE_POP,
} from './simConstants';

/**
 * 만족도.
 *
 * 3.1단계는 통근과 공업 혐오, 3.2단계가 혼잡, 3.3단계가 서비스·복지를 얹었다.
 * **기존 항은 손대지 않는다** — 각 항 끝에서 `- needsGap + amenityBonus` 만 한다.
 * 계층별 기준선(SATISFACTION_FLOOR)은 호출한 쪽에서 적용한다 —
 * 같은 자리라도 고소득 건물이 더 까다롭게 군다.
 *
 * **보너스 쪽에는 상한 클램프를 새로 넣지 마라.** 만족도가 1을 넘어도 입주율은
 * 호출부에서 잘린다. 넘은 만큼은 버려지는 게 아니라 **완충** 이 된다 — 공원을
 * 넉넉히 깔아둔 동네는 나중에 혼잡이 좀 늘어도 사람이 바로 빠지지 않는다.
 */
export function satisfaction(
  zone: number,
  commuteDist: number,
  nuisance: number,
  congestion: number,
  /** 필수 서비스 + 복지 부족분을 합친 감점. NEEDS_PENALTY_MAX 로 이미 잘린 값. */
  needsGap: number,
  /** 요구를 넘긴 복지에 붙는 소폭 보너스. */
  amenityBonus: number,
): number {
  if (commuteDist >= ROAD_DIST_UNREACHABLE) return 0;

  let commute: number;
  if (commuteDist <= COMMUTE_GOOD_DIST) commute = 1;
  else if (commuteDist >= COMMUTE_BAD_DIST) commute = 0;
  else {
    commute = 1 - (commuteDist - COMMUTE_GOOD_DIST) / (COMMUTE_BAD_DIST - COMMUTE_GOOD_DIST);
  }

  const needs = amenityBonus - needsGap;

  if (zone === ZONE_R)
    return Math.max(
      0,
      0.35 + 0.65 * commute - nuisance - CONGESTION_PENALTY_R * congestion + needs,
    );
  if (zone === ZONE_C)
    return Math.max(0, 0.3 + 0.7 * commute - CONGESTION_PENALTY_W * congestion + needs);
  return Math.max(0, 0.45 + 0.55 * commute - CONGESTION_PENALTY_W * congestion + needs);
}

/**
 * 인구에 따른 감점 유예. **서비스와 복지에 똑같이 건다.**
 *
 *   population <= SERVICE_GRACE_POP  ->  0  (감점 없음)
 *   population >= SERVICE_FULL_POP   ->  1
 *   그 사이                          ->  선형 보간
 */
export function graceFactor(population: number): number {
  if (population <= SERVICE_GRACE_POP) return 0;
  if (population >= SERVICE_FULL_POP) return 1;
  return (population - SERVICE_GRACE_POP) / (SERVICE_FULL_POP - SERVICE_GRACE_POP);
}
