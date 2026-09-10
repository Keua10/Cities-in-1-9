export interface CityPolicies {
  taxR: number;
  taxC: number;
  taxI: number;
  serviceBudget: number;
}
export const DEFAULT_POLICIES: Readonly<CityPolicies> = {
  taxR: 9,
  taxC: 9,
  taxI: 9,
  serviceBudget: 100,
};
export function normalizePolicies(value?: Partial<CityPolicies> | null): CityPolicies {
  const finite = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v)
      ? Math.max(min, Math.min(max, Math.round(v)))
      : fallback;
  return {
    taxR: finite(value?.taxR, 9, 0, 20),
    taxC: finite(value?.taxC, 9, 0, 20),
    taxI: finite(value?.taxI, 9, 0, 20),
    serviceBudget: finite(value?.serviceBudget, 100, 50, 150),
  };
}
export function taxRate(p: CityPolicies, zone: number): number {
  return [p.taxR, p.taxC, p.taxI][zone] ?? 9;
}
export function taxSatisfactionPenalty(p: CityPolicies, zone: number): number {
  return Math.max(-0.06, (taxRate(p, zone) - 9) * 0.015);
}
