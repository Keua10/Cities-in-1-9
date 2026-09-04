import {
  BASE_CHUNK_SPAN,
  BASE_SPACING_CHUNKS,
  CHUNK_SIZE,
  CHUNK_TILES,
  OVERRIDE_NONE,
} from '../core/constants';
import { chunkIndexOf, chunkKey, localIndexOf } from '../core/iso';
import {
  BLD_COVERED,
  BLD_NONE,
  isAnchor,
  levelOfCode,
  MAX_FOOTPRINT,
  zoneOfBuild,
  zoneOfCode,
} from '../sim/buildings';
import { Build } from './build';
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
  build: Uint8Array | null;
  /* ---------- 3.1단계 ---------- */
  bld: Uint8Array | null;
  bornLo: Uint8Array | null;
  bornHi: Uint8Array | null;
}

/**
 * 필지(Parcel) — 학생과 시뮬레이션이 만든 것만 들고 있는 청크 단위 묶음.
 *
 * 왜 Chunk 에서 떼어냈나:
 *   지형(tiles/heights)은 화면 밖으로 나가면 버렸다가 다시 만든다. 4096칸
 *   노이즈라 메모리에 계속 들고 있을 이유가 없다.
 *   그런데 3.1단계의 매크로 틱은 **화면에 없는 청크까지** 돌아야 한다. 도시
 *   반대편 주거지도 계속 자라야 하기 때문이다. 건물 데이터가 지형에 붙어 있으면
 *   틱마다 청크를 되살려야 하고, 그러면 매 틱 노이즈 계산이 터진다.
 *
 * 그래서 Parcel 은 한 번 만들어지면 안 버린다. 학생이 건드린 청크에만 배열이
 * 붙고(그 전에는 전부 null), 청크 하나가 꽉 차도 4KB x 5 = 20KB 다.
 */
export interface Parcel {
  cx: number;
  cy: number;
  key: string;

  /** 지형 오버레이. 생성값과 달라진 칸만. */
  tileOverride: Uint8Array | null;
  heightOverride: Uint8Array | null;

  /** 2단계: 도로·지구. OVERRIDE_NONE = 아무것도 안 지음. */
  build: Uint8Array | null;

  /** 3.1단계: 건물. BLD_NONE = 없음, BLD_COVERED = 옆 건물이 덮은 칸. */
  bld: Uint8Array | null;
  /**
   * 건물이 지어진 게임 날짜(일)를 8비트 두 개로 나눠 담는다. 앵커 칸에만 유효하다.
   *
   * **나이를 직접 저장하지 않는 이유가 여기 있다.**
   * 나이를 넣으면 매 틱 모든 건물 칸의 값이 바뀌어서 도시의 모든 청크가 매 틱
   * 저장 대상이 된다. Spark 무료 한도가 하루 만에 날아간다.
   * 건설 날짜는 한 번 쓰고 다시는 안 바뀌므로 저장 부하가 0 이다.
   * 나이는 (지금 날짜 - 건설 날짜) 로 언제든 계산된다.
   */
  bornLo: Uint8Array | null;
  bornHi: Uint8Array | null;

  /* ---------- 아래는 파생값이다. 저장하지 않고 불러올 때 다시 센다. ---------- */

  /** 지구로 지정됐지만 아직 건물이 없는 칸 수. 재건축 발동 조건이다. */
  emptyPlots: number;
  /** 도로 타일 수. 하루치 유지비 계산에 쓴다. */
  roadCount: number;
  /** 건물(앵커) 수. */
  buildingCount: number;
  /** 건물이 바뀔 때마다 올린다. 건물 메시가 이 값을 보고 다시 굽는다. */
  bldRevision: number;
  /** 재건축 후보를 훑던 자리. 매 틱 청크 전체를 훑지 않기 위한 커서. */
  scanCursor: number;
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
  /** 이 청크의 필지. 항상 있다(내용이 전부 null 일 수는 있다). */
  parcel: Parcel;
}

/** 건물 한 채를 읽어낸 결과. */
export interface BuildingInfo {
  /** 앵커 타일(왼쪽 위). */
  tx: number;
  ty: number;
  zone: number;
  level: number;
  /** 한 변의 타일 수. */
  span: number;
  /** 지어진 게임 날짜. */
  born: number;
}

/**
 * 지형·건물·소유권을 들고 있는 메모리 상의 월드.
 *
 * 지형과 고도는 좌표에서 매번 다시 만든다(저장하지 않는다).
 * 학생이 고친 칸과 시뮬레이션이 지은 건물만 필지에 기록하고, 그 필지만
 * Firestore 로 간다.
 */
export class World {
  private chunks = new Map<string, Chunk>();
  private parcels = new Map<string, Parcel>();
  private explored = new Set<string>();
  /** 저장해야 할 청크 키. */
  private dirtyKeys = new Set<string>();
  /**
   * 그중 학생이 직접 고쳐서 생긴 것이 있는가.
   * 시뮬레이션이 지은 건물만 바뀐 경우와 저장 주기를 다르게 가져간다
   * (saveManager.ts 주석 참고).
   */
  private userEdited = false;
  /** 개척 목록이 바뀌었는가. */
  private exploredDirty = false;
  /** 도로가 바뀌었는가. 매크로가 거리장을 다시 만들지 판단하는 데 쓴다. */
  private roadDirty = false;

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

  /* ---------------- 필지 ---------------- */

  /** 없으면 빈 필지를 만든다. 배열은 실제로 뭔가 지을 때까지 만들지 않는다. */
  getParcel(cx: number, cy: number): Parcel {
    const key = chunkKey(cx, cy);
    let p = this.parcels.get(key);
    if (!p) {
      p = {
        cx,
        cy,
        key,
        tileOverride: null,
        heightOverride: null,
        build: null,
        bld: null,
        bornLo: null,
        bornHi: null,
        emptyPlots: 0,
        roadCount: 0,
        buildingCount: 0,
        bldRevision: 0,
        scanCursor: 0,
      };
      this.parcels.set(key, p);
    }
    return p;
  }

  peekParcel(cx: number, cy: number): Parcel | undefined {
    return this.parcels.get(chunkKey(cx, cy));
  }

  /** 뭔가 지어진 필지만. 매크로 틱이 이걸 돈다. */
  developedParcels(): Parcel[] {
    const out: Parcel[] = [];
    for (const p of this.parcels.values()) {
      if (p.build) out.push(p);
    }
    return out;
  }

  /* ---------------- 지형 ---------------- */

  getChunk(cx: number, cy: number): Chunk {
    const key = chunkKey(cx, cy);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      const { tiles, heights } = generateChunk(cx, cy);
      const parcel = this.getParcel(cx, cy);
      chunk = {
        cx,
        cy,
        key,
        tiles,
        heights,
        revision: 0,
        heightRevision: 0,
        parcel,
      };
      applyTerrainOverride(chunk, parcel);
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
    return chunk.tiles[localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx)] as TerrainId;
  }

  setTile(tx: number, ty: number, id: TerrainId): void {
    const chunk = this.getChunk(chunkIndexOf(tx), chunkIndexOf(ty));
    const i = localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx);
    if (chunk.tiles[i] === id) return;
    chunk.tiles[i] = id;
    const p = chunk.parcel;
    if (!p.tileOverride) {
      p.tileOverride = new Uint8Array(CHUNK_TILES).fill(OVERRIDE_NONE);
    }
    p.tileOverride[i] = id;
    chunk.revision++;
    this.markDirty(p.key, true);
  }

  getHeight(tx: number, ty: number): number {
    const chunk = this.getChunk(chunkIndexOf(tx), chunkIndexOf(ty));
    return chunk.heights[localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx)];
  }

  /**
   * 고도만 필요한 경우. 청크가 아직 메모리에 없으면 생성하지 않고 지형 함수로
   * 바로 계산한다. 저장된 고도 수정분이 있으면 그것까지 본다.
   *
   * 매크로 틱이 화면 밖 청크의 평탄도를 확인할 때 이 경로를 탄다.
   */
  sampleHeight(tx: number, ty: number): number {
    const key = chunkKey(chunkIndexOf(tx), chunkIndexOf(ty));
    const i = localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx);
    const chunk = this.chunks.get(key);
    if (chunk) return chunk.heights[i];
    const p = this.parcels.get(key);
    if (p?.heightOverride) {
      const v = p.heightOverride[i];
      if (v !== OVERRIDE_NONE) return v;
    }
    return heightAt(tx, ty);
  }

  /** 지형 편집(터레이닝)용. 지금은 안 쓰지만 렌더러가 이미 대응한다. */
  setHeight(tx: number, ty: number, h: number): void {
    const chunk = this.getChunk(chunkIndexOf(tx), chunkIndexOf(ty));
    const i = localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx);
    if (chunk.heights[i] === h) return;
    chunk.heights[i] = h;
    const p = chunk.parcel;
    if (!p.heightOverride) {
      p.heightOverride = new Uint8Array(CHUNK_TILES).fill(OVERRIDE_NONE);
    }
    p.heightOverride[i] = h;
    chunk.heightRevision++;
    this.markDirty(p.key, true);
  }

  /* ---------------- 2단계: 도로·지구 ---------------- */

  getBuild(tx: number, ty: number): number {
    const p = this.parcels.get(chunkKey(chunkIndexOf(tx), chunkIndexOf(ty)));
    if (!p?.build) return OVERRIDE_NONE;
    return p.build[localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx)];
  }

  /**
   * 청크를 만들지 않고 build 값만 본다. 도로 연결 마스크를 계산할 때 옆 청크를
   * 들여다보는 용도다. 필지는 항상 메모리에 있으므로 getBuild 와 같은 값이 나온다.
   */
  sampleBuild(tx: number, ty: number): number {
    return this.getBuild(tx, ty);
  }

  /**
   * 도로·지구를 놓거나 지운다.
   *
   * **revision 을 올리지 않는다.** 올리면 ChunkMesh.syncIfStale 이 매 프레임
   * writeAllUVs(4096칸 + 128KB 버퍼 업로드)를 돌려서 드래그 건설이 버벅인다.
   * 화면 갱신은 WorldRenderer.invalidateTile 로 바뀐 칸만 직접 고친다.
   *
   * 건물이 서 있는 칸의 지구를 바꾸거나 지우면 그 건물은 헐린다.
   * 지구 없는 땅에 건물만 떠 있는 상태를 만들지 않기 위해서다.
   */
  setBuild(tx: number, ty: number, value: number, byUser = true): void {
    const cx = chunkIndexOf(tx);
    const cy = chunkIndexOf(ty);
    const p = this.getParcel(cx, cy);
    const i = localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx);
    const cur = p.build ? p.build[i] : OVERRIDE_NONE;
    if (cur === value) return;

    // 이 칸을 덮고 있던 건물은 지구가 바뀌는 순간 존재 근거를 잃는다.
    if (p.bld && p.bld[i] !== BLD_NONE) this.demolishAt(tx, ty);

    if (!p.build) {
      // 지울 것도 없는데 배열만 만들 이유가 없다.
      if (value === OVERRIDE_NONE) return;
      p.build = new Uint8Array(CHUNK_TILES).fill(OVERRIDE_NONE);
    }
    p.build[i] = value;

    if (cur === Build.Road) {
      p.roadCount--;
      this.roadDirty = true;
    }
    if (value === Build.Road) {
      p.roadCount++;
      this.roadDirty = true;
    }
    // 건물이 없는 지구 칸만 "빈 부지" 다. 위에서 헐었으므로 이 시점에는 비어 있다.
    if (zoneOfBuild(cur) >= 0) p.emptyPlots--;
    if (zoneOfBuild(value) >= 0) p.emptyPlots++;
    this.markDirty(p.key, byUser);
  }

  /* ---------------- 3.1단계: 건물 ---------------- */

  /** 칸의 건물 코드. BLD_NONE / BLD_COVERED / 앵커 코드. */
  getBld(tx: number, ty: number): number {
    const p = this.parcels.get(chunkKey(chunkIndexOf(tx), chunkIndexOf(ty)));
    if (!p?.bld) return BLD_NONE;
    return p.bld[localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx)];
  }

  /** 앵커 칸의 건설 날짜. 앵커가 아니면 의미 없는 값이 나온다. */
  bornDayAt(tx: number, ty: number): number {
    const p = this.parcels.get(chunkKey(chunkIndexOf(tx), chunkIndexOf(ty)));
    if (!p?.bornLo) return 0;
    const i = localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx);
    return p.bornLo[i] | ((p.bornHi ? p.bornHi[i] : 0) << 8);
  }

  /**
   * 이 칸을 덮고 있는 건물을 찾는다. 없으면 null.
   *
   * 덮인 칸에 앵커 위치를 따로 저장하지 않는다. 대신 왼쪽 위로 최대
   * MAX_FOOTPRINT 칸까지 거슬러 올라가며 앵커를 찾는다. 최악 9번 조회라
   * 배열을 하나 더 저장하는 것보다 싸다.
   */
  buildingCovering(tx: number, ty: number): BuildingInfo | null {
    const v = this.getBld(tx, ty);
    if (v === BLD_NONE) return null;
    for (let dy = 0; dy < MAX_FOOTPRINT; dy++) {
      for (let dx = 0; dx < MAX_FOOTPRINT; dx++) {
        const ax = tx - dx;
        const ay = ty - dy;
        const code = this.getBld(ax, ay);
        if (!isAnchor(code)) continue;
        const span = levelOfCode(code);
        if (dx < span && dy < span) {
          return {
            tx: ax,
            ty: ay,
            zone: zoneOfCode(code),
            level: span,
            span,
            born: this.bornDayAt(ax, ay),
          };
        }
      }
    }
    return null;
  }

  /**
   * 건물을 세운다. 앵커는 왼쪽 위 칸이고, footprint 는 **한 청크 안에 들어가야 한다.**
   *
   * 청크를 넘지 못하게 한 이유: 건물 하나가 두 청크 문서에 걸치면 저장이
   * 반쪽만 성공했을 때 반쪽짜리 건물이 남는다. 청크 경계 한두 줄에서 큰 건물이
   * 안 올라가는 건 감수한다(청크 64칸 중 두 줄).
   *
   * 부지 검사는 growth.ts 가 이미 끝낸 상태로 부른다.
   */
  placeBuilding(
    tx: number,
    ty: number,
    zone: number,
    level: number,
    bornDay: number,
  ): void {
    const p = this.getParcel(chunkIndexOf(tx), chunkIndexOf(ty));
    if (!p.bld) {
      p.bld = new Uint8Array(CHUNK_TILES).fill(BLD_NONE);
      p.bornLo = new Uint8Array(CHUNK_TILES).fill(BLD_NONE);
      p.bornHi = new Uint8Array(CHUNK_TILES).fill(BLD_NONE);
    }
    if (!p.bornLo) p.bornLo = new Uint8Array(CHUNK_TILES).fill(BLD_NONE);
    if (!p.bornHi) p.bornHi = new Uint8Array(CHUNK_TILES).fill(BLD_NONE);

    const span = level;
    const lx = localIndexOf(tx);
    const ly = localIndexOf(ty);
    const code = zone * 3 + (level - 1);

    for (let dy = 0; dy < span; dy++) {
      for (let dx = 0; dx < span; dx++) {
        const i = (ly + dy) * CHUNK_SIZE + (lx + dx);
        p.bld[i] = dx === 0 && dy === 0 ? code : BLD_COVERED;
        p.emptyPlots--;
      }
    }
    const anchor = ly * CHUNK_SIZE + lx;
    p.bornLo[anchor] = bornDay & 0xff;
    p.bornHi[anchor] = (bornDay >> 8) & 0xff;
    p.buildingCount++;
    p.bldRevision++;
    this.markDirty(p.key, false);
  }

  /** 이 칸을 덮고 있는 건물을 헌다. 지구는 그대로 남는다. */
  demolishAt(tx: number, ty: number): BuildingInfo | null {
    const info = this.buildingCovering(tx, ty);
    if (!info) return null;
    const p = this.getParcel(chunkIndexOf(info.tx), chunkIndexOf(info.ty));
    if (!p.bld) return null;
    const lx = localIndexOf(info.tx);
    const ly = localIndexOf(info.ty);
    for (let dy = 0; dy < info.span; dy++) {
      for (let dx = 0; dx < info.span; dx++) {
        const i = (ly + dy) * CHUNK_SIZE + (lx + dx);
        p.bld[i] = BLD_NONE;
        if (p.bornLo) p.bornLo[i] = BLD_NONE;
        if (p.bornHi) p.bornHi[i] = BLD_NONE;
        // 헐린 자리는 지구가 남아 있으면 다시 빈 부지가 된다.
        if (p.build && zoneOfBuild(p.build[i]) >= 0) p.emptyPlots++;
      }
    }
    p.buildingCount--;
    p.bldRevision++;
    this.markDirty(p.key, false);
    return info;
  }

  /* ---------------- 개척 ---------------- */

  /** 도로가 바뀌었으면 true 를 돌려주고 표시를 지운다. */
  consumeRoadDirty(): boolean {
    if (!this.roadDirty) return false;
    this.roadDirty = false;
    return true;
  }

  isExplored(cx: number, cy: number): boolean {
    return this.explored.has(chunkKey(cx, cy));
  }

  explore(cx: number, cy: number): void {
    const key = chunkKey(cx, cy);
    if (this.explored.has(key)) return;
    this.explored.add(key);
    this.exploredDirty = true;
    this.userEdited = true;
    this.onDirty?.();
  }

  exploredCount(): number {
    return this.explored.size;
  }

  /**
   * 메모리 회수. **지형만 버린다.** 필지는 매크로 틱이 계속 봐야 하므로 남긴다.
   * 아무것도 지어지지 않은 빈 필지는 같이 버린다(카메라가 그냥 지나간 자리).
   */
  unloadChunk(cx: number, cy: number): void {
    const key = chunkKey(cx, cy);
    this.chunks.delete(key);
    const p = this.parcels.get(key);
    if (
      p &&
      !p.build &&
      !p.bld &&
      !p.tileOverride &&
      !p.heightOverride &&
      !this.dirtyKeys.has(key)
    ) {
      this.parcels.delete(key);
    }
  }

  loadedChunkCount(): number {
    return this.chunks.size;
  }

  parcelCount(): number {
    return this.parcels.size;
  }

  /* ---------------- 저장/불러오기 연결부 ---------------- */

  /** 불러온 저장 데이터를 필지에 넣는다. */
  setPersistedOverrides(map: Map<string, ChunkOverride>): void {
    for (const [key, ov] of map) {
      const comma = key.indexOf(',');
      const cx = Number(key.slice(0, comma));
      const cy = Number(key.slice(comma + 1));
      const p = this.getParcel(cx, cy);
      p.tileOverride = ov.tiles;
      p.heightOverride = ov.heights;
      p.build = ov.build;
      p.bld = ov.bld;
      // bld 는 있는데 born 이 없으면(전부 255 라 압축이 null 을 돌려준 경우)
      // 255 로 채운 배열을 되살린다. 값이 정확히 복원된다.
      if (ov.bld) {
        p.bornLo = ov.bornLo ?? new Uint8Array(CHUNK_TILES).fill(BLD_NONE);
        p.bornHi = ov.bornHi ?? new Uint8Array(CHUNK_TILES).fill(BLD_NONE);
      }
      recountParcel(p);
      // 이미 만들어진 청크가 있으면 지형 수정분을 지금 반영한다.
      const chunk = this.chunks.get(key);
      if (chunk) applyTerrainOverride(chunk, p);
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

  /** 저장 대기 중인 변경에 학생이 직접 한 것이 섞여 있는가. */
  hasUserEdits(): boolean {
    return this.userEdited;
  }

  /**
   * 저장할 청크를 꺼내고 변경 표시를 지운다.
   * 배열은 **복사해서** 넘긴다 — 저장이 오가는 동안 시뮬레이션이 계속 건물을
   * 지어도 저장되는 내용과 화면이 어긋나지 않게 하기 위해서다.
   */
  takeDirty(): { keys: string[]; chunks: ChunkSnapshot[] } {
    const keys = [...this.dirtyKeys];
    const chunks: ChunkSnapshot[] = [];
    for (const key of keys) {
      const p = this.parcels.get(key);
      if (!p) continue;
      chunks.push({
        cx: p.cx,
        cy: p.cy,
        tiles: p.tileOverride ? new Uint8Array(p.tileOverride) : null,
        heights: p.heightOverride ? new Uint8Array(p.heightOverride) : null,
        build: p.build ? new Uint8Array(p.build) : null,
        bld: p.bld ? new Uint8Array(p.bld) : null,
        bornLo: p.bornLo ? new Uint8Array(p.bornLo) : null,
        bornHi: p.bornHi ? new Uint8Array(p.bornHi) : null,
      });
    }
    this.dirtyKeys.clear();
    this.exploredDirty = false;
    this.userEdited = false;
    return { keys, chunks };
  }

  /** 저장 실패 시 원상복구. 다음 주기에 다시 시도된다. */
  restoreDirty(keys: readonly string[]): void {
    for (const key of keys) this.dirtyKeys.add(key);
    this.exploredDirty = true;
  }

  private markDirty(key: string, byUser: boolean): void {
    this.dirtyKeys.add(key);
    if (byUser) this.userEdited = true;
    this.onDirty?.();
  }
}

export interface ChunkSnapshot {
  cx: number;
  cy: number;
  tiles: Uint8Array | null;
  heights: Uint8Array | null;
  build: Uint8Array | null;
  bld: Uint8Array | null;
  bornLo: Uint8Array | null;
  bornHi: Uint8Array | null;
}

function applyTerrainOverride(chunk: Chunk, p: Parcel): void {
  if (p.tileOverride) {
    for (let i = 0; i < CHUNK_TILES; i++) {
      const v = p.tileOverride[i];
      if (v !== OVERRIDE_NONE) chunk.tiles[i] = v;
    }
    chunk.revision++;
  }
  if (p.heightOverride) {
    for (let i = 0; i < CHUNK_TILES; i++) {
      const v = p.heightOverride[i];
      if (v !== OVERRIDE_NONE) chunk.heights[i] = v;
    }
    chunk.heightRevision++;
  }
}

/**
 * 파생값(빈 부지 수, 도로 수, 건물 수)을 다시 센다.
 * 저장하지 않는 값이므로 불러온 직후 한 번만 돌면 된다. 청크당 4096칸 훑기는
 * 로그인 때 한 번이라 문제되지 않는다.
 */
export function recountParcel(p: Parcel): void {
  let empty = 0;
  let roads = 0;
  let buildings = 0;
  if (p.build) {
    for (let i = 0; i < CHUNK_TILES; i++) {
      const b = p.build[i];
      if (b === Build.Road) roads++;
      else if (zoneOfBuild(b) >= 0 && (!p.bld || p.bld[i] === BLD_NONE)) empty++;
    }
  }
  if (p.bld) {
    for (let i = 0; i < CHUNK_TILES; i++) {
      if (isAnchor(p.bld[i])) buildings++;
    }
  }
  p.emptyPlots = empty;
  p.roadCount = roads;
  p.buildingCount = buildings;
  p.bldRevision++;
  p.scanCursor = 0;
}

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
