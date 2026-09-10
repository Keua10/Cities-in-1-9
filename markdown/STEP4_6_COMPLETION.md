# Cities in 1-9 — STEP 4.6 완료 기록

기준 저장소: `Keua10/Cities-in-1-9`  
기준 브랜치: `main`  
기준 커밋: `813a196b1f2361dbe829c00736e13094530e3e8e`  
범위: STEP 4.6 특수 시설

## 구현 내용

기존 STEP 3.3 시설 저장 구조를 그대로 확장했다. `Build.Civic`, `FAC_BASE`, `bld` 배열,
시설 앵커/covered 칸 구조를 그대로 사용하며 별도 저장 레이어는 만들지 않았다.
기존 시설 kind 0~16은 유지하고 뒤에만 다음 값을 추가했다.

| kind | 시설 | 크기 | 잠금해제 | 건설비 | 하루 유지비 | 구현된 역할 |
|---:|---|---:|---:|---:|---:|---|
| 17 | 통신탑 | 1×1 | 도시 Lv.2 | 2,000 | 0 | STEP 5 예약. 배치·저장만 가능하며 현재 서비스/만족도/수요/전력에 영향 없음 |
| 18 | 공항 | 3×3 | 도시 Lv.5 | 60,000 | 950 | 평지·도로 필요, 전력 수요 750. 광역교통용 시설 구조와 운영 조건을 예약 |
| 19 | 항구 | 3×3 | 도시 Lv.3 | 35,000 | 600 | 평지·도로·수역 직접 인접 필요, 전력 수요 450 |
| 20 | 교도소 | 3×3 | 도시 Lv.3 | 25,000 | 420 | 경찰서와 별도 kind. 기존 경찰 서비스 채널을 보조하며 담당 정원 1,200, 반경 34, 전력 수요 260 |

### 통신탑

요구사항대로 현재 도시 시뮬레이션 효과를 만들지 않았다. 도로 인접을 요구하지 않고,
전력 수요와 하루 유지비도 0이다. 또한 전력망 엔티티 수집에서도 제외해 건물 간 전력
중계 역할조차 하지 않는다. `ServiceField`, 복지 점수, 만족도, RCI 수요에 들어가지 않는다. 향후 STEP 5에서 kind 17을 그대로 참조할 수 있다.

### 공항·항구

구체적인 수요/만족도/교통량 보너스 수치가 인수인계 명세에 없으므로 임의의 숨은
매크로 보너스는 넣지 않았다. 대신 시설로서 배치·저장·철거·비용·유지비·전력 요구를
완성하고, 항구는 실제 수역 인접 여부를 별도 배치 조건으로 검사한다. 후속 단계에서
광역 교통 효과를 붙여도 저장 형식 변경 없이 kind 18/19를 그대로 사용할 수 있다.

### 교도소

경찰서(kind 1)를 교도소로 대체하지 않고 kind 20으로 별도 저장한다. 다만 기존
`ServiceField`의 도로 서비스 채널을 재사용해 경찰 서비스에 보조 시설로 참여한다.
교도소 자체 정원은 1,200명으로 경찰서 3,000명보다 낮게 두어 경찰서를 완전히
대체하는 상위호환 시설이 되지 않게 했다. 서비스 예산과 전력 공급 상태도 기존
서비스 품질 계산을 그대로 따른다.

## UI·렌더링

시설 선택 시트에 `특수 시설` 그룹을 추가했다. 각 시설은 잠금 레벨, 비용, 유지비,
배치 조건과 현재 역할을 표시한다.

기존 `public/sprites/facilities.png` 576×384 파일은 교체하지 않는다. 기존 kind 0~16의
아틀라스 좌표를 유지하고 새 시설만 빈 열에 런타임으로 그린다. 전체 런타임 아틀라스는
2112×384가 되며 Pixi 시설 메시 구조와 draw call 수는 바뀌지 않는다.

## 저장 호환성

- `FAC_BASE = 9` 유지
- 기존 시설 kind 0~16 유지
- 새 시설은 17~20에만 추가
- `BLD_NONE = 255`, `BLD_COVERED = 254` 유지
- `SCHEMA_VERSION`, RLE codec, `Build.Civic` 저장 구조 변경 없음
- 기존 저장 도시는 그대로 읽힌다

## 변경 파일

- `src/sim/buildings.ts`
- `src/sim/config/facilities.ts`
- `src/sim/config/power.ts`
- `src/sim/power.ts`
- `src/sim/config/sanitation.ts`
- `src/sim/config/special.ts` (신규)
- `src/sim/facilities.ts`
- `src/sim/progression.ts`
- `src/render/facilityAtlas.ts`
- `src/ui/tools.ts`
- `src/ui/cursorDetails.ts`
- `tools/check/facilityAtlasCheck.ts`
- `tools/check/specialFacilityCheck.ts` (신규)
- `tools/check/run.mjs`

## 검증

패치 작성 환경에서 다음 정적 검증을 수행했다.

- 변경 TypeScript 파일 전체 구문 변환 검사 통과
- `tools/check/run.mjs` ESM 구문 검사 통과
- 시설 관련 배열 9종과 잠금 배열이 모두 `FACILITY_COUNT = 21`과 길이 일치
- 기존 kind 0~16의 span/cost/upkeep/range/capacity 값이 현재 main과 동일함을 확인
- 새 kind 17~20이 기존 번호 뒤에만 추가됨을 확인
- span별 아틀라스 열이 0부터 연속이며 기존 열 번호가 밀리지 않음을 확인
- 보호 대상 파일(`terrain.ts`, core constants, 교통 코드, codec, world 저장 구조 등)이 ZIP에 포함되지 않음을 확인

저장소 전체 의존성을 로컬로 내려받을 수 없는 채팅 실행 환경이므로 `npx tsc --noEmit`,
`npm run build`, 전체 `tools/check/run.mjs` 실행까지는 이 환경에서 수행하지 못했다.
대신 ZIP에 `specialFacilityCheck.ts`를 추가하고 기존 atlas 검증도 21종을 검사하도록
확장했다. 저장소에 적용한 뒤 기존 검사 명령에 자동 포함된다.
