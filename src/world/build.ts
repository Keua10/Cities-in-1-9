import { CHUNK_SIZE, OVERRIDE_NONE } from '../core/constants';
import { chunkIndexOf } from '../core/iso';
import { civicCell, ROAD_CELL_BASE, zoneCell } from '../render/atlas';
import { isWater } from './terrain';
import type { Chunk, World } from './world';

/**
 * 2단계: 지형과 별개인 "지은 것" 레이어.
 *
 * 왜 Terrain 에 도로를 추가하지 않는가:
 *   1. 도로 종류와 연결 상태는 지형에서 분리한다. 연결 상태는 별도 roadLinks
 *      배열에 저장하고, 렌더링용 16가지 모양은 양쪽 연결 비트에서 계산한다.
 *   2. 지구를 철거했을 때 원래 지형으로 돌아가야 한다. 칸당 값이 하나뿐이면
 *      "풀밭 위의 주거지구" 를 표현할 수 없다.
 *   3. 3단계의 건물·차량이 같은 칸에 얹힌다. 지형과 시설을 한 배열에 섞으면
 *      나중에 반드시 되돌려야 한다.
 *
 * 그래서 칸당 바이트를 하나 더 쓴다. 아무것도 짓지 않은 청크는 배열 자체를
 * 만들지 않으므로(null) 실제 메모리는 학생이 건드린 청크에만 늘어난다.
 */
export const Build = {
  /** 아무것도 안 지음. OVERRIDE_NONE(255) 과 반드시 같아야 한다. */
  None: 255,
  Road: 0,
  ZoneR: 1, // 주거
  ZoneC: 2, // 상업
  ZoneI: 3, // 공업
  /** 3.3단계. 시설이 깔고 앉은 칸. 지구가 아니므로 zoneOfBuild 는 -1 을 준다. */
  Civic: 4,
} as const;

export type BuildId = (typeof Build)[keyof typeof Build];

/**
 * 컴파일 타임 확인.
 * Build.None 과 OVERRIDE_NONE 이 갈라지면 여기서 타입 오류가 난다.
 *
 * 이 두 값이 같아야 codec.ts 의 압축 형식을 그대로 재사용할 수 있다.
 * encodeOverride 는 배열이 전부 OVERRIDE_NONE 이면 null 을 돌려주므로,
 * 아무것도 안 지은 청크는 Firestore 필드가 아예 생기지 않는다.
 */
export const BUILD_NONE: typeof OVERRIDE_NONE = Build.None;

/** 새 ID 는 반드시 뒤에(4번부터) 붙인다. 중간에 끼우면 저장된 도시가 어긋난다. */
export const BUILD_LABELS: Record<number, string> = {
  [Build.Road]: '도로',
  [Build.ZoneR]: '주거지구',
  [Build.ZoneC]: '상업지구',
  [Build.ZoneI]: '공업지구',
  [Build.Civic]: '공공시설',
};

/**
 * 연결 방향. 비트 순서가 곧 아틀라스 도로 셀의 번호를 만든다.
 *
 *   비트 0 (1)  +tx  화면 오른쪽 아래
 *   비트 1 (2)  +ty  화면 왼쪽 아래
 *   비트 2 (4)  -tx  화면 왼쪽 위
 *   비트 3 (8)  -ty  화면 오른쪽 위
 *
 * 대각선 연결은 없다.
 */
export const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

export function isRoad(v: number): boolean {
  return v === Build.Road;
}

export function isZone(v: number): boolean {
  return v === Build.ZoneR || v === Build.ZoneC || v === Build.ZoneI;
}

/* ---------------------------------------------------------------- *
 * 연결 계산 — 저장된 양쪽 연결 비트와 도로 존재 여부를 함께 본다
 * ---------------------------------------------------------------- */

/**
 * 도로 연결 마스크(0~15).
 *
 * 필지만 조회하므로 옆 청크 지형이 아직 메모리에 없어도 청크를 새로 만들지 않는다
 * (generateChunk 는 4096칸 노이즈 계산이라 가볍게 부를 함수가 아니다).
 */
export function roadMask(world: World, tx: number, ty: number): number {
  let mask = 0;
  for (let d = 0; d < 4; d++) {
    const dir = DIRS[d];
    if (world.roadsConnected(tx, ty, tx + dir[0], ty + dir[1])) {
      mask |= 1 << d;
    }
  }
  return mask;
}

/** 4방향 중 하나라도 도로면 true. 지구의 색이 이 값에 따라 달라진다. */
export function hasRoadAccess(world: World, tx: number, ty: number): boolean {
  for (const dir of DIRS) {
    if (world.sampleBuild(tx + dir[0], ty + dir[1]) === Build.Road) return true;
  }
  return false;
}

/* ---------------------------------------------------------------- *
 * 배치 가능 여부
 * ---------------------------------------------------------------- */

export interface PlaceResult {
  ok: boolean;
  /** 학생에게 보여줄 거부 사유. 빈 문자열이면 조용히 무시한다(이미 같은 것이 있음). */
  reason: string;
}

const OK: PlaceResult = { ok: true, reason: '' };
const SILENT: PlaceResult = { ok: false, reason: '' };

/**
 * 개척하지 않은 청크에는 아무것도 못 짓는다.
 * 안개를 끄면(디버그 버튼) 지도가 보이므로 이 검사가 없으면 남의 땅에 도로를 깔 수 있다.
 * 5단계에서 개척 규칙이 붙으면 여기가 그대로 관문이 된다.
 */
function exploredOk(world: World, tx: number, ty: number): boolean {
  return world.isExplored(chunkIndexOf(tx), chunkIndexOf(ty));
}

export function canPlaceRoad(world: World, tx: number, ty: number): PlaceResult {
  if (!exploredOk(world, tx, ty)) {
    return { ok: false, reason: '아직 개척하지 않은 땅입니다' };
  }
  if (isWater(world.getTile(tx, ty))) {
    return { ok: false, reason: '물 위에는 도로를 놓을 수 없습니다' };
  }
  if (world.getBuild(tx, ty) === Build.Road) return SILENT;

  // 클릭 배치는 독립된 평면이다. 경사는 실제 연결을 추가할 때 검사한다.
  return OK;
}

/** 아직 빈 도착 칸도 가상 도로로 검사해 배치/과금 전에 거부한다. */
export function canConnectRoads(
  world: World,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): PlaceResult {
  if (Math.abs(ax - bx) + Math.abs(ay - by) !== 1 || world.getBuild(ax, ay) !== Build.Road)
    return SILENT;
  if (!exploredOk(world, ax, ay) || !exploredOk(world, bx, by))
    return { ok: false, reason: '아직 개척하지 않은 땅입니다' };
  if (Math.abs(world.sampleHeight(ax, ay) - world.sampleHeight(bx, by)) > 1)
    return { ok: false, reason: '고도 차가 너무 커서 연결할 수 없습니다' };
  for (const [x, y, nx, ny] of [
    [ax, ay, bx, by],
    [bx, by, ax, ay],
  ]) {
    const h = world.sampleHeight(x, y);
    let slopes = 0;
    for (let d = 0; d < 4; d++) {
      const dx = x + DIRS[d][0],
        dy = y + DIRS[d][1];
      if (
        ((dx === nx && dy === ny) || world.roadsConnected(x, y, dx, dy)) &&
        world.sampleHeight(dx, dy) !== h
      )
        slopes |= 1 << d;
    }
    if (slopes && slopes & (slopes - 1) && slopes !== 5 && slopes !== 10)
      return { ok: false, reason: '한 칸이 여러 방향으로 비탈질 수 없습니다' };
  }
  return OK;
}

/**
 * 지구 지정.
 *
 * 도로 인접은 "배치 조건" 이 아니라 "표시 조건" 이다. 도로 없이도 지정은 되고
 * 색만 어둡게 나온다. 3단계에서 건물이 들어설 때 "도로에 접한 지구만 개발" 로 이어진다.
 */
export function canPlaceZone(world: World, tx: number, ty: number, zone: number): PlaceResult {
  if (!exploredOk(world, tx, ty)) {
    return { ok: false, reason: '아직 개척하지 않은 땅입니다' };
  }
  if (isWater(world.getTile(tx, ty))) {
    return { ok: false, reason: '물 위에는 지구를 지정할 수 없습니다' };
  }
  const cur = world.getBuild(tx, ty);
  if (cur === Build.Road) {
    return { ok: false, reason: '도로를 먼저 철거해야 합니다' };
  }
  if (cur === zone) return SILENT;
  return OK;
}

/* ---------------------------------------------------------------- *
 * 렌더링에 쓸 윗면 셀 결정
 * ---------------------------------------------------------------- */

/**
 * 타일 윗면이 어떤 아틀라스 셀을 쓸지 정한다.
 *
 * 도로·지구는 **정점을 늘리지 않고** 윗면 UV 만 바꿔서 그린다. 반투명 오버레이를
 * 새 사각형으로 얹으면 청크당 사각형이 5,600 -> 9,700 개로 늘고 정점 버퍼가
 * 두 배가 된다. 아이패드에서 감당할 이유가 없다.
 *
 * 고도 음영 사각형은 이미 윗면 위에 겹쳐 그려지므로 도로·지구 위에도 높이에 따른
 * 밝기가 그대로 얹힌다.
 *
 * 반환값은 아틀라스 셀 번호이고 **저장되지 않는다.** 나중에 셀 순서를 바꾸거나
 * 진짜 그림으로 교체해도 도시 데이터가 깨지지 않는다.
 */
export type TopResolver = (chunk: Chunk, index: number, tx: number, ty: number) => number;

export function makeTopResolver(world: World): TopResolver {
  return (chunk, index, tx, ty) => {
    // 아무것도 안 지은 칸이 대부분이다. 배열 읽기 한 번으로 끝내는 빠른 길.
    const b = chunk.parcel.build ? chunk.parcel.build[index] : Build.None;
    if (b === Build.None) return chunk.tiles[index];
    if (b === Build.Road) return ROAD_CELL_BASE + roadMask(world, tx, ty);
    if (b >= Build.ZoneR && b <= Build.ZoneI) {
      return zoneCell(b - Build.ZoneR, hasRoadAccess(world, tx, ty));
    }
    if (b === Build.Civic) return civicCell(hasRoadAccess(world, tx, ty));
    // 모르는 ID(미래 버전에서 저장된 값)는 지형으로 떨어뜨린다. 게임이 죽으면 안 된다.
    return chunk.tiles[index];
  };
}

/** 청크 안의 지역 index. world.ts 와 같은 규칙을 쓴다. */
export function localIndex(lx: number, ly: number): number {
  return ly * CHUNK_SIZE + lx;
}
