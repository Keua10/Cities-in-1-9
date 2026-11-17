/**
 * 대륙 공통 시계 (피드백 1차).
 *
 * 모든 도시가 같은 시계를 쓴다. 대륙 어디에도 전쟁(준비·전투)이 없으면 평시 배속(PEACE_SPEED)으로,
 * 한 곳이라도 전쟁이 있으면 1배속(WAR_SPEED)으로 흐른다. 배속은 개인이 정하지 않는다.
 *
 *   세계 시각 = anchorWorld + (공유 시계 − anchorReal) × rate
 *
 * 기준점(anchor)·배속은 서버 문서 meta/clock 에 있다(net/worldClock.ts 가 받아 와 넣는다).
 * 배속이 바뀔 때마다 기준점을 그 순간으로 옮겨 시각이 끊기지 않게 한다. 문서가 없으면(둘러보기·
 * 점검) 세계 시각 = 공유 시계.
 *
 * 낮·밤, 출퇴근, 계절, 날씨는 모두 세계 시각으로 계산한다(time.ts, military/weather.ts).
 */

export interface WorldClockState {
  /** 기준 공유 시계 시각(ms). */
  anchorReal: number;
  /** 그때의 세계 시각(ms). */
  anchorWorld: number;
  /** 배속(1 = 실제 시간). */
  rate: number;
}

let state: WorldClockState = { anchorReal: 0, anchorWorld: 0, rate: 1 };

/** 공유 시계 시각(ms) → 세계 시각(ms). */
export function worldAt(realMs: number): number {
  return state.anchorWorld + (realMs - state.anchorReal) * state.rate;
}

/** 지금 배속. */
export function worldRate(): number {
  return state.rate;
}

export function worldClockState(): Readonly<WorldClockState> {
  return state;
}

export function setWorldClock(next: WorldClockState): void {
  if (
    Number.isFinite(next.anchorReal) &&
    Number.isFinite(next.anchorWorld) &&
    Number.isFinite(next.rate) &&
    next.rate > 0
  )
    state = { anchorReal: next.anchorReal, anchorWorld: next.anchorWorld, rate: next.rate };
}

/** 배속을 바꾸는 새 기준점(지금 순간에서 이어지게). */
export function rebase(nowReal: number, rate: number): WorldClockState {
  return { anchorReal: nowReal, anchorWorld: worldAt(nowReal), rate };
}
