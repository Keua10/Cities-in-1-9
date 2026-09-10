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
/** parks do not conduct electricity; other civic buildings have a fixed demand. */
export function facilityPowerDemand(kind: number): number {
  if (POWER_SPECS[kind] || kind === 4 || kind === 5) return 0;
  return [80, 80, 200, 120, 0, 0, 100, 120, 300, 80, 200, 0, 0, 0, 250, 100, 20][kind] ?? 100;
}
