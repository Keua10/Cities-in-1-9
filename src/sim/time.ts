import {
  DAYLIGHT_SWING_HOURS,
  DAYTIME_DAY_MS,
  GAMETIME_DAYS_PER_YEAR,
  LIFE_SLOT_MINUTES,
  SEASON_DAYS,
} from './simConstants';

export const enum Season {
  Spring = 0,
  Summer = 1,
  Autumn = 2,
  Winter = 3,
}

export const SEASON_NAMES: readonly string[] = ['봄', '여름', '가을', '겨울'];
export const WEEKDAY_NAMES: readonly string[] = ['월', '화', '수', '목', '금', '토', '일'];

export interface DaytimeSnapshot {
  /** Unix epoch 기준 daytime 일 번호. 저장할 필요가 없다. */
  absoluteDay: number;
  /** Unix epoch 기준 daytime 절대 시각(시간 단위, 정수). */
  absoluteHour: number;
  /** 생활 스케줄용 15분 슬롯의 절대 인덱스. */
  absoluteLifeSlot: number;
  /** 0~24, 소수 포함. */
  hour: number;
  /** 0~23. */
  hourOfDay: number;
  /** 0~1439. */
  minuteOfDay: number;
  /** 0~95 (LIFE_SLOT_MINUTES=15 기준). */
  lifeSlotOfDay: number;
  /** 0=월 ... 6=일. accelerated daytime 달력의 요일이다. */
  weekday: number;
  isWeekend: boolean;
  season: Season;
  daylightHours: number;
  sunriseHour: number;
  sunsetHour: number;
  isDay: boolean;
  /** 현재 gametime 연중 일자 0~359. */
  gameDayOfYear: number;
}

/**
 * daytime은 실제 벽시계에서 계속 흐르는 가속 생활 시계다.
 * 600초마다 하루가 정확히 한 번 돌며, 출퇴근/장보기/향후 밤낮 렌더링이
 * 모두 같은 snapshot을 읽는다. 일출/일몰은 환경 표현일 뿐 출근 시각을 바꾸지 않는다.
 */
export function daytimeAt(epochMs: number, gameDay: number): DaytimeSnapshot {
  const absoluteDay = Math.floor(epochMs / DAYTIME_DAY_MS);
  const withinDayMs = positiveMod(epochMs, DAYTIME_DAY_MS);
  const minuteOfDay = Math.floor((withinDayMs / DAYTIME_DAY_MS) * 1440);
  const hour = minuteOfDay / 60;
  const hourOfDay = Math.floor(hour) % 24;
  const absoluteHour = absoluteDay * 24 + hourOfDay;
  const slotsPerDay = 1440 / LIFE_SLOT_MINUTES;
  const lifeSlotOfDay = Math.floor(minuteOfDay / LIFE_SLOT_MINUTES);
  const absoluteLifeSlot = absoluteDay * slotsPerDay + lifeSlotOfDay;
  const weekday = positiveMod(absoluteDay, 7);

  const gameDayOfYear = positiveMod(gameDay, GAMETIME_DAYS_PER_YEAR);
  const daylightHours =
    12 + DAYLIGHT_SWING_HOURS * Math.sin((Math.PI * 2 * gameDayOfYear) / GAMETIME_DAYS_PER_YEAR);
  const sunriseHour = 12 - daylightHours / 2;
  const sunsetHour = 12 + daylightHours / 2;
  const season = Math.floor(gameDayOfYear / SEASON_DAYS) as Season;

  return {
    absoluteDay,
    absoluteHour,
    absoluteLifeSlot,
    hour,
    hourOfDay,
    minuteOfDay,
    lifeSlotOfDay,
    weekday,
    isWeekend: weekday >= 5,
    season,
    daylightHours,
    sunriseHour,
    sunsetHour,
    isDay: hour >= sunriseHour && hour < sunsetHour,
    gameDayOfYear,
  };
}

function positiveMod(value: number, mod: number): number {
  const r = value % mod;
  return r < 0 ? r + mod : r;
}
