import type { NatureState } from '../sim/nature';
import type { ConstructionJob } from '../sim/construction';
import type { DisasterState } from '../sim/disasterTypes';
import type { MetroState } from '../sim/metro';
import type { CityPolicies } from '../sim/policies';
import type { TerritoryState } from '../sim/territory';
import { START_MONEY } from '../sim/simConstants';

export interface HarborAllocation {
  passenger: number;
  cargo: number;
}

/** STEP 4.6+ sparse transport settings. Facility placement itself still lives in chunk bld/build. */
export interface TransportState {
  /** Hybrid harbor allocation keyed by anchor tile "tx,ty". */
  harbors?: Record<string, HarborAllocation>;
}

/**
 * 매크로 상태. 파생값은 저장하지 않고, 사용자가 직접 정한 희소 설정만 선택 필드로 저장한다.
 */
export interface MacroState {
  lifeElapsedMs?: number;
  nature?: NatureState;
  construction?: ConstructionJob[];
  /** 공사를 마지막으로 진행시킨 실제 시각(ms). 접속하지 않은 동안의 공사를 이어서 계산한다. */
  constructionAt?: number;
  /** 스타트 버닝 남은 시간(접속한 플레이 시간 ms). */
  startBoostMs?: number;
  /** 스타트 버닝을 이미 받았는지. 도시마다 한 번만 준다. */
  startBoostGiven?: boolean;
  metro?: MetroState;
  /** Explicit road signal controls: true installs, false suppresses automatic placement. */
  signalOverrides?: Record<string, boolean>;
  /** STEP 4.7: already explored legacy terrain. Empty list means migration is complete. */
  legacyTerrainChunks?: string[];
  policies?: CityPolicies;
  sanitationStartTick?: number;
  powerStartTick?: number;
  waterStartTick?: number;
  prosperity?: number;
  /** 식량 비축량 (sim/food.ts). */
  food?: number;
  /** 자원 비축 {iron, coal, oil} (sim/resources.ts). */
  resources?: Record<string, number>;
  /** 청크별로 캔 양 "cx,cy" → 단위. 매장량 = 처음 매장량 - 이 값. */
  mined?: Record<string, number>;
  /** 정산을 마친 전쟁 id → 시각(배상을 두 번 주고받지 않게). */
  warsSettled?: Record<string, number>;
  /** 마지막으로 기습한 시각(대가: 24시간 동맹 불가). */
  surpriseAt?: number;
  /** 전쟁이 시작된 시각(전쟁 피로). 평시에는 없음. */
  warSince?: number;
  /** 마지막 전쟁이 끝난 시각과 결과(전후 복구·승전 기분). */
  warEndedAt?: number;
  warOutcome?: 'win' | 'lose' | 'draw';
  /** 부대가 가 본 청크(대륙 지도에서 선명하게 보인다). */
  scouted?: string[];
  /** 내가 진영 대표로 항복을 신청한 전쟁 id(정산 확인용). */
  surrenderSent?: string;
  /** 영해·영공 통과 규율(피드백 1차). */
  passRule?: 'open' | 'notify' | 'permit';
  /** 마지막으로 본 공지 시각. */
  noticeSeenAt?: number;
  /** 마지막으로 실행한 관리자 지시 id. */
  adminOrderDone?: string;
  /** 마지막으로 동맹을 배신한 시각(24시간 새 동맹 불가). */
  betrayedAt?: number;
  /** 정산을 마친 동맹 id → 시각(보증금을 두 번 주고받지 않게). */
  alliancesSettled?: Record<string, number>;
  /** 군대 (sim/military/army.ts ArmyState). */
  army?: import('../sim/military/army').ArmyState;
  /** 영토·수도 (sim/territory.ts). 없으면 시작 영토 4×4 로 만든다. */
  territory?: TerritoryState;
  /** Hybrid harbor passenger/cargo allocation. Old saves simply have no field. */
  transport?: TransportState;
  /**
   * 이 도시를 만든 생성 씨앗.
   *
   * 관리자 도구의 "대도시 생성" 은 새 씨앗을 뽑아서 여기 적고 새로고침한다.
   * 그래야 누를 때마다 다른 대도시가 나오고, 같은 도시를 다시 열었을 때는
   * 같은 도시가 나온다. 필드가 없으면 대도시를 한 번도 만들지 않은 도시다.
   */
  genSeed?: number;
  /**
   * 대도시 생성 요청. **이게 없으면 대도시는 절대 만들어지지 않는다.**
   *
   * 새 학생의 도시는 빈 땅 + 시작 자금으로 시작하는 것이 기본이다. 대도시는
   * 관리자 도구가 이 값을 켜고 새로고침했을 때만 생성되고, 생성기가 도시를
   * 심고 나면 부팅 코드가 이 키를 **지운 뒤 저장한다**(한 번만 쓰이는 값).
   */
  metropolisRequest?: boolean;
  money: number;
  population: number;
  tick: number;
  tickedAt: number;
  disasters?: DisasterState;
}

export function emptyMacro(): MacroState {
  return { money: START_MONEY, population: 0, tick: 0, tickedAt: Date.now() };
}

export interface AdminOrder {
  id: string;
  kind: 'reset' | 'grant';
  /** grant: 줄 돈(만 원). */
  amount?: number;
  at: number;
}

export interface CityDoc {
  schemaVersion: number;
  /** 도시 번호. 지도 v2 부터 위치와 무관하고 이름·관리용으로만 쓴다. */
  cityIndex: number;
  /**
   * 학생이 시작 화면에서 고른 시작 영토(4×4 청크) 왼쪽 위 청크 "cx,cy".
   * 한 번 정해지면 Firestore 규칙이 바꾸지 못하게 막는다.
   */
  origin?: string;
  /** 이 도시가 만들어진 지도 판. 다르면 도시를 초기화하고 자리를 다시 고른다. */
  mapVersion?: number;
  displayName: string;
  cityName: string;
  explored: string[];
  macro: MacroState;
  /** 관리자가 남긴 지시(다음 접속 때 이 도시 기기가 실행한다). */
  adminOrder?: AdminOrder;
  saveToken: string;
  saveCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChunkDoc {
  wires?: string | null;
  pipes?: string | null;
  roadLinks?: string | null;
  tiles: string | null;
  heights: string | null;
  build: string | null;
  bld: string | null;
  bornLo: string | null;
  bornHi: string | null;
  updatedAt: number;
}

export interface ChunkPayload {
  wires?: Uint8Array | null;
  pipes?: Uint8Array | null;
  roadLinks?: Uint8Array | null;
  cx: number;
  cy: number;
  tiles: Uint8Array | null;
  heights: Uint8Array | null;
  build: Uint8Array | null;
  bld: Uint8Array | null;
  bornLo: Uint8Array | null;
  bornHi: Uint8Array | null;
}

export function newSaveToken(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}
