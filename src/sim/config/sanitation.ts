import { FAC_PRISON } from './special';

export const FAC_INCINERATOR = 14;
export const FAC_CREMATORIUM = 15;
export const FAC_CEMETERY = 16;

/**
 * Multi-source road-service passes. Prison is not a new police station code; it is a separate
 * facility kind that feeds the existing police service channel through serviceChannel().
 */
export const ROAD_SERVICE_KINDS = [0, 1, 2, 3, FAC_INCINERATOR, FAC_CREMATORIUM] as const;

export function serviceChannel(kind: number): number {
  if (kind === FAC_CEMETERY) return FAC_CREMATORIUM;
  if (kind === FAC_PRISON) return 1;
  return kind;
}

export function usesServiceBudget(kind: number): boolean {
  return kind < 4 || (kind >= FAC_INCINERATOR && kind <= FAC_CEMETERY) || kind === FAC_PRISON;
}
