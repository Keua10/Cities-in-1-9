import type { UnitType } from '../../sim/config/military';
import type { Unit } from '../../sim/military/army';
import { sharedNow } from '../../sim/sharedClock';

/** 대륙 지도에서 쓰는 이름표·색. 그리기와 목록이 같이 쓴다. */

export const UNIT_LETTER: Record<UnitType, string> = {
  infantry: '보',
  engineer: '공',
  artillery: '포',
  armor: '기',
  aa: '대',
  fighter: '전',
  bomber: '폭',
  ship: '함',
  missile: '미',
};

export const STATE_TEXT: Record<Unit['state'], string> = {
  training: '훈련 중',
  idle: '대기',
  moving: '이동',
  fighting: '전투 중',
  retreating: '후퇴',
};

/** 도시마다 다른 색(황금각으로 돌려 이웃 번호끼리 색이 멀다). */
export function cityColor(index: number, alpha: number): string {
  const hue = (index * 137.508) % 360;
  return `hsla(${hue.toFixed(0)}, 70%, 58%, ${alpha})`;
}

/** 마지막 접속이 얼마 전인가. */
export function ago(ms: number): string {
  if (ms <= 0) return '접속 기록 없음';
  const min = Math.floor((sharedNow() - ms) / 60_000);
  if (min < 60) return `${Math.max(1, min)}분 전`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

/** 지도에서 고른 것들. 지도·목록·입력이 같은 객체를 함께 본다. */
export interface MapSelection {
  /** 고른 도시 uid. */
  city: string | null;
  /** 고른 내 부대 id. */
  unit: string | null;
  /** 길게 눌러 고른 여러 부대(한꺼번에 이동·합치기). */
  picked: Set<string>;
  /** ✈ 를 누른 뒤: 다음 지도 누르기 = 공중 수송 목적지. */
  airlift: boolean;
}
