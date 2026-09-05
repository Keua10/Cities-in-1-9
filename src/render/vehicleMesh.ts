import { Mesh, MeshGeometry } from 'pixi.js';
import { MAX_ACTIVE_VEHICLES, TILE_W, WORLD_SEED } from '../core/constants';
import { tileToWorldX, tileToWorldY } from '../core/iso';
import { simHash } from '../sim/buildings';
import { lanePosition } from '../sim/traffic/laneGeometry';
import type { Vehicle } from '../sim/traffic/vehicles';
import type { World } from '../world/world';
import { VEHICLE_VARIANTS, type VehicleAtlas } from './vehicleAtlas';

const VEHICLE_RENDER_SIZE_PX = 20;

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

      // Rendering and traffic now share one TILE-SPACE lane path.
      // No screen-space nudging: the car's actual route point itself is the right-hand lane.
      const [laneTx, laneTy] = lanePosition(vehicle.route, vehicle.routeIdx, t);
      const h0 = this.world.sampleHeight(tx, ty);
      const h1 = this.world.sampleHeight(nx, ny);
      const height = h0 + (h1 - h0) * t;
      const wx = tileToWorldX(laneTx, laneTy);
      const wy = tileToWorldY(laneTx, laneTy, height);

      // 아틀라스 셀은 32px이지만 화면에 32px 그대로 그리면 도로 한 차선보다
      // 차체가 커져 반대 차선까지 덮는다. UV 셀과 화면 크기를 분리한다.
      const half = VEHICLE_RENDER_SIZE_PX / 2;
      const x0 = wx - half;
      const x1 = wx + half;
      const y1 = wy;
      const y0 = wy - VEHICLE_RENDER_SIZE_PX;
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

function write(array: Float32Array, q: number, values: number[]): void {
  let p = q * 8;
  for (let i = 0; i < 8; i++) array[p + i] = values[i];
}

function depth(vehicle: Vehicle): number {
  const i = vehicle.routeIdx * 2;
  return vehicle.route.tiles[i] + vehicle.route.tiles[i + 1] + vehicle.tileT;
}

export const VEHICLE_PIXEL_DENSITY_CHECK = TILE_W === 64;
