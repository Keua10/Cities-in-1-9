import { OVERRIDE_NONE } from '../core/constants';
import { Build } from '../world/build';

export const ZONE_R = 0;
export const ZONE_C = 1;
export const ZONE_I = 2;
export const ZONE_COUNT = 3;
export const LEVEL_COUNT = 3;

export function footprintOf(level: number): number {
  return level;
}
export const MAX_FOOTPRINT = LEVEL_COUNT;

/**
 * bld 저장 코드:
 *   0~8   일반 지구 건물 앵커
 *   9~29  시설 앵커 (STEP 4.6까지 21종)
 *   254   다른 앵커가 덮는 칸
 *   255   빈 칸
 * 기존 번호는 저장 호환성 때문에 절대 재배치하지 않는다.
 */
export const BLD_NONE = 255;
export const BLD_COVERED = 254;
export const BLD_NONE_CHECK: typeof OVERRIDE_NONE = BLD_NONE;

export function bldCode(zone: number, level: number): number {
  return zone * LEVEL_COUNT + (level - 1);
}

export function isAnchor(v: number): boolean {
  return v < ZONE_COUNT * LEVEL_COUNT;
}

export function zoneOfCode(v: number): number {
  return Math.floor(v / LEVEL_COUNT);
}

/** 기존 0~8 뒤에 붙는 시설 코드 시작점. */
export const FAC_BASE = 9;
/**
 * 시설 종류 수. 0~16은 STEP 4.5까지의 기존 값이며,
 * STEP 4.6은 17 통신탑 / 18 공항 / 19 항구 / 20 교도소를 뒤에만 추가한다.
 */
export const FACILITY_COUNT = 21;
/** kind 4~6만 기존 복지 시설이다. */
export const FAC_WELFARE_BASE = 4;

export function isWelfareKind(kind: number): boolean {
  return kind >= FAC_WELFARE_BASE && kind < 7;
}

export function isFacilityAnchor(v: number): boolean {
  return v >= FAC_BASE && v < FAC_BASE + FACILITY_COUNT;
}

export function isAnyAnchor(v: number): boolean {
  return isAnchor(v) || isFacilityAnchor(v);
}

export function facilityKindOfCode(v: number): number {
  return v - FAC_BASE;
}

export function facCode(kind: number): number {
  return FAC_BASE + kind;
}

export function levelOfCode(v: number): number {
  return (v % LEVEL_COUNT) + 1;
}

export function zoneOfBuild(build: number): number {
  if (build === Build.ZoneR) return ZONE_R;
  if (build === Build.ZoneC) return ZONE_C;
  if (build === Build.ZoneI) return ZONE_I;
  return -1;
}

export const RESIDENT_CAPACITY: readonly number[] = [8, 44, 135];
export const JOB_CAPACITY_C: readonly number[] = [6, 34, 108];
export const JOB_CAPACITY_I: readonly number[] = [10, 52, 150];

export function capacityOf(zone: number, level: number): number {
  const i = level - 1;
  if (zone === ZONE_R) return RESIDENT_CAPACITY[i];
  if (zone === ZONE_C) return JOB_CAPACITY_C[i];
  return JOB_CAPACITY_I[i];
}

export const BUILD_COST: readonly number[] = [220, 1_400, 6_200];
export const REBUILD_SURCHARGE = 1.4;

export const ZONE_KEYS: readonly string[] = ['R', 'C', 'I'];
export const ZONE_NAMES: readonly string[] = ['주거', '상업', '공업'];
export const TIER_NAMES: readonly string[] = ['저소득', '중산층', '고소득'];

export function simHash(a: number, b: number, c: number, d: number): number {
  let h = (a | 0) * 0x27d4eb2d;
  h = (h ^ ((b | 0) * 0x165667b1)) >>> 0;
  h = (h ^ ((c | 0) * 0x9e3779b1)) >>> 0;
  h = (h ^ ((d | 0) * 0x85ebca6b)) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = (h * 0x2545f491) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return h >>> 0;
}

export function simRandom(a: number, b: number, c: number, d: number): number {
  return simHash(a, b, c, d) / 4294967296;
}
