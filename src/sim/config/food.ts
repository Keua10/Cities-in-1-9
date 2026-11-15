/**
 * 식량 (농업·목축·어업) 밸런스.
 *
 * 도시 하나가 스스로 먹고살 수 있을 만큼 생산력을 **높게** 잡는다. 나중에 전쟁이
 * 들어오면 나라가 아니라 도시 단위로 싸우므로, 도시 안의 농지만으로 군대까지
 * 먹일 수 있어야 한다. 대략 곡물 농장 하나(5×5)가 시민 900명을 먹인다.
 *
 * 생산량 = 기본 생산량 × (1 − 의존도 + 의존도 × 비옥도) × 가공 보너스
 *   비옥도: 하천 가까운 낮은 풀밭이 가장 높다 (continent.ts fertilityAt).
 *   의존도: 땅의 영향을 얼마나 받는가. 온실·양계장은 0, 곡물 농장은 1.
 */

export const FAC_GRAIN_FARM = 27;
export const FAC_VEGETABLE_FARM = 28;
export const FAC_ORCHARD = 29;
export const FAC_RANCH = 30;
export const FAC_POULTRY = 31;
export const FAC_GREENHOUSE = 32;
export const FAC_FISHERY = 33;
export const FAC_GRANARY = 34;
export const FAC_FOOD_PLANT = 35;

export interface FoodSpec {
  /** 하루 기본 생산량(식량 단위). 저장·가공 시설은 0. */
  output: number;
  /** 0~1 땅(비옥도)에 의존하는 정도. */
  fertilityWeight: number;
  /** 늘려주는 저장 용량. */
  storage: number;
  /** 물(하천·바다)에 닿아야 하는가. */
  needsWater: boolean;
  /** 시설 카드에 붙는 한 줄 설명. */
  blurb: string;
}

export const FOOD_SPECS: Readonly<Record<number, FoodSpec>> = {
  [FAC_GRAIN_FARM]: {
    output: 900,
    fertilityWeight: 1,
    storage: 0,
    needsWater: false,
    blurb: '넓은 밀밭 · 하천 가까운 평지일수록 잘 자람',
  },
  [FAC_VEGETABLE_FARM]: {
    output: 380,
    fertilityWeight: 0.9,
    storage: 0,
    needsWater: false,
    blurb: '작은 채소밭 · 하천 가까운 평지일수록 잘 자람',
  },
  [FAC_ORCHARD]: {
    output: 440,
    fertilityWeight: 0.55,
    storage: 0,
    needsWater: false,
    blurb: '과수원 · 언덕이나 마른 땅에서도 꽤 자람',
  },
  [FAC_RANCH]: {
    output: 1_000,
    fertilityWeight: 0.4,
    storage: 0,
    needsWater: false,
    blurb: '소 목장 · 풀만 있으면 어디서나',
  },
  [FAC_POULTRY]: {
    output: 650,
    fertilityWeight: 0,
    storage: 0,
    needsWater: false,
    blurb: '양계장 · 땅을 가리지 않음',
  },
  [FAC_GREENHOUSE]: {
    output: 1_100,
    fertilityWeight: 0,
    storage: 0,
    needsWater: false,
    blurb: '유리 온실 · 땅을 가리지 않음',
  },
  [FAC_FISHERY]: {
    output: 600,
    fertilityWeight: 0,
    storage: 0,
    needsWater: true,
    blurb: '어업 기지 · 바다 600, 강·개울 380',
  },
  [FAC_GRANARY]: {
    output: 0,
    fertilityWeight: 0,
    storage: 20_000,
    needsWater: false,
    blurb: '곡물 창고 · 비축량 +20,000',
  },
  [FAC_FOOD_PLANT]: {
    output: 0,
    fertilityWeight: 0,
    storage: 5_000,
    needsWater: false,
    blurb: '식품 가공 · 모든 농장 생산 +20% (두 번째부터 +10%)',
  },
};

/** 시민 한 명이 하루에 먹는 식량. */
export const FOOD_PER_PERSON = 1;
/** 창고 없이도 쌓아 둘 수 있는 양. */
export const FOOD_BASE_STORAGE = 3_000;
/**
 * 근교 농가에서 공짜로 들어오는 식량(하루). 작은 마을은 농장 없이도 먹고산다.
 * 시민 300명을 넘기면서부터 농장을 짓느냐 사 오느냐가 갈린다.
 */
export const FOOD_LOCAL_SUPPLY = 300;
/** 모자란 식량을 다른 지역에서 사 오는 값(식량 1당). 1 = 만 원. */
export const FOOD_IMPORT_PRICE = 0.35;
/** 남는 식량을 내다 파는 값. 운송비를 빼서 수입가보다 훨씬 싸다. */
export const FOOD_EXPORT_PRICE = 0.2;
/** 강·개울에 닿은 어업 기지의 생산 비율 (바다 = 1). */
export const FISHERY_RIVER_RATE = 380 / 600;
/** 식품 가공 공장 보너스: 첫 공장 +20%, 이후 +10%씩, 최대 +40%. */
export const FOOD_PLANT_FIRST = 0.2;
export const FOOD_PLANT_NEXT = 0.1;
export const FOOD_PLANT_MAX = 0.4;

export function isFoodKind(kind: number): boolean {
  return FOOD_SPECS[kind] !== undefined;
}
