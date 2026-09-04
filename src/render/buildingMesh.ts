import { Mesh, MeshGeometry } from 'pixi.js';
import { CHUNK_SIZE, TILE_H, TILE_HH, TILE_W, WORLD_SEED } from '../core/constants';
import { tileToWorldX, tileToWorldY } from '../core/iso';
import { isAnchor, levelOfCode, simHash, zoneOfCode } from '../sim/buildings';
import type { Parcel } from '../world/world';
import { BUILDING_VARIANTS, buildingCellSize, type BuildingAtlas } from './buildingAtlas';

export type HeightSampler = (tx: number, ty: number) => number;

/**
 * 청크 하나에 있는 건물을 전부 한 메시로 굽는다.
 *
 * 지형과 같은 원칙이다 — 건물마다 Sprite 를 만들면 청크 몇 개만 채워도
 * 드로우콜이 수백 개가 된다. 대신 사각형을 한 정점 버퍼에 몰아넣고 건물
 * 아틀라스 한 장으로 그린다. 청크당 드로우콜은 건물이 몇 채든 1 이다.
 *
 * 지형 메시와 달리 **바뀌면 통째로 다시 굽는다.**
 * 건물은 매크로 틱이 가끔 짓고 허무는 것이라 드래그처럼 초당 수십 번 바뀌지
 * 않는다. 부분 갱신 코드를 들고 있을 이유가 없다.
 *
 * 그리는 순서:
 *   아이소메트릭에서는 화면 아래쪽(= tx+ty 가 큰 쪽)이 앞이다. 건물의 "앞
 *   꼭짓점" 타일 기준으로 정렬해서 뒤에서 앞으로 넣는다. 그래야 앞 건물이
 *   뒤 건물을 가린다.
 */
export class BuildingMesh {
  readonly mesh: Mesh;
  private geometry: MeshGeometry;
  /** 이 메시가 반영한 필지 상태. */
  revision: number;
  /** 이 청크에 실제로 그린 건물 수. */
  count = 0;

  constructor(
    parcel: Parcel,
    private atlas: BuildingAtlas,
    sampleHeight: HeightSampler,
  ) {
    const quads = collect(parcel, sampleHeight);
    this.count = quads.length;

    const n = Math.max(1, quads.length);
    const positions = new Float32Array(n * 8);
    const uvs = new Float32Array(n * 8);
    const indices = new Uint32Array(n * 6);

    for (let q = 0; q < quads.length; q++) {
      const b = quads[q];
      const size = buildingCellSize(b.level);
      const halfW = size / 2;
      // 스프라이트의 아래 가운데가 부지 다이아몬드의 아래 꼭짓점에 맞는다.
      const x0 = b.bottomX - halfW;
      const x1 = b.bottomX + halfW;
      const y1 = b.bottomY;
      const y0 = y1 - size;
      write(positions, q, [x0, y0, x1, y0, x1, y1, x0, y1]);

      const [u0, v0, u1, v1] = this.atlas.uv(b.level, b.zone, b.variant);
      write(uvs, q, [u0, v0, u1, v0, u1, v1, u0, v1]);

      const v = q * 4;
      const o = q * 6;
      indices[o] = v;
      indices[o + 1] = v + 1;
      indices[o + 2] = v + 2;
      indices[o + 3] = v;
      indices[o + 4] = v + 2;
      indices[o + 5] = v + 3;
    }

    // 건물이 하나도 없으면 빈 메시가 된다. 정점 0 개짜리 지오메트리는 Pixi 가
    // 싫어하므로 화면 밖 사각형 하나를 남겨둔다(투명 UV 라 아무것도 안 보인다).
    if (quads.length === 0) {
      write(positions, 0, [0, 0, 0, 0, 0, 0, 0, 0]);
      write(uvs, 0, [0, 0, 0, 0, 0, 0, 0, 0]);
    }

    this.geometry = new MeshGeometry({ positions, uvs, indices });
    this.mesh = new Mesh({ geometry: this.geometry, texture: atlas.texture });
    this.revision = parcel.bldRevision;
  }

  needsRebuild(parcel: Parcel): boolean {
    return parcel.bldRevision !== this.revision;
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

interface Quad {
  level: number;
  zone: number;
  variant: number;
  bottomX: number;
  bottomY: number;
  depth: number;
}

function collect(parcel: Parcel, sampleHeight: HeightSampler): Quad[] {
  const out: Quad[] = [];
  if (!parcel.bld) return out;

  const baseX = parcel.cx * CHUNK_SIZE;
  const baseY = parcel.cy * CHUNK_SIZE;

  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const code = parcel.bld[ly * CHUNK_SIZE + lx];
      if (!isAnchor(code)) continue;

      const level = levelOfCode(code);
      const zone = zoneOfCode(code);
      const tx = baseX + lx;
      const ty = baseY + ly;
      // 부지의 앞쪽(화면 아래) 타일. 여기 아래 꼭짓점이 스프라이트의 기준점이다.
      const fx = tx + level - 1;
      const fy = ty + level - 1;
      const h = sampleHeight(tx, ty);

      out.push({
        level,
        zone,
        // 같은 등급·용도가 나란히 서도 그림이 반복되지 않게 좌표로 변형을 고른다.
        // 좌표에서 뽑으므로 다시 그려도 같은 건물은 같은 변형이 나온다.
        variant: simHash(WORLD_SEED, tx, ty, level) % BUILDING_VARIANTS,
        bottomX: tileToWorldX(fx, fy),
        bottomY: tileToWorldY(fx, fy, h) + TILE_HH,
        depth: fx + fy,
      });
    }
  }

  // 뒤에서 앞으로. 같은 깊이면 큰 건물을 먼저 깔아 작은 건물이 위에 오게 한다.
  out.sort((a, b) => a.depth - b.depth || b.level - a.level);
  return out;
}

function write(target: Float32Array, quad: number, values: number[]): void {
  const p = quad * 8;
  for (let i = 0; i < 8; i++) target[p + i] = values[i];
}

/** 규격 확인용. TILE_W/TILE_H 가 바뀌면 셀 크기 계산도 같이 봐야 한다. */
export const BUILDING_TILE_CHECK = TILE_W / 2 === TILE_H;
