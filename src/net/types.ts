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

/** 3단계에서 채울 매크로 상태. 지금은 자리만 잡아둔다. */
export interface MacroState {
  /** 도시 자금. 3단계 전까지는 서버가 검증하지 않는다. */
  money: number;
  population: number;
  /** 이 도시가 소화한 시뮬레이션 틱 수. 오프라인 따라잡기 계산의 기준점. */
  tick: number;
  /** 마지막으로 시뮬레이션이 진행된 실제 시각(ms). 접속 공백을 재는 데 쓴다. */
  tickedAt: number;
}

export function emptyMacro(): MacroState {
  return { money: 0, population: 0, tick: 0, tickedAt: Date.now() };
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
  updatedAt: number;
}

/** 저장/불러오기가 주고받는 청크 단위 묶음. */
export interface ChunkPayload {
  cx: number;
  cy: number;
  tiles: Uint8Array | null;
  heights: Uint8Array | null;
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
