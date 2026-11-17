import { BASE_CHUNK_SPAN, CHUNK_SIZE } from '../core/constants';
import { chunkIndexOf, chunkKey, localIndexOf, parseChunkKey } from '../core/iso';
import type { MacroState } from '../net/types';
import { Build } from '../world/build';
import type { World } from '../world/world';
import { edgeNeighbors } from './roadGraph';
import { facilityKindOfCode, isFacilityAnchor } from './buildings';
import { facilitySpan } from './facilities';
import { METRO_FACILITY } from './metro';
import {
  FAC_AIRPORT,
  FAC_AIRPORT_L2,
  FAC_AIRPORT_L3,
  FAC_HARBOR,
  FAC_HARBOR_CARGO,
  FAC_HARBOR_HYBRID_L2,
  FAC_HARBOR_HYBRID_L3,
} from './config/special';

/**
 * 영토와 수도 (군사 콘텐츠 1단계).
 *
 * 청크(32×32칸) 단위로 땅의 주인을 정한다.
 *
 *   - 시작 영토: 고른 자리 4×4 청크. 처음부터 내 땅이고 연결 규칙을 보지 않는다(기본 영역).
 *   - 수도: 1레벨 2×2 → 2레벨 4×4 → 3레벨 6×6. 처음에는 시작 영토 한가운데 2×2.
 *   - 자동 점령: 거주 100명 이상 또는 유동인구 150명 이상이고 본 도시와 이동 연결이 되면 내 땅.
 *   - 연결: 수도의 도로에서 도로로 이어지거나, 항구·공항·지하철 노선으로 건너갈 수 있으면 연결.
 *     끊긴 채로 실제 10분이 지나면 그 청크는 주인 없는 땅이 된다(시작 영토·수도 제외).
 *   - 개척지: 내 땅과 맞닿은(대각선 포함) 주인 없는 청크. 주거·상업·공업 지구는 내 땅과
 *     개척지에만 놓을 수 있다. 그래야 지구를 깔고 사람이 들어와 땅이 넓어진다.
 *   - 공공 서비스·행정 시설(소방·경찰·병원·학교·공원·체육·교도소)은 내 땅에만.
 *     발전소·상하수도·위생·농장·교통 시설과 배관·전선은 탐사한 땅이면 어디든(보호는 안 됨).
 *
 * 연결 판정은 실제 시간(10분)을 쓰므로 매크로 틱(결정론)과 따로 돈다. 영토가 바뀌어도
 * 이미 지은 건물은 그대로 둔다 — 잃은 땅의 건물은 보호받지 못할 뿐이다.
 */

export const CAPITAL_SPANS = [2, 4, 6] as const;
/** 수도 레벨별 확장에 필요한 도시 레벨. */
export const CAPITAL_CITY_LEVEL = [1, 4, 7] as const;
export const CAPITAL_MAX_SHARE = 0.25;
export const OCCUPY_RESIDENTS = 100;
export const OCCUPY_FLOATING = 150;
/** 유동인구 = 그 청크 일자리 + 상업 일자리 × 이 값(방문객). */
export const SHOP_VISITORS_PER_JOB = 2;
export const CUT_GRACE_MS = 10 * 60_000;
export const CAPITAL_MOVE_MS = 5 * 60_000;
export const CAPITAL_MOVE_COOLDOWN_MS = 24 * 60 * 60_000;
/** 내 땅에서 이만큼(청크) 둘레까지 탐사돼 보인다. */
export const EXPLORE_RING = 2;
/** 연결 다시 계산 주기(실제 ms). 도로가 바뀌면 바로 다시 본다. */
const CONNECT_INTERVAL_MS = 15_000;
const UPDATE_INTERVAL_MS = 1_000;

const HARBORS = new Set([FAC_HARBOR, FAC_HARBOR_CARGO, FAC_HARBOR_HYBRID_L2, FAC_HARBOR_HYBRID_L3]);
const AIRPORTS = new Set([FAC_AIRPORT, FAC_AIRPORT_L2, FAC_AIRPORT_L3]);

export interface TerritoryState {
  /** 내 땅 청크 "cx,cy". */
  owned: string[];
  /** 연결이 끊긴 청크와 끊긴 실제 시각(ms). */
  cut?: Record<string, number>;
  /** 수도 레벨 1~3. */
  capitalLevel: number;
  /** 수도 왼쪽 위 청크 "cx,cy". */
  capital: string;
  /** 수도 이전 진행 중: 새 왼쪽 위 청크와 완료 시각. */
  move?: { to: string; doneAt: number };
  /** 마지막 수도 이전을 마친 실제 시각(쿨타임). */
  movedAt?: number;
  /** 전쟁으로 빼앗긴 청크. 다시 자동 점령되지 않고, 그 청크 시민은 사라진다. */
  ceded?: string[];
  /** 전쟁으로 얻은 청크. 길 연결 규칙을 보지 않는다. */
  annexed?: string[];
}

export interface ChunkPeople {
  /** 징병을 뺀 거주 인구. */
  residents: number;
  floating: number;
  /** 징병 전 거주 인구(징병 상한 계산용). */
  raw: number;
}

export interface Rect {
  cx: number;
  cy: number;
  span: number;
}

export type LandUse = 'zone' | 'owned';

export function emptyTerritory(baseCx: number, baseCy: number): TerritoryState {
  const owned: string[] = [];
  for (let dy = 0; dy < BASE_CHUNK_SPAN; dy++)
    for (let dx = 0; dx < BASE_CHUNK_SPAN; dx++) owned.push(chunkKey(baseCx + dx, baseCy + dy));
  const half = (BASE_CHUNK_SPAN - CAPITAL_SPANS[0]) / 2;
  return { owned, capitalLevel: 1, capital: chunkKey(baseCx + half, baseCy + half) };
}

function inRect(r: Rect, cx: number, cy: number): boolean {
  return cx >= r.cx && cy >= r.cy && cx < r.cx + r.span && cy < r.cy + r.span;
}

export class TerritorySystem {
  private owned = new Set<string>();
  /** 처음 고른 4×4. 연결 규칙을 보지 않는다. */
  private core: Rect;
  private connected = new Set<string>();
  private connectStamp = '';
  private lastConnectAt = -Infinity;
  private lastUpdateAt = -Infinity;
  /** 마지막 평가의 청크별 인구. 매크로 evaluate 가 채운다. */
  people = new Map<string, ChunkPeople>();
  /** 영토·수도가 바뀔 때마다 1씩 오른다. 화면이 테두리를 다시 그릴 때 쓴다. */
  revision = 0;
  /** 다른 도시의 영토(대륙 지도·전쟁에서 채움). 다른 도시민이 있는 땅은 자동 점령하지 않는다. */
  foreign = new Set<string>();
  /** 땅을 얻거나 잃었을 때(화면 알림용). */
  onChange: ((gained: string[], lost: string[]) => void) | null = null;

  constructor(
    private world: World,
    private macro: MacroState,
    private changed: () => void = () => {},
  ) {
    this.core = { cx: world.baseCx, cy: world.baseCy, span: BASE_CHUNK_SPAN };
    const state = this.normalize(macro.territory);
    macro.territory = state;
    for (const k of state.owned) this.owned.add(k);
    this.exploreAround([...this.owned]);
  }

  private normalize(raw: TerritoryState | undefined): TerritoryState {
    const fresh = emptyTerritory(this.world.baseCx, this.world.baseCy);
    if (!raw || !Array.isArray(raw.owned) || typeof raw.capital !== 'string') return fresh;
    const owned = new Set(raw.owned.filter((k) => typeof k === 'string'));
    for (const k of fresh.owned) owned.add(k);
    const level = Math.min(3, Math.max(1, Math.floor(Number(raw.capitalLevel) || 1)));
    const out: TerritoryState = { owned: [...owned], capitalLevel: level, capital: raw.capital };
    if (raw.cut && typeof raw.cut === 'object') out.cut = { ...raw.cut };
    if (raw.move && typeof raw.move.to === 'string') out.move = { ...raw.move };
    if (typeof raw.movedAt === 'number') out.movedAt = raw.movedAt;
    if (Array.isArray(raw.ceded)) out.ceded = raw.ceded.filter((k) => typeof k === 'string');
    if (Array.isArray(raw.annexed)) out.annexed = raw.annexed.filter((k) => typeof k === 'string');
    return out;
  }

  private get state(): TerritoryState {
    return this.macro.territory!;
  }

  /* ---------------- 조회 ---------------- */

  get count(): number {
    return this.owned.size;
  }

  get capitalLevel(): number {
    return this.state.capitalLevel;
  }

  isOwned(cx: number, cy: number): boolean {
    return this.owned.has(chunkKey(cx, cy));
  }

  ownedKeys(): IterableIterator<string> {
    return this.owned.values();
  }

  isCore(cx: number, cy: number): boolean {
    return inRect(this.core, cx, cy);
  }

  /** 내 땅과 맞닿은(대각선 포함) 주인 없는 청크. */
  isFrontier(cx: number, cy: number): boolean {
    if (this.isOwned(cx, cy)) return false;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if ((dx || dy) && this.isOwned(cx + dx, cy + dy)) return true;
    return false;
  }

  capitalRect(): Rect {
    const { cx, cy } = parseChunkKey(this.state.capital);
    return { cx, cy, span: CAPITAL_SPANS[this.state.capitalLevel - 1] };
  }

  isCapital(cx: number, cy: number): boolean {
    return inRect(this.capitalRect(), cx, cy);
  }

  /** 끊긴 청크와 남은 실제 시간(ms). */
  cutChunks(now = Date.now()): { key: string; leftMs: number }[] {
    const cut = this.state.cut ?? {};
    return Object.entries(cut).map(([key, at]) => ({
      key,
      leftMs: Math.max(0, at + CUT_GRACE_MS - now),
    }));
  }

  isCut(cx: number, cy: number): boolean {
    return !!this.state.cut?.[chunkKey(cx, cy)];
  }

  get moving(): { to: Rect; leftMs: number } | null {
    const m = this.state.move;
    if (!m) return null;
    const { cx, cy } = parseChunkKey(m.to);
    return {
      to: { cx, cy, span: CAPITAL_SPANS[this.state.capitalLevel - 1] },
      leftMs: Math.max(0, m.doneAt - Date.now()),
    };
  }

  /**
   * 지을 수 있는 땅인가. 빈 문자열이면 된다.
   * zone: 주거·상업·공업 지구 — 내 땅 또는 개척지.
   * owned: 공공·행정·군사 시설 — 내 땅만.
   */
  landRule = (cx: number, cy: number, use: LandUse): string => {
    if (this.isOwned(cx, cy)) return '';
    if (use === 'zone' && this.isFrontier(cx, cy)) return '';
    return use === 'zone'
      ? '내 영토나 영토와 맞닿은 청크에만 지구를 놓을 수 있습니다'
      : '이 시설은 내 영토에만 지을 수 있습니다';
  };

  /* ---------------- 매 프레임 ---------------- */

  /** 실제 시간으로 부른다. 연결 계산·자동 점령·끊김 처리·수도 이전 완료. */
  update(now = Date.now(), force = false): void {
    if (!force && now - this.lastUpdateAt < UPDATE_INTERVAL_MS) return;
    this.lastUpdateAt = now;
    const stamp = `${this.world.roadRevision}|${this.revision}|${this.world.signalRevision}`;
    if (force || stamp !== this.connectStamp || now - this.lastConnectAt >= CONNECT_INTERVAL_MS) {
      this.connectStamp = stamp;
      this.lastConnectAt = now;
      this.connected = this.computeConnected();
    }
    const gained: string[] = [];
    const lost: string[] = [];
    // 1) 자동 점령
    const ceded = new Set(this.state.ceded ?? []);
    for (const [key, p] of this.people) {
      if (this.owned.has(key) || ceded.has(key) || this.foreign.has(key)) continue;
      if (p.residents < OCCUPY_RESIDENTS && p.floating < OCCUPY_FLOATING) continue;
      if (!this.connected.has(key)) continue;
      this.owned.add(key);
      gained.push(key);
    }
    // 2) 연결 끊김
    const cut = { ...(this.state.cut ?? {}) };
    let cutChanged = false;
    for (const key of this.owned) {
      const { cx, cy } = parseChunkKey(key);
      if (
        this.isCore(cx, cy) ||
        this.isCapital(cx, cy) ||
        this.connected.has(key) ||
        this.state.annexed?.includes(key)
      ) {
        if (cut[key] !== undefined) {
          delete cut[key];
          cutChanged = true;
        }
        continue;
      }
      if (cut[key] === undefined) {
        cut[key] = now;
        cutChanged = true;
      } else if (now - cut[key] >= CUT_GRACE_MS) {
        delete cut[key];
        cutChanged = true;
        lost.push(key);
      }
    }
    for (const key of Object.keys(cut))
      if (!this.owned.has(key)) {
        delete cut[key];
        cutChanged = true;
      }
    for (const key of lost) this.owned.delete(key);
    // 3) 수도 이전 완료
    let moved = false;
    const m = this.state.move;
    if (m && now >= m.doneAt) {
      const { cx, cy } = parseChunkKey(m.to);
      const rect = { cx, cy, span: CAPITAL_SPANS[this.state.capitalLevel - 1] };
      delete this.state.move;
      if (this.allOwned(rect)) {
        this.state.capital = m.to;
        this.state.movedAt = now;
      }
      moved = true;
    }
    if (gained.length || lost.length || cutChanged || moved) {
      if (Object.keys(cut).length) this.state.cut = cut;
      else delete this.state.cut;
      this.state.owned = [...this.owned];
      if (gained.length) this.exploreAround(gained);
      this.revision++;
      this.changed();
      if (gained.length || lost.length) this.onChange?.(gained, lost);
    }
  }

  private exploreAround(keys: readonly string[]): void {
    for (const key of keys) {
      const { cx, cy } = parseChunkKey(key);
      for (let dy = -EXPLORE_RING; dy <= EXPLORE_RING; dy++)
        for (let dx = -EXPLORE_RING; dx <= EXPLORE_RING; dx++)
          if (!this.world.isExplored(cx + dx, cy + dy)) this.world.explore(cx + dx, cy + dy);
    }
  }

  /* ---------------- 연결 ---------------- */

  /** 수도 도로에서 도로·항구·공항·지하철 노선으로 닿는 청크. */
  computeConnected(): Set<string> {
    const world = this.world;
    const seen = new Set<number>();
    const reachedChunks = new Set<string>();
    const pack = (x: number, y: number) => (x + 1_048_576) * 2_097_152 + (y + 1_048_576);
    const queue: number[] = [];
    const push = (x: number, y: number) => {
      if (world.getBuild(x, y) !== Build.Road) return;
      const k = pack(x, y);
      if (seen.has(k)) return;
      seen.add(k);
      queue.push(x, y);
    };
    const flood = () => {
      while (queue.length) {
        const y = queue.pop()!;
        const x = queue.pop()!;
        reachedChunks.add(chunkKey(chunkIndexOf(x), chunkIndexOf(y)));
        for (const [nx, ny] of [
          [x + 1, y],
          [x - 1, y],
          [x, y + 1],
          [x, y - 1],
        ]) {
          if (!world.roadsConnected(x, y, nx, ny)) continue;
          const k = pack(nx, ny);
          if (seen.has(k)) continue;
          seen.add(k);
          queue.push(nx, ny);
        }
      }
    };
    // 수도 청크의 도로에서 시작한다.
    const cap = this.capitalRect();
    for (let cy = cap.cy; cy < cap.cy + cap.span; cy++)
      for (let cx = cap.cx; cx < cap.cx + cap.span; cx++) {
        const p = world.peekParcel(cx, cy);
        if (!p?.build) continue;
        for (let i = 0; i < p.build.length; i++)
          if (p.build[i] === Build.Road)
            push(cx * CHUNK_SIZE + (i % CHUNK_SIZE), cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE));
      }
    flood();

    // 항구·공항·지하철: 한 곳이라도 닿으면 같은 무리 전체가 닿는다.
    const hubs = this.hubs();
    const touches = (h: Hub) => {
      for (const [x, y] of edgeNeighbors(h.tx, h.ty, h.span)) if (seen.has(pack(x, y))) return true;
      return false;
    };
    const done = new Set<string>();
    for (let round = 0; round < 8; round++) {
      let grew = false;
      for (const [group, list] of hubs) {
        if (done.has(group) || !list.some(touches)) continue;
        done.add(group);
        for (const h of list) {
          reachedChunks.add(chunkKey(chunkIndexOf(h.tx), chunkIndexOf(h.ty)));
          for (const [x, y] of edgeNeighbors(h.tx, h.ty, h.span)) push(x, y);
        }
        grew = true;
      }
      if (!grew) break;
      flood();
    }
    return reachedChunks;
  }

  private hubs(): Map<string, Hub[]> {
    const out = new Map<string, Hub[]>();
    const add = (group: string, h: Hub) => {
      const list = out.get(group);
      if (list) list.push(h);
      else out.set(group, [h]);
    };
    const stationAt = new Map<string, Hub>();
    for (const p of this.world.developedParcels()) {
      if (!p.bld) continue;
      for (let i = 0; i < p.bld.length; i++) {
        const code = p.bld[i];
        if (!isFacilityAnchor(code)) continue;
        const kind = facilityKindOfCode(code);
        if (!HARBORS.has(kind) && !AIRPORTS.has(kind) && kind !== METRO_FACILITY) continue;
        const tx = p.cx * CHUNK_SIZE + (i % CHUNK_SIZE);
        const ty = p.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
        const hub = { tx, ty, span: facilitySpan(kind) };
        if (HARBORS.has(kind)) add('harbor', hub);
        else if (AIRPORTS.has(kind)) add('airport', hub);
        else if (kind === METRO_FACILITY) stationAt.set(`${tx},${ty}`, hub);
      }
    }
    const metro = this.macro.metro;
    if (metro?.lines && stationAt.size) {
      for (const line of metro.lines) {
        for (const stop of line.stops) {
          const surface = metro.stations[stop]?.surface;
          const h = stationAt.get(surface ? `${surface.x},${surface.y}` : stop);
          if (h) add(`metro:${line.id}`, h);
        }
      }
    }
    return out;
  }

  /* ---------------- 수도 ---------------- */

  private allOwned(r: Rect): boolean {
    for (let cy = r.cy; cy < r.cy + r.span; cy++)
      for (let cx = r.cx; cx < r.cx + r.span; cx++) if (!this.isOwned(cx, cy)) return false;
    return true;
  }

  /**
   * 다음 레벨 수도 자리. 지금 수도를 품고, 전부 내 땅인 자리 중 가장 가운데.
   * 못 찾으면 이유를 돌려준다.
   */
  expansionPlan(cityLevel: number): { rect?: Rect; reason: string } {
    const level = this.state.capitalLevel;
    if (level >= CAPITAL_SPANS.length) return { reason: '수도가 이미 최고 레벨입니다' };
    if (this.state.move) return { reason: '수도를 옮기는 중입니다' };
    const need = CAPITAL_CITY_LEVEL[level];
    if (cityLevel < need) return { reason: `도시 레벨 ${need}부터 수도를 넓힐 수 있습니다` };
    const span = CAPITAL_SPANS[level];
    const minLand = Math.ceil((span * span) / CAPITAL_MAX_SHARE);
    if (this.count < minLand)
      return {
        reason: `수도가 영토의 25%를 넘으면 안 됩니다 · 영토 ${minLand}청크 필요 (지금 ${this.count})`,
      };
    const cur = this.capitalRect();
    const ccx = cur.cx + cur.span / 2;
    const ccy = cur.cy + cur.span / 2;
    let best: Rect | undefined;
    let bestD = Infinity;
    for (let y = cur.cy + cur.span - span; y <= cur.cy; y++)
      for (let x = cur.cx + cur.span - span; x <= cur.cx; x++) {
        const r = { cx: x, cy: y, span };
        if (!this.allOwned(r)) continue;
        const d = Math.hypot(x + span / 2 - ccx, y + span / 2 - ccy);
        if (d < bestD) {
          bestD = d;
          best = r;
        }
      }
    if (!best)
      return { reason: `지금 수도를 둘러싼 ${span}×${span} 청크가 모두 내 영토여야 합니다` };
    return { rect: best, reason: '' };
  }

  expandCapital(cityLevel: number): string {
    const plan = this.expansionPlan(cityLevel);
    if (!plan.rect) return plan.reason;
    this.state.capitalLevel++;
    this.state.capital = chunkKey(plan.rect.cx, plan.rect.cy);
    this.revision++;
    this.changed();
    return '';
  }

  /** 청크 (cx,cy) 를 가운데로 하는 같은 크기의 수도 자리. */
  moveTarget(cx: number, cy: number): Rect {
    const span = CAPITAL_SPANS[this.state.capitalLevel - 1];
    return { cx: cx - (span / 2 - 1), cy: cy - (span / 2 - 1), span };
  }

  moveBlock(target: Rect, now = Date.now()): string {
    if (this.state.move) return '이미 수도를 옮기는 중입니다';
    const since = now - (this.state.movedAt ?? -Infinity);
    if (since < CAPITAL_MOVE_COOLDOWN_MS) {
      const h = Math.ceil((CAPITAL_MOVE_COOLDOWN_MS - since) / 3_600_000);
      return `수도 이전은 하루에 한 번 · ${h}시간 뒤에 다시 옮길 수 있습니다`;
    }
    const cur = this.capitalRect();
    if (cur.cx === target.cx && cur.cy === target.cy) return '지금 수도 자리입니다';
    if (!this.allOwned(target)) return '새 수도 자리는 모두 내 영토여야 합니다';
    for (let cy = target.cy; cy < target.cy + target.span; cy++)
      for (let cx = target.cx; cx < target.cx + target.span; cx++)
        if (!this.isCore(cx, cy) && !this.connected.has(chunkKey(cx, cy)))
          return '새 수도 자리가 지금 수도와 길로 이어져 있지 않습니다';
    return '';
  }

  startMove(target: Rect, now = Date.now()): string {
    const block = this.moveBlock(target, now);
    if (block) return block;
    this.state.move = { to: chunkKey(target.cx, target.cy), doneAt: now + CAPITAL_MOVE_MS };
    this.revision++;
    this.changed();
    return '';
  }

  cancelMove(): void {
    if (!this.state.move) return;
    delete this.state.move;
    this.revision++;
    this.changed();
  }

  get moveCooldownLeftMs(): number {
    return Math.max(0, (this.state.movedAt ?? -Infinity) + CAPITAL_MOVE_COOLDOWN_MS - Date.now());
  }

  isCeded(key: string): boolean {
    return !!this.state.ceded?.includes(key);
  }

  /** 전쟁에서 진 땅을 내준다(수도는 소규모 전쟁에서 보호되므로 들어오지 않는다). */
  cede(keys: readonly string[]): void {
    if (!keys.length) return;
    const ceded = new Set(this.state.ceded ?? []);
    for (const k of keys) {
      ceded.add(k);
      this.owned.delete(k);
      if (this.state.annexed) this.state.annexed = this.state.annexed.filter((x) => x !== k);
    }
    this.state.ceded = [...ceded];
    this.state.owned = [...this.owned];
    this.revision++;
    this.changed();
  }

  /** 전쟁에서 얻은 땅을 영토에 더한다. */
  annex(keys: readonly string[]): void {
    if (!keys.length) return;
    const annexed = new Set(this.state.annexed ?? []);
    for (const k of keys) {
      annexed.add(k);
      this.owned.add(k);
    }
    if (this.state.ceded) this.state.ceded = this.state.ceded.filter((k) => !annexed.has(k));
    this.state.annexed = [...annexed];
    this.state.owned = [...this.owned];
    this.exploreAround([...keys]);
    this.revision++;
    this.changed();
  }

  /** 관리자 초기화·점검용: 시작 상태로 되돌린다. */
  reset(): void {
    this.macro.territory = emptyTerritory(this.world.baseCx, this.world.baseCy);
    this.owned = new Set(this.macro.territory.owned);
    this.connected.clear();
    this.connectStamp = '';
    this.revision++;
  }
}

interface Hub {
  tx: number;
  ty: number;
  span: number;
}

/** 청크 안 칸 좌표. 점검 도구에서 쓴다. */
export function chunkOfTile(tx: number, ty: number): { cx: number; cy: number; i: number } {
  return {
    cx: chunkIndexOf(tx),
    cy: chunkIndexOf(ty),
    i: localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx),
  };
}
