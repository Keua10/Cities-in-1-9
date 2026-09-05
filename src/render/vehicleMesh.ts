import { Mesh, MeshGeometry } from 'pixi.js';
import { MAX_ACTIVE_VEHICLES, TILE_W, WORLD_SEED } from '../core/constants';
import { tileToWorldX, tileToWorldY } from '../core/iso';
import { simHash } from '../sim/buildings';
import { laneFacing, lanePosition } from '../sim/traffic/laneGeometry';
import type { Vehicle } from '../sim/traffic/vehicles';
import type { World } from '../world/world';
import {
  VEHICLE_CELL,
  VEHICLE_GROUND_DROP_PX,
  VEHICLE_VARIANTS,
  type VehicleAtlas,
} from './vehicleAtlas';

/**
 * 차량 스프라이트를 아틀라스 셀과 1:1 픽셀로 그린다.
 *
 * 예전에는 32px 셀을 20px 로 줄여 그렸다. fallback 그림이 화면축 정렬 사각형이라
 * 셀을 그대로 쓰면 반대 차선까지 덮었기 때문인데, 그 축소 때문에 차체 크기와
 * 시뮬레이션이 쓰는 차체 길이가 서로 달라졌다. 지금은 아틀라스 쪽에서 실제
 * 차체 길이/폭을 아이소메트릭으로 투영해 그리므로 1:1 로 두면 크기가 맞는다.
 */
const VEHICLE_RENDER_SIZE_PX = VEHICLE_CELL;

export class VehicleMesh {
  readonly mesh: Mesh;
  private geometry: MeshGeometry;
  private positions: Float32Array;
  private uvs: Float32Array;
  private sorted: Vehicle[] = [];
  private depths = new Map<Vehicle, number>();

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
    // 정렬 기준은 도로 중앙선이 아니라 실제 차선 위치다. 중앙선으로 정렬하면
    // 마주 오는 두 차의 깊이가 같아져 매 프레임 앞뒤가 뒤바뀌며 깜빡인다.
    this.sorted.length = 0;
    this.depths.clear();
    for (const vehicle of vehicles) {
      const [laneTx, laneTy] = lanePosition(vehicle.route, vehicle.routeIdx, vehicle.tileT);
      this.depths.set(vehicle, laneTx + laneTy);
      this.sorted.push(vehicle);
    }
    this.sorted.sort((a, b) => (this.depths.get(a) ?? 0) - (this.depths.get(b) ?? 0));

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

      // 렌더링과 시뮬레이션이 laneGeometry 하나만 본다. 화면 픽셀 보정은 없다.
      const [laneTx, laneTy] = lanePosition(vehicle.route, vehicle.routeIdx, t);
      const h0 = this.world.sampleHeight(tx, ty);
      const h1 = this.world.sampleHeight(nx, ny);
      const height = h0 + (h1 - h0) * t;
      const wx = tileToWorldX(laneTx, laneTy);
      const wy = tileToWorldY(laneTx, laneTy, height);

      // 아틀라스의 접지점(셀 중심에서 VEHICLE_GROUND_DROP_PX 아래)이 차선 위에 오게 붙인다.
      const half = VEHICLE_RENDER_SIZE_PX / 2;
      const x0 = wx - half;
      const x1 = wx + half;
      const y0 = wy - half - VEHICLE_GROUND_DROP_PX;
      const y1 = y0 + VEHICLE_RENDER_SIZE_PX;
      write(this.positions, q, [x0, y0, x1, y0, x1, y1, x0, y1]);

      // 스프라이트 방향은 차선 접선에서 뽑는다. 코너에서도 실제 향한 쪽을 쓴다.
      const facing = laneFacing(vehicle.route, vehicle.routeIdx, t);
      const variant = simHash(WORLD_SEED, vehicle.destTx, vehicle.destTy, vehicle.tier) % VEHICLE_VARIANTS;
      const [u0, v0, u1, v1] = this.atlas.uv(vehicle.kind, facing, variant);
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

export const VEHICLE_PIXEL_DENSITY_CHECK = TILE_W === 64;
