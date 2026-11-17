import { collection, doc, getDocs, setDoc, Timestamp } from 'firebase/firestore';
import { sharedNow } from '../sim/sharedClock';
import { getFirebase } from './firebase';
import { PRESENCE_ONLINE_MS } from './presence';

/**
 * 다른 도시 보기 (군사 3단계).
 *
 * 도시 문서(cities/{uid})는 크고(매크로 전체) 학생 20명 것을 다 읽으면 무겁다. 그래서
 * 대륙 지도에 필요한 것만 담은 작은 공개 문서 public/{uid} 를 저장할 때 함께 적는다.
 * 대륙 지도를 열 때 public 과 presence 를 한 번씩 읽는다(학생 수만큼 읽기).
 */

export interface PublicProfile {
  cityIndex: number;
  cityName: string;
  /** 시작 영토 왼쪽 위 "cx,cy". */
  origin: string;
  /** 내 땅 청크 "cx,cy". */
  owned: string[];
  /** 수도 왼쪽 위 "cx,cy". */
  capital: string;
  capitalLevel: number;
  cityLevel: number;
  population: number;
  updatedAt: number;
}

export interface PublicCity extends PublicProfile {
  uid: string;
  online: boolean;
  /** 마지막 접속 기록(서버 ms). 없으면 0. */
  lastSeen: number;
}

/** 공개 문서 필드가 이상하면 버린다(규칙이 막지만 한 번 더). */
export function readProfile(uid: string, raw: Record<string, unknown>): PublicProfile | null {
  const owned = Array.isArray(raw.owned) ? raw.owned.filter((k) => typeof k === 'string') : [];
  if (typeof raw.origin !== 'string' || typeof raw.capital !== 'string') return null;
  return {
    cityIndex: Number(raw.cityIndex) || 0,
    cityName: typeof raw.cityName === 'string' ? raw.cityName : `도시 ${uid.slice(0, 4)}`,
    origin: raw.origin,
    owned: owned as string[],
    capital: raw.capital,
    capitalLevel: Math.max(1, Math.min(3, Number(raw.capitalLevel) || 1)),
    cityLevel: Math.max(1, Math.min(9, Number(raw.cityLevel) || 1)),
    population: Math.max(0, Number(raw.population) || 0),
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

export async function publishProfile(uid: string, profile: PublicProfile): Promise<void> {
  const fb = getFirebase();
  if (!fb) return;
  await setDoc(doc(fb.db, 'public', uid), profile);
}

/** 모든 도시의 공개 정보와 접속 여부. 서버가 없으면 빈 목록. */
export async function loadPublicCities(): Promise<PublicCity[]> {
  const fb = getFirebase();
  if (!fb) return [];
  const [pub, pres] = await Promise.all([
    getDocs(collection(fb.db, 'public')),
    getDocs(collection(fb.db, 'presence')),
  ]);
  const seen = new Map<string, number>();
  for (const d of pres.docs) {
    const at = d.get('at');
    if (at instanceof Timestamp) seen.set(d.id, at.toMillis());
  }
  const now = sharedNow();
  const out: PublicCity[] = [];
  for (const d of pub.docs) {
    const p = readProfile(d.id, d.data());
    if (!p) continue;
    const lastSeen = seen.get(d.id) ?? 0;
    out.push({ ...p, uid: d.id, lastSeen, online: now - lastSeen < PRESENCE_ONLINE_MS });
  }
  out.sort((a, b) => a.cityIndex - b.cityIndex);
  return out;
}
