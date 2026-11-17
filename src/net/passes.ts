import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import { sharedNow } from '../sim/sharedClock';
import {
  NOTIFY_VALID_MS,
  PERMIT_VALID_MS,
  type PassDoc,
  type PassRule,
} from '../sim/military/waters';
import { getFirebase } from './firebase';

/**
 * 영해·영공 통과 (피드백 1차).
 *
 *   passes/{from}_{to}   from 이 to 의 영해·영공을 지나가겠다는 신고·허가 요청. to 가 허가·거절.
 *   incidents/{id}       to 의 무단 통과 부대를 from 이 공격했다. to 의 기기가 피해를 계산한다.
 *
 * 각 나라의 규율(자유·신고·허가)은 공개 정보(public/{uid}.pass)에 적는다.
 */

export interface Incident {
  id: string;
  from: string;
  to: string;
  key: string;
  at: number;
  power: number;
}

export class PassSession {
  /** 나와 관련된 통과 기록(내가 낸 것 + 나에게 온 것). */
  passes: Array<PassDoc & { id: string }> = [];
  revision = 0;
  onNotice: ((text: string) => void) | null = null;
  /** 내 부대가 공격받았다(무단 통과). macro 의 군대가 피해를 계산한다. */
  onIncident: ((i: Incident) => void) | null = null;
  private unsubs: Unsubscribe[] = [];
  private seenIncidents = new Set<string>();
  private lastShot = new Map<string, number>();

  constructor(
    private uid: string,
    private names: () => Record<string, string>,
  ) {}

  start(): void {
    const fb = getFirebase();
    if (!fb) return;
    this.unsubs.push(
      onSnapshot(
        query(collection(fb.db, 'passes'), where('parties', 'array-contains', this.uid)),
        (snap) => {
          const before = new Map(this.passes.map((p) => [p.id, p.state]));
          this.passes = snap.docs.map((d) => ({ ...(d.data() as PassDoc), id: d.id }));
          for (const p of this.passes) {
            if (before.get(p.id) === p.state) continue;
            const n = this.names();
            if (p.to === this.uid && p.state === 'asked')
              this.onNotice?.(`${n[p.from] ?? '다른 도시'} 통과 허가 요청`);
            if (p.from === this.uid && (p.state === 'granted' || p.state === 'denied'))
              this.onNotice?.(
                `${n[p.to] ?? '상대'} 통과 ${p.state === 'granted' ? '허가됨' : '거절됨'}`,
              );
          }
          this.revision++;
        },
        (err) => console.warn('통과 기록 구독 실패', err),
      ),
      onSnapshot(
        query(collection(fb.db, 'incidents'), where('to', '==', this.uid)),
        (snap) => {
          const now = sharedNow();
          for (const d of snap.docs) {
            if (this.seenIncidents.has(d.id)) continue;
            this.seenIncidents.add(d.id);
            const i = { ...(d.data() as Omit<Incident, 'id'>), id: d.id };
            // 오래된 기록(다시 접속했을 때)은 무시한다.
            if (now - i.at > 5 * 60_000) continue;
            this.onIncident?.(i);
          }
        },
        (err) => console.warn('공격 기록 구독 실패', err),
      ),
    );
  }

  stop(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  /** from → to 통과 기록. */
  pass(from: string, to: string): PassDoc | undefined {
    return this.passes.find((p) => p.from === from && p.to === to);
  }

  /** 신고(신고 규율) 또는 허가 요청(허가 규율). */
  async request(to: string, rule: PassRule): Promise<string> {
    const fb = getFirebase();
    if (!fb) return '서버에 연결되어 있지 않습니다';
    if (rule === 'open') return '자유 통과 나라입니다';
    const now = sharedNow();
    const data: PassDoc & { parties: string[] } = {
      from: this.uid,
      to,
      parties: [this.uid, to],
      state: rule === 'notify' ? 'notified' : 'asked',
      at: now,
      ...(rule === 'notify' ? { until: now + NOTIFY_VALID_MS } : {}),
    };
    try {
      await setDoc(doc(fb.db, 'passes', `${this.uid}_${to}`), data);
      return '';
    } catch (err) {
      console.warn('통과 신고 실패', err);
      return '보내지 못했습니다';
    }
  }

  /** 나에게 온 허가 요청에 답한다. */
  async answer(from: string, grant: boolean): Promise<void> {
    const fb = getFirebase();
    if (!fb) return;
    const now = sharedNow();
    try {
      await updateDoc(doc(fb.db, 'passes', `${from}_${this.uid}`), {
        state: grant ? 'granted' : 'denied',
        at: now,
        ...(grant ? { until: now + PERMIT_VALID_MS } : {}),
      });
    } catch (err) {
      console.warn('통과 답 실패', err);
    }
  }

  /** 무단 통과 부대 공격(전쟁 없이). 막히면 이유. */
  async attack(to: string, key: string, power: number, cooldownMs: number): Promise<string> {
    const fb = getFirebase();
    if (!fb) return '서버에 연결되어 있지 않습니다';
    const now = sharedNow();
    const last = this.lastShot.get(`${to}|${key}`) ?? 0;
    if (now - last < cooldownMs)
      return `${Math.ceil((cooldownMs - (now - last)) / 1000)}초 뒤 다시 공격할 수 있습니다`;
    if (!(power > 0)) return '가까이에 대공·전투기·군함이 없습니다';
    this.lastShot.set(`${to}|${key}`, now);
    try {
      await addDoc(collection(fb.db, 'incidents'), {
        from: this.uid,
        to,
        key,
        at: now,
        power: Math.round(power * 10) / 10,
      });
      return '';
    } catch (err) {
      console.warn('공격 기록 실패', err);
      return '공격하지 못했습니다';
    }
  }
}
