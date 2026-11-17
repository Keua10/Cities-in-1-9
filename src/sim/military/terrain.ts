import { CHUNK_SIZE } from '../../core/constants';
import { MOUNTAIN_HEIGHT, quickSite } from '../../world/continent';
import type { UnitType } from '../config/military';

/**
 * 전쟁 지형 (군사 4단계). 청크 하나를 한 가지 지형으로 본다(설계안 Ⅵ 지형 보정).
 *
 *   sea       바다(땅 부대 통과 불가)
 *   bigRiver  큰 강이 지나감: 건널 때 이동 35%, 도하 공격 −50%, 건너편 방어 +30%
 *   river     개울: 이동 50%, 도하 공격 −30%, 건너편 방어 +20%
 *   mountain  산(높이 5 이상이 절반 넘음): 보병·공병만 40%, 공격 −20%, 방어 +50%
 *   highland  고지대(평균 높이 3 이상): 이동 70%, 방어 +20%, 아래로 공격 +15%
 *   plain     평지: 기갑 공격 +25%
 * 도시(누군가의 영토 안)는 따로 겹쳐 본다: 이동 70%, 기갑 공격 −30%, 보병 방어 +40%.
 * 골짜기(양쪽 이웃이 2단 이상 높음): 숨어 있던 쪽이 첫 30초 공격 +50%.
 */

export type TerrainKind = 'sea' | 'bigRiver' | 'river' | 'mountain' | 'highland' | 'plain';

export interface ChunkTerrain {
  kind: TerrainKind;
  /** 평균 높이(물 제외). */
  height: number;
  valley: boolean;
}

export const TERRAIN_NAMES: Record<TerrainKind, string> = {
  sea: '바다',
  bigRiver: '큰 강',
  river: '하천',
  mountain: '산',
  highland: '고지대',
  plain: '평지',
};

const cache = new Map<string, ChunkTerrain>();
const SAMPLES = [4, 12, 20, 28];

function raw(cx: number, cy: number): { kind: TerrainKind; height: number } {
  let water = 0;
  let sea = 0;
  let big = 0;
  let mountain = 0;
  let height = 0;
  let land = 0;
  for (const oy of SAMPLES)
    for (const ox of SAMPLES) {
      const s = quickSite(cx * CHUNK_SIZE + ox, cy * CHUNK_SIZE + oy);
      if (s.water) {
        water++;
        if (s.water === 3) sea++;
        else if (s.water === 2) big++;
        continue;
      }
      land++;
      height += s.height;
      if (s.height >= MOUNTAIN_HEIGHT) mountain++;
    }
  const n = SAMPLES.length * SAMPLES.length;
  const avg = land ? height / land : 0;
  let kind: TerrainKind;
  if (sea >= n * 0.6 || water >= n * 0.8) kind = 'sea';
  else if (big >= 2) kind = 'bigRiver';
  else if (water - sea >= 1) kind = 'river';
  else if (mountain >= land * 0.5 && land > 0) kind = 'mountain';
  else if (avg >= 3) kind = 'highland';
  else kind = 'plain';
  return { kind, height: avg };
}

export function chunkTerrain(cx: number, cy: number): ChunkTerrain {
  const key = `${cx},${cy}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const me = raw(cx, cy);
  let valley = false;
  if (me.kind !== 'sea' && me.kind !== 'mountain') {
    const h = (dx: number, dy: number) => raw(cx + dx, cy + dy).height;
    valley =
      (h(-1, 0) >= me.height + 2 && h(1, 0) >= me.height + 2) ||
      (h(0, -1) >= me.height + 2 && h(0, 1) >= me.height + 2);
  }
  const t = { kind: me.kind, height: me.height, valley };
  if (cache.size > 100_000) cache.clear();
  cache.set(key, t);
  return t;
}

/** 이 청크를 지날 때 이동 배율. 0 이면 못 지나간다. */
export function moveFactor(
  t: ChunkTerrain,
  type: UnitType,
  urban: boolean,
  mountainsOk: boolean,
): number {
  let f: number;
  switch (t.kind) {
    case 'sea':
      return 0;
    case 'bigRiver':
      f = type === 'engineer' ? 0.6 : 0.35;
      break;
    case 'river':
      f = 0.5;
      break;
    case 'mountain':
      if (!mountainsOk) return 0;
      f = 0.4;
      break;
    case 'highland':
      f = 0.7;
      break;
    default:
      f = 1;
  }
  if (urban) f *= 0.7;
  return f;
}

/** 이 청크에서 공격하는 쪽의 공격 배율. from = 공격하는 부대가 있던(들어온) 청크 지형. */
export function attackFactor(
  t: ChunkTerrain,
  type: UnitType,
  urban: boolean,
  from: ChunkTerrain | null,
): number {
  let f = 1;
  if (t.kind === 'mountain') f *= 0.8;
  if (t.kind === 'bigRiver') f *= 0.5;
  if (t.kind === 'river') f *= 0.7;
  if (t.kind === 'plain' && type === 'armor') f *= 1.25;
  if (urban && type === 'armor') f *= 0.7;
  if (from && from.height >= t.height + 1.5) f *= 1.15; // 높은 곳에서 아래로
  return f;
}

/** 이 청크에서 막는 쪽의 방어 배율. */
export function defenseFactor(
  t: ChunkTerrain,
  type: UnitType,
  urban: boolean,
  trench: boolean,
): number {
  let f = 1;
  if (t.kind === 'mountain') f *= 1.5;
  if (t.kind === 'highland') f *= 1.2;
  if (t.kind === 'bigRiver') f *= 1.3;
  if (t.kind === 'river') f *= 1.2;
  if (urban && (type === 'infantry' || type === 'engineer')) f *= 1.4;
  if (trench) f *= 1.3;
  return f;
}
