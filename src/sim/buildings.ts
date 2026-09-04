import { OVERRIDE_NONE } from '../core/constants';
import { Build } from '../world/build';

/**
 * 3.1단계: 지구 위에 실제로 들어서는 건물.
 *
 * 레이어가 세 겹이 된 이유를 먼저 적어둔다.
 *
 *   tiles  지형   (좌표에서 매번 생성, 저장 안 함)
 *   build  지구·도로 (학생이 지정, 저장)
 *   bld    건물   (시뮬레이션이 지음, 저장)
 *
 * 건물을 build 레이어에 섞지 않는 이유:
 *   건물을 헐면 **지구는 남아야 한다.** 한 칸에 값이 하나뿐이면 "주거지구 위의
 *   2단계 건물" 을 표현할 수 없고, 재건축할 때마다 학생이 지정한 지구가 날아간다.
 *
 * ---------------------------------------------------------------
 * 계층 = 레벨
 * ---------------------------------------------------------------
 *   레벨 1 = 저소득  1x1
 *   레벨 2 = 중산층  2x2
 *   레벨 3 = 고소득  3x3
 *
 * 신축은 계층별 수요 비율로 레벨을 뽑고, 부지가 안 되면 낮은 레벨로 내려온다.
 * 재건축은 **항상 상향** 이다. 수요가 줄거나 만족도가 떨어지면 건물은 남고
 * 사람만 빠져나간다(공실). 그래서 하향 재건축이 필요 없다.
 */

/** 지구 종류 index. Build.ZoneR/C/I 와 순서를 맞춘다. */
export const ZONE_R = 0;
export const ZONE_C = 1;
export const ZONE_I = 2;
export const ZONE_COUNT = 3;
export const LEVEL_COUNT = 3;

/** 레벨 n 건물이 차지하는 한 변의 타일 수. 레벨 1=1, 2=2, 3=3. */
export function footprintOf(level: number): number {
  return level;
}
export const MAX_FOOTPRINT = LEVEL_COUNT;

/* ---------------------------------------------------------------- *
 * bld 배열 인코딩
 * ---------------------------------------------------------------- */

/**
 * 칸당 1바이트.
 *
 *   255  빈 칸        (= OVERRIDE_NONE. codec.ts 압축 형식을 그대로 쓰기 위한 값)
 *   254  다른 건물이 차지한 칸 (앵커가 아님)
 *   0~8  앵커. zone * 3 + (level - 1)
 *
 * 앵커는 **footprint 의 왼쪽 위(-tx, -ty 쪽) 칸** 이다.
 *
 * 새 값은 반드시 9번부터 뒤에 붙인다. 중간에 끼우면 저장된 도시가 어긋난다.
 */
export const BLD_NONE = 255;
export const BLD_COVERED = 254;

/** 컴파일 타임 확인: 빈 칸 값이 codec 의 빈 값과 갈라지면 여기서 오류가 난다. */
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

export function levelOfCode(v: number): number {
  return (v % LEVEL_COUNT) + 1;
}

/** 지구 build 값 -> zone index. 지구가 아니면 -1. */
export function zoneOfBuild(build: number): number {
  if (build === Build.ZoneR) return ZONE_R;
  if (build === Build.ZoneC) return ZONE_C;
  if (build === Build.ZoneI) return ZONE_I;
  return -1;
}

/* ---------------------------------------------------------------- *
 * 건물 능력치
 * ---------------------------------------------------------------- */

/**
 * 건물 한 채의 정원.
 *
 * 레벨이 오르면 차지하는 칸도 늘어나므로(1 -> 4 -> 9칸) 칸당 밀도가 실제로
 * 올라가게 하려면 정원이 칸 수보다 더 빨리 늘어야 한다.
 *   레벨1  1칸 /  8명  = 8.0/칸
 *   레벨2  4칸 / 44명  = 11.0/칸
 *   레벨3  9칸 /135명  = 15.0/칸
 */
export const RESIDENT_CAPACITY: readonly number[] = [8, 44, 135];
export const JOB_CAPACITY_C: readonly number[] = [6, 34, 108];
export const JOB_CAPACITY_I: readonly number[] = [10, 52, 150];

export function capacityOf(zone: number, level: number): number {
  const i = level - 1;
  if (zone === ZONE_R) return RESIDENT_CAPACITY[i];
  if (zone === ZONE_C) return JOB_CAPACITY_C[i];
  return JOB_CAPACITY_I[i];
}

/** 건설비. 시뮬레이션이 도시 자금에서 뺀다. */
export const BUILD_COST: readonly number[] = [220, 1_400, 6_200];
/** 재건축은 기존 건물을 헐어야 하므로 웃돈이 붙는다. */
export const REBUILD_SURCHARGE = 1.4;

export const ZONE_KEYS: readonly string[] = ['R', 'C', 'I'];
export const ZONE_NAMES: readonly string[] = ['주거', '상업', '공업'];
export const TIER_NAMES: readonly string[] = ['저소득', '중산층', '고소득'];

/* ---------------------------------------------------------------- *
 * 결정론적 난수
 * ---------------------------------------------------------------- */

/**
 * 시뮬레이션에서 Math.random 을 쓰면 안 된다.
 *
 * 오프라인 따라잡기는 "같은 입력이면 같은 결과" 를 전제로 몇천 틱을 몰아서
 * 돌린다. 나중에 Vercel 함수가 같은 계산을 재현해서 검증할 수도 있어야 한다.
 * 그래서 난수가 필요한 자리에는 좌표와 틱 번호로 값을 만든다.
 */
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

/** 0 이상 1 미만. */
export function simRandom(a: number, b: number, c: number, d: number): number {
  return simHash(a, b, c, d) / 4294967296;
}
