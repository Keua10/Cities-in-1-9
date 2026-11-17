import { chunkKey, parseChunkKey } from '../../core/iso';
import {
  AMBUSH_BONUS,
  AMBUSH_SECONDS,
  MATCHUP_STRONG,
  MATCHUP_WEAK,
  MEN_LOSS_PER_DAMAGE,
  OCCUPY_SECONDS,
  ORG_LOSS_PER_DAMAGE,
  ORG_MAX,
  ORG_REGEN_PER_SEC,
  UNIT_SPECS,
  UNSUPPLIED_MORALE_DECAY,
  UNSUPPLIED_ORG_DECAY,
  type UnitType,
} from '../config/military';
import { attackFactor, chunkTerrain, defenseFactor, moveFactor } from './terrain';

/**
 * 부대·이동·전투·점령 (군사 4단계). 화면·네트워크와 무관한 순수 계산.
 *
 * 전쟁 중에는 양쪽 기기가 **자기 부대만** 움직이고, 자기 부대가 받는 피해만 계산한다.
 * 상대 부대는 상대가 보내 준 마지막 모습(스냅숏)으로 본다. 공식이 양쪽에 똑같으므로
 * 결과가 맞는다(조금 늦을 뿐). 무작위 대신 (초, 부대 id) 해시를 써서 기기마다 같은 값이 나온다.
 */

export type UnitState = 'training' | 'idle' | 'moving' | 'fighting' | 'retreating';

export interface Unit {
  id: string;
  type: UnitType;
  men: number;
  maxMen: number;
  /** 조직력 0~100. 0 이 되면 후퇴. */
  org: number;
  /** 사기 0.3~1. */
  morale: number;
  exp: number;
  /** 지금 있는 청크. */
  cx: number;
  cy: number;
  /** 다음 청크로 가는 진행 0~1. */
  progress: number;
  /** 남은 길(청크 키). 첫 칸이 다음 청크. */
  path: string[];
  state: UnitState;
  /** 훈련이 끝나는 실제 시각. */
  readyAt?: number;
  /** 점령 중인 청크와 시작 시각. */
  occupyKey?: string;
  occupyAt?: number;
  /** 이 청크에서 전투가 시작된 시각(매복 판정). */
  engagedAt?: number;
  /** 이 청크에 처음 들어온(또는 멈춘) 시각. */
  arrivedAt?: number;
  /** 이 부대를 뽑은 청크별 인원(죽거나 해산하면 돌려준다). */
  source: Record<string, number>;
}

export interface ArmyState {
  units: Unit[];
  nextId: number;
  /** 청크별로 군대에 가 있는 인원. 그만큼 그 청크 거주·일자리가 준다. */
  drafted: Record<string, number>;
  /** 지금까지 잃은 병력의 가치(생산비 기준, 누적). 전쟁 점수 계산에 쓴다. */
  lossValue?: number;
}

export function emptyArmy(): ArmyState {
  return { units: [], nextId: 1, drafted: {} };
}

export function normalizeArmy(raw: unknown): ArmyState {
  const a = raw as Partial<ArmyState> | undefined;
  if (!a || !Array.isArray(a.units)) return emptyArmy();
  const units = a.units.filter(
    (u): u is Unit => !!u && typeof u.id === 'string' && !!UNIT_SPECS[u.type as UnitType],
  );
  for (const u of units) {
    u.path = Array.isArray(u.path) ? u.path.filter((k) => typeof k === 'string') : [];
    u.source = u.source && typeof u.source === 'object' ? u.source : {};
    u.progress = Math.max(0, Math.min(1, Number(u.progress) || 0));
  }
  return {
    units,
    nextId: Math.max(1, Number(a.nextId) || 1),
    drafted: a.drafted && typeof a.drafted === 'object' ? { ...a.drafted } : {},
    lossValue: Number(a.lossValue) || 0,
  };
}

/** 그리기용 위치(청크 좌표, 가운데 = +0.5). */
export function unitPosition(u: Unit): { x: number; y: number } {
  if (u.path.length && u.progress > 0) {
    const n = parseChunkKey(u.path[0]);
    return {
      x: u.cx + 0.5 + (n.cx - u.cx) * u.progress,
      y: u.cy + 0.5 + (n.cy - u.cy) * u.progress,
    };
  }
  return { x: u.cx + 0.5, y: u.cy + 0.5 };
}

/* ---------------- 전장 ---------------- */

export interface Side {
  uid: string;
  units: Unit[];
  /** 원래 영토. */
  owned: Set<string>;
  /** 수도 청크들. */
  capital: Set<string>;
  /** 참호·벙커가 있는 청크. */
  trenches: Set<string>;
  /** 건물이 빽빽한 청크(시가전). */
  urban: Set<string>;
}

export interface Battlefield {
  now: number;
  me: Side;
  /** 상대(전쟁 중이 아니면 null). */
  enemy: Side | null;
  /** 전쟁 중 점령: 청크 → 점령한 쪽 uid. */
  occupied: Map<string, string>;
  /** 소규모 전쟁이면 수도를 점령할 수 없다. */
  capitalProtected: boolean;
  /** 평시에 들어갈 수 없는 남의 영토. */
  foreign: (key: string) => boolean;
}

export type BattleEvent =
  | { type: 'occupied'; key: string }
  | { type: 'retreat'; unit: string }
  | { type: 'destroyed'; unit: string; why: 'encircled' | 'casualties' }
  | { type: 'engaged'; key: string }
  | { type: 'trained'; unit: string };

/** 전쟁 중 이 청크의 실제 주인 uid(없으면 ''). */
export function ownerOf(bf: Battlefield, key: string): string {
  const occ = bf.occupied.get(key);
  if (occ) return occ;
  if (bf.me.owned.has(key)) return bf.me.uid;
  if (bf.enemy?.owned.has(key)) return bf.enemy.uid;
  return '';
}

function isUrban(bf: Battlefield, key: string): boolean {
  return bf.me.urban.has(key) || !!bf.enemy?.urban.has(key);
}

/** 결정론 난수 0.9~1.1. */
function jitter(sec: number, id: string): number {
  let h = sec | 0;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return 0.9 + (((h ^ (h >>> 13)) >>> 0) / 4294967296) * 0.2;
}

function matchup(attacker: UnitType, targets: Unit[]): number {
  if (!targets.length) return 1;
  const spec = UNIT_SPECS[attacker];
  let sum = 0;
  let men = 0;
  for (const t of targets) {
    const w = Math.max(1, t.men);
    const m = spec.strongVs.includes(t.type)
      ? MATCHUP_STRONG
      : spec.weakVs.includes(t.type)
        ? MATCHUP_WEAK
        : 1;
    sum += m * w;
    men += w;
  }
  return sum / men;
}

/* ---------------- 길 찾기 ---------------- */

/**
 * 청크 길(A*). 산·큰 강은 비싸게(돌아가게), 바다는 못 지나간다. 남의 영토는 전쟁 상대만.
 * 길이 없으면 빈 배열.
 */
export function findPath(
  from: { cx: number; cy: number },
  to: { cx: number; cy: number },
  type: UnitType,
  bf: Battlefield,
  limit = 6_000,
): string[] {
  const spec = UNIT_SPECS[type];
  const goal = chunkKey(to.cx, to.cy);
  const start = chunkKey(from.cx, from.cy);
  if (goal === start) return [];
  const pass = (key: string, cx: number, cy: number): number => {
    if (bf.foreign(key) && !(bf.enemy && bf.enemy.owned.has(key))) return 0;
    return moveFactor(chunkTerrain(cx, cy), type, isUrban(bf, key), spec.mountains);
  };
  if (pass(goal, to.cx, to.cy) <= 0) return [];
  const g = new Map<string, number>([[start, 0]]);
  const prev = new Map<string, string>();
  const open: Array<{ key: string; cx: number; cy: number; f: number }> = [
    { key: start, cx: from.cx, cy: from.cy, f: 0 },
  ];
  const h = (cx: number, cy: number) => Math.hypot(cx - to.cx, cy - to.cy);
  let visited = 0;
  while (open.length && visited++ < limit) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (cur.key === goal) break;
    const gc = g.get(cur.key)!;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cur.cx + dx;
        const ny = cur.cy + dy;
        const nk = chunkKey(nx, ny);
        const f = pass(nk, nx, ny);
        if (f <= 0) continue;
        // 대각선은 양옆 중 하나라도 막혀 있으면 못 간다(바다 모서리 뚫기 방지).
        if (
          dx &&
          dy &&
          (pass(chunkKey(cur.cx + dx, cur.cy), cur.cx + dx, cur.cy) <= 0 ||
            pass(chunkKey(cur.cx, cur.cy + dy), cur.cx, cur.cy + dy) <= 0)
        )
          continue;
        const cost = gc + (dx && dy ? Math.SQRT2 : 1) / f;
        if (cost >= (g.get(nk) ?? Infinity)) continue;
        g.set(nk, cost);
        prev.set(nk, cur.key);
        open.push({ key: nk, cx: nx, cy: ny, f: cost + h(nx, ny) });
      }
  }
  if (!prev.has(goal)) return [];
  const path: string[] = [];
  for (let k = goal; k !== start; k = prev.get(k)!) path.push(k);
  return path.reverse();
}

/* ---------------- 한 걸음 ---------------- */

/**
 * 내 부대를 dtMs 만큼 움직이고, 적에게 받는 피해를 계산한다. bf.enemy.units 는 읽기만 한다.
 * bf.occupied 는 내가 점령한 청크만 고친다(상대 점령은 상대가 보낸다).
 */
export function stepArmy(army: ArmyState, bf: Battlefield, dtMs: number): BattleEvent[] {
  const events: BattleEvent[] = [];
  if (!(dtMs > 0)) return events;
  const dt = Math.min(dtMs, 5_000) / 1000;
  const enemy = bf.enemy;
  const enemyAt = new Map<string, Unit[]>();
  if (enemy)
    for (const e of enemy.units) {
      if (e.state === 'training' || e.men <= 0) continue;
      const k = chunkKey(e.cx, e.cy);
      const list = enemyAt.get(k);
      if (list) list.push(e);
      else enemyAt.set(k, [e]);
    }

  // 1) 훈련·이동
  for (const u of army.units) {
    if (u.state === 'training') {
      if (u.readyAt !== undefined && bf.now >= u.readyAt) {
        u.state = 'idle';
        u.arrivedAt = bf.now;
        events.push({ type: 'trained', unit: u.id });
      }
      continue;
    }
    const here = chunkKey(u.cx, u.cy);
    const foes = enemyAt.get(here);
    if (foes?.length && u.state !== 'retreating') {
      if (u.state !== 'fighting') {
        u.state = 'fighting';
        u.engagedAt = bf.now;
        events.push({ type: 'engaged', key: here });
      }
      continue; // 싸우는 동안은 움직이지 않는다(후퇴 명령만).
    }
    if (u.state === 'fighting') u.state = u.path.length ? 'moving' : 'idle';
    if (!u.path.length) {
      if (u.state === 'moving' || u.state === 'retreating') u.state = 'idle';
      continue;
    }
    const next = parseChunkKey(u.path[0]);
    const spec = UNIT_SPECS[u.type];
    const f = moveFactor(
      chunkTerrain(next.cx, next.cy),
      u.type,
      isUrban(bf, u.path[0]),
      spec.mountains,
    );
    if (f <= 0) {
      u.path = [];
      u.state = 'idle';
      continue;
    }
    u.progress += ((spec.speed * f) / 60) * dt;
    if (u.progress >= 1) {
      u.cx = next.cx;
      u.cy = next.cy;
      u.path.shift();
      u.progress = 0;
      u.arrivedAt = bf.now;
      delete u.occupyKey;
      delete u.occupyAt;
      if (!u.path.length && u.state !== 'retreating') u.state = 'idle';
      if (u.state === 'retreating' && !u.path.length) u.state = 'idle';
    }
  }

  // 2) 전투: 내 부대가 받는 피해
  if (enemy) {
    const sec = Math.floor(bf.now / 1000);
    const mineAt = new Map<string, Unit[]>();
    for (const u of army.units)
      if (u.state !== 'training') {
        const k = chunkKey(u.cx, u.cy);
        const list = mineAt.get(k);
        if (list) list.push(u);
        else mineAt.set(k, [u]);
      }
    for (const [key, mine] of mineAt) {
      const { cx, cy } = parseChunkKey(key);
      const foes = enemyAt.get(key) ?? [];
      // 포병은 이웃 청크에서도 지원 사격한다.
      const support: Unit[] = [];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          for (const e of enemyAt.get(chunkKey(cx + dx, cy + dy)) ?? [])
            if (e.type === 'artillery') support.push(e);
        }
      if (!foes.length && !(support.length && mine.some((u) => u.state === 'fighting'))) continue;
      const t = chunkTerrain(cx, cy);
      const urban = isUrban(bf, key);
      const defenderIsEnemy = ownerOf(bf, key) === enemy.uid;
      let incoming = 0;
      for (const e of [...foes, ...support]) {
        const es = UNIT_SPECS[e.type];
        // 이웃 청크에서 쏘는 포병만 "높은 곳에서 아래로" 보너스를 따진다.
        const from = e.cx === cx && e.cy === cy ? null : chunkTerrain(e.cx, e.cy);
        let a =
          es.attack *
          (e.men / Math.max(1, es.men || 1)) *
          Math.max(0.3, e.morale) *
          attackFactor(t, e.type, urban, from) *
          matchup(e.type, mine) *
          jitter(sec, e.id);
        // 매복: 골짜기에서 먼저 자리 잡고 있던 적이 처음 30초 +50%.
        const engaged = mine[0].engagedAt ?? bf.now;
        if (
          t.valley &&
          defenderIsEnemy &&
          (e.arrivedAt ?? 0) + 60_000 <= engaged &&
          bf.now - engaged < AMBUSH_SECONDS * 1000
        )
          a *= 1 + AMBUSH_BONUS;
        incoming += a;
      }
      const totalMen = mine.reduce((s, u) => s + Math.max(1, u.men), 0);
      for (const u of mine) {
        const us = UNIT_SPECS[u.type];
        const share = Math.max(1, u.men) / totalMen;
        const def =
          (us.defense / 10) *
          defenseFactor(
            t,
            u.type,
            urban,
            bf.me.trenches.has(key) && ownerOf(bf, key) === bf.me.uid,
          );
        const d = (incoming * share * dt) / Math.max(0.2, def);
        u.org = Math.max(0, u.org - d * ORG_LOSS_PER_DAMAGE);
        const lost = Math.min(u.men, d * MEN_LOSS_PER_DAMAGE);
        if (lost > 0) loseMen(army, u, lost);
        if (u.state !== 'fighting' && foes.length) {
          u.state = 'fighting';
          u.engagedAt = bf.now;
        }
      }
    }
  }

  // 3) 조직력 0 → 후퇴(갈 곳 없으면 포위 전멸), 병력 바닥 → 전멸
  for (const u of [...army.units]) {
    if (u.state === 'training') continue;
    if (u.men < 30) {
      removeUnit(army, u.id, false);
      events.push({ type: 'destroyed', unit: u.id, why: 'casualties' });
      continue;
    }
    if (u.org <= 0 && u.state !== 'retreating') {
      const path = retreatPath(u, bf, enemyAt);
      if (!path) {
        removeUnit(army, u.id, false);
        events.push({ type: 'destroyed', unit: u.id, why: 'encircled' });
        continue;
      }
      u.path = path;
      u.progress = 0;
      u.state = 'retreating';
      events.push({ type: 'retreat', unit: u.id });
    }
  }

  // 4) 보급·회복·점령
  for (const u of army.units) {
    if (u.state === 'training') continue;
    const key = chunkKey(u.cx, u.cy);
    const owner = ownerOf(bf, key);
    const supplied = isSupplied(u, bf);
    if (owner === bf.me.uid && u.state !== 'fighting') {
      u.org = Math.min(ORG_MAX, u.org + ORG_REGEN_PER_SEC * dt);
      u.morale = Math.min(1, u.morale + 0.01 * dt);
    } else if (!supplied) {
      u.org = Math.max(0, u.org - UNSUPPLIED_ORG_DECAY * dt);
      u.morale = Math.max(0.3, u.morale - UNSUPPLIED_MORALE_DECAY * dt);
    }
    // 점령: 적 땅(또는 적이 점령한 내 땅), 적 부대 없음, 멈춰 있음, 60초.
    if (
      enemy &&
      owner === enemy.uid &&
      (u.state === 'idle' || u.state === 'moving') &&
      !u.path.length &&
      !enemyAt.get(key)?.length &&
      !(bf.capitalProtected && enemy.capital.has(key))
    ) {
      if (u.occupyKey !== key) {
        u.occupyKey = key;
        u.occupyAt = bf.now;
      } else if (bf.now - (u.occupyAt ?? bf.now) >= OCCUPY_SECONDS * 1000) {
        if (bf.me.owned.has(key)) bf.occupied.delete(key);
        else bf.occupied.set(key, bf.me.uid);
        delete u.occupyKey;
        delete u.occupyAt;
        events.push({ type: 'occupied', key });
      }
    } else if (u.occupyKey) {
      delete u.occupyKey;
      delete u.occupyAt;
    }
  }
  return events;
}

/** 내 땅(또는 내가 점령한 땅)에서 3청크 안이면 보급된다. */
function isSupplied(u: Unit, bf: Battlefield): boolean {
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++)
      if (ownerOf(bf, chunkKey(u.cx + dx, u.cy + dy)) === bf.me.uid) return true;
  return false;
}

/** 가장 가까운 안전한 내 땅으로 가는 길. 둘레가 다 막혀 있으면 null(포위). */
function retreatPath(u: Unit, bf: Battlefield, enemyAt: Map<string, Unit[]>): string[] | null {
  const spec = UNIT_SPECS[u.type];
  const start = chunkKey(u.cx, u.cy);
  const queue: Array<{ cx: number; cy: number; path: string[] }> = [
    { cx: u.cx, cy: u.cy, path: [] },
  ];
  const seen = new Set([start]);
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur.path.length > 8) break;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cur.cx + dx;
        const ny = cur.cy + dy;
        const nk = chunkKey(nx, ny);
        if (seen.has(nk)) continue;
        seen.add(nk);
        if (enemyAt.get(nk)?.length) continue;
        const f = moveFactor(chunkTerrain(nx, ny), u.type, isUrban(bf, nk), spec.mountains);
        if (f <= 0) continue;
        const owner = ownerOf(bf, nk);
        if (bf.enemy && owner === bf.enemy.uid) continue;
        const path = [...cur.path, nk];
        if (owner === bf.me.uid) return path;
        queue.push({ cx: nx, cy: ny, path });
      }
  }
  return null;
}

/* ---------------- 인원 ---------------- */

/** 전사자: 뽑은 청크들에서 비율대로 뺀다(그만큼 그 청크 인구가 다시 찬다). */
function loseMen(army: ArmyState, u: Unit, lost: number): void {
  const total = Object.values(u.source).reduce((a, b) => a + b, 0) || 1;
  for (const [key, n] of Object.entries(u.source)) {
    const take = (lost * n) / total;
    u.source[key] = Math.max(0, n - take);
    army.drafted[key] = Math.max(0, (army.drafted[key] ?? 0) - take);
    if (army.drafted[key] < 0.5) delete army.drafted[key];
  }
  u.men = Math.max(0, u.men - lost);
  const spec = UNIT_SPECS[u.type];
  army.lossValue = (army.lossValue ?? 0) + (spec.cost * lost) / (spec.men || 1);
}

/** 부대를 없앤다. 해산(disband)이면 남은 인원이 인구로 돌아간다(drafted 에서 빠짐). */
export function removeUnit(army: ArmyState, id: string, disband: boolean): void {
  const u = army.units.find((x) => x.id === id);
  if (!u) return;
  // 전멸이든 해산이든 drafted 에서 빠진다. 전멸은 남은 인원까지 잃은 것이다.
  if (!disband) {
    const spec = UNIT_SPECS[u.type];
    army.lossValue = (army.lossValue ?? 0) + (spec.cost * u.men) / (spec.men || 1);
  }
  for (const [key, n] of Object.entries(u.source)) {
    army.drafted[key] = Math.max(0, (army.drafted[key] ?? 0) - n);
    if (army.drafted[key] < 0.5) delete army.drafted[key];
  }
  army.units = army.units.filter((x) => x !== u);
}

/**
 * 징병: 청크마다 (거주 인구 × 20%) − 이미 뽑은 수 만큼 뽑을 수 있다. 많이 남은 청크부터.
 * 모자라면 null.
 */
export function draftMen(
  army: ArmyState,
  residents: ReadonlyMap<string, number>,
  need: number,
  share: number,
): Record<string, number> | null {
  const room: Array<[string, number]> = [];
  let total = 0;
  for (const [key, r] of residents) {
    const free = Math.floor(r * share - (army.drafted[key] ?? 0));
    if (free > 0) {
      room.push([key, free]);
      total += free;
    }
  }
  if (total < need) return null;
  room.sort((a, b) => b[1] - a[1]);
  const out: Record<string, number> = {};
  let left = need;
  for (const [key, free] of room) {
    const take = Math.min(free, left);
    out[key] = take;
    left -= take;
    if (left <= 0) break;
  }
  for (const [key, n] of Object.entries(out)) army.drafted[key] = (army.drafted[key] ?? 0) + n;
  return out;
}

/** 징병 가능한 총인원. */
export function draftRoom(
  army: ArmyState,
  residents: ReadonlyMap<string, number>,
  share: number,
): number {
  let total = 0;
  for (const [key, r] of residents)
    total += Math.max(0, Math.floor(r * share - (army.drafted[key] ?? 0)));
  return total;
}

export function newUnit(
  army: ArmyState,
  type: UnitType,
  at: { cx: number; cy: number },
  source: Record<string, number>,
  now: number,
): Unit {
  const spec = UNIT_SPECS[type];
  const men = spec.men || 1;
  const u: Unit = {
    id: `u${army.nextId++}`,
    type,
    men,
    maxMen: men,
    org: ORG_MAX,
    morale: 1,
    exp: 0,
    cx: at.cx,
    cy: at.cy,
    progress: 0,
    path: [],
    state: 'training',
    readyAt: now + spec.buildSec * 1000,
    source,
  };
  army.units.push(u);
  return u;
}
