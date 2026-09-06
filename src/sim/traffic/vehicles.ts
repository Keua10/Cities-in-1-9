import type { TripPurpose } from '../citizens';
import type { JunctionPath } from './intersectionControl';
import type { Route } from './router';

export const enum VehicleKind {
  Car = 0,
  Truck = 1,
}

export interface Vehicle {
  kind: VehicleKind;
  tier: number;
  purpose: TripPurpose;
  route: Route;
  routeIdx: number;
  tileT: number;
  lane: number;
  speed: number;
  dir: number;
  destTx: number;
  destTy: number;

  /* ---- 3.2단계 교통 규칙에서 추가된 상태 ---- */

  /**
   * 난폭운전 성향.
   *
   * true 인 차량만 출구가 막혔는데도 교차로에 밀고 들어간다(=꼬리물기).
   * 비율은 AGGRESSIVE_DRIVER_PERCENT 로 조절한다. 성향은 차량이 만들어질 때
   * 한 번 정해지고 도착까지 바뀌지 않는다.
   */
  aggressive: boolean;
  /** 교차로 통행권을 기다린 누적 시간(ms). 우선순위 굶주림 방지에 쓴다. */
  waitMs: number;
  /** 정지선에서 멈춰 있던 시간(ms). 적신호 우회전의 "일시정지" 판정에 쓴다. */
  stoppedMs: number;
  /** 전혀 못 움직인 시간(ms). 교착 상태의 마지막 안전밸브. */
  stuckMs: number;
  /** 겹침 방지 장치에 붙잡혀 있던 시간(ms). 상호 교착을 푸는 데 쓴다. */
  frozenMs: number;

  /* ---- 교차로 통과 경로 캐시 ---- */
  jPath: JunctionPath | null;
  /** 캐시가 어느 경로에 대한 것인가. 재탐색하면 달라진다. */
  jPathRoute: Route | null;
  /** 캐시가 어느 교차로 색인 판(revision)에 대한 것인가. */
  jPathRev: number;
}
