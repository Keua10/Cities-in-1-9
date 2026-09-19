import type { ToolId } from './tools';

/**
 * 두 점으로 짓는 건설의 **모양**만 담당한다.
 *
 * ---------------------------------------------------------------
 * 왜 드래그를 버렸나
 * ---------------------------------------------------------------
 * 예전에는 손가락으로 지도를 훑으면 지나간 칸이 그대로 지어졌다. 태블릿에서
 * 이게 세 가지를 동시에 망쳤다.
 *
 *   1. 도구를 든 채로는 지도를 움직일 수 없었다(드래그가 곧 건설이라서).
 *   2. 손이 미끄러지면 의도하지 않은 칸까지 지어지고 돈이 나갔다. 되돌릴
 *      방법이 없었다.
 *   3. 브레젠험 보간이라 대각선 드래그가 계단 모양 도로를 만들었다. 도로는
 *      면을 칠하는 도구가 아니라 선을 긋는 도구인데도.
 *
 * 지금은 **탭 두 번 + 확정 버튼**이다. 첫 탭이 pos1, 둘째 탭이 pos2, 오른쪽
 * 확인 버튼을 눌러야 비로소 지어진다. 그 사이에는 무엇을 어디에 얼마에 짓는지
 * 화면에 다 나온다. 드래그는 언제나 지도 이동으로 돌아갔다.
 *
 * ---------------------------------------------------------------
 * 선과 면
 * ---------------------------------------------------------------
 * 도로·활주로·배관·전선·지하철은 **선**이다. 그래서 두 점을 잡아도 축 하나로
 * 스냅되어 언제나 곧은 일자가 된다(대각선으로 찍어도 긴 쪽 축을 따른다).
 * 지구와 철거는 **면**이라 두 점이 직사각형의 마주 보는 모서리가 된다.
 *
 * 시설처럼 한 채짜리 건물만 예전처럼 탭 한 번에 선다 — 두 점을 잡을 이유가
 * 없기 때문이다.
 */
export type PlacementShape = 'line' | 'area' | 'single' | 'none';

export interface Point {
  tx: number;
  ty: number;
}

/** 계획된 칸 하나의 운명. */
export type TileState =
  /** 지어진다(돈이 나간다). */
  | 'build'
  /** 이미 그렇게 되어 있어 그냥 지나간다. 돈이 안 나간다. */
  | 'skip'
  /** 못 짓는다. 그 자리는 비워두고 나머지만 짓는다. */
  | 'blocked';

export interface PlanTile extends Point {
  state: TileState;
}

export interface PlacementPlan {
  shape: PlacementShape;
  tiles: PlanTile[];
  buildCount: number;
  skipCount: number;
  blockedCount: number;
  /** 지어질 칸의 비용 합. */
  cost: number;
  /**
   * 도로 전용. 이 선이 **새로 이어줄** 인접 쌍의 수.
   *
   * 이미 놓인 두 도로를 잇는 것만으로도 건설은 성립한다(공짜 연결). 지을 칸이
   * 0 이라고 확정을 막으면 T자 교차로를 만들 방법이 사라진다.
   */
  links: number;
  /** 막힌 칸의 첫 사유. 없으면 빈 문자열. */
  reason: string;
  /** 상한에 걸려 잘렸는가. */
  truncated: boolean;
}

/** 선 하나의 최대 길이. 이보다 길면 잘라낸다. */
export const MAX_LINE_TILES = 120;
/** 면 한 변의 최대 길이. 32×32 = 1,024칸이 한 번에 지을 수 있는 최대다. */
export const MAX_AREA_SIDE = 32;
/** pos1 을 찍었을 때 "여기까지 갈 수 있다" 고 비춰주는 안내선의 길이. */
export const GUIDE_TILES = 30;

const LINE_TOOLS: ReadonlySet<string> = new Set<ToolId>([
  'road',
  'runway',
  'taxiway',
  'waterPipe',
  'sewerPipe',
  'pipeErase',
  'wire',
  'wireErase',
  'metroTunnel',
]);

const AREA_TOOLS: ReadonlySet<string> = new Set<ToolId>(['zoneR', 'zoneC', 'zoneI', 'bulldoze']);

const SINGLE_TOOLS: ReadonlySet<string> = new Set<ToolId>([
  'facility',
  'metroStation',
  'metroErase',
  'signalInstall',
  'signalRemove',
]);

export function placementShape(tool: ToolId): PlacementShape {
  if (LINE_TOOLS.has(tool)) return 'line';
  if (AREA_TOOLS.has(tool)) return 'area';
  if (SINGLE_TOOLS.has(tool)) return 'single';
  return 'none';
}

function clampStep(from: number, to: number, limit: number): number {
  const d = to - from;
  if (Math.abs(d) <= limit) return to;
  return from + Math.sign(d) * limit;
}

/**
 * pos1 → pos2 를 **축 하나로 스냅한** 곧은 선. 긴 쪽 축을 따른다.
 * 두 점이 같으면 한 칸짜리 선이 된다(도로 한 칸만 놓고 싶을 때).
 */
export function lineTiles(a: Point, b: Point): { tiles: Point[]; truncated: boolean } {
  const dx = b.tx - a.tx;
  const dy = b.ty - a.ty;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const raw = horizontal ? dx : dy;
  const end = clampStep(0, raw, MAX_LINE_TILES - 1);
  const step = Math.sign(end);
  const tiles: Point[] = [];
  for (let i = 0; ; i += 1) {
    tiles.push({
      tx: a.tx + (horizontal ? i * step : 0),
      ty: a.ty + (horizontal ? 0 : i * step),
    });
    if (step === 0 || i === Math.abs(end)) break;
  }
  return { tiles, truncated: end !== raw };
}

/** pos1 과 pos2 를 마주 보는 모서리로 삼은 직사각형. */
export function areaTiles(a: Point, b: Point): { tiles: Point[]; truncated: boolean } {
  const ex = clampStep(a.tx, b.tx, MAX_AREA_SIDE - 1);
  const ey = clampStep(a.ty, b.ty, MAX_AREA_SIDE - 1);
  const x0 = Math.min(a.tx, ex);
  const x1 = Math.max(a.tx, ex);
  const y0 = Math.min(a.ty, ey);
  const y1 = Math.max(a.ty, ey);
  const tiles: Point[] = [];
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) tiles.push({ tx, ty });
  return { tiles, truncated: ex !== b.tx || ey !== b.ty };
}

/**
 * pos1 에서 네 방향으로 뻗는 안내선.
 *
 * 터치에는 hover 가 없다. pos1 만 찍은 상태에서 아무 표시가 없으면 학생은
 * "둘째 점을 어디에 찍어야 하는지" 를 알 수 없다. 그래서 갈 수 있는 축을
 * 바닥에 비춰준다 — 선 도구가 대각선으로는 갈 수 없다는 것도 같이 읽힌다.
 */
export function guideTiles(a: Point, length = GUIDE_TILES): Point[] {
  const out: Point[] = [];
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    for (let i = 1; i <= length; i++) out.push({ tx: a.tx + dx * i, ty: a.ty + dy * i });
  }
  return out;
}
