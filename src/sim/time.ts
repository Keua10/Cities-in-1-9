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

/** 테스트 중에는 접속할 때마다 daytime을 월요일 07:30에서 시작한다. */
export const TEST_DAYTIME_START_MINUTE = 7 * 60 + 30;

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
 * daytime snapshot 계산기. 입력 ms를 DAYTIME_DAY_MS 주기의 가속 생활 시계로 변환한다.
 * 테스트 빌드에서는 아래 sessionDaytimeAt()이 접속 후 경과시간을 이 함수에 넘겨
 * 월요일 07:30에서 시작하도록 한다. 일출/일몰은 환경 표현일 뿐 출근 시각을 바꾸지 않는다.
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

/**
 * 테스트용 세션 시계. 페이지에 접속할 때마다 월요일 07:30에서 시작하고,
 * 이후에는 실제 벽시각이 아니라 앱이 실행된 경과시간만큼 진행한다.
 */
export function sessionDaytimeAt(sessionElapsedMs: number, gameDay: number): DaytimeSnapshot {
  const startOffsetMs = (TEST_DAYTIME_START_MINUTE / 1440) * DAYTIME_DAY_MS;
  return daytimeAt(Math.max(0, sessionElapsedMs) + startOffsetMs, gameDay);
}

function positiveMod(value: number, mod: number): number {
  const r = value % mod;
  return r < 0 ? r + mod : r;
}
