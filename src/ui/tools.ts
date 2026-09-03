import { pickTile } from '../core/pick';
import type { WorldRenderer } from '../render/worldRenderer';
import {
  Build,
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
  | 'bulldoze';

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
 * 돈은 계산하지 않는다. 건설비는 3단계에서 매크로가 들어올 때 붙인다.
 */
export class Tools {
  tool: ToolId = 'select';

  private message = '';
  private messageAt = 0;
  private lastTx = 0;
  private lastTy = 0;
  private hasLast = false;

  constructor(
    private world: World,
    private renderer: WorldRenderer,
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

  private paintAtWorld(wx: number, wy: number): void {
    const t = pickTile(this.world, wx, wy);

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
      if (this.world.getBuild(tx, ty) === Build.None) return;
      this.world.setBuild(tx, ty, Build.None);
      this.refresh(tx, ty);
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

    this.world.setBuild(tx, ty, value);
    this.refresh(tx, ty);
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
    ['btn-tool-bulldoze', 'bulldoze'],
  ];

  const buttons: Array<[HTMLElement, ToolId]> = [];
  for (const [id, tool] of ids) {
    const el = document.getElementById(id);
    if (el) buttons.push([el, tool]);
  }

  const sync = (): void => {
    for (const [el, tool] of buttons) {
      el.setAttribute('aria-pressed', String(tools.tool === tool));
    }
  };

  for (const [el, tool] of buttons) {
    el.addEventListener('click', () => {
      tools.setTool(tool);
      sync();
      onChange?.();
    });
  }

  sync();
}
