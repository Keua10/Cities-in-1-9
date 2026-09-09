import { BASE_CHUNK_SPAN, CHUNK_SIZE, CHUNK_TILES, OVERRIDE_NONE } from '../core/constants';
import { chunkIndexOf, chunkKey, localIndexOf } from '../core/iso';
import {
  BLD_COVERED,
  BLD_NONE,
  facCode,
  facilityKindOfCode,
  isAnchor,
  isAnyAnchor,
  isFacilityAnchor,
  levelOfCode,
  MAX_FOOTPRINT,
  zoneOfBuild,
  zoneOfCode,
} from '../sim/buildings';
import { facilitySpan } from '../sim/facilities';
import { Build, DIRS } from './build';
import { baseOriginChunk } from './spawn';
import { generateChunk, heightAt, type TerrainId } from './terrain';

/** 생성값과 달라진 칸만 담는 배열. OVERRIDE_NONE 인 칸은 "생성값 그대로". */
export interface ChunkOverride {
  roadLinks?: Uint8Array | null;
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
  /** 0~15: 명시적 연결. 255/없음: 이전 저장본과 생성 도시의 인접 연결. */
  roadLinks: Uint8Array | null;
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

/** 건물 한 채를 읽어낸 결과. 3.3단계부터 시설도 여기로 나온다. */
export interface BuildingInfo {
  /** 앵커 타일(왼쪽 위). */
  tx: number;
  ty: number;
  /**
   * 시설이면 -1.
   *
   * 기존 호출부가 zone 비교로 시설을 거르게 하려고 이 값을 쓴다. 예를 들어
   * growth.ts:rebuildFits 의 `if (info.zone !== zone) return false` 가 코드를 한 줄도
   * 안 고치고 시설을 재건축 대상에서 제외한다.
   */
  zone: number;
  level: number;
  /** 한 변의 타일 수. */
  span: number;
  /** 지어진 게임 날짜. */
  born: number;
  /** 3.3단계. 지구 건물이면 null, 시설이면 종류 번호(0~6). */
  kind: number | null;
}

/**
 * 지형·건물·소유권을 들고 있는 메모리 상의 월드.
 *
 * 지형과 고도는 좌표에서 매번 다시 만든다(저장하지 않는다).
 * 학생이 고친 칸과 시뮬레이션이 지은 건물만 필지에 기록하고, 그 필지만
 * Firestore 로 간다.
 */
export class World {
  /** 타일 수가 같아도 연결 편집을 감지한다. */
  roadRevision = 0;
  walkRevision = 0;
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
        roadLinks: null,
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
    this.walkRevision++;
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
    this.walkRevision++;
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

  private roadBits(tx: number, ty: number): number {
    const p = this.peekParcel(chunkIndexOf(tx), chunkIndexOf(ty));
    return (p?.roadLinks?.[localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx)] ?? 255) & 15;
  }

  roadsConnected(ax: number, ay: number, bx: number, by: number): boolean {
    const dx = bx - ax,
      dy = by - ay;
    const d =
      dy === 0
        ? dx === 1
          ? 0
          : dx === -1
            ? 2
            : -1
        : dx === 0
          ? dy === 1
            ? 1
            : dy === -1
              ? 3
              : -1
          : -1;
    return (
      d >= 0 &&
      this.getBuild(ax, ay) === Build.Road &&
      this.getBuild(bx, by) === Build.Road &&
      !!(this.roadBits(ax, ay) & (1 << d)) &&
      !!(this.roadBits(bx, by) & (1 << ((d + 2) & 3)))
    );
  }

  private writeRoadBits(tx: number, ty: number, bits: number, byUser: boolean): void {
    const p = this.getParcel(chunkIndexOf(tx), chunkIndexOf(ty));
    p.roadLinks ??= new Uint8Array(CHUNK_TILES).fill(OVERRIDE_NONE);
    p.roadLinks[localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx)] = bits;
    this.roadDirty = true;
    this.roadRevision++;
    this.markDirty(p.key, byUser);
  }

  /** 검증을 통과한 드래그의 연속 두 칸을 양방향으로 연결한다. */
  connectRoads(ax: number, ay: number, bx: number, by: number): boolean {
    const d = DIRS.findIndex(([dx, dy]) => bx - ax === dx && by - ay === dy);
    if (
      d < 0 ||
      this.getBuild(ax, ay) !== Build.Road ||
      this.getBuild(bx, by) !== Build.Road ||
      this.roadsConnected(ax, ay, bx, by)
    )
      return false;
    this.writeRoadBits(ax, ay, this.roadBits(ax, ay) | (1 << d), true);
    this.writeRoadBits(bx, by, this.roadBits(bx, by) | (1 << ((d + 2) & 3)), true);
    return true;
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
    this.walkRevision++;
    if (cur === Build.Road) {
      for (let d = 0; d < 4; d++) {
        const nx = tx + DIRS[d][0],
          ny = ty + DIRS[d][1];
        if (this.getBuild(nx, ny) === Build.Road) {
          this.writeRoadBits(nx, ny, this.roadBits(nx, ny) & ~(1 << ((d + 2) & 3)), byUser);
        }
      }
    }
    if (value === Build.Road || cur === Build.Road) {
      this.writeRoadBits(tx, ty, value === Build.Road && byUser ? 0 : OVERRIDE_NONE, byUser);
    }

    // 이 칸을 덮고 있던 건물은 지구가 바뀌는 순간 존재 근거를 잃는다.
    const removed = p.bld && p.bld[i] !== BLD_NONE ? this.demolishAt(tx, ty) : null;
    // 헐린 것이 시설이면 build 쪽에 Civic 칸이 그대로 남는다. 유령 칸이 되므로
    // 여기서 함께 지운다. 아래에서 p.build[i] = value 가 이 칸을 다시 덮어쓴다.
    if (removed && removed.kind !== null) {
      this.clearFacilityFootprintBuild(removed);
    }

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
   *
   * 3.3단계: **여기만 isAnyAnchor 를 쓴다.** 시설 칸에서도 앵커를 찾아야 하기
   * 때문이다. 다른 곳은 전부 isAnchor 그대로여야 시설이 인구·일자리·통행·재건축에
   * 섞이지 않는다. 시설이 3x3 까지라 탐색 범위 MAX_FOOTPRINT = 3 이 그대로 맞는다.
   */
  buildingCovering(tx: number, ty: number): BuildingInfo | null {
    const v = this.getBld(tx, ty);
    if (v === BLD_NONE) return null;
    for (let dy = 0; dy < MAX_FOOTPRINT; dy++) {
      for (let dx = 0; dx < MAX_FOOTPRINT; dx++) {
        const ax = tx - dx;
        const ay = ty - dy;
        const code = this.getBld(ax, ay);
        if (!isAnyAnchor(code)) continue;
        const facility = isFacilityAnchor(code);
        const kind = facility ? facilityKindOfCode(code) : null;
        const span = facility ? facilitySpan(kind as number) : levelOfCode(code);
        if (dx < span && dy < span) {
          return {
            tx: ax,
            ty: ay,
            // 시설은 지구가 아니다. -1 이 그것을 말한다.
            zone: facility ? -1 : zoneOfCode(code),
            // 시설의 level 은 span 과 같은 값을 넣어둔다. congestion.ts / citizens.ts 가
            // `?? 1` 로 읽는 자리인데, 그 호출부는 지구 건물 좌표로만 불리므로
            // 실제로는 도달하지 않는다.
            level: span,
            span,
            born: this.bornDayAt(ax, ay),
            kind,
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
  placeBuilding(tx: number, ty: number, zone: number, level: number, bornDay: number): void {
    this.walkRevision++;
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

  /* ---------------- 3.3단계: 시설 ---------------- */

  /**
   * 시설을 세운다. **build/bld 두 레이어에 함께 쓴다.** 검사는 호출 전에 끝난 상태.
   *
   *   build 레이어   footprint 전 칸 = Build.Civic (4)
   *   bld  레이어   앵커 칸 = FAC_BASE + kind (9~15), 나머지 칸 = BLD_COVERED
   *                 (1x1 소공원은 앵커 한 칸뿐이고 COVERED 칸이 없다)
   *   bornLo/Hi     앵커 칸에 건설 날짜 (이번 단계에서는 읽지 않는다. 노후화용 자리)
   *
   * 양쪽에 쓰는 이유: bld 에만 넣으면 growth.ts 가 그 칸을 빈 지구로 착각하고,
   * build 에만 넣으면 footprint 와 건설 날짜를 표현할 배열이 없다. 두 겹이 다
   * 걸리므로 한쪽을 실수로 놓쳐도 시설 위에 아파트가 서지 않는다.
   *
   * **placeBuilding 을 재사용하지 마라.** 그 함수는 footprint 칸마다 emptyPlots--
   * 를 하는데, 시설 칸은 애초에 emptyPlots 에 들어간 적이 없다(setBuild 는
   * zoneOfBuild(value) >= 0 일 때만 센다). 그대로 쓰면 emptyPlots 가 음수로 새고,
   * growParcel 의 `p.emptyPlots > 0` 분기가 영구히 거짓이 되어 **그 청크에서
   * 신축이 멈춘다.** 원인에서 아주 멀리 떨어져 나타나는 증상이라 미리 못박는다.
   */
  placeFacility(tx: number, ty: number, kind: number, bornDay: number): void {
    const span = facilitySpan(kind);

    // 1) footprint 전 칸에 build = Build.Civic.
    //    setBuild 를 쓴다 — 기존 건물이 있으면 내부의 demolishAt 이 알아서 헌다.
    //    setBuild 는 칸마다 필지를 스스로 찾으므로 청크를 걸쳐도 안전하다.
    for (let dy = 0; dy < span; dy++) {
      for (let dx = 0; dx < span; dx++) {
        this.setBuild(tx + dx, ty + dy, Build.Civic, true);
      }
    }

    // 2) bld 배열 -> 앵커에 facCode(kind), 나머지에 BLD_COVERED.
    //    **칸마다 필지를 다시 찾는다.** footprint 가 청크 경계를 걸치면 칸들이
    //    서로 다른 필지에 나뉘어 들어가기 때문이다.
    const touched = new Set<Parcel>();
    for (let dy = 0; dy < span; dy++) {
      for (let dx = 0; dx < span; dx++) {
        const anchorCell = dx === 0 && dy === 0;
        touched.add(
          this.writeBldCell(
            tx + dx,
            ty + dy,
            anchorCell ? facCode(kind) : BLD_COVERED,
            // 3) 건설 날짜는 앵커 칸에만. 이번 단계에서는 읽지 않지만
            //    노후화(STEP 4)를 위해 남긴다.
            anchorCell ? bornDay : null,
          ),
        );
      }
    }

    // 4) p.buildingCount 는 **올리지 않는다.** 그 값은 지구 건물 수이고
    //    recountParcel 과 짝이 맞아야 한다.
    //    걸친 필지가 여럿이면 전부 다시 굽고 전부 저장해야 한다.
    for (const p of touched) {
      p.bldRevision++;
      this.markDirty(p.key, true); // 학생이 한 일이므로 byUser = true
    }
  }

  /**
   * bld 한 칸을 쓴다. 칸이 속한 필지를 찾아 배열을 확보하고 값을 넣는다.
   *
   * footprint 를 도는 쪽에서 필지를 한 번만 찾아 쓰면 청크 경계를 걸친 순간
   * 지역 index 가 옆줄로 넘어가 엉뚱한 칸을 덮어쓴다. 칸마다 찾는 비용은
   * Map 조회 한 번이고, 시설은 최대 9칸이라 부담이 없다.
   */
  private writeBldCell(tx: number, ty: number, code: number, bornDay: number | null): Parcel {
    const p = this.getParcel(chunkIndexOf(tx), chunkIndexOf(ty));
    if (!p.bld) p.bld = new Uint8Array(CHUNK_TILES).fill(BLD_NONE);
    if (!p.bornLo) p.bornLo = new Uint8Array(CHUNK_TILES).fill(BLD_NONE);
    if (!p.bornHi) p.bornHi = new Uint8Array(CHUNK_TILES).fill(BLD_NONE);
    const i = localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx);
    p.bld[i] = code;
    if (bornDay !== null) {
      p.bornLo[i] = bornDay & 0xff;
      p.bornHi[i] = (bornDay >> 8) & 0xff;
    }
    return p;
  }

  /**
   * 이 칸을 덮은 시설을 통째로 헌다. build 의 Civic 칸까지 전부 지운다.
   * 시설이 아니면(지구 건물이거나 빈 칸) 아무것도 하지 않고 false.
   */
  removeFacilityAt(tx: number, ty: number): boolean {
    const info = this.buildingCovering(tx, ty);
    if (!info || info.kind === null) return false;
    // setBuild 가 bld 쪽 시설을 헐고, 그 안에서 남은 Civic 칸까지 정리한다.
    this.setBuild(info.tx, info.ty, Build.None, true);
    return true;
  }

  /**
   * 시설을 헌 뒤 build 레이어에 남은 Civic 칸을 지운다.
   *
   * 학생이 철거 도구로 시설의 **한 칸** 을 찍으면 setBuild(tx,ty,None) 이 불리고,
   * 그 안의 demolishAt 이 bld 쪽 시설 전체를 지운다. 그런데 build 쪽에는 나머지
   * span²-1 칸이 Civic 인 채로 남는다. **아무것도 지을 수 없는 유령 칸** 이다.
   *
   * Tools 쪽에서 처리하지 않는 이유: 지구 도구로 시설 위를 덧칠해도 같은 일이
   * 일어나기 때문이다. 한 군데(setBuild)에서 막아야 전부 막힌다.
   *
   * **setBuild 를 재귀 호출하지 않는다** — 무한 재귀가 된다. 배열에 직접 쓴다.
   * Civic 칸은 도로도 지구도 아니므로 roadCount/emptyPlots 를 건드릴 것이 없다.
   * 청크를 걸친 시설도 있으므로 칸마다 필지를 다시 찾는다.
   */
  private clearFacilityFootprintBuild(info: BuildingInfo): void {
    for (let dy = 0; dy < info.span; dy++) {
      for (let dx = 0; dx < info.span; dx++) {
        const x = info.tx + dx;
        const y = info.ty + dy;
        const p = this.parcels.get(chunkKey(chunkIndexOf(x), chunkIndexOf(y)));
        if (!p?.build) continue;
        const i = localIndexOf(y) * CHUNK_SIZE + localIndexOf(x);
        if (p.build[i] === Build.Civic) p.build[i] = Build.None;
      }
    }
  }

  /**
   * 이 칸을 덮고 있는 건물을 헌다. 지구는 그대로 남는다.
   * footprint 가 청크를 걸칠 수 있으므로(시설) 칸마다 필지를 다시 찾는다.
   */
  demolishAt(tx: number, ty: number): BuildingInfo | null {
    const info = this.buildingCovering(tx, ty);
    if (!info) return null;
    this.walkRevision++;

    const touched = new Set<Parcel>();
    for (let dy = 0; dy < info.span; dy++) {
      for (let dx = 0; dx < info.span; dx++) {
        const x = info.tx + dx;
        const y = info.ty + dy;
        const p = this.parcels.get(chunkKey(chunkIndexOf(x), chunkIndexOf(y)));
        if (!p?.bld) continue;
        const i = localIndexOf(y) * CHUNK_SIZE + localIndexOf(x);
        p.bld[i] = BLD_NONE;
        if (p.bornLo) p.bornLo[i] = BLD_NONE;
        if (p.bornHi) p.bornHi[i] = BLD_NONE;
        // 헐린 자리는 지구가 남아 있으면 다시 빈 부지가 된다.
        if (p.build && zoneOfBuild(p.build[i]) >= 0) p.emptyPlots++;
        touched.add(p);
      }
    }
    if (touched.size === 0) return null;

    // 시설은 buildingCount 에 들어간 적이 없다(placeFacility 가 올리지 않는다).
    // 여기서 내리면 지구 건물 수가 음수로 샌다. 지구 건물은 앵커가 있는
    // 필지에서만 세므로 그쪽에서만 내린다.
    if (info.kind === null) {
      const anchorParcel = this.parcels.get(chunkKey(chunkIndexOf(info.tx), chunkIndexOf(info.ty)));
      if (anchorParcel) anchorParcel.buildingCount--;
    }
    for (const p of touched) {
      p.bldRevision++;
      this.markDirty(p.key, false);
    }
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
      p.roadLinks = ov.roadLinks ?? null;
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
    this.roadDirty = true;
    this.roadRevision++;
    this.walkRevision++;
  }

  /**
   * 도시를 통째로 비운다. "맵 초기화" 가 부른다.
   *
   * 필지를 지도에서 지우지 않고 **배열만 비운다.** 키가 남아 있어야 저장할 때
   * "빈 청크" 로 나가고, citySave 가 그 문서를 지운다. 필지를 지워 버리면
   * 서버에는 예전 도시가 그대로 남고 새로고침할 때 되살아난다.
   *
   * 지형 수정분(tileOverride/heightOverride)까지 지운다. 초기화는 도시를
   * 지우는 것이지 남기는 게 아니다.
   */
  clearBuilt(): void {
    for (const p of this.parcels.values()) {
      p.tileOverride = null;
      p.heightOverride = null;
      p.build = null;
      p.roadLinks = null;
      p.bld = null;
      p.bornLo = null;
      p.bornHi = null;
      p.emptyPlots = 0;
      p.roadCount = 0;
      p.buildingCount = 0;
      p.bldRevision++;
      p.scanCursor = 0;
      this.markDirty(p.key, true);
    }
    // 지형 배열은 좌표에서 다시 만들어진다. 메모리에 있던 청크만 버리면 된다.
    this.chunks.clear();
    this.roadRevision++;
    this.walkRevision++;
    this.roadDirty = true;
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
        roadLinks: p.roadLinks ? new Uint8Array(p.roadLinks) : null,
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
  roadLinks?: Uint8Array | null;
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
 *
 * 3.3단계: **시설은 어느 쪽에도 안 들어간다.** buildingCount 는 isAnchor(코드 0~8)
 * 만 세므로 시설 코드 9~15 가 자동으로 빠지고, emptyPlots 는 zoneOfBuild 로
 * 거르므로 Build.Civic(4) 칸이 자동으로 빠진다. 여기 손댈 것이 없는 게 3장
 * 설계가 실제로 지켜진다는 증거다.
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
