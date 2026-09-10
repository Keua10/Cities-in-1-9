import type { Container, Mesh } from 'pixi.js';
import type { Parcel } from '../world/world';

interface ParcelMesh {
  readonly mesh: Mesh;
  readonly count: number;
  needsRebuild(parcel: Parcel): boolean;
  destroy(): void;
}

/** Revision-based lifetime shared by building and facility meshes. */
export class ParcelMeshLayer {
  private opacity = 1;
  setOpacity(value: number): void {
    if (value === this.opacity) return;
    this.opacity = value;
    for (const entry of this.meshes.values()) entry.mesh.alpha = value;
  }
  private meshes = new Map<string, ParcelMesh>();
  private empty = new Map<string, { parcel: Parcel; revision: number }>();

  constructor(
    private parent: Container,
    private create: (parcel: Parcel) => ParcelMesh,
    private depthOffset: number,
    private skipEmpty = false,
  ) {}

  ensure(key: string, parcel: Parcel | undefined): number {
    if (!parcel?.bld) {
      this.drop(key);
      return 0;
    }
    const empty = this.empty.get(key);
    if (empty?.parcel === parcel && empty.revision === parcel.bldRevision) return 0;
    this.empty.delete(key);
    let mesh = this.meshes.get(key);
    if (mesh?.needsRebuild(parcel)) {
      this.drop(key);
      mesh = undefined;
    }
    if (!mesh) {
      mesh = this.create(parcel);
      if (this.skipEmpty && mesh.count === 0) {
        mesh.destroy();
        this.empty.set(key, { parcel, revision: parcel.bldRevision });
        return 0;
      }
      mesh.mesh.zIndex = parcel.cx + parcel.cy + this.depthOffset;
      mesh.mesh.alpha = this.opacity;
      this.meshes.set(key, mesh);
      this.parent.addChild(mesh.mesh);
    }
    return mesh.count;
  }

  drop(key: string): void {
    this.empty.delete(key);
    const mesh = this.meshes.get(key);
    if (!mesh) return;
    this.parent.removeChild(mesh.mesh);
    mesh.destroy();
    this.meshes.delete(key);
  }
}
