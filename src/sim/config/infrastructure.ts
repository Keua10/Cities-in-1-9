/** L1 can tolerate shortages; L3 needs reliable utilities even with generous parks. */
export const TIER_UTILITY_MUL = [0.6, 1, 2.8] as const;

export function utilityPenalty(
  level: number,
  water: { supply: number; drainage: number; contamination: number },
  power: number,
  grace: number,
  waterRamp: number,
  powerRamp: number,
): number {
  const multiplier = TIER_UTILITY_MUL[level - 1] ?? 1;
  return (
    multiplier *
      grace *
      ((0.18 * (1 - water.supply) + 0.12 * (1 - water.drainage)) * waterRamp +
        0.3 * (1 - power) * powerRamp) +
    0.2 * water.contamination * water.supply
  );
}
