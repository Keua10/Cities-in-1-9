/**
 * 예전 호환 창구.
 *
 * STEP 4 에서 생성 도로의 연결 비트를 만들기 위해 이 파일이 `world.setBuild`
 * 를 몽키패치하고, 도로를 다 깐 뒤 주변 도로의 "주 진행축"을 추정해서 연결을
 * 열었다. 추정이 필요했던 이유는 생성기가 연결을 모르는 채로 도로를 깔았기
 * 때문이다.
 *
 * 이제는 생성기가 연결 그래프를 직접 만든다(cityGen.growRoadNetwork). 추정할
 * 것이 없으므로 패치도, 흐름 추정도 없앴다. 이 파일은 기존 import 경로를
 * 유지하기 위한 재노출 창구로만 남는다.
 */
export {
  generateCity,
  randomCitySeed,
  SEEDED_CITY_MONEY,
  seedCityIfEmpty,
  type SeededCity,
} from './cityGen';
