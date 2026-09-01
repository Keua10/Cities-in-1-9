import {
  CHUNK_SIZE,
  HEIGHT_UNIT,
  TILE_HH,
  TILE_HW,
} from './constants';

/**
 * 좌표계 정의 (이 파일이 유일한 기준이다)
 *
 *  - 타일 좌표 (tx, ty): 정수. 전 학급이 공유하는 글로벌 격자.
 *  - 월드 좌표 (wx, wy): 픽셀. 줌 1.0 기준. 타일의 "윗면 중심"이 기준점.
 *  - 화면 좌표 (sx, sy): 실제 canvas 픽셀. Camera 가 변환한다.
 *
 *  tx 는 화면 오른쪽-아래, ty 는 화면 왼쪽-아래 방향으로 증가한다.
 *  카메라 회전은 없다. (회전을 넣으면 스프라이트가 4배로 늘어난다)
 */

export function tileToWorldX(tx: number, ty: number): number {
  return (tx - ty) * TILE_HW;
}

export function tileToWorldY(tx: number, ty: number, height = 0): number {
  return (tx + ty) * TILE_HH - height * HEIGHT_UNIT;
}

/** 월드 좌표 -> 타일 좌표(실수). 고도 0 평면 기준. */
export function worldToTileF(wx: number, wy: number): { tx: number; ty: number } {
  const a = wx / TILE_HW;
  const b = wy / TILE_HH;
  return { tx: (b + a) / 2, ty: (b - a) / 2 };
}

/** 월드 좌표 -> 타일 좌표(정수). */
export function worldToTile(wx: number, wy: number): { tx: number; ty: number } {
  const f = worldToTileF(wx, wy);
  return { tx: Math.floor(f.tx), ty: Math.floor(f.ty) };
}

export function chunkIndexOf(tile: number): number {
  return Math.floor(tile / CHUNK_SIZE);
}

export function localIndexOf(tile: number): number {
  const m = tile % CHUNK_SIZE;
  return m < 0 ? m + CHUNK_SIZE : m;
}

export function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

export function parseChunkKey(key: string): { cx: number; cy: number } {
  const i = key.indexOf(',');
  return { cx: Number(key.slice(0, i)), cy: Number(key.slice(i + 1)) };
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 청크 하나가 월드 좌표에서 차지하는 축 정렬 사각형. 컬링에 쓴다. */
export function chunkWorldBounds(cx: number, cy: number): Bounds {
  const t0x = cx * CHUNK_SIZE;
  const t0y = cy * CHUNK_SIZE;
  const t1x = t0x + CHUNK_SIZE - 1;
  const t1y = t0y + CHUNK_SIZE - 1;
  return {
    minX: tileToWorldX(t0x, t1y) - TILE_HW,
    maxX: tileToWorldX(t1x, t0y) + TILE_HW,
    minY: tileToWorldY(t0x, t0y) - TILE_HH,
    maxY: tileToWorldY(t1x, t1y) + TILE_HH,
  };
}

/**
 * 화면에 보이는 월드 사각형을 덮는 청크 범위.
 * 아이소메트릭이라 사각형의 네 꼭짓점을 타일 좌표로 옮긴 뒤 min/max 를 잡으면
 * 보수적으로(=조금 넉넉하게) 정확한 범위가 나온다.
 */
export function visibleChunkRange(view: Bounds): {
  cx0: number;
  cy0: number;
  cx1: number;
  cy1: number;
} {
  const corners = [
    worldToTileF(view.minX, view.minY),
    worldToTileF(view.maxX, view.minY),
    worldToTileF(view.minX, view.maxY),
    worldToTileF(view.maxX, view.maxY),
  ];
  let minTx = Infinity;
  let maxTx = -Infinity;
  let minTy = Infinity;
  let maxTy = -Infinity;
  for (const c of corners) {
    if (c.tx < minTx) minTx = c.tx;
    if (c.tx > maxTx) maxTx = c.tx;
    if (c.ty < minTy) minTy = c.ty;
    if (c.ty > maxTy) maxTy = c.ty;
  }
  return {
    cx0: chunkIndexOf(Math.floor(minTx) - 1),
    cy0: chunkIndexOf(Math.floor(minTy) - 1),
    cx1: chunkIndexOf(Math.ceil(maxTx) + 1),
    cy1: chunkIndexOf(Math.ceil(maxTy) + 1),
  };
}
