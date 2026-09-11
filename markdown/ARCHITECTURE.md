# 코드 구조와 변경 기준

## 실행과 UI

`src/main.ts`는 로그인·도시 로드, 월드/렌더러/시뮬레이션 생성, 입력 연결, 프레임 실행을 조립한다. 매 프레임 순서는 매크로 → 교통 → 카메라 → 렌더러 → 미니맵·상태판·HUD다.

- `ui/toolbar.ts`: 안개·격자·중앙 이동·저장·초기화·로그아웃 버튼 연결. 초기화 확인 동작도 여기에 있다.
- `ui/gameHud.ts`: 실행 객체에서 HUD 데이터를 수집하는 연결부. `Hud`가 표시할 때만 계산한다.
- `ui/cursorDetails.ts`: 선택 위치의 시설·서비스·복지 설명. 시뮬레이션 계산과 표시 문구를 분리한다.
- `ui/hud.ts`, `ui/cityPanel.ts`, `ui/minimap.ts`: 각 표시 영역과 갱신 주기를 소유한다.
- `ui/tools.ts`: 도로·지구·시설 배치 및 철거 입력. 월드 변경은 기존 검증 경로를 통한다.

## 월드와 저장

`world/world.ts`는 타일·지구·건물·시설의 실제 상태, 변경 revision, 저장 dirty 표시를 소유한다. `world/terrain.ts`는 시드 기반 지형, `world/slope.ts`는 도로와 차량이 공유하는 경사면이다.

초기 대도시 생성은 세 파일로 나뉜다. `world/cityGen.ts`가 도로망·지구·건물·서비스 시설을, `world/cityUtilities.ts`가 전기·상하수도·위생·특수 시설을 만들고, `world/rng.ts`가 씨앗 하나로 굴러가는 난수를 준다. `world/citySeed.ts`는 기존 import 경로를 유지하는 재노출 창구다. 도로는 연결 그래프를 먼저 만들고 `build.ts`의 규칙을 통과한 간선만 여는 방식이라, 생성된 도로망은 항상 한 덩어리이고 학생이 그린 도로와 같은 규칙을 따른다. 용도 비율과 시설 수는 `sim/config/macro.ts`·`sim/config/facilities.ts`의 정원에서 역산한다 — 이 상수를 바꾸면 생성 도시의 균형도 따라 움직인다. 배경과 계측값은 [CITYGEN_REBUILD.md](CITYGEN_REBUILD.md)에 있다.

`net/types.ts`는 도시/청크 저장 계약, `net/codec.ts`는 기존 RLE 코덱, `net/citySave.ts`는 Firestore 읽기·트랜잭션, `net/saveManager.ts`는 저장 예약·재시도·상태 표시를 담당한다. 이 정리에서 저장 형식·schema version·ID 값을 변경하지 않았다.

## 시뮬레이션

- `sim/macro.ts`: 틱, 캐치업, 성장·통계·필드·재정 처리 순서. 순서를 바꾸면 서비스 부하나 수요 결과가 달라질 수 있다.
- `sim/cityStats.ts`: 파생 통계의 타입과 초기값.
- `sim/satisfaction.ts`: 만족도와 소도시 유예 계산.
- `sim/config/macro.ts`: 시간·경제·수요·성장·도로망 상수.
- `sim/config/traffic.ts`: 배정·혼잡·경로·차량·신호·생활 스케줄 상수.
- `sim/config/facilities.ts`: 서비스·복지·시설 밸런스.
- `sim/config/disasters.ts`: 사건 발생·회복·확산·피해 상수.
- `sim/simConstants.ts`: 기존 import 경로를 보존하는 재노출 창구. 상수는 해당 config 파일에서 수정한다.
- `sim/assignment.ts`, `sim/congestion.ts`, `sim/services.ts`: 도로망과 건물 상태에서 만드는 배정·혼잡·서비스 파생 정보.
- `sim/disasters.ts`, `sim/disasterTypes.ts`: 사건 실행과 사건 저장 계약.
- `sim/traffic/*`: 경로 탐색, 차량 진행, 차선 기하, 교차로 통행권, 신호, 충돌 검사. 경로 요청 큐는 FIFO 순서와 프레임 예산을 유지한다.

## 렌더링

`render/worldRenderer.ts`는 보이는 청크, 각 레이어, 무효화·퇴출을 조율한다. 개별 건물마다 Sprite를 추가하는 구조로 바꾸지 않는다.

- `render/quadBuffers.ts`: 건물·시설·차량의 같은 정점/UV 순서와 인덱스 기록.
- `render/parcelMeshLayer.ts`: 건물·시설 메시의 revision 기반 생성·재사용·제거. 시설이 없는 필지도 revision과 함께 기억해 매 프레임 빈 메시를 만들지 않는다. 다른 필지 객체·revision 변경·청크 퇴출 시 다시 확인한다.
- `render/buildingMesh.ts`, `facilityMesh.ts`, `vehicleMesh.ts`: 내용별 메시 제작. 차량은 한 프레임에 구한 차선 좌표를 정렬·배치에서 재사용한다.
- `render/signalLayer.ts`, `incidentLayer.ts`: 신호와 사건 표시. 지형·저장 상태를 바꾸지 않는다.
- `render/chunkMesh.ts`: 지형·경사 도로 메시와 부분 갱신.

## 확인 명령

```sh
npm ci
npm run format:check
npm run build
npm run check
npm run check:parity
```

`check`는 서비스·교통·차선·장기 성장·재난·아틀라스·구조·대도시 생성 검사를 실행한다. `citygen`은 생성 도시가 기본 2x2 청크를 넘지 않는지, 도로망이 한 덩어리인지, 용도 비율과 일자리 균형이 맞는지, 열흘을 돌려도 흑자인지를 본다. `check:parity`는 고정된 이전 커밋의 실제 코드를 함께 실행해 렌더 버퍼와 시뮬레이션 결과를 비교한다. 기준 커밋은 각 검사 파일에 명시되어 있으며 Git 이력이 필요하다. 의도한 기능/밸런스 변경 시에는 비교 기준 갱신 여부도 검토한다.

PowerShell 변동 프레임 검사는 다음과 같다.

```powershell
$env:TRAFFIC_FRAME_MS = '8.33,16.67,33.33,50'
npm run check:traffic
Remove-Item Env:TRAFFIC_FRAME_MS
```

`npm run format`으로 소스와 검사 코드의 Prettier 형식을 맞춘다. 이미지 원본·저장 데이터·생성 결과는 포맷 대상이 아니다. `.check/`는 실행 로그와 임시 비교 번들용이며 Git에서 제외한다.
