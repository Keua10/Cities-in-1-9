import { BASE_CHUNK_SPAN, BASE_SPACING_CHUNKS, CHUNK_SIZE } from '../core/constants';
import { heightAt, terrainAt, Terrain } from './terrain';
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

/**
 * base 후보의 지형 비율을 재는 간격.
 * 2x2 base(128x128)를 8타일 간격으로 읽으면 후보당 256점이라 충분히 안정적이고,
 * 모든 타일을 매번 노이즈 생성하는 것보다 훨씬 싸다.
 */
const BASE_TERRAIN_SAMPLE_STEP_TILES = 8;
/** 평지 / (물 + 산) 비율은 반드시 1보다 커야 한다. */
const BASE_MIN_FLAT_TO_OBSTACLE_RATIO = 1;

interface BaseOrigin {
  cx: number;
  cy: number;
}

/**
 * baseOriginChunk 는 한 부팅 중 여러 번 불릴 수 있으므로 이미 결정한 도시 위치와
 * 후보 지형 판정을 캐시한다. 값은 전부 좌표 기반 결정론적 계산이라 캐시 유무로
 * 결과가 달라지지 않는다.
 */
const placedBases: BaseOrigin[] = [];
const terrainSuitabilityCache = new Map<string, boolean>();
let nextCandidateIndex = 0;

/**
 * 도시 index 를 결정론적인 육각 후보 격자 위의 base 청크 좌표로 바꾼다.
 *
 * 후보 격자 자체는 4청크 간격이다. 후보를 순서대로 훑으면서 아래 조건을 모두
 * 만족하는 자리만 실제 base 로 채택한다.
 *
 * - base 2x2 안의 평지 비율이 물+산 비율보다 높아야 한다 (평지/(물+산) > 1)
 * - 기본: 기존 base 중심과 8청크 이상
 * - 예외: 4~8청크 사이이고 두 중심 사이를 산맥이 가로막으면 허용
 * - 어떤 경우에도 4청크 미만은 금지
 *
 * 그래서 해안·강을 낀 도시는 남지만 물이나 산이 base 대부분을 차지하는 위치는
 * 건너뛴다. Math.random 없이 기존 지형 함수만 사용하므로 같은 WORLD_SEED 에서는
 * 항상 같은 도시 번호가 같은 위치를 받는다.
 */
export function baseOriginChunk(cityIndex: number): { cx: number; cy: number } {
  const target = cityIndex <= 0 ? 0 : Math.floor(cityIndex);

  while (placedBases.length <= target) {
    const { q, r } = hexSpiral(nextCandidateIndex++);
    const candidate = candidateOrigin(q, r);
    if (!baseTerrainSuitable(candidate)) continue;
    if (!canPlaceBase(candidate, placedBases)) continue;
    placedBases.push(candidate);
  }

  return placedBases[target];
}

/** 4청크 최소 격자의 axial 좌표를 실제 청크 좌표로 바꾼다. */
function candidateOrigin(q: number, r: number): BaseOrigin {
  return {
    cx: Math.round(MOUNTAIN_MIN_SPACING_CHUNKS * (q + r / 2)),
    cy: Math.round(MOUNTAIN_MIN_SPACING_CHUNKS * r),
  };
}

/**
 * base 2x2 내부에서 평지가 물+산보다 많은가.
 *
 * 평지 = 물이 아니고 고도 5 미만인 샘플.
 * 장애지형 = 깊은/얕은 물 또는 고도 5 이상인 샘플.
 * 따라서 평지/(물+산) > 1, 즉 샘플의 절반을 넘는 곳만 base 후보가 된다.
 */
function baseTerrainSuitable(origin: BaseOrigin): boolean {
  const key = `${origin.cx},${origin.cy}`;
  const cached = terrainSuitabilityCache.get(key);
  if (cached !== undefined) return cached;

  const spanTiles = BASE_CHUNK_SPAN * CHUNK_SIZE;
  const ox = origin.cx * CHUNK_SIZE;
  const oy = origin.cy * CHUNK_SIZE;
  let flat = 0;
  let obstacle = 0;

  for (let y = BASE_TERRAIN_SAMPLE_STEP_TILES / 2; y < spanTiles; y += BASE_TERRAIN_SAMPLE_STEP_TILES) {
    for (let x = BASE_TERRAIN_SAMPLE_STEP_TILES / 2; x < spanTiles; x += BASE_TERRAIN_SAMPLE_STEP_TILES) {
      const tx = ox + x;
      const ty = oy + y;
      const terrain = terrainAt(tx, ty);
      const water = terrain === Terrain.WaterDeep || terrain === Terrain.WaterShallow;
      const mountain = heightAt(tx, ty) >= MOUNTAIN_HEIGHT_MIN;
      if (water || mountain) obstacle++;
      else flat++;
    }
  }

  const suitable = flat > obstacle * BASE_MIN_FLAT_TO_OBSTACLE_RATIO;
  terrainSuitabilityCache.set(key, suitable);
  return suitable;
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
 * 기존 0~8 고도장에서 5 이상이 24타일 이상 연속될 때만 "가로막는 산" 으로
 * 취급한다. 작은 언덕이나 한두 칸짜리 봉우리는 간격 완화 조건이 되지 않는다.
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
