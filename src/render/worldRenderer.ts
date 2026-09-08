import { Container, Graphics } from 'pixi.js';
import {
  BASE_CHUNK_SPAN,
  CHUNK_MESH_BUDGET,
  CHUNK_SIZE,
  HEIGHT_UNIT,
  MAX_HEIGHT,
  RENDER_MARGIN_PX,
  TILE_HH,
  TILE_HW,
} from '../core/constants';
import type { Camera } from '../core/camera';
import {
  chunkIndexOf,
  chunkKey,
  localIndexOf,
  tileToWorldX,
  tileToWorldY,
  visibleChunkRange,
} from '../core/iso';
import { DIRS, makeTopResolver, type TopResolver } from '../world/build';
import type { World } from '../world/world';
import type { TileAtlas } from './atlas';
import type { BuildingAtlas } from './buildingAtlas';
import { BuildingMesh } from './buildingMesh';
import type { FacilityAtlas } from './facilityAtlas';
import { FacilityMesh } from './facilityMesh';
import { FACILITY_SPECS } from '../sim/facilities';
import type { TrafficSim } from '../sim/traffic/trafficSim';
import type { VehicleAtlas } from './vehicleAtlas';
import { VehicleMesh } from './vehicleMesh';
import { SignalState, signalState } from '../sim/traffic/signals';
import { laneIsTurning } from '../sim/traffic/laneGeometry';
import { JUNCTION_LEG_MIN_TILES } from '../sim/simConstants';
import type { Vehicle } from '../sim/traffic/vehicles';
import { ChunkMesh } from './chunkMesh';
import { IncidentLayer } from './incidentLayer';
import type { DisasterSim } from '../sim/disasters';

export interface RenderStats {
  visibleChunks: number;
  loadedMeshes: number;
  foggedChunks: number;
  /** 화면에 그려지고 있는 건물 수. 3.1단계에서 추가. */
  visibleBuildings: number;
  /** 화면에 그려지고 있는 시설 수. 3.3단계에서 추가. */
  visibleFacilities: number;
}

/** 시설 도구를 든 동안 커서 아래에 보여줄 배치 미리보기. */
export interface FacilityPreview {
  tx: number;
  ty: number;
  kind: number;
  /** 놓을 수 있으면 초록, 없으면 빨강. */
  ok: boolean;
}

/** 청크 하나가 덮는 큰 다이아몬드의 꼭짓점 4개. */
function chunkDiamond(cx: number, cy: number): number[] {
  const t0x = cx * CHUNK_SIZE;
  const t0y = cy * CHUNK_SIZE;
  const t1x = t0x + CHUNK_SIZE - 1;
  const t1y = t0y + CHUNK_SIZE - 1;
  return [
    tileToWorldX(t0x, t0y),
    tileToWorldY(t0x, t0y) - TILE_HH,
    tileToWorldX(t1x, t0y) + TILE_HW,
    tileToWorldY(t1x, t0y),
    tileToWorldX(t1x, t1y),
    tileToWorldY(t1x, t1y) + TILE_HH,
    tileToWorldX(t0x, t1y) - TILE_HW,
    tileToWorldY(t0x, t1y),
  ];
}

export class WorldRenderer {
  readonly root = new Container();
  private groundLayer = new Container();
  /** 회전 차량은 큰 지형 청크 사이에 끼지 않도록 지형 합성 뒤에 그린다. */
  private turningVehicleLayer = new Container();
  private fogLayer = new Container();
  private gridLayer = new Graphics();
  private cursorLayer = new Graphics();
  /** 시설 배치 미리보기 사각형. 커서 레이어와 따로 둬야 서로 지우지 않는다. */
  private previewLayer = new Graphics();
  private signalLayer = new Graphics();
  private incidentLayer = new IncidentLayer();
  private disasters: DisasterSim | null = null;
  private lastSignalDrawMs = -1;

  private meshes = new Map<string, ChunkMesh>();
  /**
   * 건물 메시. 지형 메시와 같은 groundLayer 에 넣되 zIndex 를 0.5 올린다.
   * 그러면 자기 청크 지형 위, 다음 청크 지형 아래에 그려져서 앞쪽 청크의 언덕이
   * 뒤쪽 청크의 건물을 제대로 가린다.
   */
  private buildings = new Map<string, BuildingMesh>();
  /**
   * 시설 메시. 건물과 텍스처가 달라 합칠 수 없으므로 메시가 하나 늘어난다.
   * 시설이 하나도 없는 청크에는 아예 만들지 않으므로 대부분의 청크는 그대로다.
   */
  private facilities = new Map<string, FacilityMesh>();
  private vehicleMeshes = new Map<string, VehicleMesh>();
  private turningVehicleMesh: VehicleMesh | null = null;
  private traffic: TrafficSim | null = null;
  private vehicleAtlas: VehicleAtlas | null = null;
  private fog = new Map<string, Graphics>();

  private lastRangeKey = '';
  private lastZoom = -1;
  private cursorTile: { tx: number; ty: number } | null = null;
  private preview: FacilityPreview | null = null;

  showFog = true;
  showGrid = false;

  stats: RenderStats = {
    visibleChunks: 0,
    loadedMeshes: 0,
    foggedChunks: 0,
    visibleBuildings: 0,
    visibleFacilities: 0,
  };

  constructor(
    private world: World,
    private atlas: TileAtlas,
    private buildingAtlas: BuildingAtlas,
    private facilityAtlas: FacilityAtlas,
  ) {
    this.root.addChild(
      this.groundLayer,
      this.turningVehicleLayer,
      this.fogLayer,
      this.signalLayer,
      this.incidentLayer.graphics,
      this.gridLayer,
      this.cursorLayer,
      this.previewLayer,
    );
    this.groundLayer.interactiveChildren = false;
    this.turningVehicleLayer.interactiveChildren = false;
    this.fogLayer.interactiveChildren = false;
    // 고도가 있으면 청크끼리도 겹친다. 뒤쪽 청크부터 그려야 한다.
    this.groundLayer.sortableChildren = true;
    this.sampleHeight = (tx, ty) => this.world.sampleHeight(tx, ty);
    this.resolveTop = makeTopResolver(world);
  }

  attachTraffic(traffic: TrafficSim, atlas: VehicleAtlas): void { this.traffic = traffic; this.vehicleAtlas = atlas; }
  attachDisasters(sim: DisasterSim): void { this.disasters = sim; }

  private sampleHeight: (tx: number, ty: number) => number;
  private resolveTop: TopResolver;

  /**
   * 타일 한 칸의 윗면만 다시 그린다. 도로·지구를 놓거나 지울 때 부른다.
   *
   * 청크 전체를 다시 굽지 않는 이유:
   *   writeAllUVs 는 4096칸을 훑고 128KB 짜리 정점 버퍼를 통째로 올린다.
   *   드래그로 도로를 그으면 그게 매 프레임 돌아 아이패드에서 체감된다.
   *   여기서는 UV 8개만 고친다.
   *
   * 화면에 없는 청크는 그냥 넘어간다. 다시 보일 때 새로 구워지면서 반영된다.
   */
  invalidateTile(tx: number, ty: number): void {
    const cx = chunkIndexOf(tx);
    const cy = chunkIndexOf(ty);
    const mesh = this.meshes.get(chunkKey(cx, cy));
    if (!mesh) return;
    const chunk = this.world.peekChunk(cx, cy);
    if (!chunk) return;
    const lx = localIndexOf(tx);
    const ly = localIndexOf(ty);
    mesh.setTile(lx, ly, this.resolveTop(chunk, ly * CHUNK_SIZE + lx, tx, ty));
  }

  /** 격자/안개 토글처럼 카메라와 무관한 변화가 생겼을 때 다음 프레임에 다시 그린다. */
  forceRedraw(): void {
    this.lastRangeKey = '';
  }

  setCursorTile(tile: { tx: number; ty: number } | null): void {
    const a = this.cursorTile;
    if (a && tile && a.tx === tile.tx && a.ty === tile.ty) return;
    if (!a && !tile) return;
    this.cursorTile = tile;
    this.drawCursor();
  }

  update(camera: Camera, now: number): void {
    const view = camera.viewBounds(RENDER_MARGIN_PX);
    // 높은 타일은 화면에서 위로 밀려 올라온다. 그만큼 아래쪽을 더 훑어야
    // 화면 밖에 있는 산꼭대기가 잘리지 않는다.
    view.maxY += MAX_HEIGHT * HEIGHT_UNIT;
    const range = visibleChunkRange(view);
    const rangeKey = `${range.cx0},${range.cy0},${range.cx1},${range.cy1}`;
    const zoomChanged = Math.abs(camera.zoom - this.lastZoom) > 0.001;

    let visible = 0;
    let fogged = 0;
    let buildingsShown = 0;
    let facilitiesShown = 0;
    const usedVehicleMeshes = new Set<string>();
    const turningVehicles: Vehicle[] = [];

    for (let cy = range.cy0; cy <= range.cy1; cy++) {
      for (let cx = range.cx0; cx <= range.cx1; cx++) {
        visible++;
        const key = chunkKey(cx, cy);

        if (this.showFog && !this.world.isExplored(cx, cy)) {
          fogged++;
          this.dropMesh(key);
          this.ensureFog(key, cx, cy);
          continue;
        }

        this.dropFog(key);
        const mesh = this.ensureMesh(key, cx, cy);
        mesh.lastUsed = now;
        buildingsShown += this.ensureBuildings(key, cx, cy);
        facilitiesShown += this.ensureFacilities(key, cx, cy);
        if (this.traffic && this.vehicleAtlas) {
          const vehicles = this.traffic.vehiclesInChunk(cx, cy);
          if (vehicles.length > 0 || this.vehicleMeshes.has(key)) {
            const groundVehicles: Vehicle[] = [];
            for (const vehicle of vehicles) {
              if (laneIsTurning(vehicle.route, vehicle.routeIdx, vehicle.tileT)) {
                turningVehicles.push(vehicle);
              } else {
                groundVehicles.push(vehicle);
              }
            }
            this.ensureVehicles(key, cx, cy, groundVehicles);
            usedVehicleMeshes.add(key);
          }
        }
      }
    }

    if (rangeKey !== this.lastRangeKey || zoomChanged) {
      this.lastRangeKey = rangeKey;
      this.lastZoom = camera.zoom;
      this.drawGrid(range, camera.zoom);
      this.drawCursor();
    }

    this.evict(now, range);
    for (const key of [...this.vehicleMeshes.keys()]) if (!usedVehicleMeshes.has(key)) this.dropVehicles(key);
    this.updateTurningVehicles(turningVehicles);

    if (this.lastSignalDrawMs < 0 || now - this.lastSignalDrawMs >= 120) {
      this.lastSignalDrawMs = now;
      this.drawSignals(range);
      if (this.disasters) this.incidentLayer.draw(this.world, this.disasters, range);
    }

    this.stats.visibleChunks = visible;
    this.stats.loadedMeshes = this.meshes.size;
    this.stats.foggedChunks = fogged;
    this.stats.visibleBuildings = buildingsShown;
    this.stats.visibleFacilities = facilitiesShown;
  }

  /**
   * 시설 배치 미리보기. 시설 도구를 든 동안 커서 아래 footprint 를 반투명
   * 사각형으로 보여준다. 1x1·2x2·3x3 을 눈으로 못 보면 학생이 계속 실패한다.
   */
  setFacilityPreview(preview: FacilityPreview | null): void {
    const a = this.preview;
    if (!a && !preview) return;
    if (
      a &&
      preview &&
      a.tx === preview.tx &&
      a.ty === preview.ty &&
      a.kind === preview.kind &&
      a.ok === preview.ok
    ) {
      return;
    }
    this.preview = preview;
    this.drawPreview();
  }

  private drawPreview(): void {
    const g = this.previewLayer;
    g.clear();
    const p = this.preview;
    if (!p) return;
    const span = FACILITY_SPECS[p.kind]?.span ?? 1;
    const color = p.ok ? 0x6fd3b8 : 0xe25f5f;
    const h = this.world.sampleHeight(p.tx, p.ty);

    for (let dy = 0; dy < span; dy++) {
      for (let dx = 0; dx < span; dx++) {
        const x = tileToWorldX(p.tx + dx, p.ty + dy);
        const y = tileToWorldY(p.tx + dx, p.ty + dy, h);
        const diamond = [x, y - TILE_HH, x + TILE_HW, y, x, y + TILE_HH, x - TILE_HW, y];
        g.poly(diamond);
        g.fill({ color, alpha: 0.26 });
        g.poly(diamond);
        g.stroke({ width: Math.max(1, 1 / this.lastZoom), color, alpha: 0.9 });
      }
    }
  }

  /**
   * 신호등을 **교차로 영역마다 한 벌**, 진입로마다 한 등씩 그린다.
   *
   * 예전에는 "이웃 도로가 3개 이상인 타일" 마다 두 칸짜리 사각형을 찍었다.
   * 그래서 폭 2타일 도로를 깔면 도로 전체에 신호등이 깔려 보였다. 지금은
   * 진짜 교차로에만, 그것도 차가 들어오는 방향 쪽에 등이 하나씩 붙는다.
   */
  private drawSignals(range: { cx0: number; cy0: number; cx1: number; cy1: number }): void {
    this.signalLayer.clear();
    if (!this.traffic) return;
    const signalTime = this.traffic.signalTimeMs;
    const tx0 = range.cx0 * CHUNK_SIZE;
    const ty0 = range.cy0 * CHUNK_SIZE;
    const tx1 = (range.cx1 + 1) * CHUNK_SIZE - 1;
    const ty1 = (range.cy1 + 1) * CHUNK_SIZE - 1;

    for (const junction of this.traffic.junctions.junctions) {
      if (!junction.signalized) continue;
      if (junction.maxX < tx0 || junction.minX > tx1) continue;
      if (junction.maxY < ty0 || junction.minY > ty1) continue;
      if (this.showFog && !this.world.isExplored(chunkIndexOf(junction.minX), chunkIndexOf(junction.minY))) {
        continue;
      }
      const cx = (junction.minX + junction.maxX) / 2;
      const cy = (junction.minY + junction.maxY) / 2;
      for (const leg of junction.legs) {
        if (leg.length < JUNCTION_LEG_MIN_TILES) continue;
        const dir = DIRS[leg.enterDir];
        // 진입 방향의 반대쪽(=운전자가 보는 맞은편)에 등을 세운다.
        const spanX = (junction.maxX - junction.minX + 1) / 2 + 0.55;
        const spanY = (junction.maxY - junction.minY + 1) / 2 + 0.55;
        const lx = cx + dir[0] * spanX;
        const ly = cy + dir[1] * spanY;
        const x = tileToWorldX(lx, ly);
        const y = tileToWorldY(lx, ly, this.world.sampleHeight(junction.minX, junction.minY));
        const state = signalState(junction, leg.enterDir, signalTime);
        const color = state === SignalState.Green
          ? 0x6fe27e
          : state === SignalState.Yellow
            ? 0xe8c15a
            : 0xe25f5f;
        this.signalLayer.rect(x - 2.5, y - 15, 5, 5).fill({ color, alpha: 0.95 });
      }
    }
  }

  private ensureMesh(key: string, cx: number, cy: number): ChunkMesh {
    let mesh = this.meshes.get(key);
    const chunk = this.world.getChunk(cx, cy);
    if (mesh && mesh.needsRebuild(chunk)) {
      this.dropMesh(key);
      mesh = undefined;
    }
    if (!mesh) {
      mesh = new ChunkMesh(chunk, this.atlas, this.sampleHeight, this.resolveTop);
      mesh.mesh.zIndex = cx + cy;
      this.meshes.set(key, mesh);
      this.groundLayer.addChild(mesh.mesh);
    } else {
      mesh.syncIfStale(chunk);
    }
    return mesh;
  }

  private dropMesh(key: string): void {
    const mesh = this.meshes.get(key);
    if (mesh) {
      this.groundLayer.removeChild(mesh.mesh);
      mesh.destroy();
      this.meshes.delete(key);
    }
    this.dropBuildings(key);
    this.dropFacilities(key);
    this.dropVehicles(key);
  }

  /**
   * 건물 메시를 필지 상태에 맞춘다.
   *
   * 필지의 bldRevision 이 바뀌었을 때만 다시 굽는다. 건물은 매크로 틱이 가끔
   * 짓고 허무는 것이라 이 값이 자주 오르지 않는다. 드래그 건설과 달리 통째로
   * 다시 구워도 부담이 없다.
   */
  private ensureBuildings(key: string, cx: number, cy: number): number {
    const parcel = this.world.peekParcel(cx, cy);
    if (!parcel || !parcel.bld) {
      this.dropBuildings(key);
      return 0;
    }
    let bm = this.buildings.get(key);
    if (bm && bm.needsRebuild(parcel)) {
      this.dropBuildings(key);
      bm = undefined;
    }
    if (!bm) {
      bm = new BuildingMesh(parcel, this.buildingAtlas, this.sampleHeight);
      bm.mesh.zIndex = cx + cy + 0.5;
      this.buildings.set(key, bm);
      this.groundLayer.addChild(bm.mesh);
    }
    return bm.count;
  }

  /**
   * 시설 메시를 필지 상태에 맞춘다. 건물과 같은 규칙(bldRevision)으로 다시 굽되,
   * **시설이 하나도 없으면 메시를 아예 만들지 않는다.** 대부분의 청크에는 시설이
   * 없으므로 드로우콜이 그대로 유지된다.
   */
  private ensureFacilities(key: string, cx: number, cy: number): number {
    const parcel = this.world.peekParcel(cx, cy);
    if (!parcel || !parcel.bld) {
      this.dropFacilities(key);
      return 0;
    }
    let fm = this.facilities.get(key);
    if (fm && fm.needsRebuild(parcel)) {
      this.dropFacilities(key);
      fm = undefined;
    }
    if (!fm) {
      fm = new FacilityMesh(parcel, this.facilityAtlas, this.sampleHeight);
      if (fm.count === 0) {
        // 시설이 없는 청크. 만들자마자 버려서 씬 그래프에 안 남긴다.
        fm.destroy();
        return 0;
      }
      // 지구 건물보다 조금 앞에 둔다. 같은 칸에 둘 다 설 일은 없지만
      // 큰 시설이 뒤쪽 건물에 가리면 안 된다.
      fm.mesh.zIndex = cx + cy + 0.6;
      this.facilities.set(key, fm);
      this.groundLayer.addChild(fm.mesh);
    }
    return fm.count;
  }

  private dropFacilities(key: string): void {
    const fm = this.facilities.get(key);
    if (!fm) return;
    this.groundLayer.removeChild(fm.mesh);
    fm.destroy();
    this.facilities.delete(key);
  }

  private ensureVehicles(key: string, cx: number, cy: number, vehicles: readonly import('../sim/traffic/vehicles').Vehicle[]): void {
    if (!this.vehicleAtlas) return;
    let vm = this.vehicleMeshes.get(key);
    if (!vm) {
      vm = new VehicleMesh(this.world, this.vehicleAtlas);
      vm.mesh.zIndex = cx + cy + 0.75;
      this.vehicleMeshes.set(key, vm);
      this.groundLayer.addChild(vm.mesh);
    }
    vm.update(vehicles);
  }

  private dropVehicles(key: string): void {
    const vm = this.vehicleMeshes.get(key);
    if (!vm) return;
    this.groundLayer.removeChild(vm.mesh);
    vm.destroy();
    this.vehicleMeshes.delete(key);
  }

  private updateTurningVehicles(vehicles: readonly Vehicle[]): void {
    if (!this.vehicleAtlas) return;
    if (vehicles.length === 0) {
      if (this.turningVehicleMesh) this.turningVehicleMesh.update(vehicles);
      return;
    }
    if (!this.turningVehicleMesh) {
      this.turningVehicleMesh = new VehicleMesh(this.world, this.vehicleAtlas);
      this.turningVehicleLayer.addChild(this.turningVehicleMesh.mesh);
    }
    this.turningVehicleMesh.update(vehicles);
  }

  private dropBuildings(key: string): void {
    const bm = this.buildings.get(key);
    if (!bm) return;
    this.groundLayer.removeChild(bm.mesh);
    bm.destroy();
    this.buildings.delete(key);
  }

  private ensureFog(key: string, cx: number, cy: number): void {
    if (this.fog.has(key)) return;
    const g = new Graphics();
    g.poly(chunkDiamond(cx, cy));
    g.fill({ color: 0x0b1116, alpha: 0.94 });
    g.poly(chunkDiamond(cx, cy));
    g.stroke({ width: 2, color: 0x16222b, alpha: 0.9 });
    this.fog.set(key, g);
    this.fogLayer.addChild(g);
  }

  private dropFog(key: string): void {
    const g = this.fog.get(key);
    if (!g) return;
    this.fogLayer.removeChild(g);
    g.destroy();
    this.fog.delete(key);
  }

  /** 화면 밖 청크를 오래된 순으로 버린다. */
  private evict(
    now: number,
    range: { cx0: number; cy0: number; cx1: number; cy1: number },
  ): void {
    if (this.meshes.size <= CHUNK_MESH_BUDGET) return;
    const stale = [...this.meshes.entries()]
      .filter(([, m]) => m.lastUsed !== now)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);

    let over = this.meshes.size - CHUNK_MESH_BUDGET;
    for (const [key, mesh] of stale) {
      if (over <= 0) break;
      this.groundLayer.removeChild(mesh.mesh);
      mesh.destroy();
      this.meshes.delete(key);
      this.dropBuildings(key);
      this.dropFacilities(key);
      over--;
    }

    for (const key of [...this.fog.keys()]) {
      const [cx, cy] = key.split(',').map(Number);
      if (cx < range.cx0 - 1 || cx > range.cx1 + 1 || cy < range.cy0 - 1 || cy > range.cy1 + 1) {
        this.dropFog(key);
      }
    }
  }

  private drawGrid(
    range: { cx0: number; cy0: number; cx1: number; cy1: number },
    zoom: number,
  ): void {
    const g = this.gridLayer;
    g.clear();
    const px = 1 / zoom; // 줌과 무관하게 화면에서 1px 두께

    if (this.showGrid) {
      for (let cy = range.cy0; cy <= range.cy1; cy++) {
        for (let cx = range.cx0; cx <= range.cx1; cx++) {
          g.poly(chunkDiamond(cx, cy));
        }
      }
      g.stroke({ width: px, color: 0xffffff, alpha: 0.14 });
    }

    // 내 도시의 base 영역은 항상 표시한다. 여기가 전쟁에서 안 뺏기는 땅이다.
    const b = this.world;
    const t0x = b.baseCx * CHUNK_SIZE;
    const t0y = b.baseCy * CHUNK_SIZE;
    const t1x = t0x + BASE_CHUNK_SPAN * CHUNK_SIZE - 1;
    const t1y = t0y + BASE_CHUNK_SPAN * CHUNK_SIZE - 1;
    g.poly([
      tileToWorldX(t0x, t0y),
      tileToWorldY(t0x, t0y) - TILE_HH,
      tileToWorldX(t1x, t0y) + TILE_HW,
      tileToWorldY(t1x, t0y),
      tileToWorldX(t1x, t1y),
      tileToWorldY(t1x, t1y) + TILE_HH,
      tileToWorldX(t0x, t1y) - TILE_HW,
      tileToWorldY(t0x, t1y),
    ]);
    g.stroke({ width: px * 2, color: 0x6fd3b8, alpha: 0.75 });
  }

  private drawCursor(): void {
    const g = this.cursorLayer;
    g.clear();
    const t = this.cursorTile;
    if (!t) return;
    const h = this.world.getHeight(t.tx, t.ty);
    const x = tileToWorldX(t.tx, t.ty);
    const y = tileToWorldY(t.tx, t.ty, h);
    g.poly([x, y - TILE_HH, x + TILE_HW, y, x, y + TILE_HH, x - TILE_HW, y]);
    g.fill({ color: 0x6fd3b8, alpha: 0.18 });
    g.poly([x, y - TILE_HH, x + TILE_HW, y, x, y + TILE_HH, x - TILE_HW, y]);
    g.stroke({ width: Math.max(1, 1 / this.lastZoom), color: 0x9df0da, alpha: 0.95 });
  }

  /** 프레임 끝에서 UV 변경분을 GPU 로 올린다. */
  flush(): void {
    for (const mesh of this.meshes.values()) mesh.flush();
  }
}
