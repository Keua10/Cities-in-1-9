import { BASE_CHUNK_SPAN, BASE_SPACING_CHUNKS, CHUNK_SIZE } from '../core/constants';
import { heightAt, Terrain } from './terrain';
import type { World } from './world';

/**
 * 도시가 시작하는 위치(base) 계산.
 *
 * World 데이터 모델 자체와는 무관한, "이 도시 index가 지도 어디에 놓이는가/
 * 그 안 어디가 첫 카메라 위치인가" 를 정하는 순수 계산이다. world.ts 의
 * World 클래스가 생성될 때(baseOriginChunk) 와, 접속 직후 화면을 띄울 때
 * (baseCenterTile, findDryTileNearBase) 쓰인다.
 */

/** 산이 두 base 사이를 가로막을 때 허용하는 최소 중심 간격(청크). */
const MOUNTAIN_MIN_SPACING_CHUNKS = 4;
/** 고도 0~8 중 이 이상을 산으로 본다. */
const MOUNTAIN_HEIGHT_MIN = 5;
/** 산 판정 시 직선 위 지형을 이 간격(타일)으로 샘플링한다. */
const MOUNTAIN_SAMPLE_STEP_TILES = 8;
/** 한 점짜리 봉우리가 아니라 실제 장벽이 되도록 요구하는 연속 산 길이(타일). */
const MOUNTAIN_MIN_RUN_TILES = 24;
/** base 자체의 지형보다 "사이"의 지형을 보도록 직선의 가운데 절반만 검사한다. */
const MOUNTAIN_LINE_START = 0.25;
const MOUNTAIN_LINE_END = 0.75;

interface BaseOrigin {
  cx: number;
  cy: number;
}

/**
 * 도시 index 를 결정론적인 육각 후보 격자 위의 base 청크 좌표로 바꾼다.
 *
 * 후보 격자 자체는 4청크 간격이다. 다만 후보를 순서대로 훑으면서 이미 배치된
 * 모든 도시와 비교해 아래 규칙을 만족하는 자리만 실제 base 로 채택한다.
 *
 * - 기본: 중심 사이 8청크 이상
 * - 예외: 4~8청크 사이이고 두 중심을 잇는 직선의 가운데에 산맥이 있으면 허용
 * - 어떤 경우에도 4청크 미만은 금지
 *
 * 그래서 평지에서는 기존과 같은 8청크 이상의 간격이 유지되고, 산맥이 실제로
 * 도시 사이를 가르는 곳에서만 더 촘촘한 4청크 격자 자리가 열린다. Math.random
 * 없이 기존 지형의 heightAt 만 사용하므로 같은 WORLD_SEED 에서는 항상 같다.
 */
export function baseOriginChunk(cityIndex: number): { cx: number; cy: number } {
  const target = cityIndex <= 0 ? 0 : Math.floor(cityIndex);
  const placed: BaseOrigin[] = [{ cx: 0, cy: 0 }];
  if (target === 0) return placed[0];

  let candidateIndex = 1;
  while (placed.length <= target) {
    const { q, r } = hexSpiral(candidateIndex++);
    const candidate = candidateOrigin(q, r);
    if (canPlaceBase(candidate, placed)) placed.push(candidate);
  }

  return placed[target];
}

/** 4청크 최소 격자의 axial 좌표를 실제 청크 좌표로 바꾼다. */
function candidateOrigin(q: number, r: number): BaseOrigin {
  return {
    cx: Math.round(MOUNTAIN_MIN_SPACING_CHUNKS * (q + r / 2)),
    cy: Math.round(MOUNTAIN_MIN_SPACING_CHUNKS * r),
  };
}

/** 이미 채택된 모든 base 와 최소 거리 규칙을 만족하는가. */
function canPlaceBase(candidate: BaseOrigin, placed: readonly BaseOrigin[]): boolean {
  const hardMinSq = MOUNTAIN_MIN_SPACING_CHUNKS * MOUNTAIN_MIN_SPACING_CHUNKS;
  const normalMinSq = BASE_SPACING_CHUNKS * BASE_SPACING_CHUNKS;

  for (const other of placed) {
    const dx = candidate.cx - other.cx;
    const dy = candidate.cy - other.cy;
    const distSq = dx * dx + dy * dy;

    if (distSq < hardMinSq) return false;
    if (distSq >= normalMinSq) continue;
    if (!mountainBlocksBetween(candidate, other)) return false;
  }
  return true;
}

/**
 * 두 base 중심을 잇는 직선의 가운데 절반에 연속적인 고지대가 있는지 본다.
 *
 * 산 판정 기준은 인수인계 문서에 수치가 없어서, 기존 0~8 고도장에서 5 이상이
 * 24타일 이상 연속될 때만 "가로막는 산" 으로 취급한다. 이 정도면 작은 언덕이나
 * 한두 칸짜리 봉우리는 간격 완화 조건이 되지 않는다.
 */
function mountainBlocksBetween(a: BaseOrigin, b: BaseOrigin): boolean {
  const halfBaseTiles = (BASE_CHUNK_SPAN * CHUNK_SIZE) / 2;
  const ax = a.cx * CHUNK_SIZE + halfBaseTiles;
  const ay = a.cy * CHUNK_SIZE + halfBaseTiles;
  const bx = b.cx * CHUNK_SIZE + halfBaseTiles;
  const by = b.cy * CHUNK_SIZE + halfBaseTiles;
  const dx = bx - ax;
  const dy = by - ay;

  const lineLength = Math.hypot(dx, dy);
  const checkedLength = lineLength * (MOUNTAIN_LINE_END - MOUNTAIN_LINE_START);
  const segments = Math.max(1, Math.ceil(checkedLength / MOUNTAIN_SAMPLE_STEP_TILES));
  const sampleStep = checkedLength / segments;

  let mountainRun = 0;
  for (let i = 0; i <= segments; i++) {
    const t =
      MOUNTAIN_LINE_START +
      ((MOUNTAIN_LINE_END - MOUNTAIN_LINE_START) * i) / segments;
    const tx = Math.round(ax + dx * t);
    const ty = Math.round(ay + dy * t);

    if (heightAt(tx, ty) >= MOUNTAIN_HEIGHT_MIN) {
      mountainRun++;
      if (mountainRun * sampleStep >= MOUNTAIN_MIN_RUN_TILES) return true;
    } else {
      mountainRun = 0;
    }
  }

  return false;
}

function hexSpiral(index: number): { q: number; r: number } {
  if (index <= 0) return { q: 0, r: 0 };
  const dirs = [
    [1, 0],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [0, -1],
    [1, -1],
  ] as const;

  let ring = 1;
  let i = index;
  while (i > ring * 6) {
    i -= ring * 6;
    ring++;
  }
  i -= 1;

  let q = dirs[4][0] * ring;
  let r = dirs[4][1] * ring;
  const side = Math.floor(i / ring);
  const step = i % ring;
  for (let s = 0; s < side; s++) {
    q += dirs[s][0] * ring;
    r += dirs[s][1] * ring;
  }
  q += dirs[side][0] * step;
  r += dirs[side][1] * step;
  return { q, r };
}

/** base 영역 한가운데의 타일 좌표. 첫 카메라 위치로 쓴다. */
export function baseCenterTile(world: World): { tx: number; ty: number } {
  const half = (BASE_CHUNK_SPAN * CHUNK_SIZE) / 2;
  return {
    tx: world.baseCx * CHUNK_SIZE + half,
    ty: world.baseCy * CHUNK_SIZE + half,
  };
}

/** base 안에서 물이 아닌 첫 타일. 시작 지점 안내용. */
export function findDryTileNearBase(world: World): { tx: number; ty: number } {
  const c = baseCenterTile(world);
  const limit = BASE_CHUNK_SPAN * CHUNK_SIZE;
  for (let radius = 0; radius < limit; radius += 2) {
    for (let dy = -radius; dy <= radius; dy += 2) {
      for (let dx = -radius; dx <= radius; dx += 2) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        const tx = c.tx + dx;
        const ty = c.ty + dy;
        const t = world.getTile(tx, ty);
        if (t !== Terrain.WaterDeep && t !== Terrain.WaterShallow) {
          return { tx, ty };
        }
      }
    }
  }
  return c;
}
