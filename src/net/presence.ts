import { doc, getDoc, serverTimestamp, setDoc, Timestamp } from 'firebase/firestore';
import { syncSharedClock } from '../sim/sharedClock';
import { getFirebase } from './firebase';

/**
 * 접속 표시 + 공유 시계 맞추기 (군사 3단계).
 *
 * 화면을 보고 있는 동안 1분마다 presence/{uid} 에 서버 시각을 적는다. 다른 도시는 대륙
 * 지도를 열 때 이 값을 읽어 "최근 3분 안에 적혔으면 접속 중" 으로 본다. 실시간 구독을
 * 쓰지 않는 이유: 학생 20명이 서로를 구독하면 쓰기 한 번에 읽기가 20번씩 붙어 무료 한도를
 * 금방 넘는다. 대신 지도를 볼 때만 읽는다.
 *
 * 적은 직후 한 번 읽어 서버 시각을 받아 공유 시계(sim/sharedClock.ts)를 맞춘다.
 */

export const PRESENCE_INTERVAL_MS = 60_000;
/** 마지막 기록이 이보다 오래되면 접속 안 함으로 본다. */
export const PRESENCE_ONLINE_MS = 3 * 60_000;

export class Presence {
  private timer: number | null = null;
  private stopped = false;
  private beats = 0;

  constructor(
    private uid: string,
    private cityIndex: number,
  ) {}

  start(): void {
    const beat = () => {
      if (this.stopped) return;
      if (document.visibilityState === 'visible') void this.beat();
      this.timer = window.setTimeout(beat, PRESENCE_INTERVAL_MS);
    };
    beat();
    document.addEventListener('visibilitychange', this.onVisible);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  private onVisible = (): void => {
    if (document.visibilityState === 'visible') void this.beat();
  };

  private async beat(): Promise<void> {
    const fb = getFirebase();
    if (!fb) return;
    const ref = doc(fb.db, 'presence', this.uid);
    try {
      await setDoc(ref, { at: serverTimestamp(), city: this.cityIndex });
      // 시계는 처음 몇 번과 그 뒤 10번에 한 번만 다시 맞춘다(읽기 아끼기).
      if (this.beats++ < 3 || this.beats % 10 === 0) {
        const before = Date.now();
        const snap = await getDoc(ref);
        const after = Date.now();
        const at = snap.get('at');
        if (at instanceof Timestamp) syncSharedClock(at.toMillis(), before, after);
      }
    } catch (err) {
      console.warn('접속 표시 실패', err);
    }
  }
}
