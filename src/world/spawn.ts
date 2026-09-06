import { BASE_CHUNK_SPAN, BASE_SPACING_CHUNKS, CHUNK_SIZE } from '../core/constants';
import { Terrain } from './terrain';
import type { World } from './world';

/**
 * 도시가 시작하는 위치(base) 계산.
 *
 * World 데이터 모델 자체와는 무관한, "이 도시 index가 지도 어디에 놓이는가/
 * 그 안 어디가 첫 카메라 위치인가" 를 정하는 순수 계산이다. world.ts 의
 * World 클래스가 생성될 때(baseOriginChunk) 와, 접속 직후 화면을 띄울 때
 * (baseCenterTile, findDryTileNearBase) 쓰인다.
 */

/**
 * 도시 index 를 육각 격자 위의 base 청크 좌표로 바꾼다.
 * 0번은 원점, 이후는 원점을 둘러싸는 링을 시계 방향으로 채운다.
 * 이웃 도시와는 항상 BASE_SPACING_CHUNKS 만큼 떨어지고, 그 사이가 중립 완충지대다.
 */
export function baseOriginChunk(cityIndex: number): { cx: number; cy: number } {
  const { q, r } = hexSpiral(cityIndex);
  const cx = Math.round(BASE_SPACING_CHUNKS * (q + r / 2));
  const cy = Math.round(BASE_SPACING_CHUNKS * r);
  return { cx, cy };
}

function hexSpiral(index: number): { q: number; r: number } {
  if (index <= 0) return { q: 0, r: 0 };
  const dirs = [
    [1, 0],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [0, -1],
    [1, -1],
  ] as const;

  let ring = 1;
  let i = index;
  while (i > ring * 6) {
    i -= ring * 6;
    ring++;
  }
  i -= 1;

  let q = dirs[4][0] * ring;
  let r = dirs[4][1] * ring;
  const side = Math.floor(i / ring);
  const step = i % ring;
  for (let s = 0; s < side; s++) {
    q += dirs[s][0] * ring;
    r += dirs[s][1] * ring;
  }
  q += dirs[side][0] * step;
  r += dirs[side][1] * step;
  return { q, r };
}

/** base 영역 한가운데의 타일 좌표. 첫 카메라 위치로 쓴다. */
export function baseCenterTile(world: World): { tx: number; ty: number } {
  const half = (BASE_CHUNK_SPAN * CHUNK_SIZE) / 2;
  return {
    tx: world.baseCx * CHUNK_SIZE + half,
    ty: world.baseCy * CHUNK_SIZE + half,
  };
}

/** base 안에서 물이 아닌 첫 타일. 시작 지점 안내용. */
export function findDryTileNearBase(world: World): { tx: number; ty: number } {
  const c = baseCenterTile(world);
  const limit = BASE_CHUNK_SPAN * CHUNK_SIZE;
  for (let radius = 0; radius < limit; radius += 2) {
    for (let dy = -radius; dy <= radius; dy += 2) {
      for (let dx = -radius; dx <= radius; dx += 2) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        const tx = c.tx + dx;
        const ty = c.ty + dy;
        const t = world.getTile(tx, ty);
        if (t !== Terrain.WaterDeep && t !== Terrain.WaterShallow) {
          return { tx, ty };
        }
      }
    }
  }
  return c;
}
