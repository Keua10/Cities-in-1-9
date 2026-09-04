import {
  SAVE_DEBOUNCE_MS,
  SAVE_MIN_INTERVAL_MS,
  SAVE_SIM_INTERVAL_MS,
} from '../core/constants';
import type { World } from '../world/world';
import { ConflictError, saveCity } from './citySave';
import type { CityDoc } from './types';

export type SaveStatus =
  | 'offline' // 서버 없이 실행 중. 저장하지 않는다.
  | 'idle' // 저장할 게 없다.
  | 'pending' // 바뀐 게 있고 곧 저장된다.
  | 'saving'
  | 'saved'
  | 'error' // 실패. 다음 주기에 다시 시도한다.
  | 'conflict'; // 다른 기기가 가져갔다. 더는 저장하지 않는다.

/**
 * 언제 저장할지 정하는 곳.
 *
 * Spark 무료 한도는 하루 쓰기 2만 건이다. 학생 20명이 동시에 논다고 보면
 * 저장 한 번에 문서 2~5개가 나가므로, 아무 생각 없이 5초마다 저장하면
 * 수업 두 시간 만에 한도를 넘긴다. 그래서 두 겹으로 막는다.
 *
 *   1) 바뀐 게 있을 때만 저장한다. 가만히 있으면 쓰기가 0이다.
 *   2) 마지막 변경 후 5초 조용해야 저장하고, 저장 간 간격은 최소 60초다.
 *
 * 대신 학생이 앱을 닫거나 탭을 옮길 때는 간격을 무시하고 즉시 저장한다.
 * 작업을 잃는 것보다 쓰기 한 건이 싸다.
 */
export class SaveManager {
  status: SaveStatus = 'idle';
  /** 상태가 바뀔 때마다 불린다. UI 배너가 여기에 물린다. */
  onStatus: ((status: SaveStatus, message: string) => void) | null = null;

  private timer: number | null = null;
  private lastSaveAt = 0;
  private saving = false;
  /** 충돌이 나면 잠근다. 새로고침 전까지 저장하지 않는다. */
  private locked = false;
  private detach: (() => void) | null = null;
  /** 청크는 그대로인데 돈·틱만 바뀐 경우. 도시 문서만 다시 써야 한다. */
  private macroDirty = false;

  constructor(
    private world: World,
    private uid: string,
    private token: string,
    private city: CityDoc,
  ) {}

  /** 월드의 변경 알림과 브라우저 생명주기에 붙는다. */
  start(): void {
    this.world.onDirty = () => this.schedule();

    const onHidden = (): void => {
      if (document.visibilityState === 'hidden') void this.flush(true);
    };
    const onPageHide = (): void => {
      void this.flush(true);
    };
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onPageHide);

    this.detach = () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onPageHide);
    };
    this.setStatus('idle');
  }

  stop(): void {
    this.world.onDirty = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.detach?.();
    this.detach = null;
  }

  /** 학생이 저장 버튼을 눌렀을 때. 최소 간격을 무시한다. */
  saveNow(): Promise<void> {
    return this.flush(true);
  }

  /** 매크로가 돈·틱을 바꿨을 때. 청크가 안 바뀌어도 도시 문서는 갱신해야 한다. */
  noteMacroChange(): void {
    this.macroDirty = true;
    this.schedule();
  }

  /**
   * 다음 저장까지 기다릴 시간.
   * 학생이 직접 고친 게 섞여 있으면 짧게(60초), 시뮬레이션이 혼자 지은 것만
   * 쌓였으면 길게(10분) 잡는다. 이유는 constants.ts 의 SAVE_SIM_INTERVAL_MS 참고.
   */
  private minInterval(): number {
    return this.world.hasUserEdits() ? SAVE_MIN_INTERVAL_MS : SAVE_SIM_INTERVAL_MS;
  }

  private schedule(): void {
    if (this.locked) return;
    if (this.timer !== null) return;

    const now = Date.now();
    const sinceLast = now - this.lastSaveAt;
    const wait = Math.max(SAVE_DEBOUNCE_MS, this.minInterval() - sinceLast);

    this.setStatus('pending');
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.flush(false);
    }, wait);
  }

  private async flush(force: boolean): Promise<void> {
    if (this.locked || this.saving) return;
    if (!this.world.hasUnsaved() && !this.macroDirty) {
      if (this.status === 'pending') this.setStatus('idle');
      return;
    }
    if (!force && Date.now() - this.lastSaveAt < this.minInterval()) {
      this.schedule();
      return;
    }

    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const taken = this.world.takeDirty();
    this.macroDirty = false;
    this.saving = true;
    this.setStatus('saving');

    try {
      await saveCity(
        this.uid,
        this.token,
        {
          explored: this.world.exploredKeys(),
          macro: this.city.macro,
          cityName: this.city.cityName,
        },
        taken.chunks,
      );
      this.lastSaveAt = Date.now();
      this.setStatus('saved');
    } catch (err) {
      // 저장에 실패했으면 변경 표시를 되돌려서 다음에 다시 시도한다.
      this.world.restoreDirty(taken.keys);
      this.macroDirty = true;
      if (err instanceof ConflictError) {
        this.locked = true;
        this.setStatus('conflict');
      } else {
        console.error('저장 실패', err);
        this.setStatus('error');
        this.schedule();
      }
    } finally {
      this.saving = false;
    }
  }

  private setStatus(status: SaveStatus): void {
    this.status = status;
    this.onStatus?.(status, describe(status));
  }
}

function describe(status: SaveStatus): string {
  switch (status) {
    case 'offline':
      return '오프라인 — 저장되지 않습니다';
    case 'idle':
      return '저장됨';
    case 'pending':
      return '변경사항 있음';
    case 'saving':
      return '저장 중…';
    case 'saved':
      return '저장됨';
    case 'error':
      return '저장 실패 — 다시 시도합니다';
    case 'conflict':
      return '다른 기기에서 접속했습니다. 새로고침하세요';
  }
}

/** 서버 없이 도는 경우에 쓰는 빈 껍데기. main.ts 가 분기 없이 쓰게 해준다. */
export class OfflineSaveManager {
  status: SaveStatus = 'offline';
  onStatus: ((status: SaveStatus, message: string) => void) | null = null;

  start(): void {
    this.onStatus?.('offline', describe('offline'));
  }

  stop(): void {
    /* 할 일 없음 */
  }

  saveNow(): Promise<void> {
    return Promise.resolve();
  }

  noteMacroChange(): void {
    /* 할 일 없음 */
  }
}

export type AnySaveManager = SaveManager | OfflineSaveManager;
