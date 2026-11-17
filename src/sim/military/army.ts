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
  AIR_RANGE_CHUNKS,
  BOMB_INTERVAL_MS,
  HOSPITAL_REGEN_MUL,
  POLICE_URBAN_DEFENSE,
  DESTROYED_SHARE,
  EMBARKED_MOVE,
  FIGHTER_VS_SURFACE,
  SHORE_BOMBARD,
  unitStrength,
  type UnitDomain,
  type UnitType,
} from '../config/military';
import { attackFactor, chunkTerrain, defenseFactor, moveFactor } from './terrain';
import { weatherAir, weatherMove } from './weather';

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
  /** 공중 수송 중(공항 → 내 땅). 이동 중에는 지도에 비행기로만 보이고 싸우지 않는다. */
  airlift?: { from: string; to: string; departAt: number; arriveAt: number };
  /** 폭격기: 마지막으로 폭탄을 떨어뜨린 시각. */
  bombAt?: number;
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
  /** 내보낸 폭격·미사일(최근 15분). 전쟁 상대가 받아서 처리한다. */
  strikes?: Strike[];
  /** 받은 타격 중 처리를 마친 id → 시각. */
  struckBy?: Record<string, number>;
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
    if (u.airlift && (typeof u.airlift.to !== 'string' || !Number.isFinite(u.airlift.arriveAt)))
      delete u.airlift;
  }
  return {
    units,
    nextId: Math.max(1, Number(a.nextId) || 1),
    drafted: a.drafted && typeof a.drafted === 'object' ? { ...a.drafted } : {},
    lossValue: Number(a.lossValue) || 0,
    ...(Array.isArray(a.strikes) ? { strikes: a.strikes } : {}),
    ...(a.struckBy && typeof a.struckBy === 'object' ? { struckBy: { ...a.struckBy } } : {}),
  };
}

/** 그리기용 위치(청크 좌표, 가운데 = +0.5). */
export function unitPosition(u: Unit, now = Date.now()): { x: number; y: number } {
  if (u.airlift) {
    const a = parseChunkKey(u.airlift.from);
    const b = parseChunkKey(u.airlift.to);
    const span = Math.max(1, u.airlift.arriveAt - u.airlift.departAt);
    const f = Math.max(0, Math.min(1, (now - u.airlift.departAt) / span));
    return { x: a.cx + 0.5 + (b.cx - a.cx) * f, y: a.cy + 0.5 + (b.cy - a.cy) * f };
  }
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
  /** 해군 기지가 있어 땅 부대가 배로 바다를 건널 수 있다. */
  canSail?: boolean;
  /** 병원 둘레(2청크): 부대 회복 2배. */
  hospitals?: Set<string>;
  /** 경찰서가 있는 청크: 시가전 방어 +10%. */
  police?: Set<string>;
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
  | { type: 'trained'; unit: string }
  | { type: 'strike'; key: string; kind: 'bomb' | 'missile'; from?: string }
  | {
      type: 'struck';
      key: string;
      kind: 'bomb' | 'missile';
      intercepted: boolean;
      destroyed: string[];
    }
  | { type: 'airRaid'; key: string }
  | { type: 'landed'; unit: string; key: string };

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
 * 이 청크를 지나가는 이동 배율(0 = 못 감). 공군은 어디든 1, 군함은 바다·큰 강만,
 * 땅 부대는 지형대로 — 해군 기지가 있으면 배를 타고 바다를 건넌다(느림).
 * retreat = 후퇴(바다 건너 후퇴는 하지 않는다).
 */
export function passFactor(
  bf: Battlefield,
  type: UnitType,
  key: string,
  cx: number,
  cy: number,
  retreat = false,
): number {
  const spec = UNIT_SPECS[type];
  const t = chunkTerrain(cx, cy);
  switch (spec.domain) {
    case 'air':
      return 1;
    case 'sea':
      return t.kind === 'sea' ? 1 : t.kind === 'bigRiver' ? 0.6 : 0;
    case 'strike':
      return 0;
  }
  const f = moveFactor(t, type, isUrban(bf, key), spec.mountains);
  if (f <= 0 && t.kind === 'sea' && bf.me.canSail && !retreat) return EMBARKED_MOVE;
  return f;
}

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
    if (bf.foreign(key) && !bf.me.owned.has(key) && !(bf.enemy && bf.enemy.owned.has(key)))
      return 0;
    return passFactor(bf, type, key, cx, cy);
  };
  if (spec.domain === 'strike') return [];
  if (pass(goal, to.cx, to.cy) <= 0) return [];
  // 공군은 내 땅에서 12청크 안까지만.
  if (spec.domain === 'air' && !nearMine(bf, to.cx, to.cy, AIR_RANGE_CHUNKS)) return [];
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

/** 부대가 땅·하늘·바다 어디에 있는가(땅 부대가 배를 타고 바다 위면 'sea'). */
export function unitDomainAt(u: Unit): UnitDomain {
  const d = UNIT_SPECS[u.type].domain;
  if (d === 'ground' && chunkTerrain(u.cx, u.cy).kind === 'sea') return 'sea';
  return d;
}

/** 같은 청크에 있으면 서로 길을 막고 붙잡는가(땅끼리·바다 위 군함끼리). */
function blocks(me: Unit, foe: Unit): boolean {
  const a = UNIT_SPECS[me.type].domain;
  const b = UNIT_SPECS[foe.type].domain;
  if (a === 'ground' && b === 'ground') return unitDomainAt(me) === 'ground';
  return a === 'sea' && b === 'sea';
}

/**
 * 공격 배율: attacker 가 dist(0 = 같은 청크, 1 = 이웃) 떨어진 targetDomain 부대를 칠 수 있으면
 * 배율, 못 치면 0.
 */
export function hitFactor(attacker: Unit, targetDomain: UnitDomain, dist: 0 | 1): number {
  const type = attacker.type;
  const dom = UNIT_SPECS[type].domain;
  if (dom === 'strike' || targetDomain === 'strike') return 0;
  if (dom === 'ground') {
    if (unitDomainAt(attacker) === 'sea') return 0; // 배에 탄 땅 부대는 싸우지 못한다
    if (type === 'aa')
      return targetDomain === 'air' ? 1 : dist === 0 && targetDomain === 'ground' ? 1 : 0;
    if (type === 'artillery')
      return dist === 0 ? (targetDomain === 'ground' ? 1 : 0) : targetDomain === 'air' ? 0 : 1;
    return dist === 0 && targetDomain === 'ground' ? 1 : 0;
  }
  if (dom === 'air') {
    if (dist !== 0) return 0;
    if (type === 'fighter') return targetDomain === 'air' ? 1 : FIGHTER_VS_SURFACE;
    return targetDomain === 'air' ? 0 : 1; // 폭격기
  }
  // 군함
  if (dist === 0) return targetDomain === 'sea' ? 1 : 0;
  return targetDomain === 'ground' ? SHORE_BOMBARD : 0;
}

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
      if (e.state === 'training' || e.men <= 0 || UNIT_SPECS[e.type].domain === 'strike') continue;
      const k = chunkKey(e.cx, e.cy);
      const list = enemyAt.get(k);
      if (list) list.push(e);
      else enemyAt.set(k, [e]);
    }
  const blockersAt = (u: Unit, key: string) => (enemyAt.get(key) ?? []).filter((e) => blocks(u, e));

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
    if (UNIT_SPECS[u.type].domain === 'strike') continue;
    if (u.airlift) {
      if (bf.now >= u.airlift.arriveAt) {
        const to = parseChunkKey(u.airlift.to);
        u.cx = to.cx;
        u.cy = to.cy;
        delete u.airlift;
        u.state = 'idle';
        u.arrivedAt = bf.now;
        events.push({ type: 'landed', unit: u.id, key: chunkKey(u.cx, u.cy) });
      }
      continue;
    }
    const here = chunkKey(u.cx, u.cy);
    const foes = blockersAt(u, here);
    if (foes.length && u.state !== 'retreating') {
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
    const f = passFactor(bf, u.type, u.path[0], next.cx, next.cy);
    if (f <= 0) {
      u.path = [];
      u.state = 'idle';
      continue;
    }
    // 비·눈은 땅 부대를 느리게 한다(밤낮·날씨는 공유 시계로 두 기기가 같다).
    const wet = spec.domain === 'ground' ? weatherMove(bf.now, next.cx, next.cy) : 1;
    u.progress += ((spec.speed * f * wet) / 60) * dt;
    if (u.progress >= 1) {
      u.cx = next.cx;
      u.cy = next.cy;
      u.path.shift();
      u.progress = 0;
      u.arrivedAt = bf.now;
      delete u.occupyKey;
      delete u.occupyAt;
      if (!u.path.length) u.state = 'idle';
    }
  }

  // 2) 전투: 내 부대가 받는 피해(같은 청크·같은 영역끼리 묶어서 나눠 받는다)
  if (enemy) {
    const sec = Math.floor(bf.now / 1000);
    const groups = new Map<string, Unit[]>();
    for (const u of army.units) {
      if (u.state === 'training' || u.airlift || UNIT_SPECS[u.type].domain === 'strike') continue;
      const g = `${u.cx},${u.cy}|${unitDomainAt(u)}`;
      const list = groups.get(g);
      if (list) list.push(u);
      else groups.set(g, [u]);
    }
    for (const [g, mine] of groups) {
      const [key, dom] = g.split('|') as [string, UnitDomain];
      const { cx, cy } = parseChunkKey(key);
      const attackers: Array<{ e: Unit; f: number; near: boolean }> = [];
      for (const e of enemyAt.get(key) ?? []) {
        const f = hitFactor(e, dom, 0);
        if (f > 0) attackers.push({ e, f, near: false });
      }
      const engaged = mine.some((u) => u.state === 'fighting') || attackers.length > 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          for (const e of enemyAt.get(chunkKey(cx + dx, cy + dy)) ?? []) {
            // 포병 지원은 교전 중인 청크에만, 대공·함포는 늘.
            if (e.type === 'artillery' && dom === 'ground' && !engaged) continue;
            const f = hitFactor(e, dom, 1);
            if (f > 0) attackers.push({ e, f, near: true });
          }
        }
      if (!attackers.length) continue;
      const t = chunkTerrain(cx, cy);
      const urban = isUrban(bf, key);
      const defenderIsEnemy = ownerOf(bf, key) === enemy.uid;
      let incoming = 0;
      for (const { e, f, near } of attackers) {
        const es = UNIT_SPECS[e.type];
        const surface = es.domain === 'ground';
        // 이웃 청크에서 쏘는 땅 부대만 "높은 곳에서 아래로" 보너스를 따진다.
        const from = near && surface ? chunkTerrain(e.cx, e.cy) : null;
        let a =
          es.attack *
          f *
          (e.men / unitStrength(e.type)) *
          Math.max(0.3, e.morale) *
          (surface ? attackFactor(t, e.type, urban, from) : 1) *
          matchup(e.type, mine) *
          (es.domain === 'air' ? weatherAir(bf.now, e.cx, e.cy) : 1) *
          jitter(sec, e.id);
        // 매복: 골짜기에서 먼저 자리 잡고 있던 적이 처음 30초 +50%.
        const eng = mine[0].engagedAt ?? bf.now;
        if (
          dom === 'ground' &&
          surface &&
          t.valley &&
          defenderIsEnemy &&
          (e.arrivedAt ?? 0) + 60_000 <= eng &&
          bf.now - eng < AMBUSH_SECONDS * 1000
        )
          a *= 1 + AMBUSH_BONUS;
        incoming += a;
      }
      const total = mine.reduce((s, u) => s + Math.max(1, u.men / unitStrength(u.type)), 0);
      const blocking = (enemyAt.get(key) ?? []).filter((e) => blocks(mine[0], e)).length > 0;
      for (const u of mine) {
        const us = UNIT_SPECS[u.type];
        const share = Math.max(1, u.men / unitStrength(u.type)) / total;
        const def =
          (us.defense / 10) *
          (urban && bf.me.police?.has(key) ? 1 + POLICE_URBAN_DEFENSE : 1) *
          (dom === 'ground'
            ? defenseFactor(
                t,
                u.type,
                urban,
                bf.me.trenches.has(key) && ownerOf(bf, key) === bf.me.uid,
              )
            : 1);
        const d = (incoming * share * dt) / Math.max(0.2, def);
        u.org = Math.max(0, u.org - d * ORG_LOSS_PER_DAMAGE);
        // 기계 부대는 전력 100 기준이라 사람 부대(500명)와 같은 비율로 깎는다.
        const lost = Math.min(
          u.men,
          d * MEN_LOSS_PER_DAMAGE * (us.men ? 1 : unitStrength(u.type) / 500),
        );
        if (lost > 0) loseMen(army, u, lost);
        if (u.state !== 'fighting' && u.state !== 'retreating' && blocking) {
          u.state = 'fighting';
          u.engagedAt = bf.now;
        }
      }
    }
  }

  // 3) 조직력 0 → 후퇴(갈 곳 없으면 포위 전멸), 병력 바닥 → 전멸
  for (const u of [...army.units]) {
    if (u.state === 'training' || u.airlift || UNIT_SPECS[u.type].domain === 'strike') continue;
    if (u.men < unitStrength(u.type) * DESTROYED_SHARE) {
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

  // 4) 보급·회복·점령·폭격
  for (const u of army.units) {
    if (u.state === 'training' || u.airlift) continue;
    const dom = UNIT_SPECS[u.type].domain;
    if (dom === 'strike') continue;
    const key = chunkKey(u.cx, u.cy);
    const owner = ownerOf(bf, key);
    const supplied = isSupplied(u, bf);
    const resting = dom === 'sea' ? supplied && !blockersAt(u, key).length : owner === bf.me.uid;
    if (resting && u.state !== 'fighting') {
      const heal = bf.me.hospitals?.has(key) ? HOSPITAL_REGEN_MUL : 1;
      u.org = Math.min(ORG_MAX, u.org + ORG_REGEN_PER_SEC * heal * dt);
      u.morale = Math.min(1, u.morale + 0.01 * dt);
    } else if (!supplied) {
      u.org = Math.max(0, u.org - UNSUPPLIED_ORG_DECAY * dt);
      u.morale = Math.max(0.3, u.morale - UNSUPPLIED_MORALE_DECAY * dt);
    }
    // 폭격: 적 땅 위의 폭격기는 1분마다 시설에 폭탄을 떨어뜨린다(맞은 쪽 기기가 처리).
    if (u.type === 'bomber' && enemy && owner === enemy.uid) {
      if (u.bombAt === undefined) u.bombAt = bf.now;
      else if (bf.now - u.bombAt >= BOMB_INTERVAL_MS) {
        u.bombAt = bf.now;
        addStrike(army, {
          id: `${bf.me.uid.slice(0, 6)}-${u.id}-${bf.now}`,
          kind: 'bomb',
          key,
          at: bf.now,
          power:
            UNIT_SPECS.bomber.attack *
            (u.men / unitStrength('bomber')) *
            weatherAir(bf.now, u.cx, u.cy),
        });
        events.push({ type: 'strike', key, kind: 'bomb' });
      }
    } else delete u.bombAt;
    // 점령: 땅 부대만. 적 땅(또는 적이 점령한 내 땅), 적 땅 부대 없음, 멈춰 있음, 60초.
    if (
      enemy &&
      dom === 'ground' &&
      unitDomainAt(u) === 'ground' &&
      owner === enemy.uid &&
      (u.state === 'idle' || u.state === 'moving') &&
      !u.path.length &&
      !(enemyAt.get(key) ?? []).some((e) => UNIT_SPECS[e.type].domain === 'ground') &&
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

/* ---------------- 폭격·미사일 ---------------- */

/** 내보낸 타격(폭탄·미사일). 맞은 쪽 기기가 요격·피해를 계산한다. */
export interface Strike {
  id: string;
  kind: 'bomb' | 'missile';
  key: string;
  at: number;
  /** 공격력(전력 비율 반영). */
  power: number;
}

/** 15분 지난 타격은 지운다(상대가 이미 받아 갔다). */
export const STRIKE_KEEP_MS = 15 * 60_000;

export function addStrike(army: ArmyState, s: Strike): void {
  const list = (army.strikes ?? []).filter((x) => s.at - x.at < STRIKE_KEEP_MS);
  list.push(s);
  army.strikes = list;
}

/** 0~1 결정론 난수(타격 id). 두 기기가 같은 값을 얻는다. */
export function strikeRoll(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/** 이 부대가 보급을 받는가: 땅은 내 땅 3청크, 공군은 12청크, 군함은 6청크 안. */
function isSupplied(u: Unit, bf: Battlefield): boolean {
  const dom = UNIT_SPECS[u.type].domain;
  const r = dom === 'air' ? AIR_RANGE_CHUNKS : dom === 'sea' ? 6 : 3;
  return nearMine(bf, u.cx, u.cy, r);
}

/** (cx,cy) 에서 r 청크 안에 내 땅(점령지 포함)이 있는가. */
export function nearMine(bf: Battlefield, cx: number, cy: number, r: number): boolean {
  if (r <= 3) {
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++)
        if (ownerOf(bf, chunkKey(cx + dx, cy + dy)) === bf.me.uid) return true;
    return false;
  }
  for (const k of bf.me.owned) {
    const p = parseChunkKey(k);
    if (Math.max(Math.abs(p.cx - cx), Math.abs(p.cy - cy)) <= r && ownerOf(bf, k) === bf.me.uid)
      return true;
  }
  for (const [k, who] of bf.occupied) {
    if (who !== bf.me.uid) continue;
    const p = parseChunkKey(k);
    if (Math.max(Math.abs(p.cx - cx), Math.abs(p.cy - cy)) <= r) return true;
  }
  return false;
}

/** 가장 가까운 안전한 곳으로 가는 길. 둘레가 다 막혀 있으면 null(포위). */
function retreatPath(u: Unit, bf: Battlefield, enemyAt: Map<string, Unit[]>): string[] | null {
  const dom = UNIT_SPECS[u.type].domain;
  const start = chunkKey(u.cx, u.cy);
  const maxLen = dom === 'air' ? 20 : dom === 'sea' ? 12 : 8;
  const safe = (nk: string, nx: number, ny: number): boolean => {
    if (dom === 'sea') {
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (ownerOf(bf, chunkKey(nx + dx, ny + dy)) === bf.me.uid) return true;
      return false;
    }
    return ownerOf(bf, nk) === bf.me.uid;
  };
  const queue: Array<{ cx: number; cy: number; path: string[] }> = [
    { cx: u.cx, cy: u.cy, path: [] },
  ];
  const seen = new Set([start]);
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    if (cur.path.length > maxLen) break;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cur.cx + dx;
        const ny = cur.cy + dy;
        const nk = chunkKey(nx, ny);
        if (seen.has(nk)) continue;
        seen.add(nk);
        if ((enemyAt.get(nk) ?? []).some((e) => blocks(u, e))) continue;
        if (passFactor(bf, u.type, nk, nx, ny, true) <= 0) continue;
        const owner = ownerOf(bf, nk);
        if (dom === 'ground' && bf.enemy && owner === bf.enemy.uid) continue;
        const path = [...cur.path, nk];
        if (safe(nk, nx, ny)) return path;
        queue.push({ cx: nx, cy: ny, path });
      }
  }
  return null;
}

/* ---------------- 인원 ---------------- */

/** 전사자: 뽑은 청크들에서 비율대로 뺀다(그만큼 그 청크 인구가 다시 찬다). */
export function loseMen(army: ArmyState, u: Unit, lost: number): void {
  const total = Object.values(u.source).reduce((a, b) => a + b, 0) || 1;
  for (const [key, n] of Object.entries(u.source)) {
    const take = (lost * n) / total;
    u.source[key] = Math.max(0, n - take);
    army.drafted[key] = Math.max(0, (army.drafted[key] ?? 0) - take);
    if (army.drafted[key] < 0.5) delete army.drafted[key];
  }
  u.men = Math.max(0, u.men - lost);
  const spec = UNIT_SPECS[u.type];
  army.lossValue = (army.lossValue ?? 0) + (spec.cost * lost) / unitStrength(u.type);
}

/** 부대를 없앤다. 해산(disband)이면 남은 인원이 인구로 돌아간다(drafted 에서 빠짐). */
export function removeUnit(army: ArmyState, id: string, disband: boolean): void {
  const u = army.units.find((x) => x.id === id);
  if (!u) return;
  // 전멸이든 해산이든 drafted 에서 빠진다. 전멸은 남은 인원까지 잃은 것이다.
  if (!disband) {
    const spec = UNIT_SPECS[u.type];
    army.lossValue = (army.lossValue ?? 0) + (spec.cost * u.men) / unitStrength(u.type);
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
  /** 생산 시간 배율(군수 공장이 있으면 0.7). */
  buildFactor = 1,
): Unit {
  const spec = UNIT_SPECS[type];
  const men = unitStrength(type);
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
    readyAt: now + spec.buildSec * 1000 * buildFactor,
    source,
  };
  army.units.push(u);
  return u;
}
