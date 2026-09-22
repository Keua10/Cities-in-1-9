import {
  COMMUTE_BAD_DIST,
  COMMUTE_GOOD_DIST,
  INDUSTRY_NUISANCE_MAX,
  ROAD_DIST_UNREACHABLE,
} from './simConstants';

/**
 * 환경도 (수정사항 4).
 *
 * 지금까지 "환경" 이라 부를 만한 것은 만족도 안에 흩어져 있었다 — 공업 혐오는
 * nuisance, 혼잡은 congestion, 공원은 amenity, 통근은 commute. 각자 잘 돌지만
 * **플레이어에게는 아무것도 보이지 않았다.** 건물을 눌러도 "입주 41%" 만 나오고
 * 왜 41% 인지는 알 수 없었다.
 *
 * 환경도는 그 다섯 가지를 하나의 0~1 점수로 모은 값이다. 새로운 시뮬레이션을
 * 더하는 게 아니라 **이미 돌고 있는 값을 읽을 수 있게 만드는 것** 이므로,
 * 만족도에 다시 곱하지 않는다(같은 항을 두 번 세면 밸런스가 무너진다).
 * 화면에 뜨는 건 이 점수이고, 점수가 낮은 이유도 항목별로 그대로 나온다.
 *
 *   공원   공원·복지 요구를 얼마나 채웠는가
 *   소음   공업 밀도와 도로 혼잡이 만드는 시끄러움
 *   오염   수질 오염과 공업 매연
 *   교통   원하는 곳까지 가는 데 걸리는 정체
 *   접근성 직장까지의 도로 거리
 */
export interface EnvironmentParts {
  /** 0~1. 높을수록 좋다. */
  parks: number;
  /** 0~1. 높을수록 **나쁘다**. */
  noise: number;
  /** 0~1. 높을수록 **나쁘다**. */
  pollution: number;
  /** 0~1. 높을수록 **나쁘다**. */
  traffic: number;
  /** 0~1. 높을수록 좋다. */
  access: number;
}

export const ENVIRONMENT_WEIGHT = {
  parks: 0.22,
  noise: 0.2,
  pollution: 0.22,
  traffic: 0.18,
  access: 0.18,
} as const;

export const ENVIRONMENT_LABELS: Record<keyof EnvironmentParts, string> = {
  parks: '공원',
  noise: '소음',
  pollution: '오염',
  traffic: '교통',
  access: '접근성',
};

export const EMPTY_ENVIRONMENT: EnvironmentParts = {
  parks: 0,
  noise: 0,
  pollution: 0,
  traffic: 0,
  access: 0,
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 통근 거리를 0~1 접근성 점수로. 만족도의 통근 곡선과 같은 모양이다. */
export function accessFromCommute(dist: number): number {
  if (dist >= ROAD_DIST_UNREACHABLE) return 0;
  if (dist <= COMMUTE_GOOD_DIST) return 1;
  if (dist >= COMMUTE_BAD_DIST) return 0;
  return 1 - (dist - COMMUTE_GOOD_DIST) / (COMMUTE_BAD_DIST - COMMUTE_GOOD_DIST);
}

/**
 * 건물 한 채의 환경도 항목을 만든다.
 *
 * @param nuisance  청크 공업 밀도 감점(만족도가 쓰는 값 그대로). 0~INDUSTRY_NUISANCE_MAX.
 * @param congestion 경로 혼잡 0~1.
 * @param amenityFulfil 공원·복지 요구 충족 0~1.
 * @param waterContamination 수질 오염 0~1.
 */
export function environmentParts(
  commuteDist: number,
  nuisance: number,
  congestion: number,
  amenityFulfil: number,
  waterContamination: number,
): EnvironmentParts {
  const industry = clamp01(nuisance / INDUSTRY_NUISANCE_MAX);
  return {
    parks: clamp01(amenityFulfil),
    // 소음은 공장과 막히는 도로 둘 다에서 온다. 둘 중 나쁜 쪽이 아니라 합이다 —
    // 공장 옆 간선도로는 둘 다 겪는다.
    noise: clamp01(industry * 0.7 + congestion * 0.5),
    // 오염은 수질이 먼저다. 눈에 보이는 색이 바로 이 값이기 때문이다.
    pollution: clamp01(Math.max(waterContamination, industry * 0.8)),
    traffic: clamp01(congestion),
    access: accessFromCommute(commuteDist),
  };
}

/** 항목을 0~1 환경도 한 값으로 모은다. */
export function environmentScore(p: EnvironmentParts): number {
  const w = ENVIRONMENT_WEIGHT;
  return clamp01(
    w.parks * p.parks +
      w.access * p.access +
      w.noise * (1 - p.noise) +
      w.pollution * (1 - p.pollution) +
      w.traffic * (1 - p.traffic),
  );
}

/**
 * 건물 위에 띄우는 경고 종류 (수정사항 14).
 * 급한 것부터 나열한 순서 그대로다.
 */
export type BuildingAlert =
  | 'road'
  | 'power'
  | 'water'
  | 'sewer'
  | 'pollution'
  | 'fire'
  | 'police'
  | 'health'
  | 'environment';

export const ALERT_LABELS: Record<BuildingAlert, string> = {
  road: '도로에 연결되지 않았습니다',
  power: '전기가 들어오지 않습니다',
  water: '물이 들어오지 않습니다',
  sewer: '하수가 처리되지 않습니다',
  pollution: '수돗물이 오염됐습니다',
  fire: '소방서가 닿지 않습니다',
  police: '경찰서가 닿지 않습니다',
  health: '병원이 닿지 않습니다',
  environment: '환경도가 낮습니다',
};

/** 환경도가 이보다 낮으면 건물 위에 경고를 띄운다. */
export const ENVIRONMENT_WARNING = 0.45;
