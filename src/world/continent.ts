import { CHUNK_SIZE, CHUNK_TILES, MAX_HEIGHT, WORLD_SEED } from '../core/constants';
import { fbm, moistureAt, Terrain, type TerrainId } from './terrain';

/**
 * 가상 대륙 (지도 v2).
 *
 * 예전 지형은 끝없이 이어지는 노이즈였고, 물은 고도가 낮은 웅덩이·바다뿐이라
 * 하천이 한 칸도 없는 도시가 생겼다. 시작 지점을 학생이 고르고 나중에 같은
 * 판에서 전쟁을 하려면 **끝이 있는 하나의 대륙** 이 필요하다.
 *
 *   - 대륙: 가로 CONTINENT_W × 세로 CONTINENT_H 청크. 바깥은 전부 바다.
 *   - 산맥: 능선형 노이즈로 길게 이어진다(고도 5~8). 도시 사이를 가르는 장애물.
 *   - 언덕(능선): 고도 1~4. 장애물이 아니다.
 *   - 큰 강: 폭 6~7칸, 깊은 물 포함. 장애물이다.
 *   - 개울: 폭 2~3칸. 장애물은 아니지만 하수 방류와 농사(관개)에 쓴다.
 *
 * 저주파 값(해안선·고도·강)은 4칸 격자에서 계산하고 사이는 선형 보간한다.
 * 그래서 칸 단위 생성(generateContinentChunk)과 점 단위 질의(sampleSite,
 * 장애물 판정, 비옥도)가 **항상 같은 값** 을 낸다.
 *
 * 노이즈 원본 함수(hash2·valueNoise·fbm)와 WORLD_SEED 는 그대로 쓴다.
 */

/** 대륙 크기(청크). 32칸 청크라 타일로는 10,240 × 7,168칸(지도 v2 와 같은 땅). */
export const CONTINENT_W = 320;
export const CONTINENT_H = 224;
/** 대륙 왼쪽 위 청크. 가운데가 (0,0) 근처가 되게 둔다. */
export const CONTINENT_X0 = -CONTINENT_W / 2;
export const CONTINENT_Y0 = -CONTINENT_H / 2;
/** 3 = 청크 32칸 전환. 바뀌면 다음 로그인 때 도시를 비우고 자리를 다시 고른다. */
export const MAP_VERSION = 3;

const HALF_W_TILES = (CONTINENT_W * CHUNK_SIZE) / 2;
const HALF_H_TILES = (CONTINENT_H * CHUNK_SIZE) / 2;
const GRID = 4;
const S = WORLD_SEED;

/** 산으로 보는 고도. 이 이상이 장애물이다. */
export const MOUNTAIN_HEIGHT = 5;

/* ---------------------------------------------------------------- *
 * 4칸 격자 위의 저주파 값
 * ---------------------------------------------------------------- */

interface Field {
  /** >0 이면 육지. 해안에서 멀수록 크다. */
  land: number;
  /** 0~1 산 세기. */
  mountain: number;
  /** 0~3.x 완만한 언덕 고도. */
  hills: number;
  /** 산 꼭대기 높이(단). 봉우리마다 6~9 사이로 달라진다. */
  peaks: number;
  /** 개울·큰 강의 부호 있는 값과 기울기 크기. 0 근처가 물길이다. */
  stream: number;
  streamGrad: number;
  river: number;
  riverGrad: number;
  /** 개울이 흐를 수 있는 지역인가 0~1 (건조 지대에는 개울이 드물다). */
  streamMask: number;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function landRaw(x: number, y: number): number {
  const nx = x / HALF_W_TILES;
  const ny = y / HALF_H_TILES;
  const d = Math.sqrt(nx * nx + ny * ny);
  const coast = fbm(x / 1500, y / 1500, S + 11, 4) - 0.5;
  const bays = fbm(x / 430, y / 430, S + 12, 3) - 0.5;
  // 안쪽 바다(지중해·발트해 같은 만). 몇 군데만 깊게 파인다.
  const basin = fbm(x / 2300, y / 2300, S + 13, 3);
  const inlandSea = Math.max(0, 0.4 - basin) * 2.2;
  const edge = smoothstep(0.86, 0.98, Math.max(Math.abs(nx), Math.abs(ny)));
  return 0.8 - d + coast * 1.1 + bays * 0.32 - inlandSea - edge * 2;
}

function streamRaw(x: number, y: number): number {
  const wx = (fbm(x / 500, y / 500, S + 44, 2) - 0.5) * 160;
  const wy = (fbm(x / 500, y / 500, S + 45, 2) - 0.5) * 160;
  return fbm((x + wx) / 260, (y + wy) / 260, S + 41, 2) - 0.5;
}

function riverRaw(x: number, y: number): number {
  const wx = (fbm(x / 900, y / 900, S + 54, 2) - 0.5) * 300;
  const wy = (fbm(x / 900, y / 900, S + 55, 2) - 0.5) * 300;
  return fbm((x + wx) / 1100, (y + wy) / 1100, S + 51, 3) - 0.5;
}

function gridField(gx: number, gy: number): Field {
  const x = gx * GRID;
  const y = gy * GRID;
  const land = landRaw(x, y);
  const ridge = 1 - Math.abs(2 * fbm(x / 820, y / 820, S + 31, 4) - 1);
  const ranges = smoothstep(0.41, 0.55, fbm(x / 1900, y / 1900, S + 32, 3));
  const mountain = smoothstep(0.76, 0.93, ridge) * ranges;
  const hills = Math.max(0, (fbm(x / 520, y / 520, S + 21, 3) - 0.36) * 15);
  const peaks = 6 + fbm(x / 140, y / 140, S + 33, 2) * 4;
  const stream = streamRaw(x, y);
  const river = riverRaw(x, y);
  const e = 2;
  const sgx = (streamRaw(x + e, y) - streamRaw(x - e, y)) / (2 * e);
  const sgy = (streamRaw(x, y + e) - streamRaw(x, y - e)) / (2 * e);
  const rgx = (riverRaw(x + e, y) - riverRaw(x - e, y)) / (2 * e);
  const rgy = (riverRaw(x, y + e) - riverRaw(x, y - e)) / (2 * e);
  const streamMask = smoothstep(0.36, 0.46, fbm(x / 700, y / 700, S + 46, 2));
  return {
    land,
    mountain,
    hills,
    peaks,
    stream,
    streamGrad: Math.hypot(sgx, sgy) + 1e-6,
    river,
    riverGrad: Math.hypot(rgx, rgy) + 1e-6,
    streamMask,
  };
}

/** 격자 값 캐시. 같은 격자점을 청크 경계에서 두 번 계산하지 않는다. */
const gridCache = new Map<number, Field>();
const GRID_CACHE_MAX = 400_000;

function cachedField(gx: number, gy: number): Field {
  const key = gx * 100_003 + gy;
  let f = gridCache.get(key);
  if (!f) {
    if (gridCache.size >= GRID_CACHE_MAX) gridCache.clear();
    f = gridField(gx, gy);
    gridCache.set(key, f);
  }
  return f;
}

const FIELD_KEYS = [
  'land',
  'mountain',
  'hills',
  'peaks',
  'stream',
  'streamGrad',
  'river',
  'riverGrad',
  'streamMask',
] as const;

function fieldAt(tx: number, ty: number): Field {
  const gx = Math.floor(tx / GRID);
  const gy = Math.floor(ty / GRID);
  const fx = (tx - gx * GRID) / GRID;
  const fy = (ty - gy * GRID) / GRID;
  const a = cachedField(gx, gy);
  if (fx === 0 && fy === 0) return a;
  const b = cachedField(gx + 1, gy);
  const c = cachedField(gx, gy + 1);
  const d = cachedField(gx + 1, gy + 1);
  const out = {} as Field;
  for (const k of FIELD_KEYS) {
    const top = a[k] + (b[k] - a[k]) * fx;
    const bottom = c[k] + (d[k] - c[k]) * fx;
    out[k] = top + (bottom - top) * fy;
  }
  return out;
}

/* ---------------------------------------------------------------- *
 * 한 칸의 지형
 * ---------------------------------------------------------------- */

/** 개울 반폭(칸). 폭 2~3칸. */
const STREAM_HALF = 1.2;
/** 큰 강 반폭(칸). 폭 6~7칸. */
const RIVER_HALF = 3.2;
/** 장애물로 보는 연속 물 길이(칸). 개울(2~3칸)은 넘지 않는다. */
export const WATER_BARRIER_TILES = 6;

export interface Site {
  tile: TerrainId;
  height: number;
  /** 가장 가까운 개울·강 가장자리까지 거리(칸). 물이면 0. */
  waterDist: number;
  /** 물길 종류: 0 없음, 1 개울, 2 큰 강, 3 바다. 물 칸에서만 의미가 있다. */
  water: 0 | 1 | 2 | 3;
  /** 해안선에서 안쪽으로 얼마나 들어왔나. 음수면 바다. */
  land: number;
}

/**
 * 물길까지의 거리와 "그 물길이 실제로 흐르는 정도"(0~1).
 *
 * 부호 있는 값을 기울기로 나누면 등고선까지의 거리가 된다. 개울은 산 속과
 * 건조 지대에서 사라지고, 큰 강은 높은 산 한가운데서만 끊긴다. 끊기는 곳도
 * 0/1 이 아니라 **연속으로** 옅어져야 한다 — 그래야 계곡이 갑자기 생기거나
 * 사라지며 절벽(고도 차 2 이상)을 만들지 않는다.
 */
function waterways(f: Field): {
  stream: number;
  streamOn: number;
  river: number;
  riverOn: number;
} {
  return {
    stream: Math.abs(f.stream) / f.streamGrad - STREAM_HALF,
    streamOn: f.streamMask * (1 - smoothstep(0.22, 0.42, f.mountain)),
    river: Math.abs(f.river) / f.riverGrad - RIVER_HALF,
    riverOn: 1 - smoothstep(0.62, 0.82, f.mountain),
  };
}

/** 물길이 이 정도 이상 흐르는 곳에만 물이 찬다. */
const WATER_ON = 0.9;

interface RawSite {
  /** 물이면 1(개울)·2(큰 강)·3(바다), 아니면 0. */
  water: 0 | 1 | 2 | 3;
  deep: boolean;
  /** 계곡까지 반영한 실수 고도. 물이면 0. */
  h: number;
  near: number;
  land: number;
}

function rawSite(tx: number, ty: number): RawSite {
  const f = fieldAt(tx, ty);
  if (f.land <= 0) return { water: 3, deep: f.land < -0.04, h: 0, near: 0, land: f.land };
  const w = waterways(f);
  const streamWet = w.streamOn >= WATER_ON && w.stream <= 0;
  const riverWet = w.riverOn >= WATER_ON && w.river <= 0;
  if (streamWet || riverWet) {
    return {
      water: riverWet ? 2 : 1,
      deep: riverWet && w.river <= -RIVER_HALF * 0.45,
      h: 0,
      near: 0,
      land: f.land,
    };
  }
  const near = Math.min(
    w.streamOn >= WATER_ON ? Math.max(0, w.stream) : Infinity,
    w.riverOn >= WATER_ON ? Math.max(0, w.river) : Infinity,
  );
  // 고도: 언덕 + 산. 해안 쪽으로 완만하게 내려가고, 물길 쪽으로 계곡이 파인다.
  // 계곡은 "물길에서 d칸 떨어지면 최대 k·d 단" 이라는 상한을 흐르는 정도만큼
  // 섞는다. 모든 항이 연속이라 계곡이 갑자기 생기거나 사라지지 않는다.
  const coastRamp = smoothstep(0, 0.07, f.land);
  let h = Math.max(f.hills, f.mountain * f.peaks + f.hills * 0.25) * coastRamp;
  h -= w.streamOn * Math.max(0, h - 0.4 * Math.max(0, w.stream));
  h -= w.riverOn * Math.max(0, h - 0.22 * Math.max(0, w.river));
  return { water: 0, deep: false, h, near, land: f.land };
}

/**
 * 경사 제한 반경. 한 칸의 고도는 "주변 칸 고도 + 거리" 를 넘지 못한다.
 * 노이즈가 드물게 만드는 가파른 곳(2단 이상 절벽)을 깎아 계단으로 만든다.
 * 칸 생성과 점 질의가 같은 창을 쓰므로 결과가 같다.
 */
const SLOPE_R = 2;

function limitHeight(tx: number, ty: number, at: (x: number, y: number) => number): number {
  let h = at(tx, ty);
  for (let dy = -SLOPE_R; dy <= SLOPE_R; dy++) {
    for (let dx = -SLOPE_R; dx <= SLOPE_R; dx++) {
      if (!dx && !dy) continue;
      const v = at(tx + dx, ty + dy) + Math.max(Math.abs(dx), Math.abs(dy));
      if (v < h) h = v;
    }
  }
  return Math.max(0, Math.min(MAX_HEIGHT, Math.floor(h)));
}

function siteFrom(tx: number, ty: number, r: RawSite, height: number): Site {
  if (r.water) {
    return {
      tile: r.deep ? Terrain.WaterDeep : Terrain.WaterShallow,
      height: 0,
      waterDist: 0,
      water: r.water,
      land: r.land,
    };
  }
  let tile: TerrainId;
  if (height >= 6) tile = Terrain.Rock;
  else if (r.land < 0.018 && height === 0) tile = Terrain.Sand;
  else {
    const m = moistureAt(tx, ty) + (r.near < 10 ? 0.06 : 0);
    if (m > 0.64 && r.near > 4) tile = Terrain.Forest;
    else if (m < 0.36) tile = height >= 4 ? Terrain.Dirt : Terrain.GrassDry;
    else tile = Terrain.Grass;
  }
  return { tile, height, waterDist: r.near, water: 0, land: r.land };
}

/** 같은 좌표면 언제나 같은 값. 저장된 수정분은 반영하지 않는다. */
export function sampleSite(tx: number, ty: number): Site {
  const r = rawSite(tx, ty);
  const height = r.water ? 0 : limitHeight(tx, ty, (x, y) => rawSite(x, y).h);
  return siteFrom(tx, ty, r, height);
}

/**
 * 경사 제한을 뺀 빠른 질의. 시작 지점 평가처럼 수만 곳을 훑을 때 쓴다.
 * 고도가 드물게 1~2단 높게 나올 수 있으나 평지·산·물 비율에는 영향이 없다.
 */
export function quickSite(tx: number, ty: number): Site {
  const r = rawSite(tx, ty);
  return siteFrom(tx, ty, r, r.water ? 0 : Math.max(0, Math.min(MAX_HEIGHT, Math.floor(r.h))));
}

export function generateContinentChunk(
  cx: number,
  cy: number,
): { tiles: Uint8Array; heights: Uint8Array } {
  const tiles = new Uint8Array(CHUNK_TILES);
  const heights = new Uint8Array(CHUNK_TILES);
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  // 경사 제한에 필요한 테두리까지 실수 고도를 한 번만 계산해 둔다.
  const span = CHUNK_SIZE + SLOPE_R * 2;
  const raw: RawSite[] = new Array(span * span);
  for (let y = 0; y < span; y++)
    for (let x = 0; x < span; x++) raw[y * span + x] = rawSite(x0 + x - SLOPE_R, y0 + y - SLOPE_R);
  const at = (x: number, y: number) => raw[(y - y0 + SLOPE_R) * span + (x - x0 + SLOPE_R)].h;
  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const tx = x0 + lx;
      const ty = y0 + ly;
      const r = raw[(ly + SLOPE_R) * span + (lx + SLOPE_R)];
      const s = siteFrom(tx, ty, r, r.water ? 0 : limitHeight(tx, ty, at));
      const i = ly * CHUNK_SIZE + lx;
      tiles[i] = s.tile;
      heights[i] = s.height;
    }
  }
  return { tiles, heights };
}

export function continentHeight(tx: number, ty: number): number {
  return sampleSite(tx, ty).height;
}

export function insideContinent(cx: number, cy: number): boolean {
  return (
    cx >= CONTINENT_X0 &&
    cy >= CONTINENT_Y0 &&
    cx < CONTINENT_X0 + CONTINENT_W &&
    cy < CONTINENT_Y0 + CONTINENT_H
  );
}

/* ---------------------------------------------------------------- *
 * 농사 비옥도
 * ---------------------------------------------------------------- */

const SOIL: Record<number, number> = {
  [Terrain.Grass]: 1,
  [Terrain.Forest]: 0.85,
  [Terrain.GrassDry]: 0.7,
  [Terrain.Dirt]: 0.55,
  [Terrain.Sand]: 0.35,
  [Terrain.Rock]: 0.2,
};

/**
 * 한 칸의 농사 비옥도 0.2 ~ 1.3.
 *
 * 하천 가까이(관개)와 낮고 평평한 풀밭이 가장 좋다. 바닷가는 물이 짜서 관개
 * 보너스가 없다. 큰 강 유역이 가장 비옥하고, 개울은 그보다 조금 덜하다.
 */
export function fertilityAt(tx: number, ty: number): number {
  const f = fieldAt(tx, ty);
  if (f.land <= 0) return 0;
  const s = sampleSite(tx, ty);
  if (s.water) return 0;
  const w = waterways(f);
  const irrigation = Math.max(
    (1 - smoothstep(0, 48, w.river)) * w.riverOn,
    (1 - smoothstep(0, 32, w.stream)) * 0.75 * w.streamOn,
  );
  const soil = SOIL[s.tile] ?? 0.6;
  const heightFactor = s.height <= 2 ? 1 : s.height <= 4 ? 0.85 : 0.6;
  const v = soil * heightFactor * (0.55 + 0.75 * irrigation);
  return Math.max(0.2, Math.min(1.3, v));
}
