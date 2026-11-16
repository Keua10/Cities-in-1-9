import { CHUNK_SIZE } from '../core/constants';
import {
  DEPOSIT_BASE_RESERVE,
  DEPOSIT_MIN_RESERVE,
  DIFFICULTY_RESERVE_MUL,
  RESOURCES,
  type ResourceId,
} from '../sim/config/resources';
import { insideContinent, MOUNTAIN_HEIGHT, quickSite } from './continent';
import { fbm } from './terrain';

/**
 * 자원 매장지 (군사 2단계).
 *
 * 대륙을 8×8 청크 칸으로 나누고, 칸마다 자원별로 매장지가 생길지 정한다(결정론).
 *   - 지역마다 많고 적음이 뚜렷하도록 저주파 "지질" 노이즈가 확률을 키우거나 줄인다.
 *   - 지형에 어울리는 곳에만: 철 = 산·고지대 둘레, 석탄 = 언덕·구릉, 석유 = 낮은 평지·해안.
 *   - 매장지는 가운데 청크에서 1~3청크 반경의 덩어리. 가장자리로 갈수록 적다.
 *   - 매장지마다 난이도(얕음 45%·보통 35%·깊음 20%). 깊을수록 많이 묻혀 있다.
 *   - 있는 곳은 청크마다 최소 DEPOSIT_MIN_RESERVE(쓸 만한 양 보장).
 *
 * 어느 기기에서든 같은 좌표면 같은 결과다. 캔 양(줄어든 매장량)은 도시 저장(macro.mined)에 있다.
 */

export interface Deposit {
  resource: ResourceId;
  /** 0 얕음, 1 보통, 2 깊음. */
  difficulty: number;
  /** 이 청크의 처음 매장량. */
  reserve: number;
}

const CELL = 8;
const SEED = 0x5eed_0d1;
const CHANCE: Record<ResourceId, number> = { iron: 0.34, coal: 0.36, oil: 0.55 };
const GEO_SEED: Record<ResourceId, number> = { iron: 911, coal: 1777, oil: 2903 };

function hash(x: number, y: number, s: number): number {
  let h = (SEED ^ s) ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

interface Blob {
  resource: ResourceId;
  cx: number;
  cy: number;
  radius: number;
  difficulty: number;
  richness: number;
}

const cellCache = new Map<string, Blob[]>();
const chunkCache = new Map<string, Deposit | null>();

/** 청크 가운데 근처 몇 곳의 지형. */
function chunkTerrain(cx: number, cy: number): { height: number; water: number; mountain: number } {
  let height = 0;
  let water = 0;
  let mountain = 0;
  const pts = [8, 24];
  for (const oy of pts)
    for (const ox of pts) {
      const s = quickSite(cx * CHUNK_SIZE + ox, cy * CHUNK_SIZE + oy);
      if (s.water) water++;
      else {
        height += s.height;
        if (s.height >= MOUNTAIN_HEIGHT) mountain++;
      }
    }
  const land = 4 - water;
  return { height: land ? height / land : 0, water, mountain };
}

/** 지형이 그 자원에 얼마나 어울리는가 0~1. */
function suitability(r: ResourceId, t: { height: number; water: number; mountain: number }): number {
  if (t.water >= 3) return 0;
  if (r === 'iron') {
    // 산과 고지대 둘레. 산 한가운데(전부 산)는 캐기 어려우니 조금 깎는다.
    if (t.mountain >= 4) return 0.5;
    if (t.mountain > 0) return 1;
    return t.height >= 3 ? 0.8 : t.height >= 2 ? 0.35 : 0.08;
  }
  if (r === 'coal') {
    if (t.mountain >= 3) return 0.3;
    return t.height >= 2 && t.height <= 4.5 ? 1 : t.height >= 1 ? 0.45 : 0.15;
  }
  // 석유: 낮은 평지, 바닷가면 더 좋다.
  if (t.mountain > 0 || t.height > 2.5) return 0.05;
  return t.water > 0 ? 1 : t.height <= 1.2 ? 0.75 : 0.4;
}

function blobsOfCell(gx: number, gy: number): Blob[] {
  const key = `${gx},${gy}`;
  const hit = cellCache.get(key);
  if (hit) return hit;
  const out: Blob[] = [];
  for (let ri = 0; ri < RESOURCES.length; ri++) {
    const r = RESOURCES[ri];
    // 지역 지질: 넓은 범위에서 많고 적음이 갈린다(0.15 ~ 1.85배).
    const geo = fbm(gx * 0.18, gy * 0.18, GEO_SEED[r], 3);
    const regional = Math.max(0.15, Math.min(1.85, (geo - 0.32) * 4.5));
    if (hash(gx, gy, 101 + ri) > CHANCE[r] * regional) continue;
    const cx = gx * CELL + Math.floor(hash(gx, gy, 211 + ri) * CELL);
    const cy = gy * CELL + Math.floor(hash(gx, gy, 307 + ri) * CELL);
    if (!insideContinent(cx, cy)) continue;
    const fit = suitability(r, chunkTerrain(cx, cy));
    if (hash(gx, gy, 401 + ri) > fit) continue;
    const d = hash(gx, gy, 503 + ri);
    out.push({
      resource: r,
      cx,
      cy,
      radius: 1 + Math.floor(hash(gx, gy, 601 + ri) * 2.6),
      difficulty: d < 0.45 ? 0 : d < 0.8 ? 1 : 2,
      richness: 0.7 + hash(gx, gy, 701 + ri) * 0.9 * regional,
    });
  }
  cellCache.set(key, out);
  return out;
}

/** 청크 (cx,cy) 의 매장지. 없으면 null. */
export function depositAt(cx: number, cy: number): Deposit | null {
  const key = `${cx},${cy}`;
  const hit = chunkCache.get(key);
  if (hit !== undefined) return hit;
  const gx = Math.floor(cx / CELL);
  const gy = Math.floor(cy / CELL);
  let best: Deposit | null = null;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++)
      for (const b of blobsOfCell(gx + dx, gy + dy)) {
        const dist = Math.hypot(cx - b.cx, cy - b.cy);
        // 가장자리는 조금 들쭉날쭉하게.
        const edge = b.radius + (hash(cx, cy, 809) - 0.5) * 0.9;
        if (dist > edge) continue;
        const falloff = 1 - (dist / (b.radius + 1)) * 0.6;
        const reserve = Math.max(
          DEPOSIT_MIN_RESERVE,
          Math.round(
            (DEPOSIT_BASE_RESERVE[b.resource] *
              DIFFICULTY_RESERVE_MUL[b.difficulty] *
              b.richness *
              falloff) /
              100,
          ) * 100,
        );
        if (!best || reserve > best.reserve)
          best = { resource: b.resource, difficulty: b.difficulty, reserve };
      }
  if (best && chunkTerrain(cx, cy).water >= 4) best = null;
  if (chunkCache.size > 200_000) chunkCache.clear();
  chunkCache.set(key, best);
  return best;
}
