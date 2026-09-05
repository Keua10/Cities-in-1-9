import { Mesh, MeshGeometry } from 'pixi.js';
import { MAX_ACTIVE_VEHICLES, TILE_W, WORLD_SEED } from '../core/constants';
import { tileToWorldX, tileToWorldY } from '../core/iso';
import { simHash } from '../sim/buildings';
import type { Vehicle } from '../sim/traffic/vehicles';
import { DIRS } from '../world/build';
import type { World } from '../world/world';
import { VEHICLE_CELL, VEHICLE_VARIANTS, type VehicleAtlas } from './vehicleAtlas';

const LANE_OFFSET_PX = 4;

export class VehicleMesh {
  readonly mesh: Mesh;
  private geometry: MeshGeometry;
  private positions: Float32Array;
  private uvs: Float32Array;
  private sorted: Vehicle[] = [];

  constructor(
    private world: World,
    private atlas: VehicleAtlas,
  ) {
    const n = MAX_ACTIVE_VEHICLES;
    this.positions = new Float32Array(n * 8);
    this.uvs = new Float32Array(n * 8);
    const indices = new Uint32Array(n * 6);
    for (let q = 0; q < n; q++) {
      const v = q * 4;
      const o = q * 6;
      indices[o] = v;
      indices[o + 1] = v + 1;
      indices[o + 2] = v + 2;
      indices[o + 3] = v;
      indices[o + 4] = v + 2;
      indices[o + 5] = v + 3;
    }
    this.geometry = new MeshGeometry({ positions: this.positions, uvs: this.uvs, indices });
    this.mesh = new Mesh({ geometry: this.geometry, texture: atlas.texture });
  }

  update(vehicles: readonly Vehicle[]): void {
    this.sorted.length = 0;
    for (const vehicle of vehicles) this.sorted.push(vehicle);
    this.sorted.sort((a, b) => depth(a) - depth(b));

    let q = 0;
    for (const vehicle of this.sorted) {
      if (q >= MAX_ACTIVE_VEHICLES) break;
      const i = vehicle.routeIdx * 2;
      const tx = vehicle.route.tiles[i];
      const ty = vehicle.route.tiles[i + 1];
      const ni = Math.min(i + 2, vehicle.route.tiles.length - 2);
      const nx = vehicle.route.tiles[ni];
      const ny = vehicle.route.tiles[ni + 1];
      const t = vehicle.tileT;

      const startX = tileToWorldX(tx, ty);
      const startY = tileToWorldY(tx, ty, this.world.sampleHeight(tx, ty));
      const endX = tileToWorldX(nx, ny);
      const endY = tileToWorldY(nx, ny, this.world.sampleHeight(nx, ny));
      let wx = startX + (endX - startX) * t;
      let wy = startY + (endY - startY) * t;

      // Canvas/Pixi 화면 좌표는 y가 아래로 증가한다.
      // 따라서 진행 벡터 (dx,dy)의 화면상 오른쪽 법선은 (-dy,+dx)다.
      // 코너에서는 현재 세그먼트 우측 차선에서 다음 세그먼트 우측 차선으로 연속 보간한다.
      const curDir = dirBetween(tx, ty, nx, ny);
      const nextDir = routeNextDir(vehicle, curDir);
      const a = rightLaneOffset(curDir);
      const b = rightLaneOffset(nextDir);
      const blend = smoothstep(0.35, 1, t);
      wx += a[0] + (b[0] - a[0]) * blend;
      wy += a[1] + (b[1] - a[1]) * blend;

      const half = VEHICLE_CELL / 2;
      const x0 = wx - half;
      const x1 = wx + half;
      const y1 = wy;
      const y0 = wy - VEHICLE_CELL;
      write(this.positions, q, [x0, y0, x1, y0, x1, y1, x0, y1]);

      // fallback atlas는 방향별 색이 달라 보일 수 있다. 정식 vehicles.png가 들어오면
      // 같은 variant 칸의 실제 차량 이미지를 쓰므로 이 임시 색 변화는 사라진다.
      const variant = simHash(WORLD_SEED, vehicle.destTx, vehicle.destTy, vehicle.tier) % VEHICLE_VARIANTS;
      const [u0, v0, u1, v1] = this.atlas.uv(vehicle.kind, vehicle.dir, variant);
      write(this.uvs, q, [u0, v0, u1, v0, u1, v1, u0, v1]);
      q++;
    }

    for (; q < MAX_ACTIVE_VEHICLES; q++) {
      write(this.positions, q, [0, 0, 0, 0, 0, 0, 0, 0]);
      write(this.uvs, q, [0, 0, 0, 0, 0, 0, 0, 0]);
    }
    this.geometry.getBuffer('aPosition').update();
    this.geometry.getBuffer('aUV').update();
  }

  destroy(): void {
    this.mesh.destroy();
    try { this.geometry.destroy(true); } catch {}
  }
}

function routeNextDir(vehicle: Vehicle, fallback: number): number {
  const nextIndex = vehicle.routeIdx + 1;
  const points = vehicle.route.tiles.length / 2;
  if (nextIndex >= points - 1) return fallback;
  const i = nextIndex * 2;
  return dirBetween(
    vehicle.route.tiles[i],
    vehicle.route.tiles[i + 1],
    vehicle.route.tiles[i + 2],
    vehicle.route.tiles[i + 3],
  );
}

function rightLaneOffset(dir: number): [number, number] {
  const d = DIRS[dir] ?? DIRS[0];
  const dx = tileToWorldX(d[0], d[1]) - tileToWorldX(0, 0);
  const dy = tileToWorldY(d[0], d[1], 0) - tileToWorldY(0, 0, 0);
  const len = Math.hypot(dx, dy) || 1;
  return [(-dy / len) * LANE_OFFSET_PX, (dx / len) * LANE_OFFSET_PX];
}

function dirBetween(x: number, y: number, nx: number, ny: number): number {
  for (let i = 0; i < DIRS.length; i++) {
    if (x + DIRS[i][0] === nx && y + DIRS[i][1] === ny) return i;
  }
  return 0;
}

function smoothstep(a: number, b: number, value: number): number {
  if (value <= a) return 0;
  if (value >= b) return 1;
  const t = (value - a) / (b - a);
  return t * t * (3 - 2 * t);
}

function write(array: Float32Array, q: number, values: number[]): void {
  let p = q * 8;
  for (let i = 0; i < 8; i++) array[p + i] = values[i];
}

function depth(vehicle: Vehicle): number {
  const i = vehicle.routeIdx * 2;
  return vehicle.route.tiles[i] + vehicle.route.tiles[i + 1] + vehicle.tileT;
}

export const VEHICLE_PIXEL_DENSITY_CHECK = TILE_W === 64;
