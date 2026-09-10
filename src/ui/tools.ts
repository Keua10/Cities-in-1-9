import { pickTile } from '../core/pick';
import type { WorldRenderer } from '../render/worldRenderer';
import { FACILITY_COUNT, isWelfareKind } from '../sim/buildings';
import { canPlaceFacility, FACILITY_SPECS } from '../sim/facilities';
import type { MacroSim } from '../sim/macro';
import { PIPE_COST, PIPE_SEWER, PIPE_WATER, WATER_SPECS } from '../sim/config/water';
import { POWER_SPECS, WIRE_COST, facilityPowerDemand } from '../sim/config/power';
import { FAC_CEMETERY, FAC_INCINERATOR } from '../sim/config/sanitation';
import { AIRPORT_SPECS, HARBOR_SPECS, RUNWAY_COST, TAXIWAY_COST } from '../sim/config/transport';
import {
  FAC_COMM_TOWER,
  FAC_PRISON,
  SPECIAL_SPECS,
  isAirportFacility,
  isHarborFacility,
  isSpecialFacility,
} from '../sim/config/special';
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
  | 'select'
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
    return this.tool === 'facility' ? 'tap' : this.tool !== 'select';
  }

  get cityLevel(): number {
    return this.sim.cityLevel;
  }

  get utilityMode(): UtilityMode {
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
    if ((!this.message || now - this.messageAt > MESSAGE_MS) && this.utilityMode !== 'off') {
      return this.utilityMode === 'power'
        ? '노랑=전력 공급 범위 · 주황=용량 부족 · 회색 전선=단절 · 건물 가장자리 3칸 이내 자동 공유. 빈 땅은 전달하지 않습니다.'
        : '파랑=급수 범위 · 갈색=하수 범위 · 빨강=오염 · 주황=용량 부족 · 배관 반경 4칸. 상·하수도관은 빈 칸 1개 이상 띄우세요.';
    }
    if (!this.message || now - this.messageAt > MESSAGE_MS) {
      if (this.tool === 'road') return '클릭: 독립 도로 · 드래그: 지나간 방향으로 설치·연결';
      if (this.tool === 'runway') return '공항 활주로 · 일직선으로 길게 설치하세요';
      if (this.tool === 'taxiway') return '공항 유도로 · 터미널과 활주로를 이어야 공항이 가동됩니다';
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
    const result: PlaceResult = value === Build.Road
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

export function bindToolButtons(tools: Tools, onChange?: () => void): void {
  const ids: Array<[string, ToolId]> = [
    ['btn-tool-select', 'select'],
    ['btn-tool-road', 'road'],
    ['btn-tool-zone-r', 'zoneR'],
    ['btn-tool-zone-c', 'zoneC'],
    ['btn-tool-zone-i', 'zoneI'],
    ['btn-tool-facility', 'facility'],
    ['btn-tool-bulldoze', 'bulldoze'],
    ['btn-tool-water', 'waterPipe'],
    ['btn-tool-sewer', 'sewerPipe'],
    ['btn-tool-pipe-erase', 'pipeErase'],
    ['btn-tool-wire', 'wire'],
    ['btn-tool-wire-erase', 'wireErase'],
  ];

  const buttons: Array<[HTMLElement, ToolId]> = [];
  for (const [id, tool] of ids) {
    const el = document.getElementById(id);
    if (el) buttons.push([el, tool]);
  }

  const sheet = buildFacilitySheet(tools, () => {
    syncAll();
    onChange?.();
  });

  const syncAll = (): void => {
    for (const [el, tool] of buttons) el.setAttribute('aria-pressed', String(tools.tool === tool));
    sheet.sync();
  };

  for (const [el, tool] of buttons) {
    el.addEventListener('click', () => {
      const reopen = tool === 'facility' && tools.tool !== 'facility';
      tools.setTool(tool);
      if (tool === 'facility') sheet.setOpen(reopen || !sheet.isOpen());
      else sheet.setOpen(false);
      syncAll();
      onChange?.();
    });
  }

  syncAll();
  const pipeButton = document.getElementById('btn-pipes');
  pipeButton?.addEventListener('click', () => {
    const modes: UtilityMode[] = ['off', 'water', 'sewer', 'power'];
    tools.inspectMode = modes[(modes.indexOf(tools.inspectMode) + 1) % modes.length];
    pipeButton.textContent = {
      off: '공급 범위 보기',
      water: '급수 범위',
      sewer: '하수 범위',
      power: '전력 범위',
    }[tools.inspectMode];
    pipeButton.setAttribute('aria-pressed', String(tools.inspectMode !== 'off'));
  });
}

interface FacilitySheet {
  setOpen(open: boolean): void;
  isOpen(): boolean;
  sync(): void;
}

function buildFacilitySheet(tools: Tools, onPick: () => void): FacilitySheet {
  const root = document.createElement('div');
  root.id = 'facility-sheet';
  root.hidden = true;

  const groups: Array<[string, number[]]> = [
    ['필수 시설', []],
    ['복지 시설', []],
    ['상하수도 시설', []],
    ['발전 시설', []],
    ['위생·장의 시설', []],
    ['특수 시설', []],
  ];

  for (let kind = 0; kind < FACILITY_COUNT; kind++) {
    const group = isSpecialFacility(kind)
      ? 5
      : kind >= FAC_INCINERATOR && kind <= FAC_CEMETERY
        ? 4
        : POWER_SPECS[kind]
          ? 3
          : WATER_SPECS[kind]
            ? 2
            : isWelfareKind(kind)
              ? 1
              : 0;
    groups[group][1].push(kind);
  }

  const buttons: Array<[HTMLButtonElement, number]> = [];
  for (const [title, kinds] of groups) {
    const row = document.createElement('div');
    row.className = 'fs-row';
    const label = document.createElement('span');
    label.className = 'fs-label';
    label.textContent = title;
    row.appendChild(label);

    const list = document.createElement('div');
    list.className = 'fs-list';
    for (const kind of kinds) {
      const spec = FACILITY_SPECS[kind];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fs-item';
      btn.dataset.welfare = String(spec.welfare);
      btn.innerHTML =
        `<b>${spec.name}</b>` +
        `<i>${spec.span}x${spec.span}</i>` +
        `<s>₩${spec.cost.toLocaleString('ko-KR')} · 하루 ₩${spec.upkeepPerDay.toLocaleString('ko-KR')}</s>` +
        `<small>도시 레벨 ${spec.unlockLevel}부터</small>`;

      const water = WATER_SPECS[kind];
      if (kind >= FAC_INCINERATOR && kind <= FAC_CEMETERY) {
        btn.innerHTML +=
          `<small>도로 ${spec.range}칸 · 담당 정원 ${spec.capacity.toLocaleString('ko-KR')} · 전력 필요</small>` +
          `<small>${kind === FAC_INCINERATOR ? '모든 구역의 쓰레기를 소각 처리' : '주거 장의 수요 담당 · 화장·묘지 중 가까운 시설 배정'}</small>`;
      }
      if (POWER_SPECS[kind])
        btn.innerHTML += `<small>발전 용량 ${POWER_SPECS[kind].capacity.toLocaleString('ko-KR')} · 도로 필요</small>`;
      if (water)
        btn.innerHTML += `<small>${water.pipe === PIPE_WATER ? '급수' : '하수'} 용량 ${water.capacity.toLocaleString('ko-KR')}${water.needsWater ? ' · 하천 인접' : ''}${water.pipe === PIPE_SEWER ? ` · 배출 오염 ${Math.round(water.pollution * 100)}%` : ''}</small>`;

      if (isSpecialFacility(kind)) {
        const power = facilityPowerDemand(kind);
        const role = SPECIAL_SPECS[kind].role;
        btn.innerHTML += `<small>${role}</small>`;
        if (kind === FAC_COMM_TOWER) {
          btn.innerHTML += '<small>도로·전력 불필요 · 만족도/서비스/수요 영향 없음</small>';
        } else if (isHarborFacility(kind)) {
          const hs = HARBOR_SPECS[kind];
          const mode = hs.mode === 'passenger' ? '여객 전용' : hs.mode === 'cargo' ? '화물 전용' : '여객+화물 배분 가능';
          btn.innerHTML += `<small>${mode} · 최대 ${hs.maxShips}척 · 도로·수역 인접 필수 · 전력 수요 ${power}</small>`;
        } else if (kind === FAC_PRISON) {
          btn.innerHTML += `<small>경찰 서비스 반경 ${spec.range}칸 · 담당 정원 ${spec.capacity.toLocaleString('ko-KR')} · 전력 수요 ${power}</small>`;
        } else if (isAirportFacility(kind)) {
          const as = AIRPORT_SPECS[kind];
          btn.innerHTML += `<small>최대 항공기 ${as.maxPlanes}대 · 활주로 ${as.minRunwayTiles}칸 이상 + 유도로 연결 · 전력 수요 ${power}</small>`;
        }
      }

      btn.addEventListener('click', () => {
        if (tools.cityLevel < spec.unlockLevel) return;
        tools.facilityKind = kind;
        tools.setTool('facility');
        onPick();
      });
      list.appendChild(btn);
      buttons.push([btn, kind]);
    }
    row.appendChild(list);
    root.appendChild(row);
  }

  const airRow = document.createElement('div');
  airRow.className = 'fs-row';
  const airLabel = document.createElement('span');
  airLabel.className = 'fs-label';
  airLabel.textContent = '공항 부품';
  airRow.appendChild(airLabel);
  const airList = document.createElement('div');
  airList.className = 'fs-list';
  const surfaceButtons: Array<[HTMLButtonElement, ToolId]> = [];
  for (const [tool, title, cost, detail] of [
    ['runway', '활주로', RUNWAY_COST, '일직선으로 설치 · 공항 등급별 최소 길이 필요'],
    ['taxiway', '유도로', TAXIWAY_COST, '공항 터미널과 활주로를 연결'],
  ] as const) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fs-item';
    btn.innerHTML = `<b>${title}</b><i>1x1</i><s>타일당 ₩${cost.toLocaleString('ko-KR')}</s><small>${detail}</small>`;
    btn.addEventListener('click', () => {
      tools.setTool(tool);
      root.hidden = true;
      onPick();
    });
    airList.appendChild(btn);
    surfaceButtons.push([btn, tool]);
  }
  airRow.appendChild(airList);
  root.appendChild(airRow);

  document.body.appendChild(root);

  const refreshLocks = (): void => {
    for (const [btn, kind] of buttons) {
      const required = FACILITY_SPECS[kind].unlockLevel;
      btn.disabled = tools.cityLevel < required;
      btn.title = btn.disabled
        ? `도시 레벨 ${required}에서 잠금해제됩니다`
        : FACILITY_SPECS[kind].name;
    }
  };

  let shownLevel = tools.cityLevel;
  window.setInterval(() => {
    if (shownLevel === tools.cityLevel) return;
    shownLevel = tools.cityLevel;
    refreshLocks();
  }, 1000);
  refreshLocks();

  return {
    setOpen(open) {
      refreshLocks();
      root.hidden = !open;
    },
    isOpen() {
      return !root.hidden;
    },
    sync() {
      if (tools.tool !== 'facility') root.hidden = true;
      for (const [btn, kind] of buttons) {
        btn.setAttribute(
          'aria-pressed',
          String(tools.tool === 'facility' && tools.facilityKind === kind),
        );
      }
      for (const [btn, tool] of surfaceButtons) {
        btn.setAttribute('aria-pressed', String(tools.tool === tool));
      }
    },
  };
}
