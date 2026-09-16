import { pickTile } from '../core/pick';
import type { WorldRenderer } from '../render/worldRenderer';
import { canPlaceFacility, FACILITY_SPECS } from '../sim/facilities';
import type { MacroSim } from '../sim/macro';
import { PIPE_COST, PIPE_SEWER, PIPE_WATER, WATER_SPECS } from '../sim/config/water';
import { POWER_SPECS, WIRE_COST } from '../sim/config/power';
import { RUNWAY_COST, TAXIWAY_COST } from '../sim/config/transport';
import type { UtilityMode } from '../render/utilityLayer';
import { chunkIndexOf } from '../core/iso';
import { COST_ROAD, COST_ZONE } from '../sim/simConstants';
import {
  Build,
  canConnectRoads,
  canPlaceAirfieldSurface,
  canPlaceRoad,
  canPlaceZone,
  DIRS,
  type PlaceResult,
} from '../world/build';
import type { World } from '../world/world';

export type ToolId =
  | 'metroTunnel'
  | 'metroStation'
  | 'metroErase'
  | 'metroView'
  | 'select'
  | 'signalInstall'
  | 'signalRemove'
  | 'road'
  | 'zoneR'
  | 'zoneC'
  | 'zoneI'
  | 'facility'
  | 'runway'
  | 'taxiway'
  | 'bulldoze'
  | 'waterPipe'
  | 'sewerPipe'
  | 'pipeErase'
  | 'wire'
  | 'wireErase';

const TOOL_VALUE: Partial<Record<ToolId, number>> = {
  road: Build.Road,
  zoneR: Build.ZoneR,
  zoneC: Build.ZoneC,
  zoneI: Build.ZoneI,
  runway: Build.Runway,
  taxiway: Build.Taxiway,
};

export const TOOL_LABELS: Record<ToolId, string> = {
  metroTunnel: '지하철 터널',
  metroStation: '지하철역',
  metroErase: '지하철 철거',
  metroView: '지하철 보기',
  signalInstall: '신호등 설치',
  signalRemove: '신호등 제거',
  select: '선택',
  road: '도로',
  zoneR: '주거',
  zoneC: '상업',
  zoneI: '공업',
  facility: '시설',
  runway: '공항 활주로',
  taxiway: '공항 유도로',
  bulldoze: '철거',
  waterPipe: '상수도관',
  sewerPipe: '하수도관',
  pipeErase: '배관 철거',
  wire: '전선',
  wireErase: '전선 철거',
};

const MAX_INTERPOLATE = 64;
const MESSAGE_MS = 2500;

export class Tools {
  metroSelection: string | null = null;
  get metroMode(): boolean {
    return this.tool.startsWith('metro');
  }
  inspectMode: UtilityMode = 'off';
  tool: ToolId = 'select';
  facilityKind = 0;

  private message = '';
  private messageAt = 0;
  private lastTx = 0;
  private lastTy = 0;
  private hasLast = false;

  constructor(
    private world: World,
    private renderer: WorldRenderer,
    private sim: MacroSim,
  ) {}

  isPainting(): boolean | 'tap' {
    if (this.tool === 'metroView') return false;
    if (this.tool === 'metroStation' || this.tool === 'metroErase') return 'tap';
    return this.tool === 'facility' || this.tool === 'signalInstall' || this.tool === 'signalRemove'
      ? 'tap'
      : this.tool !== 'select';
  }

  get cityLevel(): number {
    return this.sim.cityLevel;
  }

  get utilityMode(): UtilityMode {
    if (this.metroMode) return 'off';
    if (
      this.tool === 'wire' ||
      this.tool === 'wireErase' ||
      (this.tool === 'facility' && POWER_SPECS[this.facilityKind])
    )
      return 'power';
    if (this.tool === 'sewerPipe') return 'sewer';
    if (this.tool === 'waterPipe' || this.tool === 'pipeErase') return 'water';
    const water = this.tool === 'facility' ? WATER_SPECS[this.facilityKind] : null;
    if (water) return water.pipe === PIPE_WATER ? 'water' : 'sewer';
    return this.inspectMode;
  }

  setTool(tool: ToolId): void {
    this.tool = tool;
    this.hasLast = false;
    this.message = '';
  }

  activeMessage(now: number): string {
    if (this.metroMode && (!this.message || now - this.messageAt > MESSAGE_MS))
      return this.tool === 'metroTunnel'
        ? '드래그: 터널 연결 · 역은 도로 옆 빈 땅에 설치 · 지상 건물 유지'
        : '지하철 지도 · 역을 연결한 뒤 노선을 지정합니다.';
    if ((!this.message || now - this.messageAt > MESSAGE_MS) && this.utilityMode !== 'off') {
      return this.utilityMode === 'power'
        ? '노랑=전력 공급 범위 · 주황=용량 부족 · 회색 전선=단절 · 건물 가장자리 3칸 이내 자동 공유. 빈 땅은 전달하지 않습니다.'
        : '파랑=급수 범위 · 갈색=하수 범위 · 빨강=오염 · 주황=용량 부족 · 배관 반경 4칸. 상·하수도관은 빈 칸 1개 이상 띄우세요.';
    }
    if (!this.message || now - this.messageAt > MESSAGE_MS) {
      if (this.tool === 'road') return '클릭: 독립 도로 · 드래그: 지나간 방향으로 설치·연결';
      if (this.tool === 'runway') return '공항 활주로 · 일직선으로 길게 설치하세요';
      if (this.tool === 'taxiway')
        return '공항 유도로 · 터미널과 활주로를 이어야 공항이 가동됩니다';
      return '';
    }
    return this.message;
  }

  beginPaint(wx: number, wy: number): void {
    this.hasLast = false;
    this.paintAtWorld(wx, wy);
  }

  movePaint(wx: number, wy: number): void {
    this.paintAtWorld(wx, wy);
  }

  endPaint(): void {
    this.hasLast = false;
  }

  facilityPreviewAt(
    tx: number,
    ty: number,
  ): { tx: number; ty: number; kind: number; ok: boolean } | null {
    if (this.tool === 'metroStation')
      return { tx, ty, kind: 26, ok: this.sim.metro.canPlaceStation(tx, ty).ok };
    if (this.tool !== 'facility') return null;
    const kind = this.facilityKind;
    return { tx, ty, kind, ok: canPlaceFacility(this.world, tx, ty, kind, this.cityLevel).ok };
  }

  private paintAtWorld(wx: number, wy: number): void {
    const t = pickTile(this.world, wx, wy);

    if (this.tool === 'facility') {
      if (this.hasLast) return;
      this.apply(t.tx, t.ty);
      this.lastTx = t.tx;
      this.lastTy = t.ty;
      this.hasLast = true;
      return;
    }

    if (!this.hasLast) {
      this.apply(t.tx, t.ty);
      this.lastTx = t.tx;
      this.lastTy = t.ty;
      this.hasLast = true;
      return;
    }

    if (this.lastTx === t.tx && this.lastTy === t.ty) return;

    const dx = Math.abs(t.tx - this.lastTx);
    const dy = Math.abs(t.ty - this.lastTy);
    if (dx + dy > MAX_INTERPOLATE) {
      this.apply(t.tx, t.ty);
      this.lastTx = t.tx;
      this.lastTy = t.ty;
      return;
    }

    let x = this.lastTx;
    let y = this.lastTy;
    const sx = t.tx > x ? 1 : -1;
    const sy = t.ty > y ? 1 : -1;
    let err = dx - dy;

    for (let guard = 0; guard < MAX_INTERPOLATE * 2; guard++) {
      if (x === t.tx && y === t.ty) break;
      const px = x,
        py = y;
      const e2 = err * 2;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      } else if (e2 < dx) {
        err += dx;
        y += sy;
      }
      if (this.tool === 'road' && this.world.getBuild(px, py) === Build.Road) {
        const result = canConnectRoads(this.world, px, py, x, y);
        if (!result.ok) {
          if (result.reason) this.note(result.reason);
          continue;
        }
        this.apply(x, y);
        if (this.world.connectRoads(px, py, x, y)) {
          this.refresh(px, py);
          this.refresh(x, y);
        }
      } else this.apply(x, y);
    }

    this.lastTx = t.tx;
    this.lastTy = t.ty;
  }

  private apply(tx: number, ty: number): void {
    if (this.metroMode) {
      const action =
        this.tool === 'metroStation' ? 'station' : this.tool === 'metroErase' ? 'erase' : 'tunnel';
      const result = this.sim.metro.edit(tx, ty, action);
      this.note(result.message);
      this.metroSelection = `${tx},${ty}`;
      return;
    }
    if (this.tool === 'signalInstall' || this.tool === 'signalRemove') {
      if (!this.sim.setRoadSignal(tx, ty, this.tool === 'signalInstall'))
        this.note('신호등은 도로에서만 설치·제거할 수 있습니다.');
      else
        this.note(
          this.tool === 'signalInstall' ? '신호등 설치 지정' : '신호등 제거 · 자동 설치 제외',
        );
      return;
    }
    if (this.tool === 'select') return;
    if (this.tool === 'wire' || this.tool === 'wireErase') {
      if (!this.world.isExplored(chunkIndexOf(tx), chunkIndexOf(ty))) {
        this.note('아직 개척하지 않은 땅입니다');
        return;
      }
      const present = this.tool === 'wire';
      if (this.world.getWire(tx, ty) === present) return;
      if (present && !this.sim.spend(WIRE_COST)) {
        this.note('돈이 모자랍니다');
        return;
      }
      this.world.setWire(tx, ty, present);
      return;
    }
    if (this.tool === 'waterPipe' || this.tool === 'sewerPipe' || this.tool === 'pipeErase') {
      if (!this.world.isExplored(chunkIndexOf(tx), chunkIndexOf(ty))) {
        this.note('아직 개척하지 않은 땅입니다');
        return;
      }
      const current = this.world.getPipe(tx, ty);
      const mask =
        this.tool === 'pipeErase'
          ? 0
          : current | (this.tool === 'waterPipe' ? PIPE_WATER : PIPE_SEWER);
      if (current === mask) return;
      if (mask !== 0 && !this.sim.spend(PIPE_COST)) {
        this.note('돈이 모자랍니다');
        return;
      }
      this.world.setPipe(tx, ty, mask);
      if (mask === 3)
        this.note('상·하수도관이 교차 연결되어 물이 오염됩니다. 배관 철거로 분리하세요.');
      return;
    }

    if (this.tool === 'bulldoze') {
      if (this.world.getBuild(tx, ty) === Build.None) return;
      const facility = this.world.buildingCovering(tx, ty);
      this.world.setBuild(tx, ty, Build.None);
      if (facility && facility.kind !== null) {
        this.refreshArea(facility.tx, facility.ty, facility.span);
      } else {
        this.refresh(tx, ty);
      }
      return;
    }

    if (this.tool === 'facility') {
      this.applyFacility(tx, ty);
      return;
    }

    const value = TOOL_VALUE[this.tool];
    if (value === undefined) return;

    const airfield = value === Build.Runway || value === Build.Taxiway;
    const result: PlaceResult =
      value === Build.Road
        ? canPlaceRoad(this.world, tx, ty)
        : airfield
          ? canPlaceAirfieldSurface(this.world, tx, ty, value)
          : canPlaceZone(this.world, tx, ty, value);

    if (!result.ok) {
      if (result.reason) this.note(result.reason);
      return;
    }

    const cost =
      value === Build.Road
        ? COST_ROAD
        : value === Build.Runway
          ? RUNWAY_COST
          : value === Build.Taxiway
            ? TAXIWAY_COST
            : COST_ZONE;
    if (!this.sim.spend(cost)) {
      this.note('돈이 모자랍니다');
      return;
    }

    this.world.setBuild(tx, ty, value);
    this.refresh(tx, ty);
  }

  private applyFacility(tx: number, ty: number): void {
    const kind = this.facilityKind;
    const spec = FACILITY_SPECS[kind];
    if (!spec) return;

    const result = canPlaceFacility(this.world, tx, ty, kind, this.cityLevel);
    if (!result.ok) {
      if (result.reason) this.note(result.reason);
      return;
    }
    if (!this.sim.spend(spec.cost)) {
      this.note('돈이 모자랍니다');
      return;
    }

    this.world.placeFacility(tx, ty, kind, this.sim.day);
    this.refreshArea(tx, ty, spec.span);
  }

  private refreshArea(tx: number, ty: number, span: number): void {
    for (let dy = -1; dy <= span; dy++) {
      for (let dx = -1; dx <= span; dx++) {
        this.renderer.invalidateTile(tx + dx, ty + dy);
      }
    }
  }

  private refresh(tx: number, ty: number): void {
    this.renderer.invalidateTile(tx, ty);
    for (const dir of DIRS) {
      this.renderer.invalidateTile(tx + dir[0], ty + dir[1]);
    }
  }

  private note(text: string): void {
    this.message = text;
    this.messageAt = performance.now();
  }
}

export { bindConstructionMenu as bindToolButtons } from './constructionMenu';
