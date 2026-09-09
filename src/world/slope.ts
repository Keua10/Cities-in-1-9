import { Build } from './build';
import type { World } from './world';

/**
 * 경사(비탈) 도로의 지면 모양.
 *
 * ---------------------------------------------------------------
 * 왜 이 파일이 생겼나
 * ---------------------------------------------------------------
 * 2단계까지 타일 윗면은 **언제나 평평한 다이아몬드 한 장**이었다. 고도가 다른
 * 이웃과는 절벽(옆면 사각형)으로 이어졌다. 지형만 있을 때는 그게 맞다.
 *
 * 그런데 도로가 언덕을 오르면 그 규칙이 그대로 화면에 나온다.
 *
 *     고도 1 도로 [평평] │흙 절벽 16px│ [평평] 고도 0 도로
 *
 * 도로 한복판을 흙벽이 가로지르고, 차는 그 벽을 뚫고 순간이동한다.
 * build.ts 의 경사 규칙(곧은 비탈길만 허용)은 "그릴 수 있는 모양"만 남기려고
 * 만든 것인데, 정작 **비탈을 그리는 코드가 없었다.** 그게 이번 버그다.
 *
 * ---------------------------------------------------------------
 * 지면 모형: 변의 높이는 두 타일의 평균
 * ---------------------------------------------------------------
 * 도로 타일 하나의 윗면을 평면 하나로 본다. 그 평면은
 *
 *     맞닿은 두 도로 타일의 고도가 다르면, 그 변의 높이 = 두 고도의 평균
 *     그 밖의 변(지형·건물과 닿는 변)의 높이 = 자기 고도 그대로
 *
 * 이 규칙 하나로 도로면이 **틈 없이 이어진다.** 고도 0-1 로 맞닿은 두 도로는
 * 양쪽 모두 맞닿는 변이 0.5 라 정확히 붙고, 0-1-2 로 이어지는 곧은 비탈길의
 * 가운데 칸은 0.5 에서 1.5 로 올라가는 완전한 램프가 된다.
 *
 * 평면이므로 타일 하나는 (중심 높이, tx 방향 기울기, ty 방향 기울기) 세 수로
 * 끝난다. 아이소메트릭 투영에서 이 평면은 정점 4개의 y 만 움직이면 나온다 —
 * 사각형도 드로우콜도 늘지 않는다(chunkMesh.ts 참고).
 *
 * 차량도 같은 평면을 읽는다(surfaceHeightAt). 렌더와 시뮬이 이 파일 하나만
 * 보므로 "차는 램프 위, 도로는 계단" 처럼 갈라질 수 없다.
 */
export interface TileSurface {
  /** 타일 중심의 높이(고도 단계, 0.25 단위로 소수가 나온다). */
  zc: number;
  /** tx 가 1 늘 때의 높이 변화. 0 이면 이 축으로 평평하다. */
  dzx: number;
  /** ty 가 1 늘 때의 높이 변화. */
  dzy: number;
}

/**
 * 램프로 이어지는 고도차. 지형 생성이 이웃 간 고도차를 0 또는 1 로 보장하므로
 * 정상 지형에서는 항상 1 이다. 2 이상(지형을 편집한 저장본)은 램프로 잇지 않고
 * 예전처럼 절벽으로 둔다 — 한 칸에 두 단계짜리 램프를 그리면 도로가 벽이 된다.
 */
const RAMP_STEP = 1;

export function flatSurface(h: number): TileSurface {
  return { zc: h, dzx: 0, dzy: 0 };
}

/** 두 타일이 램프로 이어지는가 = 둘 다 도로이고 고도차가 정확히 한 단계. */
export function rampJoins(world: World, ax: number, ay: number, bx: number, by: number): boolean {
  if (!world.roadsConnected(ax, ay, bx, by)) return false;
  if (world.sampleBuild(ax, ay) !== Build.Road) return false;
  if (world.sampleBuild(bx, by) !== Build.Road) return false;
  return Math.abs(world.sampleHeight(ax, ay) - world.sampleHeight(bx, by)) === RAMP_STEP;
}

/**
 * (tx, ty) 변의 높이. dx, dy 는 변의 방향(4방향 중 하나).
 * 램프로 이어지는 변만 두 고도의 평균이 되고, 나머지는 자기 고도다.
 */
function edgeHeight(
  world: World,
  tx: number,
  ty: number,
  h: number,
  dx: number,
  dy: number,
): number {
  const nx = tx + dx;
  const ny = ty + dy;
  if (!rampJoins(world, tx, ty, nx, ny)) return h;
  return (h + world.sampleHeight(nx, ny)) / 2;
}

/** 타일 하나의 윗면 평면. 도로가 아니면 언제나 평평하다. */
export function surfaceAt(world: World, tx: number, ty: number): TileSurface {
  const h = world.sampleHeight(tx, ty);
  if (world.sampleBuild(tx, ty) !== Build.Road) return flatSurface(h);

  const px = edgeHeight(world, tx, ty, h, 1, 0);
  const mx = edgeHeight(world, tx, ty, h, -1, 0);
  const py = edgeHeight(world, tx, ty, h, 0, 1);
  const my = edgeHeight(world, tx, ty, h, 0, -1);

  // 중심은 네 변의 평균이다. 한쪽만 비탈진 "비탈의 시작" 칸은 자기 고도에서
  // 0.25 만 올라가고, 그 덕에 아래 칸과 맞닿는 변이 정확히 0.5 로 떨어진다.
  return {
    zc: (px + mx) / 2 + (py + my) / 2 - h,
    dzx: px - mx,
    dzy: py - my,
  };
}

/** 이 타일이 평평하지 않은가. 도로를 놓았을 때 메시를 다시 구울지 판단한다. */
export function isRamped(world: World, tx: number, ty: number): boolean {
  const s = surfaceAt(world, tx, ty);
  return s.dzx !== 0 || s.dzy !== 0;
}

/**
 * 실수 타일 좌표에서의 지면 높이. 차량이 램프를 따라 오르내릴 때 쓴다.
 *
 * 가장 가까운 타일의 평면을 그대로 읽는다. 변에서 이웃 타일과 값이 같으므로
 * 어느 쪽 타일로 반올림되든 결과가 이어진다.
 */
export function surfaceHeightAt(world: World, txF: number, tyF: number): number {
  const tx = Math.round(txF);
  const ty = Math.round(tyF);
  const s = surfaceAt(world, tx, ty);
  return s.zc + s.dzx * (txF - tx) + s.dzy * (tyF - ty);
}

/* ---------------------------------------------------------------- *
 * 메시가 쓰는 샘플러
 * ---------------------------------------------------------------- */

export interface SlopeSampler {
  /** 타일 윗면 평면. */
  surface(tx: number, ty: number): TileSurface;
  /** (dx, dy) 방향 면의 절벽. steps 가 0 이면 벽이 없다. */
  wall(tx: number, ty: number, dx: number, dy: number): EdgeWall;
}

/**
 * 한 면(변)에 세울 절벽의 위·아래 모서리 높이.
 *
 * 예전에는 "고도차 = 사각형 장수" 하나로 끝냈다. 양쪽 지면이 항상 평평했기
 * 때문이다. 경사 도로가 생기면 그 가정이 깨진다.
 *
 *   - 램프로 이어지는 변    두 지면이 같은 높이로 만난다 -> 벽이 없어야 한다
 *   - 램프 옆의 평지        평지는 평평한데 옆 도로면은 기울어 있다
 *                          -> 반 칸짜리 삼각 틈이 생긴다. 그 틈을 메울
 *                             납작한 벽 한 장이 필요하다
 *
 * 그래서 위·아래 모서리를 **꼭짓점마다** 들고 다닌다. 평지끼리 만나면 예전과
 * 정확히 같은 값이 나온다(위 = 자기 고도, 아래 = 이웃 고도, 장수 = 그 차이).
 */
export interface EdgeWall {
  /** 쌓을 사각형 장수. */
  steps: number;
  /** 윗변 두 꼭짓점(정점 순서와 같은 차례)의 지면 높이. */
  topA: number;
  topB: number;
  /** 아랫변 두 꼭짓점의 지면 높이 = 이웃 타일의 지면. */
  botA: number;
  botB: number;
}

const NO_WALL: EdgeWall = { steps: 0, topA: 0, topB: 0, botA: 0, botB: 0 };

/** 평면 s 의 (sx, sy) 지점 높이. sx, sy 는 타일 중심 기준 -0.5 ~ +0.5. */
function cornerZ(s: TileSurface, sx: number, sy: number): number {
  return s.zc + s.dzx * sx + s.dzy * sy;
}

/**
 * (dx, dy) 방향 면의 절벽을 계산한다.
 *
 * 꼭짓점 차례는 chunkMesh 가 정점을 쓰는 차례와 같아야 한다.
 *   +tx 면: A = (+0.5, +0.5) 꼭짓점, B = (+0.5, -0.5)
 *   +ty 면: A = (-0.5, +0.5) 꼭짓점, B = (+0.5, +0.5)
 */
export function edgeWallAt(world: World, tx: number, ty: number, dx: number, dy: number): EdgeWall {
  const self = surfaceAt(world, tx, ty);
  const near = surfaceAt(world, tx + dx, ty + dy);

  let topA: number;
  let topB: number;
  let botA: number;
  let botB: number;
  if (dx === 1) {
    topA = cornerZ(self, 0.5, 0.5);
    topB = cornerZ(self, 0.5, -0.5);
    botA = cornerZ(near, -0.5, 0.5);
    botB = cornerZ(near, -0.5, -0.5);
  } else {
    topA = cornerZ(self, -0.5, 0.5);
    topB = cornerZ(self, 0.5, 0.5);
    botA = cornerZ(near, -0.5, -0.5);
    botB = cornerZ(near, 0.5, -0.5);
  }

  /*
   * 아랫변이 윗변보다 높으면 **그 꼭짓점에서 벽을 붙인다**(아래 = 위).
   *
   * 램프 옆 평지가 그렇다. 한쪽 꼭짓점은 반 칸 아래(틈)인데 다른 쪽은 반 칸
   * 위(도로가 평지 위로 올라온 쪽)다. 그대로 두면 사각형이 꼬여서(bowtie)
   * 삼각형 두 장이 어긋나 그리고, 메우려던 틈이 그대로 남는다.
   * 붙여 두면 그 꼭짓점에서 폭 0 인 삼각형이 되어 틈만 정확히 덮는다.
   */
  const lowA = Math.min(botA, topA);
  const lowB = Math.min(botB, topB);
  const drop = Math.max(topA - lowA, topB - lowB);
  // 부동소수 먼지로 벽 한 장이 서지 않게 한다. 0.05단계 = 화면에서 1픽셀 이하.
  if (drop <= 0.05) return NO_WALL;
  return { steps: Math.max(1, Math.ceil(drop - 0.05)), topA, topB, botA: lowA, botB: lowB };
}

export function makeSlopeSampler(world: World): SlopeSampler {
  return {
    surface: (tx, ty) => surfaceAt(world, tx, ty),
    wall: (tx, ty, dx, dy) => edgeWallAt(world, tx, ty, dx, dy),
  };
}
