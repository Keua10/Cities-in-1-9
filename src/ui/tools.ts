import { audio } from '../audio/audio';
import { pickTile } from '../core/pick';
import type { WorldRenderer } from '../render/worldRenderer';
import { canPlaceFacility, FACILITY_SPECS } from '../sim/facilities';
import type { MacroSim } from '../sim/macro';
import { PIPE_COST, PIPE_SEWER, PIPE_WATER, WATER_SPECS } from '../sim/config/water';
import { POWER_SPECS, WIRE_COST } from '../sim/config/power';
import { RUNWAY_COST, TAXIWAY_COST } from '../sim/config/transport';
import { METRO_TUNNEL_COST } from '../sim/metro';
import type { UtilityMode } from '../render/utilityLayer';
import { MAX_HEIGHT } from '../core/constants';
import { chunkIndexOf } from '../core/iso';
import { COST_ROAD, COST_ZONE, TERRAIN_COST, TERRAIN_SOFT_TILES } from '../sim/simConstants';
import {
  Build,
  canConnectRoads,
  canPlaceAirfieldSurface,
  canPlaceRoad,
  canPlaceZone,
  DIRS,
  type PlaceResult,
  type RoadProbe,
} from '../world/build';
import { isWater } from '../world/terrain';
import type { World } from '../world/world';
import {
  areaTiles,
  guideTiles,
  lineTiles,
  MAX_AREA_SIDE,
  placementShape,
  type PlacementPlan,
  type PlacementShape,
  type PlanTile,
  type Point,
  type TileState,
} from './placement';

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
  | 'wireErase'
  | 'terrainRaise'
  | 'terrainLower';

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
  terrainRaise: '지형 높이기',
  terrainLower: '지형 낮추기',
};

const MESSAGE_MS = 2500;

/** 칸 하나를 어떻게 처리할지. 미리보기와 실제 건설이 **같은 함수**를 본다. */
interface TileVerdict {
  state: TileState;
  reason: string;
  cost: number;
}

const SKIP: TileVerdict = { state: 'skip', reason: '', cost: 0 };

function blocked(reason: string): TileVerdict {
  return { state: 'blocked', reason, cost: 0 };
}

function buildable(cost: number): TileVerdict {
  return { state: 'build', reason: '', cost };
}

/** 화면에 그릴 선택 상태. 렌더러는 이것만 본다. */
export interface PlacementPreview {
  shape: PlacementShape;
  anchor: Point | null;
  tiles: readonly PlanTile[];
  guide: readonly Point[];
  /** 같은 그림인지 싸게 판정하려고 들고 다니는 서명. */
  key: string;
}

/** 확정 바가 읽는 요약. */
export interface PlacementSummary {
  active: boolean;
  title: string;
  detail: string;
  canConfirm: boolean;
}

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

  /* ---------- 두 점 선택 상태 ---------- */
  private pos1: Point | null = null;
  private pos2: Point | null = null;
  /** 마우스가 가리키는 칸. pos2 를 찍기 전 미리보기에만 쓴다(터치에는 없다). */
  private hover: Point | null = null;
  /*
   * 계획은 한 프레임에 세 번 읽힌다(오버레이·확정 바·확정 버튼). 1,000칸짜리
   * 범위를 그때마다 다시 계산하면 그것만으로 프레임이 흔들린다. 입력이 그대로면
   * 결과도 그대로이므로 서명이 같을 때는 지난 계산을 돌려준다.
   */
  private planCache: PlacementPlan | null = null;
  private previewCache: PlacementPreview | null = null;
  private cacheKey = '';

  constructor(
    private world: World,
    private renderer: WorldRenderer,
    private sim: MacroSim,
  ) {}

  /**
   * 입력 계층에 알리는 동작 방식.
   *
   * 이제 **모든 건설 도구가 'tap'** 이다. 한 손가락 드래그는 언제나 지도 이동이고,
   * 짧은 탭만 점을 찍는다. 도구를 든 채로 지도를 못 움직이던 문제가 여기서 끝난다.
   */
  isPainting(): boolean | 'tap' {
    if (this.tool === 'select' || this.tool === 'metroView') return false;
    return 'tap';
  }

  get shape(): PlacementShape {
    return placementShape(this.tool);
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
    this.clearSelection();
    this.message = '';
  }

  activeMessage(now: number): string {
    if (this.message && now - this.messageAt <= MESSAGE_MS) return this.message;
    if (this.pos1) {
      return this.pos2
        ? '오른쪽 ✓ 를 눌러 건설, ✕ 로 취소 · 지도를 다시 눌러 끝점을 옮길 수 있습니다'
        : this.shape === 'line'
          ? '밝게 표시된 일직선 위에서 끝점을 한 번 더 누르세요'
          : '반대쪽 모서리를 한 번 더 눌러 범위를 정하세요';
    }
    if (this.metroMode)
      return this.tool === 'metroTunnel'
        ? '지하철 터널 · 시작점과 끝점을 눌러 일직선으로 연결합니다'
        : this.tool === 'metroView'
          ? '지하철 지도 · 역을 연결한 뒤 노선을 지정합니다.'
          : '지도를 눌러 역을 놓거나 제거합니다';
    if (this.utilityMode !== 'off' && this.shape === 'none') {
      return this.utilityMode === 'power'
        ? '노랑=전력 공급 범위 · 주황=용량 부족 · 회색 전선=단절 · 건물 가장자리 3칸 이내 자동 공유. 빈 땅은 전달하지 않습니다.'
        : '파랑=급수 범위 · 갈색=하수 범위 · 빨강=오염 · 주황=용량 부족 · 배관 반경 4칸. 상·하수도관은 빈 칸 1개 이상 띄우세요.';
    }
    if (this.shape === 'line') return '시작점을 누르세요 · 두 점을 이어 일직선으로 놓습니다';
    if (this.shape === 'area') return '한쪽 모서리를 누르세요 · 두 점이 사각형 범위가 됩니다';
    if (this.shape === 'single') return '지도를 눌러 한 채 놓습니다';
    return '';
  }

  /* ---------------------------------------------------------------- *
   * 선택
   * ---------------------------------------------------------------- */

  /** 입력 계층이 부르는 진입점. 짧은 탭 한 번 = 점 하나. */
  tapAtWorld(wx: number, wy: number): void {
    const t = pickTile(this.world, wx, wy);
    this.tapTile(t.tx, t.ty);
  }

  tapTile(tx: number, ty: number): void {
    this.invalidatePlan();
    const shape = this.shape;
    if (shape === 'none') return;
    if (shape === 'single') {
      this.applySingle(tx, ty);
      return;
    }
    if (!this.pos1) {
      this.pos1 = { tx, ty };
      this.pos2 = null;
      return;
    }
    // 이미 끝점이 있어도 다시 찍으면 옮겨진다. 한 칸 어긋났다고 처음부터
    // 다시 찍게 만들 이유가 없다.
    this.pos2 = { tx, ty };
  }

  /** 마우스 hover. 끝점을 찍기 전에 결과를 미리 보여준다. */
  hoverTile(tile: Point | null): void {
    if (tile?.tx === this.hover?.tx && tile?.ty === this.hover?.ty) return;
    this.hover = tile;
    this.invalidatePlan();
  }

  hasSelection(): boolean {
    return this.pos1 !== null;
  }

  clearSelection(): void {
    this.pos1 = null;
    this.pos2 = null;
    this.invalidatePlan();
  }

  /** 계획을 다시 계산해야 한다. 세계가 바뀌는 곳(확정)에서도 부른다. */
  private invalidatePlan(): void {
    this.cacheKey = '';
    this.planCache = null;
    this.previewCache = null;
  }

  private selectionKey(): string {
    if (!this.pos1) return '';
    const end = this.pos2 ?? this.hover ?? this.pos1;
    return `${this.tool}|${this.pos1.tx},${this.pos1.ty}|${end.tx},${end.ty}|${this.pos2 ? 1 : 0}`;
  }

  /* ---------------------------------------------------------------- *
   * 계획 — 미리보기와 확정이 같은 계산을 쓴다
   * ---------------------------------------------------------------- */

  plan(): PlacementPlan | null {
    const shape = this.shape;
    if (!this.pos1 || (shape !== 'line' && shape !== 'area')) return null;
    const key = this.selectionKey();
    if (key === this.cacheKey && this.planCache) return this.planCache;
    this.cacheKey = key;
    this.previewCache = null;
    const end = this.pos2 ?? this.hover ?? this.pos1;
    const raw = shape === 'line' ? lineTiles(this.pos1, end) : areaTiles(this.pos1, end);

    /*
     * 도로는 칸 하나하나가 독립이 아니다. 앞 칸과 이어지는지(비탈 규칙)까지
     * 봐야 하고, 그 판정은 **아직 짓지 않은 앞 칸도 도로로 쳐야** 맞다.
     * 그래서 계획선을 따라가며 "여기까지 지었다고 치면" 을 넘긴다.
     */
    const planned = new Set<string>();
    const order = new Map<string, number>();
    raw.tiles.forEach((t, i) => order.set(`${t.tx},${t.ty}`, i));
    /*
     * **여기까지** 이었다고 치는 지점. 선 전체를 이미 이어진 것으로 보면
     * 아직 오지도 않은 칸 때문에 앞 칸이 막힌다(비탈 검사는 양쪽 이웃을 본다).
     * 드래그 시절과 같이 앞에서부터 한 칸씩 이어 나가며 판정한다.
     */
    let linkedUpto = -1;
    const probe: RoadProbe = {
      road: (tx, ty) => this.world.getBuild(tx, ty) === Build.Road || planned.has(`${tx},${ty}`),
      linked: (ax, ay, bx, by) => {
        if (this.world.roadsConnected(ax, ay, bx, by)) return true;
        const a = order.get(`${ax},${ay}`);
        const b = order.get(`${bx},${by}`);
        return (
          a !== undefined &&
          b !== undefined &&
          Math.abs(a - b) === 1 &&
          Math.max(a, b) <= linkedUpto
        );
      },
    };

    const tiles: PlanTile[] = [];
    let cost = 0;
    let buildCount = 0;
    let skipCount = 0;
    let blockedCount = 0;
    let reason = '';
    let prev: Point | null = null;

    for (let i = 0; i < raw.tiles.length; i++) {
      const t = raw.tiles[i];
      let v = this.verdict(t.tx, t.ty);
      if (v.state !== 'blocked' && this.tool === 'road' && prev && probe.road(prev.tx, prev.ty)) {
        const link = canConnectRoads(this.world, prev.tx, prev.ty, t.tx, t.ty, probe);
        if (!link.ok && link.reason) v = blocked(link.reason);
        else if (link.ok) linkedUpto = i;
      }
      if (v.state === 'build') {
        buildCount++;
        cost += v.cost;
        if (this.tool === 'road') planned.add(`${t.tx},${t.ty}`);
      } else if (v.state === 'skip') {
        skipCount++;
        if (this.tool === 'road') planned.add(`${t.tx},${t.ty}`);
      } else {
        blockedCount++;
        if (!reason) reason = v.reason;
      }
      tiles.push({ tx: t.tx, ty: t.ty, state: v.state });
      prev = t;
    }

    /*
     * 이어줄 쌍의 수. 이미 놓인 두 도로를 잇기만 하는 선택도 정당한 건설이다
     * (돈이 안 나갈 뿐이다). 그래서 지을 칸이 0 이어도 확정을 막지 않는다.
     */
    let links = 0;
    if (this.tool === 'road') {
      for (let i = 1; i < tiles.length; i++) {
        const a = tiles[i - 1];
        const b = tiles[i];
        if (a.state === 'blocked' || b.state === 'blocked') continue;
        if (!probe.road(a.tx, a.ty) || !probe.road(b.tx, b.ty)) continue;
        if (!this.world.roadsConnected(a.tx, a.ty, b.tx, b.ty)) links++;
      }
    }

    this.planCache = {
      shape,
      tiles,
      buildCount,
      skipCount,
      blockedCount,
      links,
      cost: this.tool === 'metroTunnel' ? buildCount * METRO_TUNNEL_COST : cost,
      reason,
      truncated: raw.truncated,
    };
    return this.planCache;
  }

  /** 렌더러가 그릴 것. 같은 그림이면 key 가 같아서 다시 그리지 않는다. */
  placementPreview(): PlacementPreview | null {
    const shape = this.shape;
    if (!this.pos1 || (shape !== 'line' && shape !== 'area')) return null;
    const plan = this.plan();
    if (!plan) return null;
    if (this.previewCache) return this.previewCache;
    this.previewCache = {
      shape,
      anchor: this.pos1,
      tiles: plan.tiles,
      guide: shape === 'line' && !this.pos2 ? guideTiles(this.pos1) : [],
      key: `${this.cacheKey}|${plan.blockedCount},${plan.buildCount}`,
    };
    return this.previewCache;
  }

  summary(): PlacementSummary {
    const plan = this.plan();
    if (!plan || !this.pos1) return { active: false, title: '', detail: '', canConfirm: false };
    const label = TOOL_LABELS[this.tool];
    const parts: string[] = [];
    if (plan.buildCount > 0) parts.push(`${plan.buildCount}칸`);
    if (plan.buildCount === 0 && plan.links > 0) parts.push(`연결 ${plan.links}`);
    if (plan.skipCount > 0) parts.push(`유지 ${plan.skipCount}`);
    if (plan.blockedCount > 0) parts.push(`불가 ${plan.blockedCount}`);
    const cost = plan.cost;
    const detail =
      plan.buildCount === 0
        ? plan.links > 0
          ? '이미 놓인 도로를 잇습니다 · ₩0'
          : plan.reason || '지을 칸이 없습니다'
        : cost > this.sim.money
          ? `₩${cost.toLocaleString('ko-KR')} · 자금 부족`
          : `₩${cost.toLocaleString('ko-KR')}`;
    return {
      active: true,
      title: `${label} ${parts.join(' · ') || '범위 선택 중'}`,
      detail,
      canConfirm: plan.buildCount > 0 || plan.links > 0,
    };
  }

  /* ---------------------------------------------------------------- *
   * 확정
   * ---------------------------------------------------------------- */

  confirmPlacement(): void {
    const plan = this.plan();
    if (!plan) return;
    if (plan.buildCount === 0 && plan.links === 0) {
      this.note(plan.reason || '지을 수 있는 칸이 없습니다');
      this.clearSelection();
      return;
    }

    let placed = 0;
    let linked = 0;
    let prev: Point | null = null;
    for (const t of plan.tiles) {
      if (t.state === 'build' && this.apply(t.tx, t.ty)) placed++;
      if (
        this.tool === 'road' &&
        prev &&
        t.state !== 'blocked' &&
        this.world.getBuild(prev.tx, prev.ty) === Build.Road &&
        this.world.getBuild(t.tx, t.ty) === Build.Road &&
        canConnectRoads(this.world, prev.tx, prev.ty, t.tx, t.ty).ok &&
        this.world.connectRoads(prev.tx, prev.ty, t.tx, t.ty)
      ) {
        linked++;
        this.refresh(prev.tx, prev.ty);
        this.refresh(t.tx, t.ty);
      }
      prev = t.state === 'blocked' ? null : t;
    }
    this.invalidatePlan();

    if (!this.message || performance.now() - this.messageAt > MESSAGE_MS) {
      const short = plan.buildCount - placed;
      this.note(
        short > 0
          ? `${placed}칸 건설 · ${short}칸은 짓지 못했습니다`
          : placed === 0
            ? `${linked}곳을 이었습니다`
            : `${placed}칸 건설 완료`,
      );
    }
    this.clearSelection();
  }

  cancelPlacement(): void {
    this.clearSelection();
    this.note('선택 취소');
  }

  /* ---------------------------------------------------------------- *
   * 칸 하나의 판정 — 미리보기가 거짓말하지 않게 실제 규칙만 쓴다
   * ---------------------------------------------------------------- */

  /**
   * 지형 수정 한 칸의 값. **이번에 고르는 넓이** 에 따라 오른다 (수정사항 10).
   * 넓이는 지금 선택 중인 직사각형에서 읽는다 — 미리보기와 실제 과금이 같다.
   */
  private terrainUnitCost(): number {
    const end = this.pos2 ?? this.hover ?? this.pos1;
    let n = 1;
    if (this.pos1 && end) {
      const w = Math.min(MAX_AREA_SIDE, Math.abs(end.tx - this.pos1.tx) + 1);
      const h = Math.min(MAX_AREA_SIDE, Math.abs(end.ty - this.pos1.ty) + 1);
      n = w * h;
    }
    return Math.round(TERRAIN_COST * (1 + (n - 1) / TERRAIN_SOFT_TILES));
  }

  private verdict(tx: number, ty: number): TileVerdict {
    if (!this.world.isExplored(chunkIndexOf(tx), chunkIndexOf(ty)))
      return blocked('아직 개척하지 않은 땅입니다');

    switch (this.tool) {
      case 'road': {
        const cur = this.world.getBuild(tx, ty);
        if (cur === Build.Road) return SKIP;
        if (isWater(this.world.getTile(tx, ty)))
          return blocked('물 위에는 도로를 놓을 수 없습니다');
        // 원래 있던 것은 없애지 않는다. 지구·시설 위로 도로를 덧그리면 예전에는
        // 그 자리가 조용히 헐렸다 — 학생이 제 도시를 지우는 사고의 원인이었다.
        if (cur !== Build.None) return blocked('먼저 철거해야 합니다');
        return buildable(COST_ROAD);
      }
      case 'runway':
      case 'taxiway': {
        const value = TOOL_VALUE[this.tool]!;
        if (this.world.getBuild(tx, ty) === value) return SKIP;
        const r = canPlaceAirfieldSurface(this.world, tx, ty, value);
        if (!r.ok) return blocked(r.reason || '여기에는 놓을 수 없습니다');
        return buildable(value === Build.Runway ? RUNWAY_COST : TAXIWAY_COST);
      }
      case 'zoneR':
      case 'zoneC':
      case 'zoneI': {
        const value = TOOL_VALUE[this.tool]!;
        const cur = this.world.getBuild(tx, ty);
        if (cur === value) return SKIP;
        // 다른 지구 위에 바로 덮어쓸 수 있다 (수정사항 8). 그 위의 건물은
        // setBuild 가 알아서 헐어준다 — 철거 도구를 한 번 더 들 이유가 없다.
        const r = canPlaceZone(this.world, tx, ty, value);
        if (!r.ok) return blocked(r.reason || '여기에는 지정할 수 없습니다');
        return buildable(COST_ZONE);
      }
      case 'terrainRaise':
      case 'terrainLower': {
        /*
         * 지형 수정 (수정사항 10).
         *
         * 이미 무언가 지어진 칸은 손대지 않는다. 도로·건물 밑의 고도를 바꾸면
         * 비탈 규칙이 통째로 깨지고, 학생 눈에는 길이 공중에 뜬다. 먼저 철거하면
         * 그만이다 — 막는 것이 아니라 순서를 정해 주는 것이다.
         */
        if (this.world.getBuild(tx, ty) !== Build.None)
          return blocked('먼저 철거해야 지형을 고칠 수 있습니다');
        if (isWater(this.world.getTile(tx, ty))) return blocked('물 위의 지형은 고칠 수 없습니다');
        const h = this.world.getHeight(tx, ty);
        const next = h + (this.tool === 'terrainRaise' ? 1 : -1);
        if (next < 0) return blocked('더 낮출 수 없습니다');
        if (next > MAX_HEIGHT) return blocked('더 높일 수 없습니다');
        return buildable(this.terrainUnitCost());
      }
      case 'bulldoze':
        return this.world.getBuild(tx, ty) === Build.None ? SKIP : buildable(0);
      case 'wire':
        return this.world.getWire(tx, ty) ? SKIP : buildable(WIRE_COST);
      case 'wireErase':
        return this.world.getWire(tx, ty) ? buildable(0) : SKIP;
      case 'waterPipe':
      case 'sewerPipe': {
        const bit = this.tool === 'waterPipe' ? PIPE_WATER : PIPE_SEWER;
        return this.world.getPipe(tx, ty) & bit ? SKIP : buildable(PIPE_COST);
      }
      case 'pipeErase':
        return this.world.getPipe(tx, ty) === 0 ? SKIP : buildable(0);
      case 'metroTunnel':
        return this.sim.metro.state.tunnels[`${tx},${ty}`] ? SKIP : buildable(0);
      default:
        return SKIP;
    }
  }

  /* ---------------------------------------------------------------- *
   * 한 채짜리 도구 (시설·지하철역·신호등) — 예전 그대로 탭 한 번
   * ---------------------------------------------------------------- */

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

  private applySingle(tx: number, ty: number): void {
    if (this.tool === 'metroStation' || this.tool === 'metroErase') {
      const result = this.sim.metro.edit(
        tx,
        ty,
        this.tool === 'metroStation' ? 'station' : 'erase',
      );
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
    if (this.tool === 'facility') this.applyFacility(tx, ty);
  }

  /* ---------------------------------------------------------------- *
   * 실제 건설 — 확정 버튼을 누른 뒤에만 여기에 온다
   * ---------------------------------------------------------------- */

  /** 한 칸을 실제로 짓는다. 지었으면 true. */
  private apply(tx: number, ty: number): boolean {
    if (this.tool === 'metroTunnel') {
      const result = this.sim.metro.edit(tx, ty, 'tunnel');
      if (!result.ok) this.note(result.message);
      return result.ok;
    }
    if (this.tool === 'wire' || this.tool === 'wireErase') {
      const present = this.tool === 'wire';
      if (this.world.getWire(tx, ty) === present) return false;
      if (present && !this.sim.spend(WIRE_COST)) {
        this.note('돈이 모자랍니다');
        return false;
      }
      this.world.setWire(tx, ty, present);
      this.feedback(tx, ty, present ? 'build' : 'demolish');
      return true;
    }
    if (this.tool === 'waterPipe' || this.tool === 'sewerPipe' || this.tool === 'pipeErase') {
      const current = this.world.getPipe(tx, ty);
      const mask =
        this.tool === 'pipeErase'
          ? 0
          : current | (this.tool === 'waterPipe' ? PIPE_WATER : PIPE_SEWER);
      if (current === mask) return false;
      if (mask !== 0 && !this.sim.spend(PIPE_COST)) {
        this.note('돈이 모자랍니다');
        return false;
      }
      this.world.setPipe(tx, ty, mask);
      this.feedback(tx, ty, mask === 0 ? 'demolish' : 'build');
      if (mask === 3)
        this.note('상·하수도관이 교차 연결되어 물이 오염됩니다. 배관 철거로 분리하세요.');
      return true;
    }

    if (this.tool === 'terrainRaise' || this.tool === 'terrainLower') {
      const h = this.world.getHeight(tx, ty);
      const next = h + (this.tool === 'terrainRaise' ? 1 : -1);
      if (next < 0 || next > MAX_HEIGHT) return false;
      if (!this.sim.spend(this.terrainUnitCost())) {
        this.note('돈이 모자랍니다');
        return false;
      }
      this.world.setHeight(tx, ty, next);
      this.refresh(tx, ty);
      this.feedback(tx, ty, 'build');
      return true;
    }

    if (this.tool === 'bulldoze') {
      if (this.world.getBuild(tx, ty) === Build.None) return false;
      const facility = this.world.buildingCovering(tx, ty);
      this.world.setBuild(tx, ty, Build.None);
      if (facility && facility.kind !== null) {
        this.refreshArea(facility.tx, facility.ty, facility.span);
      } else {
        this.refresh(tx, ty);
      }
      this.feedback(tx, ty, 'demolish');
      return true;
    }

    const value = TOOL_VALUE[this.tool];
    if (value === undefined) return false;

    const airfield = value === Build.Runway || value === Build.Taxiway;
    const result: PlaceResult =
      value === Build.Road
        ? canPlaceRoad(this.world, tx, ty)
        : airfield
          ? canPlaceAirfieldSurface(this.world, tx, ty, value)
          : canPlaceZone(this.world, tx, ty, value);

    if (!result.ok) {
      if (result.reason) this.note(result.reason);
      return false;
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
      return false;
    }

    this.world.setBuild(tx, ty, value);
    this.refresh(tx, ty);
    this.feedback(tx, ty, 'build');
    return true;
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
    if (result.warning) this.note(result.warning);
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

  /** 한 칸을 놓았을 때의 소리와 애니메이션 (수정사항 2). */
  private feedback(tx: number, ty: number, kind: 'build' | 'demolish'): void {
    // 검사 스크립트는 렌더러를 흉내만 내므로 이 레이어가 없을 수 있다.
    this.renderer.effects?.push({ kind, tx, ty, span: 1 }, performance.now());
    audio.play(kind);
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
    // 실패는 소리로 먼저 안다. 메시지는 읽기 전에 사라지기도 한다.
    if (text) audio.play('deny');
  }
}

export { bindConstructionMenu as bindToolButtons } from './constructionMenu';
