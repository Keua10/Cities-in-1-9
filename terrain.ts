import {
  CHUNK_SIZE,
  CHUNK_TILES,
  MAX_HEIGHT,
  WORLD_SEED,
} from '../core/constants';

/**
 * 지형 종류. 이 순서가 그대로 아틀라스의 셀 인덱스다.
 * 새 지형을 추가할 때는 반드시 "뒤에" 붙여야 한다. 중간에 끼우면 그림이 전부 밀린다.
 */
export const Terrain = {
  WaterDeep: 0,
  WaterShallow: 1,
  Sand: 2,
  Grass: 3,
  GrassDry: 4,
  Dirt: 5,
  Rock: 6,
  Forest: 7,
} as const;

export type TerrainId = (typeof Terrain)[keyof typeof Terrain];

export const TERRAIN_KEYS = [
  'water_deep',
  'water_shallow',
  'sand',
  'grass',
  'grass_dry',
  'dirt',
  'rock',
  'forest',
] as const;

export const TERRAIN_COUNT = TERRAIN_KEYS.length;

/** 자리표시용 색. 진짜 스프라이트가 들어오면 안 쓰인다. */
export const TERRAIN_COLORS: Record<number, string> = {
  0: '#1d4a63',
  1: '#2f7c92',
  2: '#d8c48c',
  3: '#5d9a4e',
  4: '#8faa55',
  5: '#9b7b53',
  6: '#8b8b8f',
  7: '#3d6f3c',
};

/** 물인가? (도로·건물 배치 판정에 쓴다) */
export function isWater(id: number): boolean {
  return id === Terrain.WaterDeep || id === Terrain.WaterShallow;
}

/* ---------------------------------------------------------------- *
 * 결정론적 노이즈
 * 같은 (좌표, 시드) 면 어느 기기·어느 서버에서든 같은 값이 나와야 한다.
 * Math.random 은 절대 쓰지 않는다.
 * ---------------------------------------------------------------- */

function hash2(x: number, y: number, seed: number): number {
  let h = seed ^ Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

function fbm(x: number, y: number, seed: number, octaves = 4): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, y * freq, seed + i * 7919) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/* ---------------------------------------------------------------- *
 * 지형 + 고도 생성
 * ---------------------------------------------------------------- */

const ELEVATION_SCALE = 1 / 180; // 타일 단위. 작을수록 대륙이 커진다.
const MOISTURE_SCALE = 1 / 96;
const DETAIL_SCALE = 1 / 14;

/** 고도장(연속값). 0 이 깊은 바다, 1 이 산꼭대기가 되도록 정규화되어 있다. */
export function elevationAt(tx: number, ty: number): number {
  const raw =
    fbm(tx * ELEVATION_SCALE, ty * ELEVATION_SCALE, WORLD_SEED, 5) * 0.88 +
    fbm(tx * DETAIL_SCALE, ty * DETAIL_SCALE, WORLD_SEED + 1013, 2) * 0.12;
  // 실제 fbm 값은 좁은 구간에 몰린다. 그 구간을 0~1 로 편다.
  const n = (raw - 0.28) / 0.48;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function moistureAt(tx: number, ty: number): number {
  return fbm(tx * MOISTURE_SCALE, ty * MOISTURE_SCALE, WORLD_SEED + 5501, 3);
}

/** 해수면. 이 아래는 물이고 고도는 항상 0 이다. */
export const SEA_LEVEL = 0.3;
const SHORE_LEVEL = 0.36; // 여기까지는 평지(모래사장)
const ROCK_LEVEL = 0.82; // 이 위는 바위산

export function terrainAt(tx: number, ty: number): TerrainId {
  const e = elevationAt(tx, ty);
  if (e < SEA_LEVEL - 0.08) return Terrain.WaterDeep;
  if (e < SEA_LEVEL) return Terrain.WaterShallow;
  if (e < SHORE_LEVEL) return Terrain.Sand;
  if (e > ROCK_LEVEL) return Terrain.Rock;

  const m = moistureAt(tx, ty);
  if (m > 0.62) return Terrain.Forest;
  if (m < 0.36) return e > 0.62 ? Terrain.Dirt : Terrain.GrassDry;
  return Terrain.Grass;
}

const HILL_SCALE = 1 / 52; // 언덕의 크기. 작을수록 언덕이 넓고 완만해진다.
const HILL_WEIGHT = 0.42; // 대륙 고도 대 언덕의 비율
const SHORE_RAMP = 0.22; // 해안에서 고도가 올라오는 구간 (절벽 해안 방지)

/**
 * 타일의 고도 단계(0 ~ MAX_HEIGHT).
 *
 * 대륙 규모의 고도장에 중간 크기의 언덕을 섞는다. 대륙 고도만 쓰면
 * 계단이 20타일 간격으로 벌어져서 등고선 지도처럼 보인다.
 *
 * 값이 충분히 완만해서 이웃 타일 간 차이는 항상 0 또는 1 단계다.
 * 즉 절벽은 한 칸씩 계단으로 올라가고, 산은 여러 타일에 걸쳐 층으로 쌓인다.
 * (2단계에서 도로 경사 판정을 만들 때 이 성질에 기댄다)
 */
export function heightAt(tx: number, ty: number): number {
  const e = elevationAt(tx, ty);
  if (e <= SHORE_LEVEL) return 0;
  const land = (e - SHORE_LEVEL) / (1 - SHORE_LEVEL);
  const hills = fbm(tx * HILL_SCALE, ty * HILL_SCALE, WORLD_SEED + 3313, 3);
  const ramp = land < SHORE_RAMP ? land / SHORE_RAMP : 1;
  const v = (land * (1 - HILL_WEIGHT) + hills * HILL_WEIGHT) * ramp;
  const h = Math.floor(v * (MAX_HEIGHT + 0.999));
  return h < 0 ? 0 : h > MAX_HEIGHT ? MAX_HEIGHT : h;
}

/** 절벽 옆면 재질. 바위산은 바위, 나머지는 흙. */
export function wallMaterial(topTerrain: number): 'rock' | 'soil' {
  return topTerrain === Terrain.Rock ? 'rock' : 'soil';
}

export function generateChunk(cx: number, cy: number): {
  tiles: Uint8Array;
  heights: Uint8Array;
} {
  const tiles = new Uint8Array(CHUNK_TILES);
  const heights = new Uint8Array(CHUNK_TILES);
  const baseX = cx * CHUNK_SIZE;
  const baseY = cy * CHUNK_SIZE;
  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    const row = ly * CHUNK_SIZE;
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const tx = baseX + lx;
      const ty = baseY + ly;
      tiles[row + lx] = terrainAt(tx, ty);
      heights[row + lx] = heightAt(tx, ty);
    }
  }
  return { tiles, heights };
}
