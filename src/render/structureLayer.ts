import type { Container } from 'pixi.js';
import { chunkIndexOf } from '../core/iso';
import type { Parcel, World } from '../world/world';
import {
  collectStructures,
  sortStructures,
  StructureMesh,
  type StructureAtlas,
} from './structureMesh';

/** Assign a crossing footprint to its front corner's chunk, after ALL of its ground. */
export function structuresInBucket(parcels: readonly Parcel[], cx: number, cy: number) {
  return sortStructures(
    parcels
      .flatMap(collectStructures)
      .filter(
        (q) => chunkIndexOf(q.tx + q.span - 1) === cx && chunkIndexOf(q.ty + q.span - 1) === cy,
      ),
  );
}
interface Entry {
  sources: Array<Parcel | undefined>;
  revisions: string;
  mesh: StructureMesh | null;
}

/** One structure batch per visible chunk, including footprints anchored across its back edges. */
export class StructureLayer {
  private entries = new Map<string, Entry>();
  private opacity = 1;
  constructor(
    private parent: Container,
    private world: World,
    private atlas: StructureAtlas,
  ) {}
  setOpacity(value: number): void {
    if (value === this.opacity) return;
    this.opacity = value;
    for (const entry of this.entries.values()) if (entry.mesh) entry.mesh.mesh.alpha = value;
  }
  counts(key: string): { buildings: number; facilities: number } {
    return this.entries.get(key)?.mesh?.counts ?? { buildings: 0, facilities: 0 };
  }
  ensure(key: string, cx: number, cy: number): void {
    // Every footprint is smaller than a chunk. Only these four anchor parcels can contribute.
    const coords = [
      [cx - 1, cy - 1],
      [cx, cy - 1],
      [cx - 1, cy],
      [cx, cy],
    ];
    const sources = coords.map(([x, y]) => this.world.peekParcel(x, y));
    const revisions = coords
      .map(
        ([x, y], i) =>
          `${sources[i]?.bldRevision ?? -1}:${this.world.peekChunk(x, y)?.heightRevision ?? -1}`,
      )
      .join('|');
    const previous = this.entries.get(key);
    if (previous?.revisions === revisions && sources.every((p, i) => p === previous.sources[i]))
      return;
    this.drop(key);
    const parcels = sources.filter((p): p is Parcel => !!p?.bld);
    const quads = structuresInBucket(parcels, cx, cy);
    let mesh: StructureMesh | null = null;
    if (quads.length) {
      mesh = new StructureMesh(
        parcels[0],
        this.atlas,
        (x, y) => this.world.sampleHeight(x, y),
        quads,
      );
      mesh.mesh.zIndex = cx + cy + 0.5;
      mesh.mesh.alpha = this.opacity;
      this.parent.addChild(mesh.mesh);
    }
    this.entries.set(key, { sources, revisions, mesh });
  }
  drop(key: string): void {
    const entry = this.entries.get(key);
    if (entry?.mesh) {
      this.parent.removeChild(entry.mesh.mesh);
      entry.mesh.destroy();
    }
    this.entries.delete(key);
  }
}
