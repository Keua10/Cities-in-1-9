import { doc, getDoc, setDoc } from 'firebase/firestore';
import { CHUNK_SIZE } from '../core/constants';
import { parseChunkKey } from '../core/iso';
import { Build } from '../world/build';
import type { World } from '../world/world';
import { getFirebase } from './firebase';

/**
 * 도시 배치 요약(plans/{uid}): 청크마다 8×8칸(한 칸 = 4×4 타일)의 대표 용도.
 * 대륙 지도에서 밝혀진 청크를 크게 확대하면 이 요약으로 그 도시의 도로·구역을 그린다.
 *
 * public/{uid} 와 따로 둔다 — 크고 자주 바뀌지 않으며, 규칙을 게시하기 전에
 * 이 쓰기가 실패해도 공개 문서(영토·부대)는 그대로 올라가야 하기 때문이다.
 *
 * 칸 글자: 0 빈 땅 · 1 도로 · 2 주거 · 3 상업 · 4 공업 · 5 시설 · 6 활주로.
 * 아무것도 없는 청크는 빼서 문서를 작게 둔다.
 */

export const PLAN_CELLS = 8;
const CELL_TILES = CHUNK_SIZE / PLAN_CELLS;
/** 다시 올리는 최소 간격(ms) — 쓰기를 아낀다. */
const PLAN_WRITE_MS = 3 * 60_000;
/** 남의 요약을 다시 읽는 간격(ms). */
const PLAN_READ_MS = 2 * 60_000;

export type PlanChunks = Record<string, string>;

const CODE: Record<number, number> = {
  [Build.Road]: 1,
  [Build.ZoneR]: 2,
  [Build.ZoneC]: 3,
  [Build.ZoneI]: 4,
  [Build.Civic]: 5,
  [Build.Runway]: 6,
  [Build.Taxiway]: 6,
};

/** 한 청크 요약(64글자). 비어 있으면 ''. */
export function encodeChunk(world: World, cx: number, cy: number): string {
  let out = '';
  let any = false;
  const counts = new Array(7);
  for (let gy = 0; gy < PLAN_CELLS; gy++)
    for (let gx = 0; gx < PLAN_CELLS; gx++) {
      counts.fill(0);
      for (let y = 0; y < CELL_TILES; y++)
        for (let x = 0; x < CELL_TILES; x++) {
          const v =
            CODE[
              world.getBuild(
                cx * CHUNK_SIZE + gx * CELL_TILES + x,
                cy * CHUNK_SIZE + gy * CELL_TILES + y,
              )
            ];
          if (v) counts[v]++;
        }
      // 칸의 1/4 이상 쓰였으면 가장 많은 용도(도로는 가늘어서 3칸이면 도로).
      let best = 0;
      let n = 0;
      for (let v = 2; v < 7; v++) if (counts[v] > n) ((best = v), (n = counts[v]));
      if (n < 4) best = counts[1] >= 3 ? 1 : 0;
      if (best) any = true;
      out += best;
    }
  return any ? out : '';
}

/** 내 땅 전체 요약. */
export function encodePlan(world: World, owned: Iterable<string>): PlanChunks {
  const out: PlanChunks = {};
  for (const key of owned) {
    const { cx, cy } = parseChunkKey(key);
    const s = encodeChunk(world, cx, cy);
    if (s) out[key] = s;
  }
  return out;
}

/** 내 요약을 올린다. 바뀌었고 마지막으로 올린 지 3분이 지났을 때만. */
export class PlanPublisher {
  private last = '';
  private lastAt = 0;

  constructor(private uid: string) {}

  async maybePublish(plan: PlanChunks, now = Date.now()): Promise<void> {
    const fb = getFirebase();
    if (!fb) return;
    const sig = JSON.stringify(plan);
    if (sig === this.last || now - this.lastAt < PLAN_WRITE_MS) return;
    this.last = sig;
    this.lastAt = now;
    try {
      await setDoc(doc(fb.db, 'plans', this.uid), { chunks: plan, updatedAt: now });
    } catch (err) {
      // 규칙을 아직 게시하지 않았으면 여기서 막힌다. 공개 문서에는 영향 없음.
      console.warn('도시 배치 요약을 올리지 못했습니다', err);
    }
  }
}

/** 남의 요약 읽기(2분 캐시). 실패하면 빈 요약. */
export class PlanReader {
  private cache = new Map<string, { at: number; chunks: PlanChunks; pending: boolean }>();
  /** 새 요약을 받으면 올라간다(지도를 다시 그리라는 신호). */
  revision = 0;

  /** 지금 가진 요약(없으면 읽기를 시작하고 빈 값). */
  get(uid: string): PlanChunks {
    const now = Date.now();
    const c = this.cache.get(uid);
    if (c && (c.pending || now - c.at < PLAN_READ_MS)) return c.chunks;
    const entry = { at: now, chunks: c?.chunks ?? {}, pending: true };
    this.cache.set(uid, entry);
    void this.load(uid, entry);
    return entry.chunks;
  }

  private async load(uid: string, entry: { at: number; chunks: PlanChunks; pending: boolean }) {
    const fb = getFirebase();
    try {
      if (fb) {
        const snap = await getDoc(doc(fb.db, 'plans', uid));
        const raw = snap.exists() ? snap.data().chunks : null;
        if (raw && typeof raw === 'object') {
          const clean: PlanChunks = {};
          for (const [k, v] of Object.entries(raw as Record<string, unknown>))
            if (typeof v === 'string' && /^[0-6]{64}$/.test(v)) clean[k] = v;
          entry.chunks = clean;
          this.revision++;
        }
      }
    } catch {
      // 읽기 실패: 지형만 보인다.
    }
    entry.at = Date.now();
    entry.pending = false;
  }
}
