import {
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { CEASEFIRE_PEACE_MS } from '../sim/config/war';
import type { WarDoc } from '../sim/military/warRules';
import { getFirebase } from './firebase';
import type { AdminOrder } from './types';

/**
 * 관리자(교사) 도구 — 서버 쪽 권한은 firestore.rules 의 isAdmin() 이 막는다.
 * 여기 함수는 관리자 계정이 아니면 규칙에 막혀 실패한다.
 */

/** 게임 전체 설정(meta/settings). 모두 읽고 관리자만 쓴다. */
export interface GameSettings {
  /** false 면 새 선전포고 금지(진행 중 전쟁은 그대로). */
  warsEnabled: boolean;
  /** 모든 학생에게 접속할 때 보이는 공지. */
  notice: string;
  noticeAt: number;
}

const DEFAULT_SETTINGS: GameSettings = { warsEnabled: true, notice: '', noticeAt: 0 };

export async function loadSettings(): Promise<GameSettings> {
  const fb = getFirebase();
  if (!fb) return DEFAULT_SETTINGS;
  try {
    const snap = await getDoc(doc(fb.db, 'meta', 'settings'));
    return {
      ...DEFAULT_SETTINGS,
      ...(snap.exists() ? (snap.data() as Partial<GameSettings>) : {}),
    };
  } catch (err) {
    console.warn('설정을 읽지 못했습니다', err);
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(patch: Partial<GameSettings>): Promise<void> {
  const fb = getFirebase();
  if (!fb) throw new Error('서버에 연결되어 있지 않습니다');
  const cur = await loadSettings();
  await setDoc(doc(fb.db, 'meta', 'settings'), { ...cur, ...patch });
}

/** 진행 중(준비·전투)인 전쟁 전부. */
export async function activeWars(): Promise<WarDoc[]> {
  const fb = getFirebase();
  if (!fb) return [];
  const snap = await getDocs(
    query(collection(fb.db, 'wars'), where('state', 'in', ['prep', 'active'])),
  );
  return snap.docs.map((d) => ({ ...(d.data() as WarDoc), id: d.id }));
}

/** 전쟁 강제 종료: 배상 없는 휴전, 12시간 전쟁 금지. */
export async function forceTruce(id: string): Promise<void> {
  const fb = getFirebase();
  if (!fb) throw new Error('서버에 연결되어 있지 않습니다');
  const now = Date.now();
  await updateDoc(doc(fb.db, 'wars', id), {
    state: 'ended',
    result: 'truce',
    endedAt: now,
    peaceUntil: now + CEASEFIRE_PEACE_MS,
    adminEnded: true,
    surrender: deleteField(),
    ceasefireOffer: deleteField(),
  });
}

/** 도시에 지시를 남긴다(그 학생이 다음에 접속하면 실행된다). */
export async function orderCity(uid: string, order: Omit<AdminOrder, 'id' | 'at'>): Promise<void> {
  const fb = getFirebase();
  if (!fb) throw new Error('서버에 연결되어 있지 않습니다');
  const at = Date.now();
  await updateDoc(doc(fb.db, 'cities', uid), {
    adminOrder: { ...order, id: `${order.kind}-${at}`, at },
  });
}
