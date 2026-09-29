import { FAC_FIRE, FAC_HOSPITAL, FAC_SCHOOL } from './facilities';
import { OVERLOAD_SLOPE } from './simConstants';

/** Fire crews need spare response capacity; schools/clinics tolerate mild crowding. */
export function qualityFromLoad(kind: number, ratio: number): number {
  const excess = Math.max(0, ratio - 1);
  if (kind === FAC_FIRE) return 1 / (1 + 8 * excess);
  if (kind === FAC_HOSPITAL || kind === FAC_SCHOOL)
    return Math.max(0, 1 - Math.max(0, excess - 0.15) * 0.45);
  return Math.max(0, 1 - excess * OVERLOAD_SLOPE);
}
