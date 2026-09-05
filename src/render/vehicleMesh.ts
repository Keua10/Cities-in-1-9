import { Mesh, MeshGeometry } from 'pixi.js';
import { MAX_ACTIVE_VEHICLES, TILE_W, WORLD_SEED } from '../core/constants';
import { tileToWorldX, tileToWorldY } from '../core/iso';
import { simHash } from '../sim/buildings';
import type { Vehicle } from '../sim/traffic/vehicles';
import { DIRS } from '../world/build';
import type { World } from '../world/world';
import { VEHICLE_VARIANTS, type VehicleAtlas } from './vehicleAtlas';

// 차선 오프셋은 화면 픽셀의 직각 법선으로 계산하면 안 된다.
// 아이소메트릭 투영에서는 도로 폭도 타일 평면에서 투영되므로,
// 진행방향의 '오른쪽' 타일 축으로 0.22칸 이동한 위치가 실제 차선 중심이다.
const LANE_OFFSET_TILES = 0.22;
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

      const startX = tileToWorldX(tx, ty);
      const startY = tileToWorldY(tx, ty, this.world.sampleHeight(tx, ty));
      const endX = tileToWorldX(nx, ny);
      const endY = tileToWorldY(nx, ny, this.world.sampleHeight(nx, ny));
      let wx = startX + (endX - startX) * t;
      let wy = startY + (endY - startY) * t;

      // 우측 차선은 화면 공간의 수직 벡터가 아니라 '타일 평면의 오른쪽 축'을
      // 아이소메트릭으로 투영해서 계산한다. 화면 수직벡터를 쓰면 대각선 도로에서
      // 어떤 방향은 중앙선을 타고, 반대 방향은 도로 가장자리에 붙는 왜곡이 생긴다.
      // 코너에서는 현재 우측 차선에서 다음 우측 차선으로만 부드럽게 연결한다.
      const curDir = dirBetween(tx, ty, nx, ny);
      const nextDir = routeNextDir(vehicle, curDir);
      const a = rightLaneOffset(curDir);
      const b = rightLaneOffset(nextDir);
      const blend = smoothstep(0.82, 1, t);
      wx += a[0] + (b[0] - a[0]) * blend;
      wy += a[1] + (b[1] - a[1]) * blend;

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
  // DIRS 순서가 +tx, +ty, -tx, -ty 이므로 진행방향의 오른쪽은 다음 방향이다.
  // 예: +tx로 달리면 +ty 쪽이 오른쪽 차선이다.
  const right = DIRS[(dir + 1) & 3] ?? DIRS[1];
  const dx =
    (tileToWorldX(right[0], right[1]) - tileToWorldX(0, 0)) * LANE_OFFSET_TILES;
  const dy =
    (tileToWorldY(right[0], right[1], 0) - tileToWorldY(0, 0, 0)) * LANE_OFFSET_TILES;
  return [dx, dy];
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
