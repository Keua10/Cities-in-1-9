# Cities-in-1-9 — STEP 3.2 인수인계 (차량 마이크로 시뮬레이션)

> 이 문서는 Claude 가 구조를 확정한 뒤 ChatGPT 에게 세부 구현/디버깅을 맡기기 위한 핸드오프 문서다.
> **구조적 결정은 이미 끝났다. GPT 는 아래 명세를 그대로 구현하고, 세부 로직과 문법 오류만 처리한다. 명세 해석을 임의로 바꾸지 마라.**
> 이 문서에 있는 인터페이스/시그니처는 **뼈대**다. 이름·필드·파일 경로를 바꾸지 말고 본문만 채워라.

---

## 0. 이번 단계의 목표 — 왜 이렇게 만드는가

STEP 3.1 까지 도시는 "숫자" 로만 돌아간다. 인구도 통근도 전부 집계값이다.
STEP 3.2 는 그 위에 **실제로 움직이는 개별 객체** 를 얹는다.

### 이 게임이 고치려는 것

테오타운을 비롯한 기존 게임의 교통은 **최단거리 내비게이션** 하나로 끝난다.
바로 옆에 텅 빈 도로가 있어도 모든 차가 같은 길로 몰린다. 그래서 학생이 도로를
아무리 잘 설계해도 보상이 없다.

이 게임에서는 다르게 간다.

- 차량은 **혼잡을 비용에 포함해서** 경로를 고른다. 막히면 돌아간다.
- 혼잡도는 **실제 차량이 만든 값** 이다. 추정치가 아니다.
- 그래서 **우회로를 깔면 실제로 교통이 갈라진다.** 도로 설계가 성적표가 된다.

### 사람은 계속 움직이지 않는다

시민은 배경 소음이 아니라 **일정을 가진 개인** 이다.

- 개인마다 **직장 건물이 정해져 있다.** 취직한 것이고, 매일 같은 건물로 출퇴근한다.
- 출근 시각이 사람마다 조금씩 다르다. 전원이 8시 정각에 나오지 않는다.
- 생필품이 떨어지면 그때 장을 보러 간다. 상시 이동이 아니다.
- **소득 계층마다 행동이 다르다.**
  - 어디에 취직하는가 (계층 맞는 직장)
  - 얼마나 멀리까지 통근하는가
  - 어느 상업 건물에 가는가
  - 그리고 **막히는 걸 얼마나 참는가** — 이게 경로 선택을 갈라놓는다

이 네 가지가 합쳐져야 "현실감 있는 트래픽" 이 나온다. 차를 그냥 도로 위에
뿌리는 게 아니다.

---

## 1. 절대 변경 금지

기존 저장 데이터와 연결되어 있다. 값도 구조도 바꾸지 마라.

- `WORLD_SEED`, `TILE_W` / `TILE_H`, `HEIGHT_UNIT`, `CHUNK_SIZE`, `BASE_CHUNK_SPAN`, `BASE_SPACING_CHUNKS`
- `src/world/terrain.ts` 의 `hash2`, `valueNoise`, `fbm`
- `src/net/codec.ts` 의 저장·압축 형식, `SCHEMA_VERSION`
- `src/world/build.ts` 의 Build ID 0~3
- `src/sim/buildings.ts` 의 건물 코드 0~8, `BLD_NONE=255`, `BLD_COVERED=254`
- 청크 메시 구조 (청크당 1 draw call). 스프라이트 개별 렌더링으로 되돌리지 마라.
- `src/render/buildingMesh.ts` 의 건물 앵커 규칙

**시뮬레이션 안에서 `Math.random()` 과 `Date.now()` 금지.**
난수가 필요하면 `src/sim/buildings.ts` 의 `simHash` / `simRandom` 을 좌표와
틱 번호로 호출한다.

> 단 하나의 예외: **차량 마이크로 층은 실시간 프레임 위에서 돈다.**
> 자세한 건 3장.

---

## 2. 레이어 구조 (이번 단계의 핵심)

기존 두 층 위에 세 층이 더 얹힌다.

```
L0  매크로        건물·인구·수요·재정        전 도시   결정론   저장됨(물리 상태만)
L1  배정          누가 어느 건물에 취직/장보기  전 도시   결정론   저장 안 함
L2  혼잡          도로 타일별 혼잡도           전 도시   실측+추정 저장 안 함
L3  통행          누가 지금 어디로 출발하는가   활성영역  실시간   저장 안 함
L4  차량          경로·차간거리·신호등          활성영역  실시간   저장 안 함
```

**활성 영역** = 카메라 중심 청크 기준 `SIM_RADIUS_CHUNKS`(=1) 반경, 즉 3×3 청크.
`src/core/constants.ts` 에 이미 있다. 값 바꾸지 마라.

### 층마다 도는 범위가 다른 이유

L1(배정)과 L2(혼잡)는 **전 도시** 에서 돈다. 활성 영역 밖의 통근도 존재해야
경계를 넘어 들어오는 차가 만들어지고, 화면 밖 동네의 만족도도 계산된다.

L3(통행)와 L4(차량)만 활성 영역으로 제한한다. 여기가 프레임 예산을 먹는 곳이다.

### 화면 밖 혼잡도 — 반드시 지킬 것

차량은 활성 영역에서만 돈다. 그런데 화면 밖 도로의 혼잡도를 0 으로 두면
**학생이 안 보는 동네가 더 잘 자라게 된다.** 자기 도시를 들여다보면 손해 보는
구조가 되므로 절대 안 된다.

그래서 혼잡도는 이렇게 관리한다.

1. **실측 우선.** 활성 영역 안에서는 실제 차량 밀도를 관측해 기록한다.
2. **기록은 남는다.** 카메라가 떠나도 그 타일의 값은 사라지지 않고 천천히
   추정치 쪽으로 수렴한다.
3. **추정치로 메운다.** 한 번도 관측된 적 없는 도로는 L1 배정표에서 유도한
   통행량으로 초기값을 넣는다.

즉 혼잡도는 "차가 그린 그림" 이 아니라 **차가 실제로 만든 값이 도로에 남은 것**
이다. 그 값이 통근 만족도를 깎고 매크로를 움직인다.

### 결정론에 대한 정직한 기록

이 설계는 오프라인 캐치업 구간에서 완전 재현성을 포기한다. 캐치업 중에는 차량이
없으므로 그 구간의 혼잡도는 전부 추정치로 돈다. 온라인으로 계속 붙어 있던 도시와
방치했던 도시가 소수점까지 같은 숫자를 내지는 않는다.

**대신 방치한 쪽이 유리해지면 안 된다.** 추정치는 실측 평균보다 살짝 나쁘게
(=혼잡하게) 잡는다. `CONGESTION_ESTIMATE_BIAS` 가 그 값이다.
L0 매크로 자체(건물 성장·재개발·재정)의 결정론은 그대로 유지된다.

---

## 3. 시간축 — 매크로와 차량은 다른 시계를 쓴다

- 매크로: 1틱 = 게임 1시간 = 실시간 1초 (`MS_PER_TICK`, `TICKS_PER_DAY`)
- 차량: **프레임 `deltaMs` 기준 실시간**

차량을 매크로 시계에 묶으면 1초 만에 도시를 횡단해야 해서 화면이 말이 안 된다.
차량은 실시간으로 달리고, "지금 몇 시인가" 만 매크로의 `MacroSim.hourOfDay`
(이미 있음) 에서 읽어와 통행 발생량을 조절한다.

한 대의 차가 실제로 출발지에서 목적지까지 달려 도착한다. 목적지에 도착하면
그 통행은 완료되고 차는 사라진다. 통행 하나가 게임 시간 몇 시간에 해당하는지는
따지지 않는다.

---

## 4. 파일 명세

### 4.1 신규 파일

| 경로 | 역할 | 도는 범위 |
|---|---|---|
| `src/sim/assignment.ts` | 취직·상권 배정 | 전 도시, 하루 1회 |
| `src/sim/congestion.ts` | 도로 혼잡도 저장·갱신 | 전 도시 |
| `src/sim/citizens.ts` | 시민 유도, 생필품, 통행 발생 | 활성 영역 |
| `src/sim/traffic/router.ts` | 혼잡 가중 A* + 경로 캐시 | 활성 영역 |
| `src/sim/traffic/signals.ts` | 신호등 위상 (무상태) | — |
| `src/sim/traffic/vehicles.ts` | 차량 상태·이동·차간거리 | 활성 영역 |
| `src/sim/traffic/trafficSim.ts` | 마이크로 루프 총괄 | 활성 영역 |
| `src/render/vehicleAtlas.ts` | 차량 스프라이트 아틀라스 | — |
| `src/render/vehicleMesh.ts` | 청크당 차량 메시 | — |

### 4.2 수정 파일

| 경로 | 무엇을 |
|---|---|
| `src/sim/simConstants.ts` | 9장의 상수 추가 (저장 안 되는 파일이라 안전) |
| `src/sim/macro.ts` | `satisfaction()` 에 혼잡 항 추가, assignment/congestion 갱신 호출 |
| `src/sim/roadGraph.ts` | 도로 타일 목록 노출 + 타일 용량 계산 추가 |
| `src/render/worldRenderer.ts` | 차량 레이어 관리 |
| `src/main.ts` | 마이크로 루프 연결, 카메라 중심 청크 전달 |
| `src/core/constants.ts` | **주석 1줄만.** `MAX_ACTIVE_VEHICLES` 주석이 "4단계에서 사용" 으로 잘못 적혀 있다 → "3.2단계에서 사용". **값은 1000 그대로.** |
| `src/ui/hud.ts` | 차량 수 / 평균 혼잡도 표시 |

---

## 5. `src/sim/assignment.ts` — 취직과 상권

### 왜 필요한가

"개개인은 같은 건물로 출퇴근한다" 를 만드는 층이다. 통행이 발생할 때마다
목적지를 새로 뽑으면 매일 다른 회사에 출근하게 된다. 그건 트래픽이 아니라 난수다.

### 시민을 객체로 만들지 않는 이유

인구는 1만 명을 넘어간다. 시민 객체 1만 개를 매 틱 훑을 수 없다.
대신 **시민 = (주거건물 앵커 tx, ty, 슬롯 번호)** 로 유도한다. 객체를 만들지 않는다.

- 계층 = 그 건물의 등급
- 생활 리듬 오프셋 = `simRandom(WORLD_SEED, tx, ty, slot)` → 출근 시각 분산
- 직장 = 그 건물의 배정표를 슬롯 번호로 인덱싱

같은 슬롯은 항상 같은 직장으로 간다. 저장할 게 하나도 없다.

### 배정 알고리즘

하루 1회 (`ROAD_FIELD_INTERVAL` 과 같은 주기), `RoadField.rebuild()` 직후 실행.

1. 모든 직장 건물(상업·공업)의 **정원** 을 계층별 풀로 모은다
2. 모든 주거 건물을 훑으며, 그 건물의 **입주 인원(filled)** 만큼 직장 슬롯을 가져간다
3. 배정 우선순위: **계층 적합도 > 도로 거리**
4. 계층별 통근 인내 상한(`COMMUTE_RANGE_BY_TIER`)을 넘는 직장은 후보에서 제외
5. 남는 사람은 미취업으로 둔다 (통행을 만들지 않는다)

**계층 적합도 표** — 거주 계층 × 직장 등급 가중치

| 거주 | L1 직장 | L2 직장 | L3 직장 |
|---|---|---|---|
| L1 저소득 | 1.0 | 0.6 | 0.15 |
| L2 중산층 | 0.5 | 1.0 | 0.7 |
| L3 고소득 | 0.1 | 0.6 | 1.0 |

상권 배정도 같은 구조로 한 번 더 돌린다. 다른 점만:

- 목적지는 **상업 건물만**
- 거리 상한이 통근보다 훨씬 짧다 (`SHOP_RANGE_BY_TIER`)
- 주거 건물당 상권 링크는 최대 3곳까지 (생필품 종류가 아니라 선택지 분산용)
- L3 는 등급 높은 상업 건물을 강하게 선호하고 거리를 덜 본다

### 뼈대

```ts
// src/sim/assignment.ts
import type { World } from '../world/world';
import type { RoadField } from './roadGraph';
import type { CityStats } from './macro';

/** 주거 건물 하나에서 출발하는 통행 목적지 한 곳. */
export interface DestLink {
  /** 목적지 건물의 앵커 타일. */
  tx: number;
  ty: number;
  /** 이 목적지로 가는 인원 수. */
  count: number;
  /** 목적지 건물 등급 1~3. 차종·경로 가중치에 쓴다. */
  level: number;
  /** 목적지 지구 (ZONE_C / ZONE_I). */
  zone: number;
  /** 배정 시점의 도로 거리(타일). 통행 시간 추정과 혼잡 추정치에 쓴다. */
  dist: number;
}

/** 주거 건물 하나의 배정 결과. */
export interface ParcelAssignment {
  /** 슬롯 번호 -> 직장. jobs 를 count 만큼 펼치면 슬롯 인덱스가 된다. */
  jobs: DestLink[];
  /** 장보기 후보. 최대 SHOP_LINKS_MAX 개. */
  shops: DestLink[];
  /** 취직하지 못한 인원. 출퇴근 통행을 만들지 않는다. */
  unemployed: number;
}

export class AssignmentTable {
  /** key = `${anchorTx},${anchorTy}` (주거 건물 앵커) */
  private table = new Map<string, ParcelAssignment>();

  /** 하루 1회 전 도시 재배정. RoadField.rebuild 직후에 부른다. */
  rebuild(world: World, field: RoadField, stats: CityStats): void {
    // TODO
  }

  get(anchorTx: number, anchorTy: number): ParcelAssignment | undefined {
    // TODO
  }

  /**
   * 슬롯 번호로 직장을 인덱싱한다. 같은 슬롯은 항상 같은 건물을 돌려준다.
   * 이게 "취직" 의 실체다.
   */
  jobForSlot(anchorTx: number, anchorTy: number, slot: number): DestLink | null {
    // TODO
  }

  /** 장보기 목적지. 슬롯과 날짜 해시로 후보 중 하나를 고른다. */
  shopForSlot(
    anchorTx: number,
    anchorTy: number,
    slot: number,
    day: number,
  ): DestLink | null {
    // TODO
  }

  /**
   * 혼잡 추정치용. 배정표의 모든 링크를 (출발, 도착, 인원) 으로 펼친다.
   * congestion.ts 가 이걸 도로에 흘려보내 관측되지 않은 타일을 메운다.
   */
  *allLinks(): Generator<{ fromTx: number; fromTy: number; link: DestLink }> {
    // TODO
  }
}
```

---

## 6. `src/sim/congestion.ts` — 혼잡도

### 자료 구조

도로 타일당 값 하나. 청크별 `Uint8Array(CHUNK_TILES)`, 0~255 로 정규화한 혼잡도.
`RoadField` 와 같은 `Map<string, ...>` 패턴을 그대로 쓴다.

관측 여부를 따로 들고 있어야 한다 (관측된 적 없으면 추정치를 넣어야 하므로).
`observed: Uint8Array` 비트/바이트 하나 더.

### 타일 용량

같은 도로라도 십자 교차로는 직선보다 훨씬 적게 흘린다.
`roadMask(world, tx, ty)` (이미 `build.ts` 에 있음) 의 연결 수로 유도한다.

| 연결 수 | 형태 | 용량 배율 |
|---|---|---|
| 1 | 막다른 길 | 0.5 |
| 2 (마주보는 두 방향) | 직선 | 1.0 |
| 2 (꺾임) | 커브 | 0.8 |
| 3 | T자 | 0.6 |
| 4 | 십자 | 0.5 |

경사 타일은 추가로 ×0.8.

### 갱신

**실측 (활성 영역, 1초마다)**

```
관측치 = (그 타일 위 평균 차량 수) / (타일 용량 × VEHICLES_PER_TILE)
congestion = congestion × (1 - CONGESTION_ALPHA) + 관측치 × CONGESTION_ALPHA
observed = 1
```

**감쇠 (전 도시, 게임 1시간마다)**

활성 영역 밖 타일은 추정치 쪽으로 천천히 이동한다.

```
congestion += (추정치 - congestion) × CONGESTION_DECAY
```

**추정치**

`AssignmentTable.allLinks()` 를 돌면서 각 링크의 인원을
`RoadField` 최단 경로를 따라 흘려보내 도로 타일별 통행량을 누적한다.
동점 내리막이 여러 개면 **인원을 균등 분배** 한다 (이래야 평행 도로가 갈라진다).

```
추정치 = min(1, 통행량 / (타일 용량 × ESTIMATE_CAPACITY)) × CONGESTION_ESTIMATE_BIAS
```

`CONGESTION_ESTIMATE_BIAS > 1` 이다. 방치한 도시가 유리해지지 않게 하려고
추정치를 실측보다 살짝 나쁘게 잡는 것이다.

### 매크로로 가는 피드백

`macro.ts` 의 `satisfaction()` 에 항을 하나 더한다. 기존 인자를 지우지 말고 추가만.

```ts
function satisfaction(
  zone: number,
  commuteDist: number,
  nuisance: number,
  congestion: number,   // 새 인자: 그 건물 통근 경로의 평균 혼잡도 0~1
): number
```

주거는 `- CONGESTION_PENALTY_R × congestion`,
상업·공업은 `- CONGESTION_PENALTY_W × congestion` 만큼 깎는다.

건물별 "경로 평균 혼잡도" 는 배정표의 직장 링크 경로에서 읽는다.
매 틱 계산하지 말고 혼잡도 갱신 주기에 맞춰 건물당 한 번만 계산해 캐시한다.

### 뼈대

```ts
// src/sim/congestion.ts
import type { World } from '../world/world';
import type { RoadField } from './roadGraph';
import type { AssignmentTable } from './assignment';

export class CongestionMap {
  /** 0~1. 도로가 아니거나 모르는 타일은 0. */
  at(tx: number, ty: number): number { /* TODO */ }

  /** 타일 용량 배율 0~1. roadMask + 경사에서 유도. */
  capacityAt(world: World, tx: number, ty: number): number { /* TODO */ }

  /** 차량이 매 프레임 자기 위치를 신고한다. 누적만 하고 계산은 commitSamples 에서. */
  sample(tx: number, ty: number): void { /* TODO */ }

  /** 실시간 1초마다. 누적 표본을 혼잡도로 반영한다. */
  commitSamples(world: World): void { /* TODO */ }

  /** 게임 1시간마다. 활성 영역 밖을 추정치 쪽으로 감쇠시킨다. */
  decayOutside(
    world: World,
    activeCx: number,
    activeCy: number,
    radius: number,
  ): void { /* TODO */ }

  /** 하루 1회. 배정표에서 추정치를 다시 만든다. */
  rebuildEstimate(world: World, field: RoadField, table: AssignmentTable): void {
    /* TODO */
  }

  /** 건물 하나의 통근 경로 평균 혼잡도. macro.satisfaction 이 쓴다. */
  routeCongestionFor(anchorTx: number, anchorTy: number): number { /* TODO */ }
}
```

---

## 7. `src/sim/citizens.ts` — 시민과 통행 발생

### 개인 상태는 활성 영역에만 존재한다

시민의 실제 상태는 두 개뿐이다.

1. **생필품 재고** (0~255)
2. **지금 통행 중인가** (비트)

이걸 전 도시 1만 명에게 들고 있을 필요는 없다. 화면 밖 시민의 소비는 이미
매크로의 상업 수요(`SHOP_JOBS_PER_RESIDENT`)가 대신하고 있다.

그래서 **개인 상태는 활성 영역 안의 주거 건물에만 만든다.**
활성 영역이 바뀌면 새로 들어온 건물은 계층별 기본 재고로 초기화하고,
나간 건물은 버린다.

### 생활 리듬

개인 오프셋 = `simRandom(WORLD_SEED, anchorTx, anchorTy, slot)` → 0~1.
이 값으로 출퇴근 시각을 ±2시간 흩뿌린다. 전원이 8시 정각에 나오지 않게 하는 장치다.

| 통행 | 시각 | 피크 | 조건 |
|---|---|---|---|
| 출근 | 6~10시 | 8시 | 취직한 시민, 하루 1회 |
| 퇴근 | 16~20시 | 18시 | 출근했던 시민 |
| 장보기 | 10~21시 | 19시 | 생필품 재고 0 |
| 화물 | 종일 완만 | 14시 | 공업 건물 → 상업/공업 |

요일 개념은 없다. 게임에 없으니 만들지 마라.

### 생필품

게임 1시간마다 계층별 속도로 감소한다.

- L1: 느리게 (소비가 적다)
- L3: 빠르게 (소비가 많다)

0 이 되면 장보기 통행을 만들고, 목적지 상업 건물에 도착하면 가득 채운다.
목적지에 못 가면(경로 없음) 재고를 조금만 채우고 만족도에 반영하지 않는다 —
이 단계에서는 생필품이 만족도를 깎지 않는다. 통행을 만드는 장치일 뿐이다.

> 생필품이 만족도에 영향을 주는 건 STEP 4 이후다. 여기서 넣지 마라.

### 뼈대

```ts
// src/sim/citizens.ts

export const enum TripPurpose {
  Commute = 0,   // 집 -> 직장
  Home = 1,      // 직장 -> 집
  Shop = 2,      // 집 -> 상업
  Freight = 3,   // 공업 -> 상업/공업
}

/** 통행 하나. 차량으로 바뀌기 직전의 요청서다. */
export interface Trip {
  purpose: TripPurpose;
  /** 소득 계층 1~3. 경로 가중치와 스프라이트를 가른다. */
  tier: number;
  fromTx: number;
  fromTy: number;
  toTx: number;
  toTy: number;
}

export class CitizenPool {
  /**
   * 활성 영역을 옮긴다. 새로 들어온 주거 건물은 기본 재고로 초기화하고,
   * 빠진 건물은 버린다.
   */
  setActiveRegion(cx: number, cy: number, radius: number): void { /* TODO */ }

  /** 게임 1시간마다. 생필품 감소. */
  consumeSupplies(tier: number): void { /* TODO */ }

  /**
   * 이 시각에 출발하는 통행을 뽑는다.
   * hourOfDay 와 개인 오프셋, 생필품 재고를 보고 결정한다.
   * budget 을 넘겨서 만들지 마라 (차량 상한이 있다).
   */
  collectTrips(hourOfDay: number, dtMs: number, budget: number): Trip[] {
    /* TODO */
  }

  /** 차량이 목적지에 도착했을 때. 장보기면 재고를 채우고, 출근이면 퇴근 예약을 건다. */
  onTripComplete(trip: Trip): void { /* TODO */ }
}
```

---

## 8. `src/sim/traffic/` — 차량

### 8.1 `router.ts` — 혼잡 가중 A*

**여기가 이 단계의 핵심이다.** 최단거리 내비게이션을 쓰지 마라.

타일 비용:

```
cost(tile) = BASE_TILE_COST
           × (1 + CONGESTION_WEIGHT[tier] × congestion.at(tile))
           × (경사 타일이면 SLOPE_COST_MUL)
         + 교차로 진입 페널티 (좌회전 > 우회전 > 직진)
         + 신호등이 있으면 SIGNAL_WAIT_COST
```

휴리스틱: 맨해튼 거리 × `BASE_TILE_COST`.
혼잡 가중이 항상 1 이상이므로 admissible 하다. 최적 경로가 보장된다.

**계층별 혼잡 가중** — 이게 계층마다 다른 길로 가게 만드는 장치다.

| 계층 | `CONGESTION_WEIGHT` | 행동 |
|---|---|---|
| L1 저소득 | 0.6 | 막혀도 최단거리로 간다 |
| L2 중산층 | 1.2 | 어느 정도 우회한다 |
| L3 고소득 | 2.2 | 돌아가더라도 안 막히는 길을 고른다 |

결과적으로 **도로를 잘 설계한 동네에 고소득층이 자리잡는다.** 의도한 것이다.

**재탐색**: 차가 교차로에 진입할 때, 남은 경로의 다음 `REROUTE_LOOKAHEAD` 타일의
혼잡 합이 탐색 당시보다 `REROUTE_THRESHOLD` 이상 커졌으면 재탐색한다.
재탐색도 프레임 예산에 포함된다.

**경로 캐시**: key = `출발 도로타일 | 도착 도로타일 | tier`.
같은 건물쌍 통행이 많으므로 히트율이 높다. 혼잡도 갱신 주기마다 캐시를 비운다.

**예산**: 프레임당 A* `ROUTE_BUDGET_PER_FRAME` 건. 초과분은 다음 프레임으로 넘긴다.
탐색 대기 중인 차는 스폰을 미룬다 (경로 없이 도로에 세워두지 마라).

```ts
// src/sim/traffic/router.ts
export interface Route {
  /** 도로 타일 나열. 인덱스 0 이 출발 도로 타일. */
  tiles: Int32Array;   // (ty << 16 | tx) 같은 패킹 대신 tx,ty 를 번갈아 넣어도 된다
  /** 탐색 당시의 경로 혼잡 합. 재탐색 판정 기준값. */
  costAtPlan: number;
}

export class Router {
  /** 프레임 예산 안에서 대기열을 처리한다. */
  update(budget: number): void { /* TODO */ }

  /** 경로를 요청한다. 즉시 나올 수도 있고(캐시), 다음 프레임에 콜백으로 올 수도 있다. */
  request(
    fromTx: number, fromTy: number,
    toTx: number, toTy: number,
    tier: number,
    onDone: (route: Route | null) => void,
  ): void { /* TODO */ }

  /** 혼잡도가 갱신되면 캐시를 비운다. */
  invalidateCache(): void { /* TODO */ }
}
```

### 8.2 `signals.ts` — 신호등

**상태를 들고 있지 마라.** 좌표와 시각의 함수로 계산한다.

- 연결 수 3 이상인 도로 타일만 신호등을 갖는다
- 주기 `SIGNAL_CYCLE_MS`. 오프셋 = `simHash(WORLD_SEED, tx, ty, 0) % SIGNAL_CYCLE_MS`
- 위상: NS 녹색 → 황 → EW 녹색 → 황

```ts
// src/sim/traffic/signals.ts
export const enum SignalPhase { NSGreen = 0, NSYellow = 1, EWGreen = 2, EWYellow = 3 }

export function hasSignal(world: World, tx: number, ty: number): boolean { /* TODO */ }

/** timeMs 는 실시간 누적 밀리초. */
export function phaseAt(tx: number, ty: number, timeMs: number): SignalPhase { /* TODO */ }

/** dir 방향으로 이 교차로에 진입해도 되는가. */
export function canEnter(
  tx: number, ty: number, dir: number, timeMs: number,
): boolean { /* TODO */ }
```

### 8.3 `vehicles.ts` — 차량

```ts
// src/sim/traffic/vehicles.ts
export const enum VehicleKind { Car = 0, Truck = 1 }

export interface Vehicle {
  kind: VehicleKind;
  /** 소득 계층 1~3. 경로 가중치와 색을 가른다. */
  tier: number;
  purpose: TripPurpose;

  route: Route;
  /** route.tiles 안의 현재 위치. */
  routeIdx: number;
  /** 현재 타일 진행도 0~1. */
  tileT: number;
  /** 0 = 오른쪽 차선, 1 = 왼쪽(추월 없음, 우측통행 표현용). */
  lane: number;

  /** 타일/초. */
  speed: number;
  /** 진행 방향 0~3 (build.ts 의 DIRS 순서와 같다). */
  dir: number;

  /** 목적지 건물 앵커. 도착 판정과 onTripComplete 에 쓴다. */
  destTx: number;
  destTy: number;
}
```

**차간거리**: 같은 타일·같은 레인에서 앞차와의 거리, 그리고 다음 타일 앞차까지 본다.
`DESIRED_GAP_TILES` 보다 좁으면 감속, `MIN_GAP_TILES` 이하면 정지.
가감속은 `ACCEL_TILES_PER_SEC2` / `DECEL_TILES_PER_SEC2` 로 제한한다. 순간이동 금지.

**스폰**
- 출발 건물이 활성 영역 안 → 그 건물 진입 도로 타일에서 스폰
- 출발이 밖, 도착이 안 → 활성 영역 **경계 도로 타일** 에서 스폰 (밖에서 들어오는 차)
- 진입 도로 타일이 이미 꽉 찼으면 스폰을 미룬다

**디스폰**
- 목적지 건물 진입 도로에 도착 → `onTripComplete` 호출 후 제거
- 활성 영역 밖으로 나감 → 조용히 제거
- 카메라 이동으로 활성 영역이 바뀜 → 밖으로 나간 차 즉시 제거

**상한**: `MAX_ACTIVE_VEHICLES`(=1000) 초과 시 카메라에서 먼 차부터 제거하고
새 스폰을 억제한다. 상한을 넘긴 상태로 프레임을 넘기지 마라.

### 8.4 `trafficSim.ts` — 총괄

```ts
// src/sim/traffic/trafficSim.ts
export class TrafficSim {
  constructor(
    world: World,
    macro: MacroSim,
    congestion: CongestionMap,
    assignment: AssignmentTable,
  ) {}

  /** 카메라 중심 청크가 바뀌면 부른다. */
  setActiveChunk(cx: number, cy: number): void { /* TODO */ }

  /**
   * 매 프레임. 순서를 지켜라.
   *   1) 라우터 예산 소진
   *   2) 통행 수집 -> 스폰
   *   3) 차량 이동 (차간거리 -> 신호 -> 위치 갱신)
   *   4) 혼잡 표본 신고
   *   5) 1초 경과 시 congestion.commitSamples()
   */
  update(dtMs: number): void { /* TODO */ }

  /** 렌더러가 읽는다. 청크별로 나눠서 준다. */
  vehiclesInChunk(cx: number, cy: number): readonly Vehicle[] { /* TODO */ }

  get activeCount(): number { /* TODO */ }
}
```

---

## 9. 상수 (`src/sim/simConstants.ts` 에 추가)

이 파일은 저장되지 않는다. 값은 자유롭게 조정해도 기존 도시가 안 깨진다.
**아래 이름을 바꾸지 마라.**

```ts
/* ---------------- 3.2단계: 배정 ---------------- */

/** 계층별 통근 거리 상한(타일). 이 밖의 직장은 후보에서 빠진다. */
export const COMMUTE_RANGE_BY_TIER: readonly number[] = [40, 80, 140];
/** 계층별 장보기 거리 상한(타일). 통근보다 훨씬 짧다. */
export const SHOP_RANGE_BY_TIER: readonly number[] = [16, 28, 45];
/** 주거 건물당 상권 후보 수. */
export const SHOP_LINKS_MAX = 3;
/** [거주 계층][직장 등급] 적합도. 5장 표와 같은 값. */
export const JOB_FIT: readonly (readonly number[])[] = [
  [1.0, 0.6, 0.15],
  [0.5, 1.0, 0.7],
  [0.1, 0.6, 1.0],
];

/* ---------------- 3.2단계: 혼잡 ---------------- */

/** 타일 하나가 감당하는 차량 수(용량 1.0 기준). */
export const VEHICLES_PER_TILE = 4;
/** 실측 반영 속도. 1초마다 적용. */
export const CONGESTION_ALPHA = 0.25;
/** 활성 영역 밖에서 추정치로 수렴하는 속도. 게임 1시간마다 적용. */
export const CONGESTION_DECAY = 0.08;
/** 추정치 보정 배율. 1보다 커야 방치한 도시가 유리해지지 않는다. */
export const CONGESTION_ESTIMATE_BIAS = 1.15;
/** 추정치 계산에서 타일 하나가 흘릴 수 있는 하루 통행 인원. */
export const ESTIMATE_CAPACITY = 260;
/** 혼잡이 만족도를 깎는 폭. */
export const CONGESTION_PENALTY_R = 0.30;
export const CONGESTION_PENALTY_W = 0.20;

/* ---------------- 3.2단계: 생필품 ---------------- */

/** 계층별 시간당 생필품 소비량 (255 만점). 고소득이 더 많이 쓴다. */
export const SUPPLY_USE_PER_HOUR: readonly number[] = [3, 5, 8];
/** 활성 영역에 새로 들어온 시민의 시작 재고. */
export const SUPPLY_START = 160;

/* ---------------- 3.2단계: 경로 ---------------- */

export const BASE_TILE_COST = 10;
/** 계층별 혼잡 회피 성향. 이 차이가 계층마다 다른 길을 만든다. */
export const CONGESTION_WEIGHT: readonly number[] = [0.6, 1.2, 2.2];
export const SLOPE_COST_MUL = 1.25;
export const TURN_COST_STRAIGHT = 0;
export const TURN_COST_RIGHT = 3;
export const TURN_COST_LEFT = 9;
export const SIGNAL_WAIT_COST = 6;
/** 프레임당 A* 탐색 건수 상한. */
export const ROUTE_BUDGET_PER_FRAME = 5;
/** 재탐색 판정에서 앞을 내다보는 타일 수. */
export const REROUTE_LOOKAHEAD = 8;
/** 이만큼 나빠졌으면 재탐색한다. */
export const REROUTE_THRESHOLD = 0.35;
/** A* 가 펼치는 노드 상한. 넘으면 실패로 처리하고 통행을 버린다. */
export const ROUTE_MAX_NODES = 4000;

/* ---------------- 3.2단계: 차량 ---------------- */

export const VEHICLE_SPEED_TILES_PER_SEC = 2.6;
export const TRUCK_SPEED_MUL = 0.75;
export const ACCEL_TILES_PER_SEC2 = 3.0;
export const DECEL_TILES_PER_SEC2 = 5.0;
export const DESIRED_GAP_TILES = 0.55;
export const MIN_GAP_TILES = 0.22;

/* ---------------- 3.2단계: 신호등 ---------------- */

export const SIGNAL_CYCLE_MS = 16_000;
export const SIGNAL_GREEN_MS = 7_000;
export const SIGNAL_YELLOW_MS = 1_000;

/* ---------------- 3.2단계: 통행 발생 ---------------- */

/** 시각별 출근 통행 가중치. 인덱스 = hourOfDay 0~23. */
export const RUSH_TO_WORK: readonly number[] = [
  0, 0, 0, 0, 0, 0.05, 0.35, 0.8, 1.0, 0.6, 0.2, 0.05,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];
/** 시각별 퇴근 통행 가중치. */
export const RUSH_TO_HOME: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0.1, 0.5, 0.9, 1.0, 0.7, 0.3, 0.08, 0, 0,
];
/** 시각별 장보기 가중치. */
export const RUSH_TO_SHOP: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.2, 0.35,
  0.45, 0.4, 0.4, 0.45, 0.55, 0.7, 0.85, 1.0, 0.7, 0.3, 0.05, 0,
];
/** 화물 통행 가중치. 종일 완만하다. */
export const FREIGHT_CURVE: readonly number[] = [
  0.1, 0.1, 0.1, 0.15, 0.25, 0.4, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0,
  0.95, 1.0, 1.0, 0.9, 0.8, 0.7, 0.5, 0.35, 0.25, 0.2, 0.15, 0.1,
];
/** 실시간 1초당 최대 스폰 수. 프레임 스파이크 방지. */
export const MAX_SPAWNS_PER_SEC = 90;
```

---

## 10. 렌더링

### 10.1 깊이 정렬 — 반드시 청크당 메시로

차량을 전역 메시 하나로 만들면 건물과 z정렬이 깨진다.
건물 메시가 청크당 `zIndex = cx + cy + 0.5` 이므로, 앞 청크 건물이 뒤 청크 차를
가리게 하려면 차량도 청크 단위여야 한다.

**청크당 차량 메시 하나, `zIndex = cx + cy + 0.75`.**
활성 청크가 9개이므로 드로우콜은 최대 +9. 예산 안이다.

청크 안에서는 매 프레임 `depth = tx + ty` 로 정렬한 뒤 정점 버퍼를 다시 쓴다.
차량은 매 프레임 움직이므로 `BuildingMesh` 처럼 revision 비교로 건너뛸 수 없다.
1000대 × 4정점 = 4000정점, 32KB/프레임 업로드. 문제없다.

### 10.2 스프라이트 규격

> **지난 단계에서 반복적으로 누락된 부분이다. 아래 픽셀 수치를 그대로 지켜라.**
> "N타일 크기" 만 맞추고 도트 밀도를 안 맞추면 지형·건물과 따로 논다.

- 파일: `public/sprites/vehicles.png`
- 전체 크기: **256 × 64 px**
- 셀 크기: **32 × 32 px** (타일 폭 64px 기준이므로 차 한 대 = 타일 폭의 절반)
- 배치:
  - 행 0 (y 0~31): **승용차** — 셀 8개
  - 행 1 (y 32~63): **트럭** — 셀 8개
  - 행 안의 x 순서: 방향 4종 × 색 변형 2종
    - x 0~31 / 32~63 : `+tx` (화면 오른쪽 아래) 변형 A / B
    - x 64~95 / 96~127 : `+ty` (화면 왼쪽 아래) A / B
    - x 128~159 / 160~191 : `-tx` (화면 왼쪽 위) A / B
    - x 192~223 / 224~255 : `-ty` (화면 오른쪽 위) A / B
  - 방향 순서는 `src/world/build.ts` 의 `DIRS` 배열 순서와 **똑같이** 맞춘다
- 기준점: 셀의 **가운데 아래 끝**. 건물 아틀라스와 같은 규칙이다
- **도트 밀도: 1px 단위.** 안티앨리어싱 없음. 지형·도로·건물과 같은 밀도.
  4배 블록화 같은 후처리 절대 금지
- 제한 팔레트, 2px 계단형 윤곽 — `buildings.png` 와 같은 기준
- 차량 몸통은 셀 32×32 안에서 대략 24×16 을 넘지 않게. 나머지는 투명 여백

파일이 아직 없으면 `vehicleAtlas.ts` 가 **코드로 생성해서** 구현이 막히지
않게 한다. `atlas.ts` / `buildingAtlas.ts` 의 기존 방식을 그대로 따른다.

```ts
// src/render/vehicleAtlas.ts
export const VEHICLE_ATLAS_URL = 'sprites/vehicles.png';
export const VEHICLE_CELL = 32;
export const VEHICLE_VARIANTS = 2;
export const VEHICLE_ATLAS_W = 256;
export const VEHICLE_ATLAS_H = 64;

export interface VehicleAtlas {
  texture: Texture;
  placeholder: boolean;
  uv(kind: number, dir: number, variant: number): [number, number, number, number];
}

export async function loadVehicleAtlas(): Promise<VehicleAtlas> { /* TODO */ }
```

### 10.3 `vehicleMesh.ts`

`BuildingMesh` 와 같은 구조인데 **매 프레임 갱신** 이 다르다.
정점 버퍼를 미리 `MAX_ACTIVE_VEHICLES × 4` 로 할당해두고, 매 프레임 앞에서부터
채운 뒤 남는 사각형은 UV 를 0 으로 접어 안 보이게 한다. 매 프레임 재할당 금지.

차량의 화면 위치:
```
wx = tileToWorldX(tx, ty) + (진행 방향으로 tileT 만큼 보간)
wy = tileToWorldY(tx, ty, sampleHeight(tx, ty)) + 레인 오프셋
```
스프라이트 아래 가운데가 이 지점에 온다.

---

## 11. `main.ts` 연결

```ts
// boot() 안, sim 생성 뒤
const congestion = new CongestionMap();
const assignment = new AssignmentTable();
sim.attachTraffic(congestion, assignment);   // macro 가 하루 1회 rebuild 를 부른다

const vehicleAtlas = await loadVehicleAtlas();
const traffic = new TrafficSim(world, sim, congestion, assignment);
renderer.attachTraffic(traffic, vehicleAtlas);

// app.ticker.add 안, sim.update 다음
const cam = worldToTile(camera.x, camera.y);
traffic.setActiveChunk(chunkIndexOf(cam.tx), chunkIndexOf(cam.ty));
traffic.update(ticker.deltaMS);
```

`sim.update()` 를 먼저 부르고 `traffic.update()` 를 나중에 부른다.
순서를 뒤집으면 차량이 한 틱 늦은 매크로 상태를 본다.

---

## 12. 성능 예산 (넘으면 설계를 다시 봐야 한다)

| 항목 | 상한 |
|---|---|
| 활성 차량 | 1,000대 |
| 프레임당 A* | 5건 |
| A* 노드 전개 | 건당 4,000 |
| 초당 스폰 | 90대 |
| 추가 드로우콜 | 청크당 1, 최대 9 |
| 프레임당 정점 업로드 | 32KB |
| 배정 재계산 | 게임 하루 1회 |
| 혼잡 실측 반영 | 실시간 1초 1회 |

아이패드 60fps 기준이다. `tools/simcheck.ts` 에 차량 없는 매크로 검증이 이미
있으니, 마이크로용 검증은 별도로 만들지 말고 브라우저에서 HUD 로 확인한다.

---

## 13. GPT 체크리스트

- [ ] `assignment.ts` — 취직·상권 배정. 같은 슬롯은 항상 같은 건물로
- [ ] `congestion.ts` — 실측 + 추정, 타일 용량, 화면 밖 감쇠
- [ ] `citizens.ts` — 시민 유도(객체 배열 금지), 생필품, 시간대별 통행 발생
- [ ] `router.ts` — **혼잡 가중 A***. 계층별 회피 성향, 캐시, 재탐색
- [ ] `signals.ts` — 무상태 신호등
- [ ] `vehicles.ts` — 차간거리, 가감속, 스폰·디스폰, 상한 관리
- [ ] `trafficSim.ts` — 매 프레임 순서 지키기
- [ ] `vehicleAtlas.ts` / `vehicleMesh.ts` — 청크당 메시, zIndex +0.75, 매 프레임 갱신
- [ ] `macro.ts` — `satisfaction()` 에 혼잡 인자 추가, 하루 1회 배정·추정 갱신 호출
- [ ] `roadGraph.ts` — 도로 타일 목록 노출, 타일 용량
- [ ] `simConstants.ts` — 9장 상수 그대로 추가
- [ ] `constants.ts` — `MAX_ACTIVE_VEHICLES` **주석만** 수정 (값 1000 유지)
- [ ] `worldRenderer.ts` / `main.ts` / `hud.ts` 연결
- [ ] `npm run build` (tsc --noEmit + vite build) 통과 확인

---

## 14. 이번 범위 밖 (건드리지 마라)

- 보행자 개별 시뮬레이션 — 설계상 데이터 전용이다
- 지하철, 버스 — **버스는 만들지 않는다**
- 기본청크 4×4 → 3×3 변경 및 맵 초기화
- 기본청크 간격 8 → 8~12 랜덤화
- 기본청크 외 지형(평지/산/강 60/30/10) 자연 생성
- L3 고소득 건물의 인프라(공원/전기/수도) 민감도
- 도로 비인접 지역 1단계 건물 생성 버그
- 상하수도·오염 (STEP 4)
- 생필품이 만족도에 영향을 주는 것 (STEP 4 이후)

---

## 15. 파일 전달 규칙

- `node_modules`, `package-lock.json`, `dist` 는 전달하지 않는다
- 이 문서 + **실제로 수정할 파일만** 압축해서 전달한다
- 이게 **패치 파일** 인지 **전체 배포 프로젝트** 인지 반드시 명시한다
  (STEP 3.1 에서 이걸 혼동해 Vercel 빌드가 모듈 누락으로 실패했다)
- 파일 경로 기준으로 그대로 덮어쓸 수 있게 작업한다. 임의 재구조화 금지
- 작업 후 `npm run build` 통과를 확인하고 보고한다
