import {
  BASE_CHUNK_SPAN,
  BASE_SPACING_CHUNKS,
  CHUNK_SIZE,
} from '../core/constants';
import { chunkIndexOf, chunkKey, localIndexOf } from '../core/iso';
import {
  generateChunk,
  heightAt,
  Terrain,
  type TerrainId,
} from './terrain';

export interface Chunk {
  cx: number;
  cy: number;
  key: string;
  tiles: Uint8Array;
  heights: Uint8Array;
  /** 타일 종류가 바뀔 때마다 올린다. 렌더러는 UV 만 다시 쓴다. */
  revision: number;
  /** 고도가 바뀔 때마다 올린다. 렌더러는 메시를 통째로 다시 만든다. */
  heightRevision: number;
}

/**
 * 지형·소유권을 들고 있는 메모리 상의 월드.
 * 0단계에서는 전부 로컬 생성이고, 1단계에서 Firestore 스냅샷을 여기에 덮어쓴다.
 * 저장되는 것은 "생성값과 달라진 타일"뿐이므로 지형 자체는 저장하지 않는다.
 */
export class World {
  private chunks = new Map<string, Chunk>();
  private explored = new Set<string>();

  /** 이 클라이언트가 조종하는 도시의 base 청크 왼쪽 위 좌표. */
  baseCx = 0;
  baseCy = 0;

  constructor(cityIndex = 0) {
    const origin = baseOriginChunk(cityIndex);
    this.baseCx = origin.cx;
    this.baseCy = origin.cy;
    for (let dy = 0; dy < BASE_CHUNK_SPAN; dy++) {
      for (let dx = 0; dx < BASE_CHUNK_SPAN; dx++) {
        this.explored.add(chunkKey(this.baseCx + dx, this.baseCy + dy));
      }
    }
  }

  getChunk(cx: number, cy: number): Chunk {
    const key = chunkKey(cx, cy);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      const { tiles, heights } = generateChunk(cx, cy);
      chunk = { cx, cy, key, tiles, heights, revision: 0, heightRevision: 0 };
      this.chunks.set(key, chunk);
    }
    return chunk;
  }

  /** 메모리에 이미 올라와 있는 청크만 돌려준다. 없으면 만들지 않는다. */
  peekChunk(cx: number, cy: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cy));
  }

  getTile(tx: number, ty: number): TerrainId {
    const chunk = this.getChunk(chunkIndexOf(tx), chunkIndexOf(ty));
    const i = localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx);
    return chunk.tiles[i] as TerrainId;
  }

  setTile(tx: number, ty: number, id: TerrainId): void {
    const chunk = this.getChunk(chunkIndexOf(tx), chunkIndexOf(ty));
    const i = localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx);
    if (chunk.tiles[i] === id) return;
    chunk.tiles[i] = id;
    chunk.revision++;
  }

  getHeight(tx: number, ty: number): number {
    const chunk = this.getChunk(chunkIndexOf(tx), chunkIndexOf(ty));
    return chunk.heights[localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx)];
  }

  /**
   * 고도만 필요한 경우. 청크가 아직 메모리에 없으면 생성하지 않고
   * 지형 함수로 바로 계산한다. 청크 경계에서 이웃 고도를 볼 때 쓴다.
   */
  sampleHeight(tx: number, ty: number): number {
    const chunk = this.peekChunk(chunkIndexOf(tx), chunkIndexOf(ty));
    if (!chunk) return heightAt(tx, ty);
    return chunk.heights[localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx)];
  }

  /** 지형 편집(터레이닝)용. 지금은 안 쓰지만 렌더러가 이미 대응한다. */
  setHeight(tx: number, ty: number, h: number): void {
    const chunk = this.getChunk(chunkIndexOf(tx), chunkIndexOf(ty));
    const i = localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx);
    if (chunk.heights[i] === h) return;
    chunk.heights[i] = h;
    chunk.heightRevision++;
  }

  isExplored(cx: number, cy: number): boolean {
    return this.explored.has(chunkKey(cx, cy));
  }

  explore(cx: number, cy: number): void {
    this.explored.add(chunkKey(cx, cy));
  }

  exploredCount(): number {
    return this.explored.size;
  }

  /** 메모리 회수. 5단계 이후 청크가 많아지면 필요해진다. */
  unloadChunk(cx: number, cy: number): void {
    this.chunks.delete(chunkKey(cx, cy));
  }

  loadedChunkCount(): number {
    return this.chunks.size;
  }
}

/**
 * 도시 index 를 육각 격자 위의 base 청크 좌표로 바꾼다.
 * 0번은 원점, 이후는 원점을 둘러싸는 링을 시계 방향으로 채운다.
 * 이웃 도시와는 항상 BASE_SPACING_CHUNKS 만큼 떨어지고, 그 사이가 중립 완충지대다.
 */
export function baseOriginChunk(cityIndex: number): { cx: number; cy: number } {
  const { q, r } = hexSpiral(cityIndex);
  // 육각 축좌표 -> 정사각 청크 격자. 홀수 행을 절반 밀어 벌집 모양을 만든다.
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
