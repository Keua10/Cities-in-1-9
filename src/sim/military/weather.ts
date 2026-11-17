import { DAYTIME_DAY_MS } from '../config/macro';
import { CONTINENT_Y0, CONTINENT_H } from '../../world/continent';
import { chunkTerrain } from './terrain';

/**
 * 전쟁용 밤·날씨 (설계안 Ⅵ: 밤에는 시야 절반, 비·눈에는 이동 −20%, 바람이 강하면 공군 정확도 감소).
 *
 * 두 기기가 같은 날씨를 보도록 **공유 시계 시각과 청크 위치만으로** 정한다(저장·통신 없음).
 *   - 하루 = 실제 10분(전시 1배속의 생활 하루). 20시~5시가 밤.
 *   - 날씨는 16×16청크 지역마다 실제 20분씩 바뀐다. 북쪽 1/3 과 산은 비 대신 눈.
 */

export type Weather = 'clear' | 'rain' | 'snow' | 'wind';

export const WEATHER_PERIOD_MS = 20 * 60_000;
export const WEATHER_REGION = 16;
/** 비·눈: 땅 부대 이동 배율. */
export const WET_MOVE = 0.8;
/** 강풍: 공군 공격(폭격 포함) 배율. */
export const WIND_AIR = 0.7;
/** 밤: 부대 시야(청크). 낮은 2. */
export const NIGHT_VISION = 1;

export const WEATHER_NAMES: Record<Weather, string> = {
  clear: '맑음',
  rain: '비',
  snow: '눈',
  wind: '강풍',
};

function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1) ^ Math.imul(c, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 지금 시각(실제 ms) 기준 생활 시각 0~24. */
export function hourAt(now: number): number {
  const f = (((now % DAYTIME_DAY_MS) + DAYTIME_DAY_MS) % DAYTIME_DAY_MS) / DAYTIME_DAY_MS;
  return f * 24;
}

export function isNight(now: number): boolean {
  const h = hourAt(now);
  return h >= 20 || h < 5;
}

export function weatherAt(now: number, cx: number, cy: number): Weather {
  const rx = Math.floor(cx / WEATHER_REGION);
  const ry = Math.floor(cy / WEATHER_REGION);
  const period = Math.floor(now / WEATHER_PERIOD_MS);
  const r = hash3(rx, ry, period);
  if (r < 0.62) return 'clear';
  if (r < 0.86) {
    const north = cy < CONTINENT_Y0 + CONTINENT_H / 3;
    const k = chunkTerrain(cx, cy).kind;
    return north || k === 'mountain' ? 'snow' : 'rain';
  }
  return 'wind';
}

/** 땅 부대 이동 배율(비·눈 −20%). */
export function weatherMove(now: number, cx: number, cy: number): number {
  const w = weatherAt(now, cx, cy);
  return w === 'rain' || w === 'snow' ? WET_MOVE : 1;
}

/** 공군 공격 배율(강풍 −30%). */
export function weatherAir(now: number, cx: number, cy: number): number {
  return weatherAt(now, cx, cy) === 'wind' ? WIND_AIR : 1;
}

/** 부대 시야(밤이면 절반). */
export function visionAt(now: number, day: number): number {
  return isNight(now) ? NIGHT_VISION : day;
}
