import {
  collection,
  doc,
  onSnapshot,
  query,
  runTransaction,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import { PEACE_SPEED, WAR_SPEED } from '../sim/config/pace';
import { sharedNow } from '../sim/sharedClock';
import { rebase, setWorldClock, worldClockState, type WorldClockState } from '../sim/worldClock';
import { getFirebase } from './firebase';

/**
 * 대륙 공통 시계 연결 (피드백 1차).
 *
 *   meta/clock  { anchorReal, anchorWorld, rate }  — 세계 시각 기준점과 배속.
 *
 * 진행 중인 전쟁(준비·전투)을 지켜보다가, 대륙 어디에도 전쟁이 없으면 평시 배속, 하나라도
 * 있으면 1배속이 되도록 먼저 알아챈 기기가 기준점을 옮긴다(트랜잭션, 시각이 이어지게).
 */
export class WorldClockLink {
  private unsubs: Unsubscribe[] = [];
  private anyWar: boolean | null = null;
  private loaded = false;
  private exists = false;
  private busy = false;
  private lastTry = 0;
  /** 배속이 바뀌었다(화면 알림). */
  onRate: ((rate: number) => void) | null = null;

  start(): void {
    const fb = getFirebase();
    if (!fb) return;
    this.unsubs.push(
      onSnapshot(
        doc(fb.db, 'meta', 'clock'),
        (snap) => {
          this.loaded = true;
          this.exists = snap.exists();
          if (snap.exists()) {
            const before = worldClockState().rate;
            setWorldClock(snap.data() as WorldClockState);
            const after = worldClockState().rate;
            if (before !== after) this.onRate?.(after);
          }
          this.reconcile();
        },
        (err) => {
          // 규칙이 아직 게시되지 않았거나 읽지 못하면 이 기기에서만 평시 배속으로 흐른다.
          console.warn('세계 시계 구독 실패', err);
          const t = sharedNow();
          setWorldClock({ anchorReal: t, anchorWorld: t, rate: PEACE_SPEED });
        },
      ),
      onSnapshot(
        query(collection(fb.db, 'wars'), where('state', 'in', ['prep', 'active'])),
        (snap) => {
          this.anyWar = !snap.empty;
          this.reconcile();
        },
        (err) => console.warn('진행 중인 전쟁 구독 실패', err),
      ),
    );
    // 놓친 전환이 있으면 다시 맞춘다.
    window.setInterval(() => this.reconcile(), 15_000);
  }

  stop(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  /** 지금 있어야 할 배속과 문서가 다르면 기준점을 옮긴다. */
  private reconcile(): void {
    if (!this.loaded || this.anyWar === null || this.busy) return;
    const want = this.anyWar ? WAR_SPEED : PEACE_SPEED;
    if (this.exists && worldClockState().rate === want) return;
    const now = sharedNow();
    if (now - this.lastTry < 5_000) return;
    this.lastTry = now;
    const fb = getFirebase();
    if (!fb) return;
    this.busy = true;
    void runTransaction(fb.db, async (tx) => {
      const ref = doc(fb.db, 'meta', 'clock');
      const snap = await tx.get(ref);
      const t = sharedNow();
      if (!snap.exists()) {
        // 처음: 세계 시각 = 지금 공유 시계에서 시작.
        tx.set(ref, { anchorReal: t, anchorWorld: t, rate: want });
        return;
      }
      const cur = snap.data() as WorldClockState;
      if (cur.rate === want) return;
      setWorldClock(cur);
      tx.set(ref, rebase(t, want));
    })
      .catch((err) => console.warn('세계 시계 갱신 실패', err))
      .finally(() => {
        this.busy = false;
      });
  }
}
