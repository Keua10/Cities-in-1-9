import {
  DAYTIME_DAY_MS,
  GAMETIME_DAY_MS,
  GAMETIME_DAYS_PER_YEAR,
  SEASON_DAYS,
} from '../config/macro';
import { CONTINENT_Y0, CONTINENT_H } from '../../world/continent';
import { chunkTerrain } from './terrain';

/**
 * 전쟁용 밤·날씨 (설계안 Ⅵ: 밤에는 시야 절반, 비·눈에는 이동 −20%, 바람이 강하면 공군 정확도 감소).
 *
 * 모든 도시가 같은 날씨를 보도록 **공유 시계 시각과 청크 위치만으로** 정한다(저장·통신 없음).
 * 도시 화면 날씨(sim/nature.ts)도 이 값을 쓴다 — 전쟁 날씨가 따로 있지 않다.
 *   - 계절은 대륙 전체가 같다: 실제 60초 = 1일, 90일 = 한 계절(1배속 도시 달력과 같은 빠르기).
 *   - 하루 = 실제 10분(전시 1배속의 생활 하루). 20시~5시가 밤.
 *   - 날씨는 16×16청크 지역마다 실제 20분씩 바뀐다. 계절에 따라 확률이 다르다
 *     (여름 비 많음, 겨울 눈, 가을 바람). 북쪽 1/3 과 산은 봄·가을 비도 눈.
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

/** 대륙 공통 달력의 날(공유 시계 기준). 도시 배속과 상관없다. */
export function worldGameDay(now: number): number {
  return Math.floor(now / GAMETIME_DAY_MS);
}

/** 대륙 공통 계절 0 봄 · 1 여름 · 2 가을 · 3 겨울. */
export function worldSeason(now: number): 0 | 1 | 2 | 3 {
  const d =
    ((worldGameDay(now) % GAMETIME_DAYS_PER_YEAR) + GAMETIME_DAYS_PER_YEAR) %
    GAMETIME_DAYS_PER_YEAR;
  return Math.floor(d / SEASON_DAYS) as 0 | 1 | 2 | 3;
}

/** 계절별 [맑음까지, 비·눈까지] 누적 확률. 나머지는 강풍. */
const SEASON_ODDS: Record<0 | 1 | 2 | 3, [number, number]> = {
  0: [0.6, 0.88],
  1: [0.5, 0.88],
  2: [0.6, 0.8],
  3: [0.55, 0.88],
};

/** 북쪽(대륙 위 1/3)인가. */
function northern(cy: number): boolean {
  return cy < CONTINENT_Y0 + CONTINENT_H / 3;
}

export function weatherAt(now: number, cx: number, cy: number): Weather {
  const rx = Math.floor(cx / WEATHER_REGION);
  const ry = Math.floor(cy / WEATHER_REGION);
  const period = Math.floor(now / WEATHER_PERIOD_MS);
  const r = hash3(rx, ry, period);
  const season = worldSeason(now);
  const [clear, wet] = SEASON_ODDS[season];
  if (r < clear) return 'clear';
  if (r < wet) {
    if (season === 3) return 'snow';
    if (season === 1) return 'rain';
    const k = chunkTerrain(cx, cy).kind;
    return northern(cy) || k === 'mountain' ? 'snow' : 'rain';
  }
  return 'wind';
}

/** 비·눈의 세기 0.3~1(같은 지역·같은 때는 같다). */
export function weatherIntensity(now: number, cx: number, cy: number): number {
  const rx = Math.floor(cx / WEATHER_REGION);
  const ry = Math.floor(cy / WEATHER_REGION);
  return 0.3 + 0.7 * hash3(rx + 7, ry - 3, Math.floor(now / WEATHER_PERIOD_MS));
}

/** 기온(°C): 계절(대륙 공통) + 위도(북쪽이 춥다) + 하루 중 시각. */
export function temperatureAt(now: number, cy: number): number {
  const d =
    ((worldGameDay(now) % GAMETIME_DAYS_PER_YEAR) + GAMETIME_DAYS_PER_YEAR) %
    GAMETIME_DAYS_PER_YEAR;
  const lat = (cy - CONTINENT_Y0) / CONTINENT_H; // 0 북 ~ 1 남
  return (
    12 +
    17 * Math.sin((2 * Math.PI * (d - 45)) / GAMETIME_DAYS_PER_YEAR) +
    (lat - 0.5) * 10 +
    4 * Math.sin(((hourAt(now) - 9) / 24) * Math.PI * 2)
  );
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
