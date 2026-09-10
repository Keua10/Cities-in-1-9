# 시설 아틀라스 원본과 재생성

`facilities-source.png`는 이 작업에서 ImageGen으로 생성한 시설 7종의 원본이다. 기존 buildings.png의 상세 아이소메트릭 픽셀 아트와 맞춰 소방서, 경찰서, 병원, 학교, 소공원, 공원, 체육시설을 요청했다.

최종 편집 요청의 의도: “Keep the seven distinct isometric pixel-art facilities, crisp detailed pixels, matching the existing city building art. Remove all black background, glow, shadows outside the buildings and checkerboard; use a truly transparent background. Keep each facility separate and completely visible.” 도구가 실제 알파 대신 체크무늬를 반환하여 사용자의 승인에 따라 스크립트로 후처리했다.

`npm run art:facilities`는 연결된 밝은 중립 배경을 제거하고 각 시설을 분리해 셀에 배치한다. 원본 내부의 흰 벽은 보존한다. 체육시설 울타리 안에 남은 배경도 별도로 제거한다. 최하단 발판을 셀의 아래 중앙에 맞추며 최근접 보간을 사용한다.

산출물은 `public/sprites/facilities.png`(576×384, RGBA)와 무시되는 `.check/facilities-preview.png`다. 셀은 소공원 64×64, 소방서·경찰서·공원 128×128, 병원·학교·체육시설 192×192다. 렌더러의 기존 시설 메시·UV 규격을 따른다.

`node tools/check/run.mjs atlas`는 이미지 크기, 7개 셀의 실제 내용, 아래 중앙 정렬, 미사용 영역의 완전 투명을 검사한다. 원본 그림의 배치가 바뀌면 분리 영역과 체육시설 배경 제거 영역도 다시 확인해야 한다.
