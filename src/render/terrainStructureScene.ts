import { Mesh, MeshGeometry, Texture, type Container } from 'pixi.js';
import type { ChunkMesh } from './chunkMesh';
import type { StructureMesh } from './structureMesh';
import { quadIndices } from './quadBuffers';

export interface SceneCommand {
  depth: number;
  tx: number;
  ty: number;
  span: number;
  structure: boolean;
  start: number;
  count: number;
  positions: Float32Array;
  uvs: Float32Array;
}

/** Storage chunks must never determine occlusion. Ground at a tile precedes its building. */
export function sortSceneCommands(commands: SceneCommand[]): SceneCommand[] {
  return commands.sort(
    (a, b) =>
      a.depth - b.depth ||
      Number(a.structure) - Number(b.structure) ||
      b.span - a.span ||
      a.ty - b.ty ||
      a.tx - b.tx,
  );
}

/** A cached, single-draw terrain/structure mesh in global tile order. Road planes stay intact. */
export class TerrainStructureScene {
  rebuildCount = 0;
  lastBuildMs = 0;
  private mesh: Mesh | null = null;
  private geometry: MeshGeometry | null = null;
  private sources: unknown[] = [];
  private stamps: number[] = [];
  private textures = new Map<number, Texture>();
  private opacity = 1;
  private width: number;
  private height: number;
  private ground: HTMLCanvasElement;
  private structures: HTMLCanvasElement;
  constructor(
    private parent: Container,
    terrain: Texture,
    structures: Texture,
  ) {
    this.ground = terrain.source.resource as HTMLCanvasElement;
    this.structures = structures.source.resource as HTMLCanvasElement;
    this.width = Math.max(this.ground.width, this.structures.width);
    this.height = this.ground.height + this.structures.height;
  }
  private texture(): Texture {
    let texture = this.textures.get(this.opacity);
    if (texture) return texture;
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.ground, 0, 0);
    ctx.globalAlpha = this.opacity;
    ctx.drawImage(this.structures, 0, this.ground.height);
    texture = Texture.from(canvas);
    texture.source.scaleMode = 'nearest';
    texture.source.autoGenerateMipmaps = false;
    this.textures.set(this.opacity, texture);
    return texture;
  }
  setOpacity(value: number): void {
    if (this.opacity === value) return;
    this.opacity = value;
    if (this.mesh) this.mesh.texture = this.texture();
  }
  update(ground: readonly ChunkMesh[], structures: readonly StructureMesh[]): void {
    const sources = [...ground, ...structures];
    const stamps = ground.flatMap((g) => [g.revision, g.heightRevision, g.visualRevision]);
    if (
      sources.length === this.sources.length &&
      sources.every((s, i) => s === this.sources[i]) &&
      stamps.every((s, i) => s === this.stamps[i])
    )
      return;
    const started = performance.now();
    this.sources = sources;
    this.stamps = stamps;
    const commands: SceneCommand[] = [];
    for (const mesh of ground) {
      const { positions, uvs, tiles } = mesh.sceneTiles();
      for (const t of tiles)
        commands.push({ ...t, depth: t.tx + t.ty, span: 1, structure: false, positions, uvs });
    }
    for (const mesh of structures) {
      const { positions, uvs, quads } = mesh.sceneData();
      quads.forEach((q, i) =>
        commands.push({ ...q, start: i, count: 1, structure: true, positions, uvs }),
      );
    }
    sortSceneCommands(commands);
    const count = commands.reduce((n, c) => n + c.count, 0);
    const positions = new Float32Array(Math.max(1, count) * 8),
      uvs = new Float32Array(positions.length);
    let offset = 0;
    for (const c of commands) {
      const begin = c.start * 8,
        end = (c.start + c.count) * 8;
      positions.set(c.positions.subarray(begin, end), offset);
      const source = c.structure ? this.structures : this.ground;
      const y = c.structure ? this.ground.height : 0;
      for (let i = begin; i < end; i += 2) {
        uvs[offset++] = (c.uvs[i] * source.width) / this.width;
        uvs[offset++] = (c.uvs[i + 1] * source.height + y) / this.height;
      }
    }
    if (this.mesh) {
      this.parent.removeChild(this.mesh);
      this.mesh.destroy();
      this.geometry?.destroy(true);
    }
    this.geometry = new MeshGeometry({
      positions,
      uvs,
      indices: count ? quadIndices(count) : new Uint32Array(6),
    });
    this.mesh = new Mesh({ geometry: this.geometry, texture: this.texture() });
    // Dynamic road traffic remains above the static scene, as before this terrain repair.
    this.mesh.zIndex = -Number.MAX_VALUE;
    this.parent.addChild(this.mesh);
    this.rebuildCount++;
    this.lastBuildMs = performance.now() - started;
  }
}
