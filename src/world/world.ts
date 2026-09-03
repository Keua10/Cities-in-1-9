import {
  BASE_CHUNK_SPAN,
  BASE_SPACING_CHUNKS,
  CHUNK_SIZE,
  CHUNK_TILES,
  OVERRIDE_NONE,
} from '../core/constants';
import { chunkIndexOf, chunkKey, localIndexOf } from '../core/iso';
import {
  generateChunk,
  heightAt,
  Terrain,
  type TerrainId,
} from './terrain';

/** 생성값과 달라진 칸만 담는 배열. OVERRIDE_NONE 인 칸은 "생성값 그대로". */
export interface ChunkOverride {
  tiles: Uint8Array | null;
  heights: Uint8Array | null;
  /**
   * 2단계: 도로·지구 레이어. 지형과 달리 "생성값" 이 없으므로 이 배열 자체가
   * 곧 저장 대상이다. OVERRIDE_NONE(255) = 아무것도 안 지음.
   */
  build: Uint8Array | null;
}

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
  /**
   * 저장 대상. 생성값과 달라진 칸만 들어간다.
   * 한 번도 고친 적 없는 청크는 null 이라 메모리를 안 먹는다(청크당 4KB 절약).
   */
  tileOverride: Uint8Array | null;
  heightOverride: Uint8Array | null;
  /**
   * 2단계: 도로·지구. 처음 지을 때 만들고 OVERRIDE_NONE 으로 채운다.
   * 아무것도 안 지은 청크는 null 이라 메모리를 안 먹는다(청크당 4KB 절약).
   *
   * tiles 와 달리 "생성값 + 오버레이" 두 벌이 아니다. 전부 학생이 만든
   * 데이터라 배열 하나가 곧 저장 대상이다.
   */
  build: Uint8Array | null;
}

/**
 * 지형·소유권을 들고 있는 메모리 상의 월드.
 *
 * 지형과 고도는 좌표에서 매번 다시 만든다(저장하지 않는다).
 * 학생이 고친 칸만 오버레이 배열에 따로 기록하고, 그 오버레이만 Firestore 로 간다.
 * 1단계에서 불러온 오버레이는 pending 에 넣어두었다가 그 청크가 처음 만들어질 때
 * 덮어씌운다 — 청크는 카메라가 다가가야 생기므로 미리 다 만들면 안 된다.
 */
export class World {
  private chunks = new Map<string, Chunk>();
  private explored = new Set<string>();
  /** 아직 청크가 안 만들어져서 대기 중인 저장 데이터. */
  private pending = new Map<string, ChunkOverride>();
  /** 저장해야 할 청크 키. */
  private dirtyKeys = new Set<string>();
  /** 개척 목록이 바뀌었는가. */
  private exploredDirty = false;

  /** 저장할 게 생겼을 때 불린다. SaveManager 가 여기에 물린다. */
  onDirty: (() => void) | null = null;

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
      chunk = {
        cx,
        cy,
        key,
        tiles,
        heights,
        revision: 0,
        heightRevision: 0,
        tileOverride: null,
        heightOverride: null,
        build: null,
      };
      this.chunks.set(key, chunk);

      const saved = this.pending.get(key);
      if (saved) {
        this.pending.delete(key);
        applyOverride(chunk, saved);
      }
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
    if (!chunk.tileOverride) {
      chunk.tileOverride = new Uint8Array(CHUNK_TILES).fill(OVERRIDE_NONE);
    }
    chunk.tileOverride[i] = id;
    chunk.revision++;
    this.markDirty(chunk.key);
  }

  getHeight(tx: number, ty: number): number {
    const chunk = this.getChunk(chunkIndexOf(tx), chunkIndexOf(ty));
    return chunk.heights[localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx)];
  }

  /**
   * 고도만 필요한 경우. 청크가 아직 메모리에 없으면 생성하지 않고
   * 지형 함수로 바로 계산한다. 청크 경계에서 이웃 고도를 볼 때 쓴다.
   *
   * 주의: 저장된 고도 오버레이는 반영되지 않는다. 터레이닝을 실제로 넣는
   * 단계에서는 청크를 만들어 보는 쪽으로 바꿔야 한다. 지금은 고도를 아무도
   * 고치지 않으므로 문제없다.
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
    if (!chunk.heightOverride) {
      chunk.heightOverride = new Uint8Array(CHUNK_TILES).fill(OVERRIDE_NONE);
    }
    chunk.heightOverride[i] = h;
    chunk.heightRevision++;
    this.markDirty(chunk.key);
  }

  /* ---------------- 2단계: 도로·지구 레이어 ---------------- */

  getBuild(tx: number, ty: number): number {
    const chunk = this.getChunk(chunkIndexOf(tx), chunkIndexOf(ty));
    if (!chunk.build) return OVERRIDE_NONE;
    return chunk.build[localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx)];
  }

  /**
   * 청크를 만들지 않고 build 값만 본다. 도로 연결 마스크를 계산할 때 옆 청크를
   * 들여다보는 용도다.
   *
   * getChunk 를 쓰면 화면 밖 청크까지 generateChunk(4096칸 노이즈)가 돌아버린다.
   * 아직 안 만들어진 청크는 pending(불러왔지만 아직 안 펼친 저장 데이터)까지만 본다.
   */
  sampleBuild(tx: number, ty: number): number {
    const cx = chunkIndexOf(tx);
    const cy = chunkIndexOf(ty);
    const i = localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx);
    const chunk = this.chunks.get(chunkKey(cx, cy));
    if (chunk) return chunk.build ? chunk.build[i] : OVERRIDE_NONE;
    const saved = this.pending.get(chunkKey(cx, cy));
    if (saved?.build) return saved.build[i];
    return OVERRIDE_NONE;
  }

  /**
   * 도로·지구를 놓거나 지운다.
   *
   * **revision 을 올리지 않는다.** 올리면 ChunkMesh.syncIfStale 이 매 프레임
   * writeAllUVs(4096칸 + 128KB 버퍼 업로드)를 돌려서, 드래그로 도로를 그을 때
   * 아이패드에서 체감된다. 화면 갱신은 WorldRenderer.invalidateTile 로
   * 바뀐 칸만 직접 고친다.
   */
  setBuild(tx: number, ty: number, value: number): void {
    const chunk = this.getChunk(chunkIndexOf(tx), chunkIndexOf(ty));
    const i = localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx);
    const cur = chunk.build ? chunk.build[i] : OVERRIDE_NONE;
    if (cur === value) return;
    if (!chunk.build) {
      // 지울 것도 없는데 배열만 만들 이유가 없다.
      if (value === OVERRIDE_NONE) return;
      chunk.build = new Uint8Array(CHUNK_TILES).fill(OVERRIDE_NONE);
    }
    chunk.build[i] = value;
    this.markDirty(chunk.key);
  }

  isExplored(cx: number, cy: number): boolean {
    return this.explored.has(chunkKey(cx, cy));
  }

  explore(cx: number, cy: number): void {
    const key = chunkKey(cx, cy);
    if (this.explored.has(key)) return;
    this.explored.add(key);
    this.exploredDirty = true;
    this.onDirty?.();
  }

  exploredCount(): number {
    return this.explored.size;
  }

  /** 메모리 회수. 5단계 이후 청크가 많아지면 필요해진다. */
  unloadChunk(cx: number, cy: number): void {
    const key = chunkKey(cx, cy);
    // 아직 저장 안 된 청크를 버리면 학생의 작업이 사라진다.
    if (this.dirtyKeys.has(key)) return;
    const chunk = this.chunks.get(key);
    // 오버레이는 살려서 pending 으로 돌려놓는다. 다시 다가오면 그대로 복원된다.
    if (chunk && (chunk.tileOverride || chunk.heightOverride || chunk.build)) {
      this.pending.set(key, {
        tiles: chunk.tileOverride,
        heights: chunk.heightOverride,
        build: chunk.build,
      });
    }
    this.chunks.delete(key);
  }

  loadedChunkCount(): number {
    return this.chunks.size;
  }

  /* ---------------- 저장/불러오기 연결부 ---------------- */

  /** 불러온 오버레이를 넣는다. 청크 생성 전에 부르는 게 정상 경로다. */
  setPersistedOverrides(map: Map<string, ChunkOverride>): void {
    for (const [key, ov] of map) {
      const chunk = this.chunks.get(key);
      if (chunk) applyOverride(chunk, ov);
      else this.pending.set(key, ov);
    }
  }

  /** 불러온 개척 목록으로 갈아끼운다. base 4x4 는 항상 남긴다. */
  setExploredKeys(keys: readonly string[]): void {
    for (const key of keys) this.explored.add(key);
    this.exploredDirty = false;
  }

  exploredKeys(): string[] {
    return [...this.explored];
  }

  hasUnsaved(): boolean {
    return this.dirtyKeys.size > 0 || this.exploredDirty;
  }

  /**
   * 저장할 청크를 꺼내고 변경 표시를 지운다.
   * 배열은 **복사해서** 넘긴다 — 저장이 오가는 동안 학생이 계속 타일을 고쳐도
   * 저장되는 내용과 화면이 어긋나지 않게 하기 위해서다.
   * 저장이 실패하면 restoreDirty 로 되돌린다.
   */
  takeDirty(): { keys: string[]; chunks: ChunkSnapshot[] } {
    const keys = [...this.dirtyKeys];
    const chunks: ChunkSnapshot[] = [];
    for (const key of keys) {
      const chunk = this.chunks.get(key);
      if (!chunk) continue;
      chunks.push({
        cx: chunk.cx,
        cy: chunk.cy,
        tiles: chunk.tileOverride ? new Uint8Array(chunk.tileOverride) : null,
        heights: chunk.heightOverride ? new Uint8Array(chunk.heightOverride) : null,
        build: chunk.build ? new Uint8Array(chunk.build) : null,
      });
    }
    this.dirtyKeys.clear();
    this.exploredDirty = false;
    return { keys, chunks };
  }

  /** 저장 실패 시 원상복구. 다음 주기에 다시 시도된다. */
  restoreDirty(keys: readonly string[]): void {
    for (const key of keys) this.dirtyKeys.add(key);
    this.exploredDirty = true;
  }

  private markDirty(key: string): void {
    this.dirtyKeys.add(key);
    this.onDirty?.();
  }
}

export interface ChunkSnapshot {
  cx: number;
  cy: number;
  tiles: Uint8Array | null;
  heights: Uint8Array | null;
  build: Uint8Array | null;
}

function applyOverride(chunk: Chunk, ov: ChunkOverride): void {
  if (ov.tiles) {
    chunk.tileOverride = ov.tiles;
    for (let i = 0; i < CHUNK_TILES; i++) {
      const v = ov.tiles[i];
      if (v !== OVERRIDE_NONE) chunk.tiles[i] = v;
    }
    chunk.revision++;
  }
  if (ov.heights) {
    chunk.heightOverride = ov.heights;
    for (let i = 0; i < CHUNK_TILES; i++) {
      const v = ov.heights[i];
      if (v !== OVERRIDE_NONE) chunk.heights[i] = v;
    }
    chunk.heightRevision++;
  }
  if (ov.build) {
    // build 는 생성값이 없다. 배열을 그대로 받는다.
    chunk.build = ov.build;
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
