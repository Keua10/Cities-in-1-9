import { START_MONEY } from '../sim/simConstants';

/**
 * Firestore 에 실제로 저장되는 것들의 타입.
 *
 * 대원칙: **지형과 고도는 저장하지 않는다.**
 * 지형은 (좌표, WORLD_SEED) 에서 항상 같은 값이 나오므로 클라이언트가 매번 다시
 * 만든다. Firestore 에는 "생성값과 달라진 부분" 과 도시의 상태만 들어간다.
 *
 * 문서 경로
 *   meta/registry            도시 번호 발급기 (nextIndex 하나만 들어있다)
 *   cities/{uid}             도시 1개 = 계정 1개. 문서 ID 가 곧 로그인 UID 다.
 *   cities/{uid}/chunks/{cx}_{cy}   그 청크에서 생성값과 달라진 타일들
 *
 * 도시 문서 ID 를 UID 로 둔 이유:
 *   - 보안 규칙이 `request.auth.uid == cityId` 한 줄로 끝난다(추가 읽기 0회).
 *   - 한 계정이 도시 두 개를 가지는 게 구조적으로 불가능해진다.
 */

/**
 * 매크로 상태. 3.1단계에서 실제로 쓰이기 시작했다.
 *
 * **여기 있는 네 개가 전부다.** 인구 구성, 수요, 만족도, 입주율, 통근 거리는
 * 저장하지 않는다. 전부 (건물 배치 + 도로 배치 + 틱) 에서 다시 계산되는
 * 값이고, 매 틱 변하는 값을 저장하면 도시의 모든 청크가 매 틱 저장 대상이
 * 되어 Spark 무료 한도가 하루 만에 날아간다.
 *
 * 필드가 1단계와 같으므로 SCHEMA_VERSION 은 그대로 둔다.
 */
export interface MacroState {
  /** 도시 자금. 3.1단계에서는 클라이언트가 계산한다. */
  money: number;
  /** 표시용 인구. 접속 직후 시뮬레이션이 돌기 전에도 보여주려고 넣어둔다. */
  population: number;
  /** 이 도시가 소화한 시뮬레이션 틱 수 = 게임 내 경과 시간(시간 단위). */
  tick: number;
  /** 마지막으로 시뮬레이션이 진행된 실제 시각(ms). 접속 공백을 재는 데 쓴다. */
  tickedAt: number;
}

export function emptyMacro(): MacroState {
  return { money: START_MONEY, population: 0, tick: 0, tickedAt: Date.now() };
}

/** cities/{uid} 문서. */
export interface CityDoc {
  schemaVersion: number;
  /** 육각 격자 위 도시 번호. 한 번 배정되면 절대 안 바뀐다(바뀌면 도시가 순간이동한다). */
  cityIndex: number;
  /** 학생이 보는 이름. 지금은 로그인 아이디에서 자동으로 만든다. */
  displayName: string;
  cityName: string;
  /** 개척한 청크 키 목록("cx,cy"). base 4x4 는 항상 포함된다. */
  explored: string[];
  macro: MacroState;
  /**
   * 지금 이 도시를 조종 중인 세션 표식.
   * 로그인할 때마다 새로 발급하고, 저장할 때 값이 다르면 저장을 거부한다.
   * = 나중에 접속한 기기가 이긴다. 먼저 있던 기기는 저장 실패로 알게 된다.
   */
  saveToken: string;
  saveCount: number;
  createdAt: number;
  updatedAt: number;
}

/** cities/{uid}/chunks/{cx}_{cy} 문서. 값은 RLE + base64 문자열이다. */
export interface ChunkDoc {
  /** 지형 오버레이. 바뀐 타일이 하나도 없으면 null. */
  tiles: string | null;
  /** 고도 오버레이(터레이닝). 지금은 항상 null 이지만 자리는 잡아둔다. */
  heights: string | null;
  /**
   * 2단계에서 추가. 도로·지구 레이어. 형식은 tiles 와 완전히 같다.
   *
   * 순수 가산이라 SCHEMA_VERSION 을 올리지 않는다. 1단계에 저장된 문서에는 이
   * 필드가 없고, decodeOverride(null) 이 null 을 돌려주므로 "아무것도 안 지음"
   * 으로 자연스럽게 읽힌다. 마이그레이션 코드가 필요 없다.
   */
  build: string | null;
  /**
   * 3.1단계에서 추가. 건물 레이어와 건설 날짜(하위/상위 8비트).
   * build 와 형식이 완전히 같고, 순수 가산이라 SCHEMA_VERSION 을 올리지 않는다.
   * 2단계까지 저장된 문서에는 이 필드가 없고 decodeOverride(null) 이 null 을
   * 돌려주므로 "건물 없음" 으로 자연스럽게 읽힌다.
   */
  bld: string | null;
  bornLo: string | null;
  bornHi: string | null;
  updatedAt: number;
}

/** 저장/불러오기가 주고받는 청크 단위 묶음. */
export interface ChunkPayload {
  cx: number;
  cy: number;
  tiles: Uint8Array | null;
  heights: Uint8Array | null;
  build: Uint8Array | null;
  bld: Uint8Array | null;
  bornLo: Uint8Array | null;
  bornHi: Uint8Array | null;
}

/**
 * 세션 표식 발급.
 * 여기서 Math.random 을 쓰는 건 괜찮다 — 지형 생성이 아니라 일회용 식별자다.
 * (지형 쪽에는 절대 Math.random 을 넣지 말 것.)
 */
export function newSaveToken(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}
