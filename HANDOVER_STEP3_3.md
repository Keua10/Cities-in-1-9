# STEP 3.3 인수인계 — 서비스 시설 · 복지 시설

> 이 문서는 **다음 작업자에게 넘기는 현재 상태 보고서**다. 원본 설계 문서(STEP3_3.md)를
> 대체하지 않는다. 원본이 "무엇을 만들 것인가"라면, 이 문서는 "무엇이 만들어졌고,
> 원본과 어디가 달라졌으며, 왜 달라졌는가"다.
>
> 브랜치: `claude/step-3-3-skeleton-yvri09` (main 에는 아직 머지되지 않았다)
> 커밋: `b14afa3` 뼈대 · `337e207` 밸런스 조정 · 그 뒤 청크 경계 제한 제거

---

## 0. 30초 요약

STEP 3.3 의 뼈대가 전부 들어갔고 동작한다. `npm run build` 통과,
전용 검증기 `serviceCheck` 전 항목 통과, 기존 `simcheck` 통과.

원본 명세에서 **의도적으로 달라진 곳이 세 군데** 있다. 전부 이유가 있고 아래 4장에
근거와 실측치를 적어뒀다. 이 세 곳을 모르고 원본만 읽으면 코드가 틀린 것처럼 보인다.

1. 복지 세기·반경·비용을 다시 잡았다 (원본 값으로는 6장 밸런스 표가 재현되지 않는다)
2. 시설 유지비를 낮췄다 (원본 값으로는 도시가 부트스트랩 함정에 빠진다)
3. "청크 경계에는 지을 수 없습니다" 제한을 없앴다 (기획 의도에 없던 제약)

남은 일은 5장에 있다. 가장 중요한 것은 **재해 시스템(3.4)이 읽어갈 창구가 이미
확정돼 있다**는 것이다 — `serviceQualityAt` 과 `amenityScoreAt` 두 개만 읽으면 되고
`services.ts` 를 고칠 필요가 없다.

---

## 1. 파일 지도 — 어디에 무엇이 있나

### 신규

| 파일 | 무엇 |
|---|---|
| `src/sim/facilities.ts` | 7종 카탈로그(`FACILITY_SPECS`)와 배치 규칙(`canPlaceFacility`) |
| `src/sim/services.ts` | **이 단계의 심장.** `ServiceField` 한 클래스가 필수/복지 두 가족을 모두 든다 |
| `src/render/facilityAtlas.ts` | 576x384 아틀라스 규격 + 그림 없을 때 코드로 그리는 placeholder |
| `src/render/facilityMesh.ts` | 청크당 시설 메시. 시설 없는 청크에는 아예 안 만든다 |
| `tools/check/serviceCheck.ts` | 명세 12장 전 항목 검증기 |
| `HANDOVER_STEP3_3.md` | 이 문서 |

### 수정

| 파일 | 무엇 |
|---|---|
| `src/sim/buildings.ts` | `FAC_BASE=9`, `FACILITY_COUNT=7`, `FAC_WELFARE_BASE=4`, `isFacilityAnchor`, `isAnyAnchor` 등. **`isAnchor` 는 그대로 `v < 9`** |
| `src/world/build.ts` | `Build.Civic = 4`, `BUILD_LABELS`, `makeTopResolver` 에 civic 셀 한 줄 |
| `src/world/world.ts` | `BuildingInfo.kind`, `buildingCovering`(`isAnyAnchor`), `placeFacility`, `removeFacilityAt`, `writeBldCell`, `setBuild` 의 유령 칸 정리, `demolishAt` 청크 대응 |
| `src/sim/macro.ts` | `ServiceField` 소유·갱신, `satisfaction()` 에 `needsGap`/`amenityBonus`, 부하 적립, 시설 유지비, `CityStats` 6필드, `graceFactor` |
| `src/sim/simConstants.ts` | 10장 상수 전부 (맨 뒤에 추가) |
| `src/render/atlas.ts` | `CIVIC_CELL_BASE`, `civicCell()`, `ATLAS_CELL_COUNT` 갱신 |
| `src/render/worldRenderer.ts` | 시설 메시 연결, 배치 미리보기(`setFacilityPreview`) |
| `src/ui/tools.ts` + `index.html` + `src/style.css` | `facility` 도구, 필수/복지 두 묶음 시트, 드래그 금지 |
| `src/ui/minimap.ts` | 커버리지 레이어(이진) + 복지 히트맵 |
| `src/ui/cityPanel.ts` | 커버율 게이지 4개 + 복지 게이지 1개 + 안내 문구 |
| `src/main.ts` + `src/ui/hud.ts` | 타일 정보에 서비스·복지 줄 |
| `tools/simcheck.ts` | 시나리오가 시설도 함께 짓도록 수정 (4장 참고) |

---

## 2. 반드시 알고 있어야 할 설계 세 가지

이걸 모르고 손대면 원인에서 아주 멀리 떨어진 곳에서 증상이 터진다.

### 2.1 `isAnchor` 는 절대 넓히지 마라

`isAnchor(v)` 는 `v < 9` 다. 시설 코드가 9부터 시작하므로 **아래 여덟 군데가 코드를
한 줄도 안 고치고 자동으로 시설을 건너뛴다.**

```
macro.ts      인구·일자리·입주율 집계, 공업 혐오도
assignment.ts 취직·상권 배정
citizens.ts   통행 발생
roadGraph.ts  통근 거리장 소스
growth.ts     재건축 후보
buildingMesh  지구 건물 메시
simcheck.ts   등급별 집계
```

시설을 알아야 하는 곳은 **세 군데뿐**이고 거기만 `isAnyAnchor` / `isFacilityAnchor` 를 쓴다.

- `world.ts:buildingCovering` — 시설 칸에서 앵커를 찾아야 한다
- `world.ts:recountParcel` — 손댈 게 없다(자동으로 빠진다). 그게 설계가 지켜진다는 증거
- `render/facilityMesh.ts`

`isAnchor` 를 시설까지 포함하게 넓히는 순간 여덟 군데가 조용히 틀리기 시작하고,
증상은 "인구가 이상하게 늘어남"처럼 나타난다.

### 2.2 시설은 두 레이어에 함께 쓴다

```
build 레이어   footprint 전 칸 = Build.Civic (4)
bld  레이어   앵커 칸 = FAC_BASE + kind (9~15), 나머지 = BLD_COVERED
bornLo/Hi     앵커 칸에 건설 날짜 (지금은 안 읽는다. 노후화용 자리)
```

두 겹이 **각자 다른 이유로** 자동 건축을 막는다 — `growth.ts:buildPass` 는
`zoneOfBuild(Civic) === -1` 이라 건너뛰고, `plotFits` 는 `getBld !== BLD_NONE` 이라 막는다.
한쪽을 실수로 놓쳐도 시설 위에 아파트가 서지 않는다.

**`placeBuilding` 을 재사용하지 마라.** 그 함수는 칸마다 `emptyPlots--` 를 하는데
시설 칸은 애초에 `emptyPlots` 에 들어간 적이 없다. 그대로 쓰면 `emptyPlots` 가
음수로 새고 그 청크에서 **신축이 영구히 멈춘다.**

### 2.3 한 틱 지연은 버그가 아니라 순환을 끊는 장치다

품질 ← 담당 인구 ← 입주율 ← 만족도 ← 품질. 순환이다.
끊는 방법은 하나뿐이라 `evaluate()` 는 **직전 평가에서 적립된 부하**로 계산한 품질을 쓴다.

```
evaluate() 안에서
  건물마다: serviceGap 계산(지난 부하 기준 품질) -> 입주율 확정 -> accrueLoad()
  루프 끝:  settleLoads()  — 적립된 부하로 품질 확정, 카운터 비움
```

결정론은 안 깨진다. 부하 초기값은 항상 0 이고 저장하지 않으며, `primeCatchup` 이
`evaluate` 를 두 번 부르므로 첫 틱 전에 한 번 채워진다.

---

## 3. 다음 단계가 읽어갈 창구 (3.4 / STEP 4)

**이미 확정돼 있다. 이것만 읽으면 되고 `services.ts` 를 고칠 필요가 없다.**

```ts
// 이 칸의 종류별 서비스 품질 0~1. 재해 확률·확산·진압 계산의 유일한 입력.
sim.services.serviceQualityAt(tx: number, ty: number, kind: number): number;

// 이 칸의 복지 점수. STEP 4 오염 시스템이 "공원이 오염을 상쇄한다" 에 쓴다.
sim.services.amenityScoreAt(tx: number, ty: number): number;
```

`kind` 는 `FAC_FIRE(0) / FAC_POLICE(1) / FAC_HOSPITAL(2) / FAC_SCHOOL(3)`.

부수적으로 쓸 수 있는 것: `ownerFor`, `distFor`, `qualityOf`, `loadOf`,
`facilityList()`, `nearbyWelfare()`, `roadCoveredAt()`.

---

## 4. 원본 명세와 달라진 곳 — 전부 근거 있음

### 4.1 복지 세기·반경·비용을 다시 잡았다

**증상**: 원본 값 `FACILITY_STRENGTH = [.., 0.35, 1.0, 0.9]` 로는 6장 밸런스 표의
"복지 요구 충족" 줄이 도시 규모에서 재현되지 않았다.

**원인**: 세기는 "시설 바로 위의 점수"이고 감쇠가 선형이라, 실제로 요구를 채우는
것은 중심에서 얼마간 떨어진 **원**이다. 원본 값으로 그 원을 계산하면:

| | 저소득 0.35 | 중산층 0.90 | 고소득 1.80 |
|---|---|---|---|
| 소공원 (0.35, r8) | d=0 에서만 | 불가 | 불가 |
| 공원 (1.0, r16) | 10.4칸 | **1.6칸** | 불가 |
| 체육 (0.9, r12) | 7.3칸 | d=0 | 불가 |

중산층이 "공원 1.6칸 안"에서만 충족된다. 2장 문장은 "동네에 제대로 된 공원이
있어야 한다"인데 실제로는 공원 앞마당이다. 게다가 검증기 22번(같은 예산이면
3종이 비슷하게 좋아야 한다)이 **5.20배**로 벌어져 체육시설이 완전히 열등했다.

**조치**: 2장의 세 줄을 거리로 되돌려 잡았다.

```ts
FACILITY_STRENGTH = [0,0,0,0, 0.65, 1.50, 1.60];   // 소공원 · 공원 · 체육
FACILITY_RANGE    = [40,34,55,30, 8, 16, 14];      // 체육 12 -> 14
FACILITY_COST     = [4500,4000,14000,10000, 600, 4600, 6000];
```

결과:

| | 충족 반경 |
|---|---|
| 소공원 → 저소득 | 3.7칸 · 중산층은 세기가 모자라 불가 |
| 공원 → 중산층 | 6.4칸 · 고소득은 혼자 불가 |
| 체육 → 중산층 | 6.1칸 · 고소득은 혼자 불가 |
| 공원 + 체육 겹침 → 고소득 | 6.2칸 |

22번이 **5.20배 → 1.57배**. 2장의 세 줄("저소득은 소공원 하나, 중산층은 제대로 된
공원, 고소득은 공원 + 체육시설")이 그대로 거리로 나온다.

### 4.2 시설 유지비를 낮췄다

**증상**: 원본 값으로 도시를 덮을 만큼 지으면 유지비가 하루 수입의 **70%** 에 닿았다.
커버가 모자라 수입이 낮고, 수입이 낮아 시설을 더 못 짓는 부트스트랩 함정.
11장이 잡은 목표는 15~25% 다.

**조치**:

```ts
// 원본: [520, 480, 1100, 900, 40, 260, 700]
FACILITY_UPKEEP_PER_DAY = [170, 160, 360, 300, 15, 110, 135];
```

220일 주행 실측 **34%**. 건설비는 거의 그대로 둬서 "지금 이 돈을 여기 쓸 것인가"
하는 배치 결정은 남겼다. 도시를 목 조르던 고정비만 낮춘 것이다.

> 세금(`TAX_*`)은 손대지 않았다. 기획자가 "세금은 플레이어가 직접 조정할 수 있게
> 하고 행복도/만족도에 반영할 것"이라고 밝혔으므로, 그 기능이 들어오면 수입 쪽이
> 달라지고 이 비율도 다시 봐야 한다.

### 4.3 "청크 경계에는 지을 수 없습니다" 제한을 없앴다

**증상**: 청크 경계 근처에서 시설을 놓으려 하면 거부됐다. 기획 의도에 없던 제약이다.

**원래 왜 있었나**: 원본 명세 4장이 `growth.ts:fitsInChunk` 와 같은 규칙을 요구했고,
그 근거는 "건물 하나가 두 저장 문서에 걸치면 반쪽만 저장될 수 있다"였다.

**실제로 확인한 것**: `citySave.ts` 의 저장은 `runTransaction` 으로 **모든 청크를
한 번에 원자적으로 커밋**한다. 걸친 청크 둘이 함께 저장되거나 함께 실패하므로
반쪽짜리 시설이 남지 않는다. 근거가 성립하지 않았다.

**조치**: 제한을 없애고, 쓰기 경로를 청크에 안전하게 고쳤다.

- `World.writeBldCell(tx, ty, code, bornDay)` 신규 — **칸마다 필지를 다시 찾는다.**
  한 번만 찾아 쓰면 경계를 넘는 순간 지역 index 가 옆줄로 넘어가 엉뚱한 칸을 덮어쓴다
- `placeFacility` / `demolishAt` / `clearFacilityFootprintBuild` 를 전부 칸 단위로 변경
- 걸친 **모든** 필지에 `bldRevision++` 와 `markDirty` (메시 재굽기 + 저장 둘 다 필요)
- `canPlaceFacility` 의 개척 검사도 앵커 하나가 아니라 칸마다로 변경

검증기 4b 항목이 이걸 지킨다 — 청크를 걸쳐 병원(3x3)을 놓고, 옆 청크 칸에서 앵커를
되찾고, 옆 청크 칸을 찍어 철거했을 때 유령 칸이 안 남는지 확인한다.

> 남은 이론적 한계: `MAX_CHUNKS_PER_SAVE = 200`. 한 번에 더러워진 청크가 200개를
> 넘으면 초과분이 잘린다. 시설 하나가 걸치는 청크는 최대 4개이므로 실질적 위험은
> 없지만, 알고는 있어야 한다.

### 4.4 `tools/simcheck.ts` 시나리오와 목표 범위를 고쳤다

3.3 이후로 시설은 "있으면 좋은 것"이 아니라 **기반시설**이다. 소방서도 공원도 없는
8천명 도시는 설계상 건강한 도시가 아니므로, 그런 도시에 "입주율 70~94%" 를 요구하는
것은 더 이상 의미 있는 검증이 아니다.

- 시나리오가 **도시가 자라는 대로 시설을 한 채씩** 짓는다. 비율 상한을 건설 조건으로
  걸면 부트스트랩 함정에 갇히므로, 현금과 하루 흑자만 보고 짓고 비율은 결과로 보고한다
- 자리를 블록 목록 **전체에 고르게** 편다. `i * stride` 방식은 시설 수가 블록 수에
  가까워지면 청크 위쪽 절반에만 몰려서, 더 지을수록 커버율이 떨어졌다
- **입주율 하한 0.70 → 0.55.** 0.70~0.94 는 만족도에 서비스·복지 항이 *아예 없던*
  3.1 기준값이다. 대신 3.3 이 책임지는 값을 따로 검사한다:
  도로에 닿은 건물 커버율 ≥ 85%, 복지 충족률 ≥ 80%, 유지비 비율 ≤ 40%

실측(220일): 인구 6,492 · 입주율 62% · 시설 47채 · 유지비 34% ·
도로에 닿은 건물 기준 커버율 [86,97,96,96] · 복지 충족 94%.

> **입주율 62% 가 3.1 의 75% 보다 낮은 것은 정상이다.** 3.3 이 만족도에 상시
> 감점을 얹었기 때문이고, 건물 1,310채 중 310채가 도로에 안 닿아 영영 커버 밖이다
> (3.1 때부터 공실이던 건물들이다). 시설 없이 돌리면 20%대로 주저앉는다.

---

## 5. 남은 일

### 5.1 바로 해야 하는 것

- [ ] **`public/sprites/facilities.png` 그리기** — 576x384. 규격은
      `src/render/facilityAtlas.ts` 파일 맨 위 주석에 밴드/열 표로 박혀 있다.
      지금은 코드로 그린 placeholder 로 돌아간다(게임은 정상 동작한다)
- [ ] **실제로 플레이해보고 밸런스 조정** — 4.1/4.2 값은 검증기를 통과하도록 잡은
      것이지 손맛을 본 값이 아니다. 조정해도 되는 값 목록은 원본 11장에 있다

### 5.2 알려진 문제 (3.3 범위 밖)

- **`trafficCheck` 1건 실패** — "적신호 우회전은 반드시 일시정지 뒤에 이루어진다".
  3.3 이 만든 버그가 **아니다.** main 에서는 이 상황이 0회라 검사가 무의미하게
  통과하고 있었는데, 3.3 으로 통행량이 늘자(174→201대) 1회 발생하면서 3.2 의
  잠복 버그가 드러났다. 원본 15장이 교통 층을 이번 범위 밖으로 못박아 손대지 않았다
- **`laneCheck` 실행 불가** — `@napi-rs/canvas` 미설치. 이 환경의 문제이고
  코드 변경과 무관하다

### 5.3 다음 단계 (원본 15장이 이번 범위 밖으로 정한 것들)

- **STEP 3.4**: 화재 발생·확산·진압, 범죄, 질병. 3장의 창구만 읽으면 된다
- **STEP 4**: 상하수도·전기, 오염(공원이 오염을 상쇄하는 것도 그때), 토지가치
- 소방차·구급차·경찰차 — 3.2 교통 층을 건드리는 일이라 별도 단계
- 시설 노후화 — `bornLo/bornHi` 에 날짜만 기록해뒀고 읽지 않는다
- 월드 전체 커버리지 오버레이 — 지금은 미니맵까지만

---

## 6. 검증하는 법

```bash
npm install          # node_modules 가 없다면

# 타입 + 빌드
npm run build

# 3.3 전용 검증기 (명세 12장 전 항목)
npx esbuild tools/check/serviceCheck.ts --bundle --platform=node --format=esm \
  --alias:pixi.js=./tools/check/stub-pixi.ts --outfile=/tmp/serviceCheck.mjs
node /tmp/serviceCheck.mjs

# 기존 검증기
npx esbuild tools/simcheck.ts --bundle --platform=node --format=esm \
  --alias:pixi.js=./tools/check/stub-pixi.ts --outfile=/tmp/simcheck.mjs
node /tmp/simcheck.mjs

npx esbuild tools/check/trafficCheck.ts --bundle --platform=node --format=esm \
  --alias:pixi.js=./tools/check/stub-pixi.ts --outfile=/tmp/trafficCheck.mjs
node /tmp/trafficCheck.mjs
```

현재 상태: `build` 통과 · `serviceCheck` 전 항목 통과 · `simcheck` 통과 ·
`trafficCheck` 1건 실패(5.2 참고) · `laneCheck` 실행 불가(5.2 참고).

**밸런스를 건드렸다면 `serviceCheck` 의 17b 와 25b 를 가장 먼저 보라.**
17b 는 "시설이 하나도 없어도 통근만 괜찮으면 저소득 동네는 살아남는다"(만족도
0.305 > 기준선 0.25)를, 25b 는 "하강 나선이 스스로 멈춘다"를 지킨다.
나머지가 다 맞아도 이 둘이 깨지면 학생 도시가 통째로 비기 시작한다.

---

## 7. 손대면 안 되는 것 (원본 1장 + 이번에 확인된 것)

- `WORLD_SEED`, `TILE_W/H`, `HEIGHT_UNIT`, `CHUNK_SIZE`, `BASE_CHUNK_SPAN`
- `terrain.ts` 의 `hash2` / `valueNoise` / `fbm`
- `codec.ts` 의 저장·압축 형식, **`SCHEMA_VERSION = 1` 그대로**
  (build 값 4 와 bld 코드 9~15 가 늘어난 것뿐이라 마이그레이션이 필요 없다.
   이전 저장본은 "시설 없음"으로 자연스럽게 읽힌다)
- `build.ts` 의 Build ID 0~3, `buildings.ts` 의 건물 코드 0~8, `BLD_NONE=255`,
  `BLD_COVERED=254` — 새 값은 반드시 뒤에 붙인다
- **`isAnchor(v)` 의 의미** (2.1 참고)
- STEP 3.2 의 교통 규칙 전부
- 시뮬레이션 안에서 `Math.random()` 과 `Date.now()` 금지 — 결정론이 깨진다.
  난수가 필요하면 `simRandom(seed, tick, tx, ty)`
