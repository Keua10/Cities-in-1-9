import { pickTile } from '../core/pick';
import type { WorldRenderer } from '../render/worldRenderer';
import { FACILITY_COUNT, isWelfareKind } from '../sim/buildings';
import { canPlaceFacility, FACILITY_SPECS } from '../sim/facilities';
import type { MacroSim } from '../sim/macro';
import { COST_ROAD, COST_ZONE } from '../sim/simConstants';
import { Build, canPlaceRoad, canPlaceZone, DIRS, type PlaceResult } from '../world/build';
import type { World } from '../world/world';

export type ToolId = 'select' | 'road' | 'zoneR' | 'zoneC' | 'zoneI' | 'facility' | 'bulldoze';

/** 도구 -> build 레이어에 쓸 값. 'select' 와 'bulldoze' 는 따로 다룬다. */
const TOOL_VALUE: Partial<Record<ToolId, number>> = {
  road: Build.Road,
  zoneR: Build.ZoneR,
  zoneC: Build.ZoneC,
  zoneI: Build.ZoneI,
};

export const TOOL_LABELS: Record<ToolId, string> = {
  select: '선택',
  road: '도로',
  zoneR: '주거',
  zoneC: '상업',
  zoneI: '공업',
  facility: '시설',
  bulldoze: '철거',
};

/** 한 번의 드래그 이벤트에서 채울 수 있는 최대 칸 수. 순간이동 방지. */
const MAX_INTERPOLATE = 64;
/** 거부 사유를 화면에 띄워두는 시간. */
const MESSAGE_MS = 2500;

/**
 * 2단계 도구.
 *
 * 하는 일은 세 가지뿐이다.
 *   1. 어떤 도구가 켜져 있는지 들고 있는다.
 *   2. 눌린 월드 좌표를 타일로 바꿔 규칙을 검사하고 World 에 쓴다.
 *   3. 바뀐 칸과 그 이웃만 렌더러에 알려 다시 그리게 한다.
 *
 * 3.1단계에서 건설비가 붙었다. 돈이 모자라면 배치 자체가 거부된다.
 * 철거는 공짜다 — 학생이 실수를 되돌리는 걸 돈으로 막을 이유가 없다.
 */
export class Tools {
  tool: ToolId = 'select';
  /** 시설 도구가 지금 들고 있는 종류. 시설 시트에서 고른다. */
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

  isPainting(): boolean {
    return this.tool !== 'select';
  }

  setTool(tool: ToolId): void {
    this.tool = tool;
    this.hasLast = false;
    this.message = '';
  }

  /** 지금 표시해야 할 안내 문구. 없으면 빈 문자열. */
  activeMessage(now: number): string {
    if (!this.message) return '';
    if (now - this.messageAt > MESSAGE_MS) return '';
    return this.message;
  }

  beginPaint(wx: number, wy: number): void {
    this.hasLast = false;
    this.paintAtWorld(wx, wy);
  }

  /**
   * 드래그 중 호출. 포인터 이벤트는 빠르게 그으면 타일을 건너뛰므로
   * 직전 칸과 현재 칸 사이를 타일 좌표 기준으로 메운다.
   * 안 그러면 도로가 점선처럼 끊긴 채 깔린다.
   */
  movePaint(wx: number, wy: number): void {
    this.paintAtWorld(wx, wy);
  }

  endPaint(): void {
    this.hasLast = false;
  }

  /**
   * 시설 도구를 든 동안 커서 아래 미리보기 상태. 놓을 수 있으면 초록, 없으면 빨강.
   * main.ts 가 매 프레임 커서로 부른다.
   */
  facilityPreviewAt(
    tx: number,
    ty: number,
  ): { tx: number; ty: number; kind: number; ok: boolean } | null {
    if (this.tool !== 'facility') return null;
    const kind = this.facilityKind;
    return { tx, ty, kind, ok: canPlaceFacility(this.world, tx, ty, kind).ok };
  }

  private paintAtWorld(wx: number, wy: number): void {
    const t = pickTile(this.world, wx, wy);

    /*
     * 시설은 **드래그로 칠하지 않는다.** 보간 경로를 그대로 두면 손가락을 조금만
     * 끌어도 시설이 수십 채 서고 자금이 순식간에 마이너스가 된다. 탭 한 번에
     * 한 채만 놓고, 같은 드래그 안에서는 더 놓지 않는다.
     */
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
      // 손가락이 화면 밖으로 나갔다 들어온 경우. 이어 그리면 지도를 가로지른다.
      this.apply(t.tx, t.ty);
      this.lastTx = t.tx;
      this.lastTy = t.ty;
      return;
    }

    // 브레젠험. 대각선으로 그어도 4방향 연결이 끊기지 않게 한 축씩 움직인다.
    let x = this.lastTx;
    let y = this.lastTy;
    const sx = t.tx > x ? 1 : -1;
    const sy = t.ty > y ? 1 : -1;
    let err = dx - dy;

    for (let guard = 0; guard < MAX_INTERPOLATE * 2; guard++) {
      if (x === t.tx && y === t.ty) break;
      const e2 = err * 2;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      } else if (e2 < dx) {
        err += dx;
        y += sy;
      }
      this.apply(x, y);
    }

    this.lastTx = t.tx;
    this.lastTy = t.ty;
  }

  private apply(tx: number, ty: number): void {
    if (this.tool === 'select') return;

    if (this.tool === 'bulldoze') {
      // 지구를 지우면 그 위의 건물도 같이 헐린다(World.setBuild).
      // 시설이면 setBuild 안에서 footprint 의 Civic 칸까지 함께 정리된다.
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

    const result: PlaceResult =
      value === Build.Road
        ? canPlaceRoad(this.world, tx, ty)
        : canPlaceZone(this.world, tx, ty, value);

    if (!result.ok) {
      if (result.reason) this.note(result.reason);
      return;
    }

    const cost = value === Build.Road ? COST_ROAD : COST_ZONE;
    if (!this.sim.spend(cost)) {
      this.note('돈이 모자랍니다');
      return;
    }

    this.world.setBuild(tx, ty, value);
    this.refresh(tx, ty);
  }

  /**
   * 시설 한 채를 놓는다.
   *
   * 규칙 검사(물·경사·청크 경계·기존 건물·도로 인접)는 canPlaceFacility 가 전부
   * 하고, 돈 검사만 여기서 한다. 거부 사유는 기존 note() 로 그대로 띄운다.
   */
  private applyFacility(tx: number, ty: number): void {
    const kind = this.facilityKind;
    const spec = FACILITY_SPECS[kind];
    if (!spec) return;

    const result = canPlaceFacility(this.world, tx, ty, kind);
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

  /** footprint 전 칸과 그 테두리를 다시 그린다. 지면이 Civic 으로 바뀌기 때문이다. */
  private refreshArea(tx: number, ty: number, span: number): void {
    for (let dy = -1; dy <= span; dy++) {
      for (let dx = -1; dx <= span; dx++) {
        this.renderer.invalidateTile(tx + dx, ty + dy);
      }
    }
  }

  /**
   * 바뀐 칸과 이웃 4칸을 다시 그린다.
   *
   * 이웃까지 갱신하는 이유가 두 가지다.
   *   - 도로 연결 모양이 이웃 쪽에서도 바뀐다(직선이 T자가 되는 식).
   *   - 도로를 놓거나 지우면 옆 지구의 "도로 접함" 색이 바뀐다.
   */
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

/** 툴바의 도구 버튼을 묶는다. 한 번에 하나만 켜진다. */
export function bindToolButtons(tools: Tools, onChange?: () => void): void {
  const ids: Array<[string, ToolId]> = [
    ['btn-tool-select', 'select'],
    ['btn-tool-road', 'road'],
    ['btn-tool-zone-r', 'zoneR'],
    ['btn-tool-zone-c', 'zoneC'],
    ['btn-tool-zone-i', 'zoneI'],
    ['btn-tool-facility', 'facility'],
    ['btn-tool-bulldoze', 'bulldoze'],
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
    for (const [el, tool] of buttons) {
      el.setAttribute('aria-pressed', String(tools.tool === tool));
    }
    sheet.sync();
  };

  for (const [el, tool] of buttons) {
    el.addEventListener('click', () => {
      // 시설 버튼을 다시 누르면 시트를 접는다. 태블릿에서 화면을 되찾는 유일한 길이다.
      const reopen = tool === 'facility' && tools.tool !== 'facility';
      tools.setTool(tool);
      if (tool === 'facility') sheet.setOpen(reopen || !sheet.isOpen());
      else sheet.setOpen(false);
      syncAll();
      onChange?.();
    });
  }

  syncAll();
}

interface FacilitySheet {
  setOpen(open: boolean): void;
  isOpen(): boolean;
  sync(): void;
}

/**
 * 시설 선택 시트.
 *
 * 버튼 6개에 7개를 더 붙이면 태블릿 하단 dock 이 완전히 넘친다. **"시설" 버튼
 * 하나** 를 넣고, 누르면 이 시트를 띄운다.
 *
 * 시트 안은 **두 묶음으로 나눠서** 보여준다 — 학생이 "이건 필수, 이건 선택" 을
 * UI 에서 바로 읽어야 한다. 각 항목에 건설비와 하루 유지비를 같이 적는다.
 * 유지비가 안 보이면 학생이 시설을 깔아놓고 왜 파산했는지 모른다.
 */
function buildFacilitySheet(tools: Tools, onPick: () => void): FacilitySheet {
  const root = document.createElement('div');
  root.id = 'facility-sheet';
  root.hidden = true;

  const groups: Array<[string, number[]]> = [
    ['필수 시설', []],
    ['복지 시설', []],
  ];
  for (let kind = 0; kind < FACILITY_COUNT; kind++) {
    groups[isWelfareKind(kind) ? 1 : 0][1].push(kind);
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
        `<s>₩${spec.cost.toLocaleString('ko-KR')} · 하루 ₩${spec.upkeepPerDay.toLocaleString('ko-KR')}</s>`;
      btn.addEventListener('click', () => {
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

  document.body.appendChild(root);

  return {
    setOpen(open) {
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
    },
  };
}
