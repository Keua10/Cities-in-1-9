import { SIGNAL_ALL_RED_MS, SIGNAL_GREEN_MS, SIGNAL_YELLOW_MS } from '../simConstants';
import type { Junction } from './junctions';

/**
 * 신호등 — **교차로 영역 단위**로 돈다.
 *
 * 예전에는 타일마다 따로 위상을 계산했다(`phaseAt(tx, ty, t)`). 그래서
 *  1. 폭 2타일 도로에서는 직선 구간의 모든 타일이 교차로로 잡혀 신호가 켜졌고,
 *  2. 실제 교차로가 2x2 여도 네 칸의 위상이 제각각이라 한 칸은 초록, 옆 칸은
 *     빨강인 상태가 나왔다.
 *
 * 지금은 Junction 하나가 하나의 위상을 갖는다. 영역 안 모든 칸이 같은 신호다.
 *
 * ── 주기 ──────────────────────────────────────────────────────────
 *   [축0 녹색][축0 황색][전적색][축1 녹색][축1 황색][전적색]
 *
 * **전적색(all-red)** 구간이 핵심이다. 이게 없으면 황색 끝에 교차로 안에 남은
 * 차와 반대 축에서 막 출발한 차가 정확히 겹친다. 실제 신호기에 있는 것과
 * 같은 이유로 넣었다.
 *
 * 축 구분: DIRS 인덱스 0(+tx), 2(-tx) 가 축 0, 1(+ty), 3(-ty) 가 축 1이다.
 */

export const enum SignalState {
  Green = 0,
  Yellow = 1,
  Red = 2,
}

const PHASE_LEN = SIGNAL_GREEN_MS + SIGNAL_YELLOW_MS + SIGNAL_ALL_RED_MS;

/** 실제 한 주기 길이. simConstants 의 SIGNAL_CYCLE_MS 는 오프셋 해시 범위로만 쓴다. */
export const SIGNAL_PERIOD_MS = PHASE_LEN * 2;

/** 진입 방향이 속한 축(0 = ±tx, 1 = ±ty). */
export function signalAxis(dir: number): number {
  return dir & 1;
}

/** 교차로 영역의 현재 위상 시각(0 ~ SIGNAL_PERIOD_MS). */
function cycleTime(junction: Junction, timeMs: number): number {
  const t = (timeMs + junction.offsetMs) % SIGNAL_PERIOD_MS;
  return t < 0 ? t + SIGNAL_PERIOD_MS : t;
}

/** 이 진입 방향의 신호 상태. 신호가 없는 교차로는 항상 Green 을 돌려준다(=통행우선순위로 처리). */
export function signalState(junction: Junction, enterDir: number, timeMs: number): SignalState {
  if (!junction.signalized) return SignalState.Green;
  const t = cycleTime(junction, timeMs);
  const axis = signalAxis(enterDir);
  const mine = axis === 0 ? 0 : PHASE_LEN;
  const local = t - mine;
  if (local < 0 || local >= PHASE_LEN) return SignalState.Red;
  if (local < SIGNAL_GREEN_MS) return SignalState.Green;
  if (local < SIGNAL_GREEN_MS + SIGNAL_YELLOW_MS) return SignalState.Yellow;
  return SignalState.Red; // 전적색
}

/**
 * 지금 녹색인 축. -1 이면 "녹색인 축이 없다" — 황색과 전적색 구간 둘 다에서
 * -1 이 나온다(황색은 이미 녹색이 끝난 상태이므로 별도 취급하지 않는다).
 *
 * 현재는 어디서도 호출하지 않는 죽은 코드다. 렌더러(worldRenderer.ts)는 신호등을
 * 진입로 단위로 그리므로 signalState() 를 진입로별로 직접 불러 Green/Yellow/Red
 * 를 구분해 쓴다 — 축 단위로 뭉뚱그린 이 함수로는 황색을 표현할 수 없어서다.
 * 나중에 축 전체를 한 번에 다뤄야 하는 자리(예: 교차로 전체를 한 색으로 표시하는
 * 디버그 오버레이)가 생기면 그때 다시 쓸 수 있어 남겨둔다.
 */
export function greenAxis(junction: Junction, timeMs: number): number {
  if (!junction.signalized) return -1;
  const t = cycleTime(junction, timeMs);
  const local = t < PHASE_LEN ? t : t - PHASE_LEN;
  if (local >= SIGNAL_GREEN_MS) return -1;
  return t < PHASE_LEN ? 0 : 1;
}

/** 이 축의 녹색이 끝나기까지 남은 시간(ms). 이미 녹색이 아니면 0. */
export function greenRemainingMs(junction: Junction, enterDir: number, timeMs: number): number {
  if (!junction.signalized) return Number.POSITIVE_INFINITY;
  const t = cycleTime(junction, timeMs);
  const axis = signalAxis(enterDir);
  const mine = axis === 0 ? 0 : PHASE_LEN;
  const local = t - mine;
  if (local < 0 || local >= SIGNAL_GREEN_MS) return 0;
  return SIGNAL_GREEN_MS - local;
}
