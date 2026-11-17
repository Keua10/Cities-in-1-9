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
import { UNIT_SPECS, type UnitType } from '../config/military';

/**
 * 전쟁 규칙 계산 (군사 4·5단계). 네트워크와 무관한 순수 함수.
 */

export type WarKind = 'small' | 'large';
export type WarState = 'prep' | 'active' | 'ended';
export type WarResult = 'winA' | 'winB' | 'truce' | 'ceasefire';

export interface WarDoc {
  id: string;
  a: string;
  b: string;
  parties: [string, string];
  names: Record<string, string>;
  kind: WarKind;
  surprise: boolean;
  state: WarState;
  declaredAt: number;
  startsAt: number;
  /** 한쪽이 끊긴 시각(다시 이어지면 지움). */
  pausedAt?: number;
  /** 항복 신청. */
  surrender?: { by: string; at: number };
  result?: WarResult;
  endedAt?: number;
  /** 이 시각까지 두 도시는 다시 전쟁할 수 없다. */
  peaceUntil?: number;
  /** 패전국이 실제로 낸 배상(승전국이 받아 간다). */
  paid?: { money: number; iron: number; coal: number; oil: number; chunks: string[] };
  /** 점수(끝날 때 기록). */
  score?: Record<string, number>;
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
  const s = UNIT_SPECS[type];
  return (s.cost * men) / (s.men || 1);
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
