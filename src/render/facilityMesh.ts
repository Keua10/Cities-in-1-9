import { quadIndices, writeQuad } from './quadBuffers';
import { Mesh, MeshGeometry } from 'pixi.js';
import { CHUNK_SIZE, TILE_HH } from '../core/constants';
import { tileToWorldX, tileToWorldY } from '../core/iso';
import { facilityKindOfCode, isFacilityAnchor } from '../sim/buildings';
import { FACILITY_SPECS } from '../sim/facilities';
import type { Parcel } from '../world/world';
import { facilityCellSize, type FacilityAtlas } from './facilityAtlas';

export type HeightSampler = (tx: number, ty: number) => number;

/**
 * 청크 하나에 있는 시설을 전부 한 메시로 굽는다. BuildingMesh 와 같은 구조다.
 *
 * 지구 건물과 텍스처가 다르므로 메시를 합칠 수 없고, 청크당 메시가 하나 늘어난다.
 * 단 **시설이 있는 청크에서만 만든다.** 시설은 도시당 열댓 채라 대부분의 청크는
 * 드로우콜이 그대로다(worldRenderer 가 count === 0 이면 아예 안 붙인다).
 *
 * 재굽기 판정은 p.bldRevision 을 그대로 재사용한다 — 시설도 bld 를 건드리므로
 * 자동으로 올라간다.
 */
export class FacilityMesh {
  readonly mesh: Mesh;
  private geometry: MeshGeometry;
  /** 이 메시가 반영한 필지 상태. */
  revision: number;
  /** 이 청크에 실제로 그린 시설 수. */
  count = 0;

  constructor(
    parcel: Parcel,
    private atlas: FacilityAtlas,
    sampleHeight: HeightSampler,
  ) {
    const quads = collect(parcel, sampleHeight);
    this.count = quads.length;

    const n = Math.max(1, quads.length);
    const positions = new Float32Array(n * 8);
    const uvs = new Float32Array(n * 8);
    const indices = quads.length ? quadIndices(quads.length) : new Uint32Array(6);

    for (let q = 0; q < quads.length; q++) {
      const f = quads[q];
      const size = facilityCellSize(f.span);
      const halfW = size / 2;
      // 스프라이트의 아래 가운데가 부지 다이아몬드의 아래 꼭짓점에 맞는다.
      const x0 = f.bottomX - halfW;
      const x1 = f.bottomX + halfW;
      const y1 = f.bottomY;
      const y0 = y1 - size;
      writeQuad(positions, q, x0, y0, x1, y1);

      const [u0, v0, u1, v1] = this.atlas.uv(f.kind);
      writeQuad(uvs, q, u0, v0, u1, v1);
    }

    // Typed arrays are already zeroed for the empty-mesh placeholder.

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
  kind: number;
  span: number;
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
      if (!isFacilityAnchor(code)) continue;

      const kind = facilityKindOfCode(code);
      const span = FACILITY_SPECS[kind].span;
      const tx = baseX + lx;
      const ty = baseY + ly;
      // 부지의 앞쪽(화면 아래) 타일. 여기 아래 꼭짓점이 스프라이트의 기준점이다.
      const fx = tx + span - 1;
      const fy = ty + span - 1;
      const h = sampleHeight(tx, ty);

      out.push({
        kind,
        span,
        bottomX: tileToWorldX(fx, fy),
        bottomY: tileToWorldY(fx, fy, h) + TILE_HH,
        depth: fx + fy,
      });
    }
  }

  // 뒤에서 앞으로. 같은 깊이면 큰 시설을 먼저 깔아 작은 시설이 위에 오게 한다.
  out.sort((a, b) => a.depth - b.depth || b.span - a.span);
  return out;
}
