import {
  FAC_AIRPORT,
  FAC_AIRPORT_L2,
  FAC_AIRPORT_L3,
  FAC_COMM_TOWER,
  FAC_HARBOR,
  FAC_HARBOR_CARGO,
  FAC_HARBOR_HYBRID_L2,
  FAC_HARBOR_HYBRID_L3,
  FAC_PRISON,
} from './special';

export const POWER_REACH = 5;
export const WIRE_COST = 18;
export const WIRE_UPKEEP = 0.08;
export const FAC_WIND = 11;
export const FAC_GAS = 12;
export const FAC_SOLAR = 13;
/** 석탄 화력(config/resources.ts FAC_COAL_POWER). 석탄이 있어야 돈다. */
export const FAC_COAL_POWER = 47;

export const POWER_SPECS: Readonly<Record<number, { capacity: number }>> = {
  [FAC_WIND]: { capacity: 5000 },
  [FAC_GAS]: { capacity: 30000 },
  [FAC_SOLAR]: { capacity: 15000 },
  // 2단계(대형, config/tiers.ts): 풍력 단지 · 복합화력 · 대형 태양광
  72: { capacity: 16000 },
  73: { capacity: 95000 },
  74: { capacity: 48000 },
  [FAC_COAL_POWER]: { capacity: 45000 },
};

/** Parks and the STEP 5-reserved communication tower do not consume power. */
export function facilityPowerDemand(kind: number): number {
  if (POWER_SPECS[kind] || kind === 4 || kind === 5 || kind === FAC_COMM_TOWER) return 0;
  const demand = [80, 80, 200, 120, 0, 0, 100, 120, 300, 80, 200, 0, 0, 0, 250, 100, 20][kind];
  if (demand !== undefined) return demand;
  if (kind === FAC_AIRPORT) return 750;
  if (kind === FAC_AIRPORT_L2) return 1_500;
  if (kind === FAC_AIRPORT_L3) return 3_200;
  if (kind === FAC_HARBOR || kind === FAC_HARBOR_CARGO) return 450;
  if (kind === FAC_HARBOR_HYBRID_L2) return 900;
  if (kind === FAC_HARBOR_HYBRID_L3) return 1_800;
  if (kind === FAC_PRISON) return 260;
  // 식량 시설 27~35: 밭·목장은 적게, 온실·가공 공장은 많이 쓴다.
  const food = [40, 20, 20, 60, 120, 250, 60, 30, 300][kind - 27];
  if (food !== undefined) return food;
  // 자원 36~46: 광산 1·2·3단계, 제철소, 정유소.
  const res = [150, 150, 150, 260, 260, 260, 420, 420, 420, 900, 700][kind - 36];
  if (res !== undefined) return res;
  // 2단계(대형) 62~71: 1단계보다 2~3배.
  const tier2 = [220, 220, 600, 320, 650, 260, 40, 600, 300, 520][kind - 62];
  if (tier2 !== undefined) return tier2;
  if (kind === 48) return 150;
  if (kind === 49) return 0;
  if (kind === 50) return 40;
  if (kind === 59) return 5;
  if (kind === 60) return 60;
  if (kind === 61) return 300;
  const mil = [400, 600, 120, 500, 600, 900, 800, 700][kind - 51];
  if (mil !== undefined) return mil;
  return 100;
}
