import { Mesh, MeshGeometry, Texture, type Container } from 'pixi.js';
import type { ChunkMesh } from './chunkMesh';
import type { StructureMesh } from './structureMesh';
import { quadIndices } from './quadBuffers';
import type { VehicleSceneData } from './vehicleMesh';

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

interface SceneBatch {
  mesh: Mesh;
  geometry: MeshGeometry;
}
interface VehicleBatch extends SceneBatch {
  capacity: number;
  positions: Float32Array;
  uvs: Float32Array;
}

/** Global tile bands let moving traffic interleave without rebuilding static ground/art. */
export class TerrainStructureScene {
  rebuildCount = 0;
  lastBuildMs = 0;
  private batches: SceneBatch[] = [];
  private vehicleBatches = new Map<number, VehicleBatch>();
  private vehicleArt: HTMLCanvasElement | null = null;
  private dirty = false;
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
    ctx.globalAlpha = 1;
    if (this.vehicleArt)
      ctx.drawImage(this.vehicleArt, 0, this.ground.height + this.structures.height);
    texture = Texture.from(canvas);
    texture.source.scaleMode = 'nearest';
    texture.source.autoGenerateMipmaps = false;
    this.textures.set(this.opacity, texture);
    return texture;
  }
  setOpacity(value: number): void {
    if (this.opacity === value) return;
    this.opacity = value;
    for (const batch of [...this.batches, ...this.vehicleBatches.values()])
      batch.mesh.texture = this.texture();
  }
  setVehicleTexture(texture: Texture): void {
    const source = texture.source.resource as HTMLCanvasElement;
    if (source === this.vehicleArt) return;
    this.vehicleArt = source;
    this.width = Math.max(this.ground.width, this.structures.width, source.width);
    this.height = this.ground.height + this.structures.height + source.height;
    for (const batch of this.vehicleBatches.values()) this.drop(batch);
    this.vehicleBatches.clear();
    for (const batch of this.batches) this.drop(batch);
    this.batches = [];
    for (const texture of this.textures.values()) texture.destroy(true);
    this.textures.clear();
    this.dirty = true;
  }
  private drop(batch: SceneBatch): void {
    this.parent.removeChild(batch.mesh);
    batch.mesh.destroy();
    batch.geometry.destroy(true);
  }
  private createBatch(positions: Float32Array, uvs: Float32Array, order: number): SceneBatch {
    const geometry = new MeshGeometry({
      positions,
      uvs,
      indices: quadIndices(positions.length / 8),
    });
    // All bands share an atlas, so Pixi can batch consecutive bands rather than one draw per tile.
    geometry.batchMode = 'batch';
    const mesh = new Mesh({ geometry, texture: this.texture() });
    mesh.zIndex = order;
    this.parent.addChild(mesh);
    return { mesh, geometry };
  }
  update(ground: readonly ChunkMesh[], structures: readonly StructureMesh[]): void {
    const sources = [...ground, ...structures];
    const stamps = ground.flatMap((g) => [g.revision, g.heightRevision, g.visualRevision]);
    if (
      !this.dirty &&
      sources.length === this.sources.length &&
      sources.every((s, i) => s === this.sources[i]) &&
      stamps.every((s, i) => s === this.stamps[i])
    )
      return;
    const started = performance.now();
    this.dirty = false;
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
    for (const batch of this.batches) this.drop(batch);
    this.batches = [];
    const groups = new Map<number, SceneCommand[]>();
    for (const c of commands) {
      const order = c.depth * 3 + (c.structure ? 2 : 0);
      const group = groups.get(order) ?? [];
      group.push(c);
      groups.set(order, group);
    }
    for (const [order, group] of groups) {
      const count = group.reduce((n, c) => n + c.count, 0);
      const positions = new Float32Array(count * 8),
        uvs = new Float32Array(count * 8);
      let offset = 0;
      for (const c of group) {
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
      this.batches.push(this.createBatch(positions, uvs, order));
    }
    this.rebuildCount++;
    this.lastBuildMs = performance.now() - started;
  }
  updateVehicles(data: VehicleSceneData): void {
    for (const batch of this.vehicleBatches.values()) batch.mesh.visible = false;
    if (!this.vehicleArt) return;
    const groups = new Map<number, number[]>();
    data.depths.forEach((depth, index) => {
      const indices = groups.get(depth) ?? [];
      indices.push(index);
      groups.set(depth, indices);
    });
    for (const [depth, indices] of groups) {
      let batch = this.vehicleBatches.get(depth);
      if (!batch || batch.capacity < indices.length) {
        if (batch) this.drop(batch);
        const capacity = 2 ** Math.ceil(Math.log2(Math.max(4, indices.length)));
        const positions = new Float32Array(capacity * 8),
          uvs = new Float32Array(capacity * 8);
        batch = { ...this.createBatch(positions, uvs, depth * 3 + 1), capacity, positions, uvs };
        this.vehicleBatches.set(depth, batch);
      }
      let offset = 0;
      for (const index of indices) {
        batch.positions.set(data.positions.subarray(index * 8, index * 8 + 8), offset);
        for (let i = index * 8; i < index * 8 + 8; i += 2) {
          batch.uvs[offset++] = (data.uvs[i] * this.vehicleArt.width) / this.width;
          batch.uvs[offset++] =
            (data.uvs[i + 1] * this.vehicleArt.height +
              this.ground.height +
              this.structures.height) /
            this.height;
        }
      }
      batch.positions.fill(0, offset);
      batch.uvs.fill(0, offset);
      batch.geometry.getBuffer('aPosition').update();
      batch.geometry.getBuffer('aUV').update();
      batch.mesh.visible = true;
    }
    // Drop inactive bands beyond the current static view so roaming cannot grow the pool forever.
    const low = this.batches[0]?.mesh.zIndex ?? Infinity;
    const high = this.batches[this.batches.length - 1]?.mesh.zIndex ?? -Infinity;
    for (const [depth, batch] of this.vehicleBatches) {
      if (!batch.mesh.visible && (depth * 3 < low || depth * 3 > high)) {
        this.drop(batch);
        this.vehicleBatches.delete(depth);
      }
    }
  }
}
