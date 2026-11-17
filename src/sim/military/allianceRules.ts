import {
  ALLIANCE_DEPOSITS,
  BETRAYAL_LOCK_MS,
  MAX_ALLIANCES,
  SURPRISE_PENALTY_MS,
} from '../config/war';

/**
 * 동맹 규칙 (군사 5단계). Firestore 없이 계산만 한다(점검 도구에서 그대로 부른다).
 *
 *   신청: 신청한 쪽이 보증금을 먼저 낸다(내 돈에서 빠짐).
 *   수락: 받은 쪽도 같은 금액을 낸다 → 동맹.
 *   거절·취소: 신청한 쪽이 돌려받는다.
 *   해제: 둘 다 자기 보증금을 돌려받는다.
 *   배신(동맹에게 선전포고): 배신한 쪽 보증금은 상대에게 → 상대가 두 몫을 받는다.
 *     배신한 도시는 24시간 동안 새 동맹 불가.
 *   기습한 도시는 24시간 동안 동맹 신청 불가.
 */

export type AllianceState = 'pending' | 'active' | 'declined' | 'cancelled' | 'ended' | 'broken';

export interface AllianceDoc {
  id: string;
  /** 두 uid(정렬). */
  parties: [string, string];
  /** 신청한 쪽. */
  from: string;
  names: Record<string, string>;
  state: AllianceState;
  /** 한쪽이 거는 보증금(만 원). */
  deposit: number;
  createdAt: number;
  acceptedAt?: number;
  endedAt?: number;
  /** 해제·배신·거절·취소한 쪽. */
  endedBy?: string;
}

export const OPEN_STATES: ReadonlySet<AllianceState> = new Set(['pending', 'active']);

export function partnerOf(a: AllianceDoc, uid: string): string {
  return a.parties[0] === uid ? a.parties[1] : a.parties[0];
}

export function allianceParties(u1: string, u2: string): [string, string] {
  return u1 < u2 ? [u1, u2] : [u2, u1];
}

/** 나와 그 도시 사이의 열린(신청 중·맺은) 동맹. */
export function openWith(
  list: readonly AllianceDoc[],
  uid: string,
  other: string,
): AllianceDoc | undefined {
  return list.find(
    (a) => OPEN_STATES.has(a.state) && a.parties.includes(uid) && a.parties.includes(other),
  );
}

export function isAllied(list: readonly AllianceDoc[], uid: string, other: string): boolean {
  return openWith(list, uid, other)?.state === 'active';
}

export function alliesOf(list: readonly AllianceDoc[], uid: string): string[] {
  return list
    .filter((a) => a.state === 'active' && a.parties.includes(uid))
    .map((a) => partnerOf(a, uid));
}

export interface AllianceActor {
  uid: string;
  money: number;
  surpriseAt?: number;
  betrayedAt?: number;
}

function lockLeft(at: number | undefined, span: number, now: number): number {
  return at === undefined ? 0 : Math.max(0, at + span - now);
}

const hours = (ms: number) => Math.ceil(ms / 3_600_000);

/** 동맹 신청을 막는 이유(빈 문자열 = 가능). */
export function requestBlock(o: {
  now: number;
  me: AllianceActor;
  them: string;
  deposit: number;
  alliances: readonly AllianceDoc[];
  atWarWith: boolean;
}): string {
  const { now, me } = o;
  if (o.them === me.uid) return '자기 도시와는 동맹을 맺을 수 없습니다';
  if (!(ALLIANCE_DEPOSITS as readonly number[]).includes(o.deposit)) return '보증금을 고르세요';
  const betray = lockLeft(me.betrayedAt, BETRAYAL_LOCK_MS, now);
  if (betray) return `동맹을 배신해서 ${hours(betray)}시간 뒤에 새 동맹을 맺을 수 있습니다`;
  const surprise = lockLeft(me.surpriseAt, SURPRISE_PENALTY_MS, now);
  if (surprise) return `기습공격을 해서 ${hours(surprise)}시간 뒤에 동맹을 신청할 수 있습니다`;
  if (o.atWarWith) return '전쟁 중인 도시와는 동맹을 맺을 수 없습니다';
  const open = openWith(o.alliances, me.uid, o.them);
  if (open) return open.state === 'active' ? '이미 동맹입니다' : '이미 동맹 신청 중입니다';
  const mine = o.alliances.filter((a) => OPEN_STATES.has(a.state) && a.parties.includes(me.uid));
  if (mine.length >= MAX_ALLIANCES) return `동맹은 신청 중인 것까지 ${MAX_ALLIANCES}개까지입니다`;
  if (me.money < o.deposit) return '보증금을 낼 돈이 모자랍니다';
  return '';
}

/** 받은 동맹 신청을 수락할 수 없는 이유. */
export function acceptBlock(o: {
  now: number;
  me: AllianceActor;
  doc: AllianceDoc;
  alliances: readonly AllianceDoc[];
  atWarWith: boolean;
}): string {
  const { now, me, doc } = o;
  if (doc.state !== 'pending') return '이미 끝난 신청입니다';
  if (doc.from === me.uid || !doc.parties.includes(me.uid)) return '받은 신청이 아닙니다';
  const betray = lockLeft(me.betrayedAt, BETRAYAL_LOCK_MS, now);
  if (betray) return `동맹을 배신해서 ${hours(betray)}시간 뒤에 새 동맹을 맺을 수 있습니다`;
  if (o.atWarWith) return '전쟁 중인 도시와는 동맹을 맺을 수 없습니다';
  const active = o.alliances.filter((a) => a.state === 'active' && a.parties.includes(me.uid));
  if (active.length >= MAX_ALLIANCES) return `동맹은 ${MAX_ALLIANCES}개까지입니다`;
  if (me.money < doc.deposit) return '보증금을 낼 돈이 모자랍니다';
  return '';
}

/** 이 사람이 보증금을 냈는가. */
export function hasPaid(doc: AllianceDoc, uid: string): boolean {
  return doc.from === uid || doc.acceptedAt !== undefined;
}

/**
 * 끝난 동맹에서 이 사람이 돌려받을 돈(만 원). 아직 안 끝났으면 null.
 * 낸 적 없는 사람은 0(배신당한 쪽은 자기 몫 + 배신자 몫).
 */
export function settleDelta(doc: AllianceDoc, uid: string): number | null {
  if (OPEN_STATES.has(doc.state)) return null;
  if (!doc.parties.includes(uid) || !hasPaid(doc, uid)) return 0;
  if (doc.state === 'broken') return doc.endedBy === uid ? 0 : doc.deposit * 2;
  return doc.deposit;
}
