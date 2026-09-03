import { Mesh, MeshGeometry } from 'pixi.js';
import {
  CHUNK_SIZE,
  CHUNK_TILES,
  HEIGHT_UNIT,
  TILE_HH,
  TILE_HW,
} from '../core/constants';
import { tileToWorldX, tileToWorldY } from '../core/iso';
import type { TopResolver } from '../world/build';
import { wallMaterial } from '../world/terrain';
import type { Chunk } from '../world/world';
import { shadeCellFor, WallCell, type TileAtlas } from './atlas';

export type HeightSampler = (tx: number, ty: number) => number;

/**
 * 청크 하나를 통째로 하나의 메시로 굽는다.
 *
 * 타일 4096개를 스프라이트 4096개로 만들면 아이패드에서 청크 몇 개만 띄워도
 * 프레임이 무너진다. 대신 정점 버퍼 하나 + 아틀라스 텍스처 하나로 묶으면
 * 청크당 드로우콜이 1이 된다.
 *
 * 2단계의 도로·지구도 **이 구조를 그대로 쓴다.** 새 사각형을 얹지 않고 윗면의
 * UV 만 다른 셀(도로·지구)로 바꾼다. 그래서 정점 수도 드로우콜도 안 늘어난다.
 * 어떤 셀을 쓸지는 resolveTop 콜백이 정하므로 이 파일은 도로를 몰라도 된다.
 *
 * 사각형(quad) 구성은 타일 하나당
 *   [오른쪽 절벽 n장] [왼쪽 절벽 n장] [윗면 1장] [고도 음영 1장]
 * 이고, 타일은 행 우선(ly -> lx) 순서로 들어간다.
 * 아이소메트릭에서 이 순서가 곧 뒤에서 앞으로 그리는 순서라서,
 * 앞 타일의 윗면이 뒤 타일의 절벽을 자연스럽게 가린다.
 *
 * 절벽이 필요한 타일에만 벽 사각형을 만든다. 지형 특성상 절벽은 한 번에
 * 한 단계씩만 생기므로(이웃 고도 차이 최대 1), 실제 벽 개수는 타일 수의
 * 10~20% 수준이다.
 */
export class ChunkMesh {
  readonly mesh: Mesh;
  private geometry: MeshGeometry;
  private uvs: Float32Array;
  private uvDirty = false;

  /** 타일별 첫 사각형 번호 / 오른쪽 벽 수 / 전체 벽 수 */
  private quadStart: Int32Array;
  private rightWalls: Uint8Array;
  private wallCount: Uint8Array;

  /** 이 메시가 반영한 청크 상태 */
  revision: number;
  heightRevision: number;
  /** 마지막으로 화면에 쓰인 시각 — LRU 회수용 */
  lastUsed = 0;

  /** 이 청크의 왼쪽 위 타일 좌표. resolveTop 에 넘길 전역 좌표를 만드는 데 쓴다. */
  private baseX: number;
  private baseY: number;

  constructor(
    chunk: Chunk,
    private atlas: TileAtlas,
    sampleHeight: HeightSampler,
    private resolveTop: TopResolver,
  ) {
    const baseX = chunk.cx * CHUNK_SIZE;
    const baseY = chunk.cy * CHUNK_SIZE;
    this.baseX = baseX;
    this.baseY = baseY;

    this.quadStart = new Int32Array(CHUNK_TILES);
    this.rightWalls = new Uint8Array(CHUNK_TILES);
    this.wallCount = new Uint8Array(CHUNK_TILES);

    // 1차: 사각형 개수를 센다.
    let quads = 0;
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const i = ly * CHUNK_SIZE + lx;
        const h = chunk.heights[i];
        const right = Math.max(0, h - sampleHeight(baseX + lx + 1, baseY + ly));
        const left = Math.max(0, h - sampleHeight(baseX + lx, baseY + ly + 1));
        this.quadStart[i] = quads;
        this.rightWalls[i] = right;
        this.wallCount[i] = right + left;
        // 고도 0 은 음영이 없으므로 사각형을 만들지 않는다 (타일의 약 절반).
        quads += right + left + 1 + (h > 0 ? 1 : 0);
      }
    }

    const positions = new Float32Array(quads * 8);
    const uvs = new Float32Array(quads * 8);
    const indices = new Uint32Array(quads * 6);

    // 2차: 정점을 채운다. UV 는 writeAllUVs 가 따로 채운다.
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const i = ly * CHUNK_SIZE + lx;
        const tx = baseX + lx;
        const ty = baseY + ly;
        const h = chunk.heights[i];
        const cx = tileToWorldX(tx, ty);
        const cy = tileToWorldY(tx, ty, h);

        let q = this.quadStart[i];
        const right = this.rightWalls[i];
        const left = this.wallCount[i] - right;

        // 오른쪽 아래를 향한 면 (+tx 방향)
        for (let k = 0; k < right; k++) {
          const y0 = cy + k * HEIGHT_UNIT;
          const y1 = y0 + HEIGHT_UNIT;
          writeQuad(positions, q, [
            cx, y0 + TILE_HH,
            cx + TILE_HW, y0,
            cx + TILE_HW, y1,
            cx, y1 + TILE_HH,
          ]);
          q++;
        }

        // 왼쪽 아래를 향한 면 (+ty 방향)
        for (let k = 0; k < left; k++) {
          const y0 = cy + k * HEIGHT_UNIT;
          const y1 = y0 + HEIGHT_UNIT;
          writeQuad(positions, q, [
            cx - TILE_HW, y0,
            cx, y0 + TILE_HH,
            cx, y1 + TILE_HH,
            cx - TILE_HW, y1,
          ]);
          q++;
        }

        // 윗면, 그리고 그 위에 겹치는 고도 음영
        const top = [
          cx - TILE_HW, cy - TILE_HH,
          cx + TILE_HW, cy - TILE_HH,
          cx + TILE_HW, cy + TILE_HH,
          cx - TILE_HW, cy + TILE_HH,
        ];
        writeQuad(positions, q, top);
        if (h > 0) writeQuad(positions, q + 1, top);
      }
    }

    for (let q = 0; q < quads; q++) {
      const v = q * 4;
      const o = q * 6;
      indices[o] = v;
      indices[o + 1] = v + 1;
      indices[o + 2] = v + 2;
      indices[o + 3] = v;
      indices[o + 4] = v + 2;
      indices[o + 5] = v + 3;
    }

    this.uvs = uvs;
    this.geometry = new MeshGeometry({ positions, uvs, indices });
    this.mesh = new Mesh({ geometry: this.geometry, texture: atlas.texture });
    this.revision = chunk.revision;
    this.heightRevision = chunk.heightRevision;
    this.writeAllUVs(chunk);
    this.flush();
  }

  /**
   * 청크 전체의 UV 를 다시 쓴다.
   * 청크가 처음 구워질 때와 불러오기 직후에만 돈다. 도로를 한 칸 놓을 때는
   * setTile 쪽으로 가야 한다(4096칸을 다시 쓰면 드래그가 버벅인다).
   */
  writeAllUVs(chunk: Chunk): void {
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const i = ly * CHUNK_SIZE + lx;
        const tile = chunk.tiles[i];
        const walls = this.wallCount[i];
        if (walls > 0) {
          // 절벽 옆면은 항상 지형으로 판정한다.
          // 도로를 깐다고 절벽이 아스팔트가 되면 안 된다.
          const rock = wallMaterial(tile) === 'rock';
          const right = this.rightWalls[i];
          for (let k = 0; k < walls; k++) {
            const isRight = k < right;
            const cell = rock
              ? isRight
                ? WallCell.RockRight
                : WallCell.RockLeft
              : isRight
                ? WallCell.SoilRight
                : WallCell.SoilLeft;
            this.writeWallUV(this.quadStart[i] + k, cell, isRight);
          }
        }
        const top = this.quadStart[i] + walls;
        this.writeTopUV(top, this.resolveTop(chunk, i, this.baseX + lx, this.baseY + ly));
        const h = chunk.heights[i];
        if (h > 0) this.writeTopUV(top + 1, shadeCellFor(h));
      }
    }
    this.revision = chunk.revision;
  }

  /**
   * 타일 하나의 윗면만 갱신. 도로·지구를 놓을 때 타는 유일한 경로다.
   * cell 은 지형 ID 일 수도 있고 도로·지구 셀 번호일 수도 있다.
   */
  setTile(localX: number, localY: number, cell: number): void {
    const i = localY * CHUNK_SIZE + localX;
    this.writeTopUV(this.quadStart[i] + this.wallCount[i], cell);
  }

  private writeTopUV(quad: number, tileId: number): void {
    const [u0, v0, u1, v1] = this.atlas.uv(tileId);
    writeQuad(this.uvs, quad, [u0, v0, u1, v0, u1, v1, u0, v1]);
    this.uvDirty = true;
  }

  private writeWallUV(quad: number, cell: number, isRight: boolean): void {
    const [u0, v0, u1, v1] = this.atlas.uvWall(cell);
    const vm = (v0 + v1) / 2;
    // 정점 순서는 위 2차 패스에서 넣은 순서와 같아야 한다.
    writeQuad(
      this.uvs,
      quad,
      isRight
        ? [u0, vm, u1, v0, u1, vm, u0, v1]
        : [u0, v0, u1, vm, u1, v1, u0, vm],
    );
    this.uvDirty = true;
  }

  /** 바뀐 UV 를 GPU 로 올린다. 프레임당 한 번만 부르면 된다. */
  flush(): void {
    if (!this.uvDirty) return;
    this.geometry.getBuffer('aUV').update();
    this.uvDirty = false;
  }

  /** 고도가 바뀌면 정점 자체가 달라지므로 메시를 새로 만들어야 한다. */
  needsRebuild(chunk: Chunk): boolean {
    return chunk.heightRevision !== this.heightRevision;
  }

  syncIfStale(chunk: Chunk): void {
    if (chunk.revision === this.revision) return;
    this.writeAllUVs(chunk);
    this.flush();
  }

  destroy(): void {
    this.mesh.destroy();
    try {
      this.geometry.destroy(true);
    } catch {
      // Pixi 버전에 따라 mesh.destroy() 가 이미 지오메트리를 정리한다.
    }
  }
}

function writeQuad(target: Float32Array, quad: number, values: number[]): void {
  const p = quad * 8;
  for (let i = 0; i < 8; i++) target[p + i] = values[i];
}
