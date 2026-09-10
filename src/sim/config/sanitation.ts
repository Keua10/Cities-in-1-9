export const FAC_INCINERATOR = 14;
export const FAC_CREMATORIUM = 15;
export const FAC_CEMETERY = 16;
/** Funeral alternatives share one road coverage channel; demand is counted once. */
export const ROAD_SERVICE_KINDS = [0, 1, 2, 3, FAC_INCINERATOR, FAC_CREMATORIUM] as const;
export function serviceChannel(kind: number): number {
  return kind === FAC_CEMETERY ? FAC_CREMATORIUM : kind;
}
export function usesServiceBudget(kind: number): boolean {
  return kind < 4 || (kind >= FAC_INCINERATOR && kind <= FAC_CEMETERY);
}
