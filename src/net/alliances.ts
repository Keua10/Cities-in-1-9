import {
  collection,
  doc,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import type { MacroSim } from '../sim/macro';
import {
  acceptBlock,
  allianceParties,
  alliesOf,
  isAllied,
  openWith,
  partnerOf,
  requestBlock,
  settleDelta,
  type AllianceDoc,
} from '../sim/military/allianceRules';
import { sharedNow } from '../sim/sharedClock';
import { getFirebase } from './firebase';

/**
 * 동맹 연결 (군사 5단계). alliances/{id} 문서 하나가 동맹 하나다(두 사람 모두 고칠 수 있다).
 * 돈은 각자 자기 기기에서만 움직인다: 낼 때는 버튼을 누른 쪽이 바로 빼고, 끝난 동맹은
 * 문서를 본 각자가 settleDelta 만큼 돌려받는다(macro.alliancesSettled 로 한 번만).
 */
export class AllianceSession {
  alliances: AllianceDoc[] = [];
  revision = 0;
  onNotice: ((text: string) => void) | null = null;
  /** 지금 이 도시와 전쟁 중인가(선전포고한 도시와는 동맹 불가). */
  atWarWith: (uid: string) => boolean = () => false;
  private unsub: Unsubscribe | null = null;
  private seen = new Map<string, string>();

  constructor(
    private uid: string,
    private sim: MacroSim,
    private myName: string,
  ) {}

  start(): void {
    const fb = getFirebase();
    if (!fb) return;
    this.unsub = onSnapshot(
      query(collection(fb.db, 'alliances'), where('parties', 'array-contains', this.uid)),
      (snap) => {
        this.alliances = snap.docs.map((d) => ({ ...(d.data() as AllianceDoc), id: d.id }));
        this.notices();
        this.settle();
        this.revision++;
      },
      (err) => console.warn('동맹 구독 실패', err),
    );
  }

  stop(): void {
    this.unsub?.();
  }

  allies(): string[] {
    return alliesOf(this.alliances, this.uid);
  }

  isAllied(other: string): boolean {
    return isAllied(this.alliances, this.uid, other);
  }

  openWith(other: string): AllianceDoc | undefined {
    return openWith(this.alliances, this.uid, other);
  }

  /** 나에게 온, 아직 답하지 않은 신청. */
  incoming(): AllianceDoc[] {
    return this.alliances.filter((a) => a.state === 'pending' && a.from !== this.uid);
  }

  private actor() {
    const m = this.sim.state;
    return {
      uid: this.uid,
      money: this.sim.money,
      surpriseAt: m.surpriseAt,
      betrayedAt: m.betrayedAt,
    };
  }

  requestWhy(them: string, deposit: number): string {
    return requestBlock({
      now: sharedNow(),
      me: this.actor(),
      them,
      deposit,
      alliances: this.alliances,
      atWarWith: this.atWarWith(them),
    });
  }

  async request(them: string, themName: string, deposit: number): Promise<string> {
    const fb = getFirebase();
    if (!fb) return '서버에 연결되어 있지 않습니다';
    const why = this.requestWhy(them, deposit);
    if (why) return why;
    const now = sharedNow();
    const parties = allianceParties(this.uid, them);
    const id = `${parties[0].slice(0, 8)}-${parties[1].slice(0, 8)}-${now}`;
    const data: Omit<AllianceDoc, 'id'> = {
      parties,
      from: this.uid,
      names: { [this.uid]: this.myName, [them]: themName },
      state: 'pending',
      deposit,
      createdAt: now,
    };
    this.sim.adjustMoney(-deposit);
    try {
      await setDoc(doc(fb.db, 'alliances', id), data);
      return '';
    } catch (err) {
      console.warn('동맹 신청 실패', err);
      this.sim.adjustMoney(deposit);
      return '동맹 신청을 보내지 못했습니다';
    }
  }

  async accept(id: string): Promise<string> {
    const fb = getFirebase();
    const a = this.alliances.find((x) => x.id === id);
    if (!fb || !a) return '신청을 찾지 못했습니다';
    const why = acceptBlock({
      now: sharedNow(),
      me: this.actor(),
      doc: a,
      alliances: this.alliances,
      atWarWith: this.atWarWith(partnerOf(a, this.uid)),
    });
    if (why) return why;
    this.sim.adjustMoney(-a.deposit);
    try {
      await updateDoc(doc(fb.db, 'alliances', id), {
        state: 'active',
        acceptedAt: sharedNow(),
        [`names.${this.uid}`]: this.myName,
      });
      return '';
    } catch (err) {
      console.warn('동맹 수락 실패', err);
      this.sim.adjustMoney(a.deposit);
      return '동맹을 맺지 못했습니다';
    }
  }

  /** 거절(받은 쪽)·취소(보낸 쪽)·해제(맺은 동맹). */
  async close(id: string): Promise<string> {
    const fb = getFirebase();
    const a = this.alliances.find((x) => x.id === id);
    if (!fb || !a) return '동맹을 찾지 못했습니다';
    const state = a.state === 'active' ? 'ended' : a.from === this.uid ? 'cancelled' : 'declined';
    try {
      await updateDoc(doc(fb.db, 'alliances', id), {
        state,
        endedAt: sharedNow(),
        endedBy: this.uid,
      });
      return '';
    } catch (err) {
      console.warn('동맹 정리 실패', err);
      return '처리하지 못했습니다';
    }
  }

  /** 선전포고한 상대와의 동맹을 깬다(배신). 신청 중이던 것은 취소. 배신이면 true. */
  async betray(them: string): Promise<boolean> {
    const fb = getFirebase();
    const a = this.openWith(them);
    if (!fb || !a) return false;
    const now = sharedNow();
    const broken = a.state === 'active';
    if (broken) this.sim.state.betrayedAt = now;
    try {
      await updateDoc(doc(fb.db, 'alliances', a.id), {
        state: broken ? 'broken' : a.from === this.uid ? 'cancelled' : 'declined',
        endedAt: now,
        endedBy: this.uid,
      });
    } catch (err) {
      console.warn('동맹 깨기 실패', err);
    }
    return broken;
  }

  private settle(): void {
    const m = this.sim.state;
    for (const a of this.alliances) {
      if (m.alliancesSettled?.[a.id]) continue;
      const delta = settleDelta(a, this.uid);
      if (delta === null) continue;
      m.alliancesSettled = { ...(m.alliancesSettled ?? {}), [a.id]: sharedNow() };
      if (delta) this.sim.adjustMoney(delta);
      else this.sim.onMacroChange?.();
    }
  }

  private notices(): void {
    for (const a of this.alliances) {
      const was = this.seen.get(a.id);
      this.seen.set(a.id, a.state);
      if (was === a.state) continue;
      const other = partnerOf(a, this.uid);
      const name = a.names[other] ?? '다른 도시';
      const fresh =
        was === undefined && sharedNow() - (a.endedAt ?? a.acceptedAt ?? a.createdAt) > 60_000;
      if (fresh) continue; // 예전 기록은 알리지 않는다
      const money = a.deposit ? ` · 보증금 ${a.deposit.toLocaleString()}만 원` : '';
      if (a.state === 'pending' && a.from !== this.uid)
        this.onNotice?.(`🤝 ${name}이(가) 동맹을 신청했습니다${money} · 대륙 지도에서 답하세요`);
      else if (a.state === 'active' && a.from === this.uid)
        this.onNotice?.(`🤝 ${name}과(와) 동맹을 맺었습니다`);
      else if (a.state === 'declined' && a.from === this.uid)
        this.onNotice?.(`${name}이(가) 동맹 신청을 거절했습니다`);
      else if (a.state === 'ended' && a.endedBy !== this.uid)
        this.onNotice?.(`${name}이(가) 동맹을 해제했습니다`);
      else if (a.state === 'broken' && a.endedBy !== this.uid)
        this.onNotice?.(
          `⚠ ${name}이(가) 동맹을 깨고 선전포고했습니다${a.deposit ? ` · 보증금 ${(a.deposit * 2).toLocaleString()}만 원을 받습니다` : ''}`,
        );
    }
  }
}
