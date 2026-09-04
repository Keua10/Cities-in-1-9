import { CHUNK_SIZE, CHUNK_TILES, WORLD_SEED } from '../core/constants';
import { localIndexOf } from '../core/iso';
import { isWater } from '../world/terrain';
import type { Parcel, World } from '../world/world';
import {
  BLD_NONE,
  BUILD_COST,
  capacityOf,
  isAnchor,
  LEVEL_COUNT,
  levelOfCode,
  REBUILD_SURCHARGE,
  simRandom,
  zoneOfBuild,
  zoneOfCode,
} from './buildings';
import type { RoadField } from './roadGraph';
import {
  DEMAND_SCALE,
  MAX_BUILDS_PER_TICK,
  MAX_REBUILDS_PER_TICK,
  REBUILD_DEMAND_GAP,
  REBUILD_MIN_AGE_DAYS,
  REBUILD_SCAN_BUDGET,
  REDEVELOPMENT_SECTOR_SIZE,
} from './simConstants';

/**
 * 건물이 들어서고 갈아엎히는 규칙.
 *
 * 두 가지 동작만 있다.
 *
 *   신축   빈 부지가 남아 있는 동안. 계층별 수요 비율로 레벨을 뽑고,
 *          그 레벨의 부지(1x1 / 2x2 / 3x3)가 안 나오면 한 단계씩 낮춘다.
 *
 *   재건축 **16x16 자기 섹터와 인접 8개 섹터에 빈 부지가 없을 때만.**
 *          자기 섹터에서 충분히 오래된 건물들을 찾아 더 높은 레벨 하나를 세운다.
 *          항상 상향이다. 수요가 식으면 건물은 남고 사람만 빠진다(공실).
 */

export interface GrowthContext {
  /** [zone][level-1] 형태의 수요. -1 ~ +1. */
  demand: number[][];
  /** 도로망. 어느 칸이 개발 가능한지 여기서 본다. */
  field: RoadField;
  /** 지금 게임 날짜(일). 건설 날짜로 기록된다. */
  today: number;
  /** 지금 틱 번호. 결정론적 난수의 씨앗으로 들어간다. */
  tick: number;
  /** 쓸 수 있는 돈. 이 함수는 읽기만 하고, 실제 차감은 반환값으로 돌려준다. */
  money: number;
}

export interface GrowthResult {
  built: number;
  demolished: number;
  spent: number;
}

const EMPTY_RESULT: GrowthResult = { built: 0, demolished: 0, spent: 0 };

/* ---------------------------------------------------------------- *
 * 부지 검사
 * ---------------------------------------------------------------- */

/**
 * (tx, ty) 를 왼쪽 위로 하는 span x span 부지가 **한 청크 안에** 들어가는가.
 *
 * 청크를 넘는 건물을 금지하는 이유는 world.ts 의 placeBuilding 주석에 있다.
 * 요약하면 건물 하나가 두 저장 문서에 걸치면 반쪽만 저장될 수 있다.
 */
function fitsInChunk(tx: number, ty: number, span: number): boolean {
  return localIndexOf(tx) + span <= CHUNK_SIZE && localIndexOf(ty) + span <= CHUNK_SIZE;
}

/**
 * 신축용 부지 검사.
 *
 *   - 전부 같은 지구
 *   - 전부 건물 없음
 *   - 전부 같은 고도 (안 그러면 건물이 절벽에 걸친다)
 *   - 물 아님
 *   - 도로에 한 칸이라도 접함
 */
export function plotFits(
  world: World,
  field: RoadField,
  tx: number,
  ty: number,
  span: number,
  zone: number,
): boolean {
  if (!fitsInChunk(tx, ty, span)) return false;
  const h = world.sampleHeight(tx, ty);
  let reachable = false;
  for (let dy = 0; dy < span; dy++) {
    for (let dx = 0; dx < span; dx++) {
      const x = tx + dx;
      const y = ty + dy;
      if (zoneOfBuild(world.getBuild(x, y)) !== zone) return false;
      if (world.getBld(x, y) !== BLD_NONE) return false;
      if (world.sampleHeight(x, y) !== h) return false;
      if (isWater(world.getTile(x, y))) return false;
      if (field.nearRoad(x, y)) reachable = true;
    }
  }
  return reachable;
}

/**
 * 재건축용 부지 검사.
 *
 * 신축과 다른 점:
 *   - 칸이 비어 있으면 **안 된다.** 빈 칸이 있다는 건 아직 신축할 자리가
 *     남았다는 뜻이고, 그러면 멀쩡한 건물을 헐 이유가 없다.
 *   - 부지 안의 모든 건물이 REBUILD_MIN_AGE_DAYS 를 넘겨야 한다.
 *   - 부지 밖으로 삐져나온 건물이 하나라도 있으면 안 된다. 그 건물을 헐면
 *     부지 밖 칸이 함께 비어버린다.
 *   - 모든 건물의 레벨이 목표 레벨보다 낮아야 한다(상향 전용).
 */
export function rebuildFits(
  world: World,
  field: RoadField,
  tx: number,
  ty: number,
  span: number,
  zone: number,
  today: number,
): boolean {
  if (!fitsInChunk(tx, ty, span)) return false;
  const h = world.sampleHeight(tx, ty);
  let reachable = false;

  for (let dy = 0; dy < span; dy++) {
    for (let dx = 0; dx < span; dx++) {
      const x = tx + dx;
      const y = ty + dy;
      if (zoneOfBuild(world.getBuild(x, y)) !== zone) return false;
      if (world.sampleHeight(x, y) !== h) return false;
      if (field.nearRoad(x, y)) reachable = true;

      const info = world.buildingCovering(x, y);
      if (!info) return false; // 빈 칸이 있으면 재건축 대상이 아니다
      if (info.zone !== zone) return false;
      if (info.level >= span) return false; // 이미 같거나 더 높은 등급
      if (today - info.born < REBUILD_MIN_AGE_DAYS) return false;
      // 삐져나옴 검사
      if (
        info.tx < tx ||
        info.ty < ty ||
        info.tx + info.span > tx + span ||
        info.ty + info.span > ty + span
      ) {
        return false;
      }
    }
  }
  return reachable;
}

/**
 * 후보가 속한 16x16 섹터와 인접 8개 섹터에 빈 필지가 하나라도 있는지 본다.
 *
 * 빈 필지는 "구역으로 지정됐지만 건물이 없는 물리 타일"이다. 도로 접근성은
 * 여기서 보지 않는다. 도로 비인접 L1 생성 규칙은 이번 단계의 변경 범위가 아니며,
 * 신축 가능 여부와 재개발 포화 조건을 섞으면 같은 입력의 판정이 달라질 수 있다.
 */
export function sectorNeighborhoodHasEmptyLot(world: World, tx: number, ty: number): boolean {
  const sectorX = Math.floor(tx / REDEVELOPMENT_SECTOR_SIZE);
  const sectorY = Math.floor(ty / REDEVELOPMENT_SECTOR_SIZE);

  for (let sy = sectorY - 1; sy <= sectorY + 1; sy++) {
    for (let sx = sectorX - 1; sx <= sectorX + 1; sx++) {
      const startX = sx * REDEVELOPMENT_SECTOR_SIZE;
      const startY = sy * REDEVELOPMENT_SECTOR_SIZE;
      for (let dy = 0; dy < REDEVELOPMENT_SECTOR_SIZE; dy++) {
        for (let dx = 0; dx < REDEVELOPMENT_SECTOR_SIZE; dx++) {
          const x = startX + dx;
          const y = startY + dy;
          if (zoneOfBuild(world.sampleBuild(x, y)) >= 0 && world.getBld(x, y) === BLD_NONE) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/* ---------------------------------------------------------------- *
 * 레벨 뽑기
 * ---------------------------------------------------------------- */

/**
 * 계층별 수요를 가중치로 삼아 레벨을 하나 고른다.
 *
 * 수요가 0 이하인 계층은 아예 후보에서 빠진다. 그래서 저소득 수요가 마이너스면
 * 1단계 건물은 새로 안 생기고, 중산층 수요가 압도적이면 2단계가 주로 뽑힌다.
 * 학생이 말한 "수요에 따라 지어지는 레벨의 비율이 달라진다" 가 이 부분이다.
 */
export function pickLevel(demandForZone: readonly number[], roll: number): number {
  let total = 0;
  for (let i = 0; i < LEVEL_COUNT; i++) {
    if (demandForZone[i] > 0) total += demandForZone[i];
  }
  if (total <= 0) return 0;

  let acc = 0;
  const target = roll * total;
  for (let i = 0; i < LEVEL_COUNT; i++) {
    const w = demandForZone[i];
    if (w <= 0) continue;
    acc += w;
    if (target <= acc) return i + 1;
  }
  return LEVEL_COUNT;
}

/* ---------------------------------------------------------------- *
 * 청크 하나 처리
 * ---------------------------------------------------------------- */

/**
 * 필지 하나에서 이번 틱에 할 일을 한다.
 *
 * 매 틱 4096칸을 다 훑으면 청크가 늘어날수록 감당이 안 되므로, 필지마다
 * 커서(scanCursor)를 들고 REBUILD_SCAN_BUDGET 칸씩만 이어서 훑는다.
 * 몇 틱에 걸쳐 청크를 한 바퀴 도는 셈이고, 틱은 1초에 한 번이라 학생 눈에는
 * 도시가 자연스럽게 자라는 것으로 보인다.
 */
/**
 * 지은 만큼 수요를 **그 자리에서** 깎는다.
 *
 * 이게 없으면 과잉 건설이 난다. 수요는 STATS_INTERVAL 틱에 한 번만 다시
 * 계산되는데, 그 사이에도 건설은 매 틱 돌아간다. 수요가 갱신될 때까지 몇십
 * 채가 우르르 올라가고, 건물은 헐리지 않으므로 그 초과분이 영구히 남아
 * 도시가 공실 상태로 굳어버린다.
 *
 * 반대 방향(철거)도 같은 이유로 돌려준다.
 */
function chargeDemand(ctx: GrowthContext, zone: number, level: number, sign: number): void {
  const d = ctx.demand[zone];
  d[level - 1] = Math.max(-1, Math.min(1, d[level - 1] - (sign * capacityOf(zone, level)) / DEMAND_SCALE));
}

export function growParcel(
  world: World,
  p: Parcel,
  ctx: GrowthContext,
): GrowthResult {
  if (!p.build) return EMPTY_RESULT;
  // 신축을 먼저 시도한다. 그 뒤에도 현재 후보 섹터 주변 9개 섹터가 꽉 찬
  // 경우에만 재개발 패스가 실제 후보를 처리한다.
  if (p.emptyPlots > 0) {
    const result = buildPass(world, p, ctx);
    if (result.built > 0 || result.spent > 0) return result;
  }
  return rebuildPass(world, p, ctx);
}

/** 빈 부지가 남아 있을 때: 새로 짓는다. */
function buildPass(world: World, p: Parcel, ctx: GrowthContext): GrowthResult {
  let built = 0;
  let spent = 0;
  let scanned = 0;
  const baseX = p.cx * CHUNK_SIZE;
  const baseY = p.cy * CHUNK_SIZE;

  while (scanned < REBUILD_SCAN_BUDGET && built < MAX_BUILDS_PER_TICK) {
    const i = p.scanCursor;
    p.scanCursor = (p.scanCursor + 1) % CHUNK_TILES;
    scanned++;
    const zone = zoneOfBuild(p.build![i]);
    if (zone < 0) continue;
    if (p.bld && p.bld[i] !== BLD_NONE) continue;

    const lx = i % CHUNK_SIZE;
    const ly = (i - lx) / CHUNK_SIZE;
    const tx = baseX + lx;
    const ty = baseY + ly;

    if (!plotFits(world, ctx.field, tx, ty, 1, zone)) continue;

    const roll = simRandom(WORLD_SEED, ctx.tick, tx, ty);
    let level = pickLevel(ctx.demand[zone], roll);
    if (level === 0) continue;

    // 원하는 레벨이 안 들어가면 한 단계씩 낮춘다.
    // 1x1 은 위에서 이미 확인했으므로 결국 뭔가는 지어진다.
    while (level > 1 && !plotFits(world, ctx.field, tx, ty, level, zone)) level--;

    const cost = BUILD_COST[level - 1];
    if (ctx.money - spent < cost) break; // 돈이 없으면 이번 틱은 여기까지

    world.placeBuilding(tx, ty, zone, level, ctx.today);
    chargeDemand(ctx, zone, level, 1);
    spent += cost;
    built++;
  }

  return { built, demolished: 0, spent };
}

/**
 * 후보가 속한 섹터 주변 9개 섹터에 빈 부지가 없을 때만 상향 재개발한다.
 *
 * 후보 우선순위는 "가장 오래된 것" 이다. 커서로 훑다가 조건에 맞는 자리를
 * 찾으면 그 자리에서 바로 처리한다. 정렬을 하지 않는 이유는 청크당 4096칸을
 * 매 틱 정렬할 수 없기 때문이고, 커서가 한 바퀴 도는 동안 오래된 건물은
 * 어차피 전부 후보에 걸린다.
 */
function rebuildPass(world: World, p: Parcel, ctx: GrowthContext): GrowthResult {
  if (!p.bld) return EMPTY_RESULT;

  let built = 0;
  let demolished = 0;
  let spent = 0;
  let scanned = 0;
  const baseX = p.cx * CHUNK_SIZE;
  const baseY = p.cy * CHUNK_SIZE;
  const sectorEmptyCache = new Map<string, boolean>();

  while (scanned < REBUILD_SCAN_BUDGET && built < MAX_REBUILDS_PER_TICK) {
    const i = p.scanCursor;
    p.scanCursor = (p.scanCursor + 1) % CHUNK_TILES;
    scanned++;
    const code = p.bld[i];
    if (!isAnchor(code)) continue;

    const zone = zoneOfCode(code);
    const level = levelOfCode(code);
    if (level >= LEVEL_COUNT) continue; // 이미 최고 등급

    const lx = i % CHUNK_SIZE;
    const ly = (i - lx) / CHUNK_SIZE;
    const tx = baseX + lx;
    const ty = baseY + ly;

    // 후보 앵커가 속한 현재 섹터만 탐색 대상으로 삼고, 자기+인접 8개 섹터에
    // 빈 필지가 하나라도 있으면 재개발하지 않는다.
    const sectorX = Math.floor(tx / REDEVELOPMENT_SECTOR_SIZE);
    const sectorY = Math.floor(ty / REDEVELOPMENT_SECTOR_SIZE);
    const sectorKey = `${sectorX},${sectorY}`;
    let hasEmpty = sectorEmptyCache.get(sectorKey);
    if (hasEmpty === undefined) {
      hasEmpty = sectorNeighborhoodHasEmptyLot(world, tx, ty);
      sectorEmptyCache.set(sectorKey, hasEmpty);
    }
    if (hasEmpty) continue;

    // 위 등급부터 시도한다. 3x3 이 되면 3단계로, 안 되면 2단계로.
    for (let target = LEVEL_COUNT; target > level; target--) {
      if (ctx.demand[zone][target - 1] - ctx.demand[zone][level - 1] < REBUILD_DEMAND_GAP) {
        continue;
      }
      if (!rebuildFits(world, ctx.field, tx, ty, target, zone, ctx.today)) continue;

      const cost = Math.round(BUILD_COST[target - 1] * REBUILD_SURCHARGE);
      if (ctx.money - spent < cost) return { built, demolished, spent };

      // 부지 안의 건물을 전부 헌다. rebuildFits 가 삐져나온 건물이 없음을
      // 이미 확인했으므로 부지 밖 칸이 비는 일은 없다.
      for (let dy = 0; dy < target; dy++) {
        for (let dx = 0; dx < target; dx++) {
          const gone = world.demolishAt(tx + dx, ty + dy);
          if (gone) {
            chargeDemand(ctx, gone.zone, gone.level, -1);
            demolished++;
          }
        }
      }
      world.placeBuilding(tx, ty, zone, target, ctx.today);
      chargeDemand(ctx, zone, target, 1);
      spent += cost;
      built++;
      break;
    }
  }

  return { built, demolished, spent };
}
