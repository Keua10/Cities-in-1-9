import { Mesh, MeshGeometry, Texture } from 'pixi.js';
import { CHUNK_SIZE, TILE_HH, TILE_W, WORLD_SEED } from '../core/constants';
import { tileToWorldX, tileToWorldY } from '../core/iso';
import {
  facilityKindOfCode,
  isAnyAnchor,
  isFacilityAnchor,
  levelOfCode,
  simHash,
  zoneOfCode,
} from '../sim/buildings';
import { facilitySpan } from '../sim/facilities';
import type { Parcel } from '../world/world';
import { BUILDING_VARIANTS, type BuildingAtlas } from './buildingAtlas';
import type { FacilityAtlas } from './facilityAtlas';
import { quadIndices, writeQuad } from './quadBuffers';

export interface StructureAtlas {
  texture: Texture;
  buildingUv(level: number, zone: number, variant: number): [number, number, number, number];
  facilityUv(kind: number): [number, number, number, number];
}
/** Pack without scaling so one mesh can interleave both types by actual depth. */
export function combineStructureAtlas(
  buildings: BuildingAtlas,
  facilities: FacilityAtlas,
): StructureAtlas {
  const b = buildings.texture.source.resource as HTMLCanvasElement,
    f = facilities.texture.source.resource as HTMLCanvasElement;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(b.width, f.width);
  canvas.height = b.height + f.height;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(b, 0, 0);
  ctx.drawImage(f, 0, b.height);
  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'nearest';
  texture.source.autoGenerateMipmaps = false;
  const uv = (
    r: [number, number, number, number],
    w: number,
    h: number,
    o: number,
  ): [number, number, number, number] => [
    (r[0] * w) / canvas.width,
    (r[1] * h + o) / canvas.height,
    (r[2] * w) / canvas.width,
    (r[3] * h + o) / canvas.height,
  ];
  return {
    texture,
    buildingUv: (l, z, v) => uv(buildings.uv(l, z, v), b.width, b.height, 0),
    facilityUv: (k) => uv(facilities.uv(k), f.width, f.height, b.height),
  };
}
export interface StructureQuad {
  tx: number;
  ty: number;
  span: number;
  kind: number | null;
  zone: number;
  variant: number;
  depth: number;
}
export function sortStructures(list: StructureQuad[]): StructureQuad[] {
  return list.sort((a, b) => a.depth - b.depth || b.span - a.span || a.ty - b.ty || a.tx - b.tx);
}
export function collectStructures(parcel: Parcel): StructureQuad[] {
  const list: StructureQuad[] = [];
  if (!parcel.bld) return list;
  for (let i = 0; i < parcel.bld.length; i++) {
    const code = parcel.bld[i];
    if (!isAnyAnchor(code)) continue;
    const tx = parcel.cx * CHUNK_SIZE + (i % CHUNK_SIZE),
      ty = parcel.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
    const kind = isFacilityAnchor(code) ? facilityKindOfCode(code) : null,
      span = kind === null ? levelOfCode(code) : facilitySpan(kind);
    list.push({
      tx,
      ty,
      span,
      kind,
      zone: kind === null ? zoneOfCode(code) : -1,
      variant: simHash(WORLD_SEED, tx, ty, span) % BUILDING_VARIANTS,
      depth: tx + ty + 2 * (span - 1),
    });
  }
  return sortStructures(list);
}
export class StructureMesh {
  readonly quads: StructureQuad[];
  readonly mesh: Mesh;
  readonly count: number;
  readonly counts: { buildings: number; facilities: number };
  private geometry: MeshGeometry;
  private revision: number;
  constructor(
    private parcel: Parcel,
    atlas: StructureAtlas,
    height: (x: number, y: number) => number,
    quads = collectStructures(parcel),
  ) {
    this.quads = quads;
    this.count = quads.length;
    const facilities = quads.filter((q) => q.kind !== null).length;
    this.counts = { buildings: this.count - facilities, facilities };
    const n = Math.max(1, this.count),
      positions = new Float32Array(n * 8),
      uvs = new Float32Array(n * 8),
      indices = this.count ? quadIndices(this.count) : new Uint32Array(6);
    quads.forEach((q, i) => {
      const size = q.span * TILE_W,
        fx = q.tx + q.span - 1,
        fy = q.ty + q.span - 1,
        x = tileToWorldX(fx, fy),
        y = tileToWorldY(fx, fy, height(q.tx, q.ty)) + TILE_HH + (q.kind === null ? 1 : 0);
      writeQuad(positions, i, x - size / 2, y - size, x + size / 2, y);
      writeQuad(
        uvs,
        i,
        ...(q.kind === null
          ? atlas.buildingUv(q.span, q.zone, q.variant)
          : atlas.facilityUv(q.kind)),
      );
    });
    this.geometry = new MeshGeometry({ positions, uvs, indices });
    this.mesh = new Mesh({ geometry: this.geometry, texture: atlas.texture });
    this.revision = parcel.bldRevision;
  }
  needsRebuild(parcel: Parcel): boolean {
    return parcel !== this.parcel || parcel.bldRevision !== this.revision;
  }
  sceneData() {
    return { positions: this.geometry.positions, uvs: this.geometry.uvs, quads: this.quads };
  }
  destroy(): void {
    this.mesh.destroy();
    try {
      this.geometry.destroy(true);
    } catch {
      /* Mesh may own geometry. */
    }
  }
}
