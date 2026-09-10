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

export const POWER_REACH = 3;
export const WIRE_COST = 18;
export const WIRE_UPKEEP = 0.08;
export const FAC_WIND = 11;
export const FAC_GAS = 12;
export const FAC_SOLAR = 13;

export const POWER_SPECS: Readonly<Record<number, { capacity: number }>> = {
  [FAC_WIND]: { capacity: 2000 },
  [FAC_GAS]: { capacity: 12000 },
  [FAC_SOLAR]: { capacity: 6000 },
};

/** Parks and the STEP 5-reserved communication tower do not consume power. */
export function facilityPowerDemand(kind: number): number {
  if (POWER_SPECS[kind] || kind === 4 || kind === 5 || kind === FAC_COMM_TOWER) return 0;
  const demand = [
    80, 80, 200, 120, 0, 0, 100, 120, 300, 80, 200, 0, 0, 0, 250, 100, 20,
  ][kind];
  if (demand !== undefined) return demand;
  if (kind === FAC_AIRPORT) return 750;
  if (kind === FAC_AIRPORT_L2) return 1_500;
  if (kind === FAC_AIRPORT_L3) return 3_200;
  if (kind === FAC_HARBOR || kind === FAC_HARBOR_CARGO) return 450;
  if (kind === FAC_HARBOR_HYBRID_L2) return 900;
  if (kind === FAC_HARBOR_HYBRID_L3) return 1_800;
  if (kind === FAC_PRISON) return 260;
  return 100;
}
