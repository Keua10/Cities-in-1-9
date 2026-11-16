/**
 * 자원 (군사 2단계): 철·석탄·석유.
 *
 *   매장지   world/deposits.ts — 여러 청크에 걸친 덩어리. 청크마다 매장량과 난이도(얕음·보통·깊음).
 *   채굴     철광산·탄광·유정 1~3단계. 단계가 높을수록 깊은 곳까지, 더 많이 캔다.
 *   쓰임     제철소(철+석탄 → 공업 생산력), 정유소(석유 → 공업 생산력), 석탄 화력 발전(석탄 → 전기).
 *            군대(4단계부터)도 철·석탄·석유를 쓴다.
 *   거래     도시 간 공용 시장(net/market.ts). 많이 캐는 도시가 수출국이 된다.
 *
 * 단위: 자원은 "단위", 돈은 만 원(다른 설정과 같음).
 */

export type ResourceId = 'iron' | 'coal' | 'oil';
export const RESOURCES: readonly ResourceId[] = ['iron', 'coal', 'oil'];
export const RESOURCE_NAMES: Record<ResourceId, string> = {
  iron: '철',
  coal: '석탄',
  oil: '석유',
};
/** 지도·패널 색. */
export const RESOURCE_COLORS: Record<ResourceId, number> = {
  iron: 0xc8643c,
  coal: 0x4a4f57,
  oil: 0xe0b23a,
};

/** 채굴 난이도. 0 얕음, 1 보통, 2 깊음. 채굴 시설 단계 - 1 이하만 캘 수 있다. */
export const DIFFICULTY_NAMES = ['얕음', '보통', '깊음'] as const;

/* ---------------- 시설 ID ---------------- */

export const FAC_IRON_MINE_1 = 36;
export const FAC_COAL_MINE_1 = 37;
export const FAC_OIL_WELL_1 = 38;
export const FAC_IRON_MINE_2 = 39;
export const FAC_COAL_MINE_2 = 40;
export const FAC_OIL_WELL_2 = 41;
export const FAC_IRON_MINE_3 = 42;
export const FAC_COAL_MINE_3 = 43;
export const FAC_OIL_WELL_3 = 44;
export const FAC_STEEL_MILL = 45;
export const FAC_REFINERY = 46;
export const FAC_COAL_POWER = 47;

export interface MineSpec {
  resource: ResourceId;
  /** 1~3. 캘 수 있는 난이도 = tier - 1 이하. */
  tier: number;
  /** 하루 채굴량(단위). */
  output: number;
}

/** 단계별 채굴 속도 배수: ×1, ×2, ×3.5 (설계안 Ⅳ). */
export const MINE_TIER_RATE = [1, 2, 3.5] as const;
/** 1단계 기준 하루 채굴량. */
export const MINE_BASE_OUTPUT: Record<ResourceId, number> = { iron: 40, coal: 50, oil: 25 };

export const MINE_SPECS: Readonly<Record<number, MineSpec>> = (() => {
  const out: Record<number, MineSpec> = {};
  const ids: Record<ResourceId, number[]> = {
    iron: [FAC_IRON_MINE_1, FAC_IRON_MINE_2, FAC_IRON_MINE_3],
    coal: [FAC_COAL_MINE_1, FAC_COAL_MINE_2, FAC_COAL_MINE_3],
    oil: [FAC_OIL_WELL_1, FAC_OIL_WELL_2, FAC_OIL_WELL_3],
  };
  for (const r of RESOURCES)
    ids[r].forEach((kind, i) => {
      out[kind] = {
        resource: r,
        tier: i + 1,
        output: Math.round(MINE_BASE_OUTPUT[r] * MINE_TIER_RATE[i]),
      };
    });
  return out;
})();

export function isMineKind(kind: number): boolean {
  return MINE_SPECS[kind] !== undefined;
}

/* ---------------- 가공·소비 시설 ---------------- */

export interface ConsumerSpec {
  /** 하루에 쓰는 자원. */
  input: Partial<Record<ResourceId, number>>;
  blurb: string;
}

export const CONSUMER_SPECS: Readonly<Record<number, ConsumerSpec>> = {
  [FAC_STEEL_MILL]: {
    input: { iron: 30, coal: 15 },
    blurb: '철 30 + 석탄 15/일 → 공업 생산력 +12% (두 번째부터 +6%)',
  },
  [FAC_REFINERY]: {
    input: { oil: 20 },
    blurb: '석유 20/일 → 공업 생산력 +12% (두 번째부터 +6%) · 가스 발전 연료비 -40%',
  },
  [FAC_COAL_POWER]: {
    input: { coal: 35 },
    blurb: '석탄 35/일 → 전력 45,000 · 석탄이 떨어지면 멈춤 · 대기 오염 큼',
  },
};

/** 제철소·정유소가 올려주는 공업 세수. 첫 시설 +12%, 다음부터 +6%씩, 합쳐 최대 +40%. */
export const INDUSTRY_BONUS_FIRST = 0.12;
export const INDUSTRY_BONUS_NEXT = 0.06;
export const INDUSTRY_BONUS_MAX = 0.4;
/** 정유소가 하나라도 돌면 가스 발전소 유지비가 이만큼 준다. */
export const REFINERY_GAS_DISCOUNT = 0.4;

/** 자원마다 쌓아 둘 수 있는 최대량. 가득 차면 광산이 멈춘다(시장에 파세요). */
export const RESOURCE_STORAGE = 10_000;

/* ---------------- 매장지 생성 ---------------- */

/** 청크 하나의 기본 매장량(얕음). 보통 ×1.6, 깊음 ×2.8. */
export const DEPOSIT_BASE_RESERVE: Record<ResourceId, number> = {
  iron: 6_000,
  coal: 7_000,
  oil: 4_000,
};
export const DIFFICULTY_RESERVE_MUL = [1, 1.6, 2.8] as const;
/** 매장지가 있으면 청크마다 최소 이만큼은 있다(쓸 만한 양 보장). */
export const DEPOSIT_MIN_RESERVE = 2_500;

/* ---------------- 시장 ---------------- */

/** 기준 가격(만 원/단위). */
export const MARKET_BASE_PRICE: Record<ResourceId, number> = { iron: 6, coal: 4, oil: 10 };
/** 시장 재고가 이 값이면 기준 가격. 많으면 싸지고 적으면 비싸진다. */
export const MARKET_REF_STOCK: Record<ResourceId, number> = {
  iron: 30_000,
  coal: 30_000,
  oil: 20_000,
};
export const MARKET_PRICE_MIN = 0.35;
export const MARKET_PRICE_MAX = 3;
/** 살 때는 시세보다 비싸게, 팔 때는 싸게(거래 수수료). */
export const MARKET_BUY_MARKUP = 1.08;
export const MARKET_SELL_MARKDOWN = 0.92;
/** 한 번에 사고팔 수 있는 최대량. */
export const MARKET_MAX_LOT = 5_000;

/** 시장 재고에 따른 시세(만 원/단위). */
export function marketPrice(r: ResourceId, stock: number): number {
  const ref = MARKET_REF_STOCK[r];
  const f = Math.pow(2, ((ref - Math.max(0, stock)) / ref) * 1.5);
  return MARKET_BASE_PRICE[r] * Math.max(MARKET_PRICE_MIN, Math.min(MARKET_PRICE_MAX, f));
}

/**
 * qty 만큼 사고팔 때 총액. 한 단위씩 재고가 움직이며 값이 바뀌므로 구간 평균으로 계산한다.
 * qty > 0 = 시장에서 산다(재고 감소), qty < 0 = 시장에 판다(재고 증가).
 */
export function tradeTotal(r: ResourceId, stock: number, qty: number): number {
  if (qty === 0) return 0;
  const after = stock - qty;
  const steps = 8;
  let sum = 0;
  for (let i = 0; i < steps; i++)
    sum += marketPrice(r, stock + ((after - stock) * (i + 0.5)) / steps);
  const avg = sum / steps;
  return qty > 0 ? avg * qty * MARKET_BUY_MARKUP : avg * -qty * MARKET_SELL_MARKDOWN;
}
