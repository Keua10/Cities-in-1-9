import { BASE_CHUNK_SPAN, BASE_SPACING_CHUNKS, CHUNK_SIZE } from '../core/constants';
import {
  CONTINENT_H,
  CONTINENT_W,
  CONTINENT_X0,
  CONTINENT_Y0,
  MOUNTAIN_HEIGHT,
  quickSite,
  WATER_BARRIER_TILES,
} from './continent';

/**
 * 도시 시작 자리(2×2 청크) 규칙.
 *
 *  1. 땅: 대륙 안쪽(가장자리 2청크 제외), 평지가 물+산보다 많다.
 *  2. 하천: 2×2 안에 개울이나 강이 흐른다. 하수 방류에 꼭 필요하다.
 *  3. 간격: 다른 도시 중심과
 *       - SITE_NEAR 청크 미만이면 무조건 안 된다.
 *       - SITE_FAR 청크 이상이면 무조건 된다.
 *       - 그 사이면 **둘 사이에 장애물(바다·큰 강·산맥)이 있을 때만** 된다.
 *     평지로 이어진 도시는 멀리, 산·강·바다로 갈린 도시는 가까이 붙을 수 있다.
 *     능선(고도 1~4 언덕)과 개울은 장애물이 아니다.
 */

export const SITE_NEAR = 6;
export const SITE_FAR = BASE_SPACING_CHUNKS;
/** 산맥으로 인정하는 연속 길이(칸). 한두 개 봉우리는 장애물이 아니다. */
export const MOUNTAIN_BARRIER_TILES = 24;
const EDGE_MARGIN = 2;
/** 청크 통계 표본 간격(칸). 청크당 8×8 = 64점. */
export const STAT_STEP = 8;
export const STAT_SAMPLES = (CHUNK_SIZE / STAT_STEP) ** 2;
/** 표본에서 이만큼 안에 물길이 있으면 "청크에 하천이 흐른다" 로 본다. */
const RIVER_NEAR_TILES = 6;

export const CHUNK_LAND = 1;
export const CHUNK_RIVER = 2;
export const CHUNK_COAST = 4;
export const CHUNK_BIG_RIVER = 8;

/** 청크 하나의 요약. 시작 화면이 미리 계산된 표로 받는다(4바이트). */
export interface ChunkStat {
  flags: number;
  /** 0~64 평지 표본 수(물 아님, 고도 5 미만). */
  flat: number;
  /** 0~64 산 표본 수(고도 5 이상). */
  mountain: number;
  /** 0~255 평균 비옥도 × 200. */
  fertility: number;
}

export interface Origin {
  cx: number;
  cy: number;
}

export function originKey(o: Origin): string {
  return `${o.cx},${o.cy}`;
}

export function parseOriginKey(key: string): Origin | null {
  const m = /^(-?\d+),(-?\d+)$/.exec(key);
  return m ? { cx: Number(m[1]), cy: Number(m[2]) } : null;
}

/* ---------------------------------------------------------------- *
 * 청크 통계
 * ---------------------------------------------------------------- */

export function computeChunkStat(cx: number, cy: number): ChunkStat {
  let flags = 0;
  let flat = 0;
  let mountain = 0;
  let fert = 0;
  let maybeRiver = false;
  for (let y = STAT_STEP / 2; y < CHUNK_SIZE; y += STAT_STEP) {
    for (let x = STAT_STEP / 2; x < CHUNK_SIZE; x += STAT_STEP) {
      const s = quickSite(cx * CHUNK_SIZE + x, cy * CHUNK_SIZE + y);
      if (s.water === 3) {
        flags |= CHUNK_COAST;
        continue;
      }
      flags |= CHUNK_LAND;
      if (s.water || s.waterDist <= RIVER_NEAR_TILES) maybeRiver = true;
      if (s.water) continue;
      if (s.height >= MOUNTAIN_HEIGHT) mountain++;
      else {
        flat++;
        fert += quickFertility(s.tile, s.height, s.waterDist);
      }
    }
  }
  if (maybeRiver) flags |= riverFlags(cx, cy);
  return { flags, flat, mountain, fertility: flat ? Math.round((fert / flat) * 200) : 0 };
}

/**
 * 청크 안에 개울·강 물이 **실제로** 있는가. 가로 1칸·세로 2칸 간격으로 훑는다.
 * 이 격자는 폭 2칸 넘는 띠를 어느 방향으로 놓아도 반드시 한 점을 품으므로
 * 폭 2~3칸 개울을 놓치지 않는다. 표본 간격(8칸)으로만 보면 기본 영역 바로
 * 바깥을 흐르는 개울까지 "하천 있음" 으로 잡았다.
 */
function riverFlags(cx: number, cy: number): number {
  let flags = 0;
  for (let y = 0; y < CHUNK_SIZE; y += 2)
    for (let x = 0; x < CHUNK_SIZE; x++) {
      const w = quickSite(cx * CHUNK_SIZE + x, cy * CHUNK_SIZE + y).water;
      if (w === 1 || w === 2) {
        flags |= CHUNK_RIVER;
        if (w === 2) return flags | CHUNK_BIG_RIVER;
      }
    }
  return flags;
}

/** 시작 화면 요약용 비옥도. 농장이 쓰는 fertilityAt 의 근사다. */
function quickFertility(tile: number, height: number, waterDist: number): number {
  const soil = [0, 0, 0.35, 1, 0.7, 0.55, 0.2, 0.85][tile] ?? 0.6;
  const irrigation = Math.max(0, 1 - waterDist / 40);
  const hf = height <= 2 ? 1 : height <= 4 ? 0.85 : 0.6;
  return Math.min(1.3, soil * hf * (0.55 + 0.75 * irrigation));
}

/** 대륙 전체를 한 줄로 늘어놓은 청크 통계 표. */
export class ChunkStatTable {
  constructor(private readonly bytes: Uint8Array) {
    if (bytes.length !== CONTINENT_W * CONTINENT_H * 4)
      throw new Error(`대륙 표 크기 오류: ${bytes.length}`);
  }

  static compute(): ChunkStatTable {
    const bytes = new Uint8Array(CONTINENT_W * CONTINENT_H * 4);
    for (let y = 0; y < CONTINENT_H; y++)
      for (let x = 0; x < CONTINENT_W; x++) {
        const s = computeChunkStat(CONTINENT_X0 + x, CONTINENT_Y0 + y);
        bytes.set([s.flags, s.flat, s.mountain, s.fertility], (y * CONTINENT_W + x) * 4);
      }
    return new ChunkStatTable(bytes);
  }

  get raw(): Uint8Array {
    return this.bytes;
  }

  at(cx: number, cy: number): ChunkStat | null {
    const x = cx - CONTINENT_X0;
    const y = cy - CONTINENT_Y0;
    if (x < 0 || y < 0 || x >= CONTINENT_W || y >= CONTINENT_H) return null;
    const i = (y * CONTINENT_W + x) * 4;
    const b = this.bytes;
    return { flags: b[i], flat: b[i + 1], mountain: b[i + 2], fertility: b[i + 3] };
  }
}

/** 표가 없을 때(점검 도구·둘러보기 기본 자리)는 청크를 그때그때 계산한다. */
const lazyStats = new Map<string, ChunkStat>();
function lazyStat(cx: number, cy: number): ChunkStat {
  const key = `${cx},${cy}`;
  let s = lazyStats.get(key);
  if (!s) {
    s = computeChunkStat(cx, cy);
    lazyStats.set(key, s);
  }
  return s;
}

/* ---------------------------------------------------------------- *
 * 자리 평가
 * ---------------------------------------------------------------- */

export interface SiteSummary {
  /** 땅 조건(1·2)을 만족하는가. 간격은 따로 본다. */
  ok: boolean;
  reason: string;
  flatPct: number;
  mountainPct: number;
  waterPct: number;
  river: boolean;
  bigRiver: boolean;
  coast: boolean;
  /** 0~130 (%). */
  fertility: number;
}

export function siteSummary(o: Origin, table?: ChunkStatTable | null): SiteSummary {
  let flat = 0;
  let mountain = 0;
  let flags = 0;
  let fert = 0;
  let inside = true;
  for (let dy = 0; dy < BASE_CHUNK_SPAN; dy++)
    for (let dx = 0; dx < BASE_CHUNK_SPAN; dx++) {
      const cx = o.cx + dx;
      const cy = o.cy + dy;
      const s = table ? table.at(cx, cy) : lazyStat(cx, cy);
      if (!s) {
        inside = false;
        continue;
      }
      flat += s.flat;
      mountain += s.mountain;
      flags |= s.flags;
      fert += s.fertility * s.flat;
    }
  const total = STAT_SAMPLES * BASE_CHUNK_SPAN * BASE_CHUNK_SPAN;
  const water = total - flat - mountain;
  const summary: SiteSummary = {
    ok: false,
    reason: '',
    flatPct: Math.round((flat / total) * 100),
    mountainPct: Math.round((mountain / total) * 100),
    waterPct: Math.round((water / total) * 100),
    river: (flags & CHUNK_RIVER) !== 0,
    bigRiver: (flags & CHUNK_BIG_RIVER) !== 0,
    coast: (flags & CHUNK_COAST) !== 0,
    fertility: flat ? Math.round(fert / flat / 2) : 0,
  };
  const inMargin =
    inside &&
    o.cx >= CONTINENT_X0 + EDGE_MARGIN &&
    o.cy >= CONTINENT_Y0 + EDGE_MARGIN &&
    o.cx + BASE_CHUNK_SPAN <= CONTINENT_X0 + CONTINENT_W - EDGE_MARGIN &&
    o.cy + BASE_CHUNK_SPAN <= CONTINENT_Y0 + CONTINENT_H - EDGE_MARGIN;
  if (!inMargin) summary.reason = '대륙 가장자리라 시작할 수 없습니다';
  else if (flat <= water + mountain) summary.reason = '평지가 부족합니다 (물·산이 절반 이상)';
  else if (!summary.river) summary.reason = '하천이 흐르지 않습니다';
  else summary.ok = true;
  return summary;
}

/* ---------------------------------------------------------------- *
 * 간격
 * ---------------------------------------------------------------- */

function center(o: Origin): [number, number] {
  const half = (BASE_CHUNK_SPAN * CHUNK_SIZE) / 2;
  return [o.cx * CHUNK_SIZE + half, o.cy * CHUNK_SIZE + half];
}

export function centerDistance(a: Origin, b: Origin): number {
  return Math.hypot(a.cx - b.cx, a.cy - b.cy);
}

const barrierCache = new Map<string, boolean>();

/**
 * 두 도시 중심을 잇는 선 위에 장애물이 있는가.
 *
 * 두 기본 영역의 **사이 구간** 만 본다(각 영역 안쪽은 제외). 2칸 간격으로 걸으며
 *   - 바다·큰 강이 WATER_BARRIER_TILES 칸 이상 이어지거나
 *   - 고도 5 이상이 MOUNTAIN_BARRIER_TILES 칸 이상 이어지면
 * 장애물로 본다. 개울(2~3칸)과 능선(고도 1~4)은 걸리지 않는다.
 */
export function barrierBetween(a: Origin, b: Origin): boolean {
  const key =
    a.cx < b.cx || (a.cx === b.cx && a.cy <= b.cy)
      ? `${originKey(a)}|${originKey(b)}`
      : `${originKey(b)}|${originKey(a)}`;
  const hit = barrierCache.get(key);
  if (hit !== undefined) return hit;
  const [ax, ay] = center(a);
  const [bx, by] = center(b);
  const len = Math.hypot(bx - ax, by - ay);
  // 기본 영역 반폭만큼 양 끝을 뺀다(대각선이면 조금 더 들어간다).
  const skip = (BASE_CHUNK_SPAN * CHUNK_SIZE) / 2;
  const step = 2;
  let water = 0;
  let mountain = 0;
  let result = false;
  for (let d = skip; d <= len - skip; d += step) {
    const t = d / len;
    const s = quickSite(Math.round(ax + (bx - ax) * t), Math.round(ay + (by - ay) * t));
    water = s.water === 3 || s.water === 2 ? water + step : 0;
    mountain = !s.water && s.height >= MOUNTAIN_HEIGHT ? mountain + step : 0;
    if (water >= WATER_BARRIER_TILES || mountain >= MOUNTAIN_BARRIER_TILES) {
      result = true;
      break;
    }
  }
  if (barrierCache.size > 200_000) barrierCache.clear();
  barrierCache.set(key, result);
  return result;
}

/** 이미 정해진 도시들과의 간격 규칙. 막히면 이유를 돌려준다. */
export function spacingBlock(o: Origin, others: readonly Origin[]): string {
  for (const other of others) {
    const d = centerDistance(o, other);
    if (d < SITE_NEAR) return '다른 도시와 너무 가깝습니다';
    if (d < SITE_FAR && !barrierBetween(o, other))
      return '다른 도시와 평지로 이어져 있어 더 떨어져야 합니다 · 사이에 산·강·바다가 있으면 가까이 지을 수 있어요';
  }
  return '';
}

export function canStartAt(
  o: Origin,
  others: readonly Origin[],
  table?: ChunkStatTable | null,
): { ok: boolean; reason: string; summary: SiteSummary } {
  const summary = siteSummary(o, table);
  if (!summary.ok) return { ok: false, reason: summary.reason, summary };
  const spacing = spacingBlock(o, others);
  return { ok: !spacing, reason: spacing, summary };
}

/**
 * 시작 화면 없이 도시 번호만으로 자리가 필요할 때(점검 도구, 예전 API).
 * 대륙 가운데부터 나선으로 훑어 규칙을 만족하는 자리를 차례로 채택한다.
 */
const defaultOrigins: Origin[] = [];
let spiralIndex = 0;

export function defaultOrigin(index: number): Origin {
  const target = Math.max(0, Math.floor(index));
  while (defaultOrigins.length <= target) {
    const c = squareSpiral(spiralIndex++);
    const o = { cx: c.x * 2 - 1, cy: c.y * 2 - 1 };
    if (Math.abs(c.x) * 2 > CONTINENT_W / 2 && Math.abs(c.y) * 2 > CONTINENT_H / 2)
      throw new Error('대륙에 더 이상 시작 자리가 없습니다');
    if (canStartAt(o, defaultOrigins).ok) defaultOrigins.push(o);
  }
  return defaultOrigins[target];
}

function squareSpiral(n: number): { x: number; y: number } {
  if (n === 0) return { x: 0, y: 0 };
  let k = Math.ceil((Math.sqrt(n + 1) - 1) / 2);
  let t = 2 * k + 1;
  let m = t * t;
  t -= 1;
  if (n >= m - t) return { x: k - (m - n), y: -k };
  m -= t;
  if (n >= m - t) return { x: -k, y: -k + (m - n) };
  m -= t;
  if (n >= m - t) return { x: -k + (m - n), y: k };
  return { x: k, y: k - (m - n - t) };
}
