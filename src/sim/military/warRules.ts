import { parseChunkKey } from '../../core/iso';
import {
  BIG_BATTLE_SHARE,
  CEASEFIRE_QUIET_MS,
  LARGE_WAR_CAPITAL,
  OCCUPIED_CHUNK_SCORE,
  REPARATION_MONEY,
  REPARATION_RESOURCES,
  SMALL_WAR_CAPITAL,
  SURPRISE_BORDER_CHUNKS,
  SURPRISE_MIN_CITY_LEVEL,
  SURPRISE_QUIET_MS,
  SURPRISE_RATIO,
  WAR_JUDGE_AFTER_MS,
  WAR_RANGE_CHUNKS,
  WIN_RATIO,
} from '../config/war';
import { unitStrength, UNIT_SPECS, type UnitType } from '../config/military';

/**
 * 전쟁 규칙 계산 (군사 4·5단계). 네트워크와 무관한 순수 함수.
 */

export type WarKind = 'small' | 'large';
export type WarState = 'prep' | 'active' | 'ended';
export type WarResult = 'winA' | 'winB' | 'truce' | 'ceasefire';
/** 진영: a = 선포한 쪽, b = 받은 쪽. 대규모 전쟁에서는 다른 도시가 어느 진영으로 참가한다. */
export type WarSide = 'a' | 'b';

/** 패전국 한 곳이 낸 배상. chunks = 승전 진영 도시별로 내준 청크. */
export interface Paid {
  money: number;
  iron: number;
  coal: number;
  oil: number;
  chunks: Record<string, string[]>;
}

export interface WarDoc {
  id: string;
  a: string;
  b: string;
  /** 참가한 모든 도시(선포·받은 쪽 + 참가국). */
  parties: string[];
  names: Record<string, string>;
  /** 대규모 전쟁 참가국: 진영·수도 레벨·참가 시각. */
  joined?: Record<string, { side: WarSide; level: number; at: number }>;
  /** 선포·받은 쪽 수도 레벨(참가국 공격 제한 판정). */
  levels?: Record<string, number>;
  kind: WarKind;
  surprise: boolean;
  state: WarState;
  declaredAt: number;
  startsAt: number;
  /** 한쪽이 끊긴 시각(다시 이어지면 지움). */
  pausedAt?: number;
  /** 항복 신청(진영 대표가 낸다). votes = 받는 진영에서 동의한 도시. */
  surrender?: { by: string; at: number; votes?: Record<string, boolean> };
  /** 휴전 제안. votes = 참가국별 찬성(true)·반대(false). 모든 진영 2/3 + 직접 참여국 둘 다 찬성이면 휴전. */
  ceasefireOffer?: { by: string; at: number; votes: Record<string, boolean> };
  /** 관리자(선생님)가 강제로 끝낸 전쟁. */
  adminEnded?: boolean;
  /** 휴전 제안이 받아들여져 끝났다(큰 전투 없이 1시간 휴전과 구분). */
  agreedCeasefire?: boolean;
  result?: WarResult;
  endedAt?: number;
  /** 이 시각까지 두 도시는 다시 전쟁할 수 없다. */
  peaceUntil?: number;
  /** 패전국마다 실제로 낸 배상(승전국들이 기여도 비율로 받아 간다). */
  paid?: Record<string, Paid>;
  /** 점수(끝날 때 기록). 진영 대표 uid(a·b) → 진영 점수. */
  score?: Record<string, number>;
  /** 끝날 때 기여도(배상 나누기). */
  contrib?: Record<string, number>;
}

/** 한쪽이 보내는 전장 스냅숏(wars/{id}/sides/{uid}). */
export interface SideDoc {
  at: number;
  units: CompactUnit[];
  owned: string[];
  capital: string[];
  trenches: string[];
  urban: string[];
  /** 내가 점령을 주장한 청크와 시각. 두 쪽 주장 중 늦은 쪽이 이긴다. */
  claims: Record<string, number>;
  /** 내가 잃은 병력의 가치(생산비 기준). 상대 점수가 된다. */
  lossValue: number;
  /** 큰 전투(내 병력 10% 이상)가 마지막으로 있었던 시각. */
  bigBattleAt: number;
  /** 전쟁 시작 때 내 병력(큰 전투 기준). */
  men: number;
  /** 내가 보낸 폭격·미사일(최근 15분). 상대 기기가 요격·피해를 계산한다. */
  strikes?: import('./army').Strike[];
}

export interface CompactUnit {
  id: string;
  t: UnitType;
  m: number;
  o: number;
  mo: number;
  x: number;
  y: number;
  p: number;
  path: string[];
  s: string;
  ar?: number;
}

/** 두 도시 영토 사이의 가장 가까운 거리(청크, 체비쇼프). */
export function territoryDistance(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return Infinity;
  const pa = a.map(parseChunkKey);
  const pb = b.map(parseChunkKey);
  let best = Infinity;
  for (const p of pa)
    for (const q of pb) {
      const d = Math.max(Math.abs(p.cx - q.cx), Math.abs(p.cy - q.cy));
      if (d < best) best = d;
    }
  return best;
}

export interface DeclareInput {
  now: number;
  kind: WarKind;
  me: { uid: string; online: boolean; capitalLevel: number; cityLevel: number; owned: string[] };
  them: { uid: string; online: boolean; capitalLevel: number; owned: string[] };
  /** 두 도시와 관련된 모든 전쟁(끝난 것 포함). */
  wars: readonly WarDoc[];
}

/** 선전포고를 할 수 없는 이유. 빈 문자열이면 된다. */
export function declareBlock(x: DeclareInput): string {
  const need = x.kind === 'large' ? LARGE_WAR_CAPITAL : SMALL_WAR_CAPITAL;
  const label = x.kind === 'large' ? '대규모' : '소규모';
  if (x.me.capitalLevel < need) return `${label} 전쟁은 내 수도 ${need}레벨부터 할 수 있습니다`;
  if (x.them.capitalLevel < need)
    return `상대 수도가 ${need}레벨이 안 되어 ${label} 전쟁을 걸 수 없습니다`;
  if (!x.them.online) return '상대가 접속해 있어야 전쟁을 시작할 수 있습니다';
  for (const w of x.wars) {
    if (w.state !== 'ended' && (w.parties.includes(x.me.uid) || w.parties.includes(x.them.uid)))
      return w.parties.includes(x.me.uid)
        ? '이미 다른 전쟁 중입니다'
        : '상대가 이미 다른 전쟁 중입니다';
    if (
      w.state === 'ended' &&
      w.parties.includes(x.me.uid) &&
      w.parties.includes(x.them.uid) &&
      (w.peaceUntil ?? 0) > x.now
    ) {
      const h = Math.ceil(((w.peaceUntil ?? 0) - x.now) / 3_600_000);
      return `이 도시와는 ${h}시간 뒤에 다시 전쟁할 수 있습니다`;
    }
  }
  const d = territoryDistance(x.me.owned, x.them.owned);
  if (d > WAR_RANGE_CHUNKS)
    return `상대 영토가 ${WAR_RANGE_CHUNKS}청크 안에 있어야 합니다 (지금 ${d}청크)`;
  return '';
}

export interface SurpriseInput {
  now: number;
  cityLevel: number;
  myId: string;
  wars: readonly WarDoc[];
  /** 내 부대 위치·인원. */
  myUnits: ReadonlyArray<{ cx: number; cy: number; men: number }>;
  /** 상대가 공개한 부대 위치·인원(공개 문서). */
  theirUnits: ReadonlyArray<{ cx: number; cy: number; men: number }>;
  theirOwned: readonly string[];
}

/** 기습(준비 시간 없이 바로 개전)을 할 수 없는 이유. */
export function surpriseBlock(x: SurpriseInput): string {
  if (x.cityLevel < SURPRISE_MIN_CITY_LEVEL)
    return `기습은 도시 ${SURPRISE_MIN_CITY_LEVEL}레벨부터`;
  for (const w of x.wars)
    if (w.parties.includes(x.myId) && (w.endedAt ?? x.now) > x.now - SURPRISE_QUIET_MS)
      return '직전 24시간 안에 다른 전쟁이 있었습니다';
  const theirs = new Set(x.theirOwned);
  const nearBorder = (cx: number, cy: number) => {
    for (let dy = -SURPRISE_BORDER_CHUNKS; dy <= SURPRISE_BORDER_CHUNKS; dy++)
      for (let dx = -SURPRISE_BORDER_CHUNKS; dx <= SURPRISE_BORDER_CHUNKS; dx++)
        if (theirs.has(`${cx + dx},${cy + dy}`)) return true;
    return false;
  };
  const mine = x.myUnits.filter((u) => nearBorder(u.cx, u.cy)).reduce((s, u) => s + u.men, 0);
  const theirsNear = x.theirUnits
    .filter((u) => nearBorder(u.cx, u.cy))
    .reduce((s, u) => s + u.men, 0);
  if (mine <= 0) return `국경 ${SURPRISE_BORDER_CHUNKS}청크 안에 부대를 먼저 배치하세요`;
  if (mine < theirsNear * SURPRISE_RATIO)
    return `국경 병력이 상대의 ${SURPRISE_RATIO}배 이상이어야 합니다 (내 ${mine}명 / 상대 ${theirsNear}명)`;
  return '';
}

/** 부대 하나의 가치(생산비). */
export function unitValue(type: UnitType, men: number): number {
  return (UNIT_SPECS[type].cost * men) / unitStrength(type);
}

/** 점령 주장 두 개를 합쳐 청크 → 점령한 uid. 원래 주인이 되찾으면 빠진다. */
export function mergeClaims(
  a: { uid: string; claims: Record<string, number>; owned: readonly string[] },
  b: { uid: string; claims: Record<string, number>; owned: readonly string[] },
): Map<string, string> {
  const out = new Map<string, string>();
  const ownedA = new Set(a.owned);
  const ownedB = new Set(b.owned);
  const keys = new Set([...Object.keys(a.claims), ...Object.keys(b.claims)]);
  for (const k of keys) {
    const ta = a.claims[k] ?? -1;
    const tb = b.claims[k] ?? -1;
    const who = ta >= tb ? a.uid : b.uid;
    const original = ownedA.has(k) ? a.uid : ownedB.has(k) ? b.uid : '';
    if (who !== original) out.set(k, who);
  }
  return out;
}

/** 전쟁 점수: 파괴한 적 병력 가치 + 점령한 청크 × 2,000. */
export function warScore(
  occupied: Map<string, string>,
  uid: string,
  enemyLossValue: number,
): number {
  let chunks = 0;
  for (const who of occupied.values()) if (who === uid) chunks++;
  return Math.round(enemyLossValue + chunks * OCCUPIED_CHUNK_SCORE);
}

/** 점수로 결과. 1.5배 이상 차이면 승전, 아니면 종전 협정. */
export function judge(scoreA: number, scoreB: number): WarResult {
  if (scoreA >= Math.max(1, scoreB) * WIN_RATIO && scoreA > 0) return 'winA';
  if (scoreB >= Math.max(1, scoreA) * WIN_RATIO && scoreB > 0) return 'winB';
  return 'truce';
}

/** 휴전 조건: 시작(또는 마지막 큰 전투) 뒤 1시간 동안 큰 전투가 없음. */
export function ceasefireDue(war: WarDoc, lastBigBattle: number, now: number): boolean {
  if (war.state !== 'active') return false;
  return now - Math.max(war.startsAt, lastBigBattle) >= CEASEFIRE_QUIET_MS;
}

/** 끊긴 지 24시간이 지나 판정할 때인가. */
export function judgeDue(war: WarDoc, now: number): boolean {
  return (
    war.state === 'active' && war.pausedAt !== undefined && now - war.pausedAt >= WAR_JUDGE_AFTER_MS
  );
}

/** 큰 전투인가: 이번에 싸우는 내 병력이 내 전체 병력의 10% 이상. */
export function isBigBattle(fightingMen: number, totalMen: number): boolean {
  return totalMen > 0 && fightingMen >= totalMen * BIG_BATTLE_SHARE;
}

/** 패전국이 낼 배상(최대치). */
export function reparations(
  money: number,
  stock: { iron: number; coal: number; oil: number },
): { money: number; iron: number; coal: number; oil: number } {
  return {
    money: Math.max(0, Math.floor(money * REPARATION_MONEY)),
    iron: Math.floor(stock.iron * REPARATION_RESOURCES),
    coal: Math.floor(stock.coal * REPARATION_RESOURCES),
    oil: Math.floor(stock.oil * REPARATION_RESOURCES),
  };
}

/* ---------------- 대규모 전쟁(연합) ---------------- */

export function sideOf(w: WarDoc, uid: string): WarSide | null {
  if (uid === w.a) return 'a';
  if (uid === w.b) return 'b';
  return w.joined?.[uid]?.side ?? null;
}

export function otherSide(s: WarSide): WarSide {
  return s === 'a' ? 'b' : 'a';
}

/** 그 진영의 도시들(대표가 먼저). */
export function membersOf(w: WarDoc, side: WarSide): string[] {
  const out = [w[side]];
  for (const [uid, j] of Object.entries(w.joined ?? {})) if (j.side === side) out.push(uid);
  return out;
}

export function levelOf(w: WarDoc, uid: string): number {
  return w.joined?.[uid]?.level ?? w.levels?.[uid] ?? 2;
}

/**
 * 공격자(수도 3레벨)는 진영으로 참가한 수도 2레벨 도시의 영토를 공격할 수 없다(계획서).
 */
export function landProtected(w: WarDoc, attacker: string, target: string): boolean {
  return levelOf(w, attacker) >= 3 && !!w.joined?.[target] && levelOf(w, target) < 3;
}

/** 수도까지 점령할 수 있는가: 대규모 전쟁의 직접 참여국(선포·받은 쪽)만. */
export function capitalOpen(w: WarDoc, uid: string): boolean {
  return w.kind === 'large' && (uid === w.a || uid === w.b);
}

/** 항복을 받아들이는 데 필요한 동의 수: 받는 진영의 2/3(기습 전쟁이면 3/4). */
export function consentNeeded(w: WarDoc, side: WarSide): number {
  const n = membersOf(w, side).length;
  return Math.max(1, Math.ceil(n * (w.surprise ? 3 / 4 : 2 / 3) - 1e-9));
}

/** 항복이 받아들여졌는가: 받는 진영 대표가 동의했거나, 그 진영 2/3(3/4) 이상이 동의. */
export function surrenderAccepted(w: WarDoc): boolean {
  const s = w.surrender;
  if (!s) return false;
  const by = sideOf(w, s.by);
  if (!by) return false;
  const other = otherSide(by);
  const votes = Object.keys(s.votes ?? {}).filter((u) => s.votes![u] && sideOf(w, u) === other);
  return votes.includes(w[other]) || votes.length >= consentNeeded(w, other);
}

/**
 * 여러 도시의 점령 주장을 합친다. 청크마다 가장 늦은 주장이 이긴다. 원래 주인이나 같은
 * 진영 도시가 되찾았으면 빠진다(해방).
 */
export function mergeAllClaims(
  w: WarDoc,
  list: ReadonlyArray<{ uid: string; claims: Record<string, number>; owned: readonly string[] }>,
): Map<string, string> {
  const owner = new Map<string, string>();
  for (const x of list) for (const k of x.owned) owner.set(k, x.uid);
  const best = new Map<string, { uid: string; t: number }>();
  for (const x of list)
    for (const [k, t] of Object.entries(x.claims)) {
      const cur = best.get(k);
      if (!cur || t > cur.t) best.set(k, { uid: x.uid, t });
    }
  const out = new Map<string, string>();
  for (const [k, { uid }] of best) {
    const original = owner.get(k) ?? '';
    if (uid === original) continue;
    if (original && sideOf(w, original) === sideOf(w, uid)) continue;
    out.set(k, uid);
  }
  return out;
}

/** 진영 점수: 상대 진영이 잃은 병력·시설 가치 + 우리 진영이 점령한 청크 × 2,000. */
export function sideScore(
  w: WarDoc,
  side: WarSide,
  occupied: Map<string, string>,
  enemyLoss: number,
): number {
  let chunks = 0;
  for (const who of occupied.values()) if (sideOf(w, who) === side) chunks++;
  return Math.round(enemyLoss + chunks * OCCUPIED_CHUNK_SCORE);
}

/** 기여도: 점령한 청크 × 2,000 + 끝날 때 남은 부대 가치 + 1(참가만 해도 몫이 있다). */
export function contributions(
  w: WarDoc,
  occupied: Map<string, string>,
  armyValue: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const uid of w.parties) {
    let chunks = 0;
    for (const who of occupied.values()) if (who === uid) chunks++;
    out[uid] = Math.round(chunks * OCCUPIED_CHUNK_SCORE + (armyValue[uid] ?? 0) + 1);
  }
  return out;
}

/** 승전 진영에서 내 몫(0~1). */
export function shareOf(w: WarDoc, uid: string): number {
  const side = sideOf(w, uid);
  if (!side) return 0;
  const team = membersOf(w, side);
  const c = w.contrib ?? {};
  const total = team.reduce((s, u) => s + (c[u] ?? 1), 0);
  return (c[uid] ?? 1) / Math.max(1, total);
}

/** 대규모 전쟁에 진영으로 참가할 수 없는 이유. */
export function joinBlock(x: {
  w: WarDoc;
  me: { uid: string; capitalLevel: number };
  side: WarSide;
  wars: readonly WarDoc[];
  alliedWith: (uid: string) => boolean;
}): string {
  const { w, me } = x;
  if (w.kind !== 'large') return '대규모 전쟁에만 참가할 수 있습니다';
  if (w.state === 'ended') return '이미 끝난 전쟁입니다';
  if (w.parties.includes(me.uid)) return '이미 참가하고 있습니다';
  if (me.capitalLevel < SMALL_WAR_CAPITAL)
    return `수도 ${SMALL_WAR_CAPITAL}레벨부터 참가할 수 있습니다`;
  for (const o of x.wars)
    if (o.id !== w.id && o.state !== 'ended' && o.parties.includes(me.uid))
      return '이미 다른 전쟁 중입니다';
  if (!membersOf(w, x.side).some((u) => x.alliedWith(u)))
    return '그 진영 도시와 동맹이어야 참가할 수 있습니다';
  return '';
}

/* ---------------- 휴전 제안 ---------------- */

/** 휴전에 필요한 찬성 수: 모든 참가국의 2/3. */
export function ceasefireNeeded(w: WarDoc): number {
  return Math.max(2, Math.ceil(w.parties.length * (2 / 3) - 1e-9));
}

/** 찬성한 참가국 수. */
export function ceasefireYes(w: WarDoc): number {
  const v = w.ceasefireOffer?.votes ?? {};
  return w.parties.filter((u) => v[u] === true).length;
}

/** 휴전 제안이 통과했는가: 참가국 2/3 찬성, 직접 참여국(선포·받은 쪽) 둘 다 찬성. */
export function ceasefireAccepted(w: WarDoc): boolean {
  const o = w.ceasefireOffer;
  if (!o) return false;
  return o.votes[w.a] === true && o.votes[w.b] === true && ceasefireYes(w) >= ceasefireNeeded(w);
}

/** 더 이상 통과할 수 없는가(직접 참여국이 반대했거나, 남은 표를 다 더해도 모자람). */
export function ceasefireDead(w: WarDoc): boolean {
  const o = w.ceasefireOffer;
  if (!o) return false;
  if (o.votes[w.a] === false || o.votes[w.b] === false) return true;
  const no = w.parties.filter((u) => o.votes[u] === false).length;
  return w.parties.length - no < ceasefireNeeded(w);
}
