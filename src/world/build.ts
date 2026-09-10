import { CHUNK_SIZE, OVERRIDE_NONE } from '../core/constants';
import { chunkIndexOf } from '../core/iso';
import { civicCell, ROAD_CELL_BASE, zoneCell } from '../render/atlas';
import { isWater } from './terrain';
import type { Chunk, World } from './world';

/**
 * 2단계: 지형과 별개인 "지은 것" 레이어.
 * 저장 ID 0~4는 기존 도시 호환성을 위해 고정한다. 공항 표면은 뒤에만 추가한다.
 */
export const Build = {
  /** 아무것도 안 지음. OVERRIDE_NONE(255) 과 반드시 같아야 한다. */
  None: 255,
  Road: 0,
  ZoneR: 1,
  ZoneC: 2,
  ZoneI: 3,
  Civic: 4,
  /** 공항 확장: 기존 build 배열을 그대로 사용한다. */
  Runway: 5,
  Taxiway: 6,
} as const;

export type BuildId = (typeof Build)[keyof typeof Build];
export const BUILD_NONE: typeof OVERRIDE_NONE = Build.None;

export const BUILD_LABELS: Record<number, string> = {
  [Build.Road]: '도로',
  [Build.ZoneR]: '주거지구',
  [Build.ZoneC]: '상업지구',
  [Build.ZoneI]: '공업지구',
  [Build.Civic]: '공공시설',
  [Build.Runway]: '공항 활주로',
  [Build.Taxiway]: '공항 유도로',
};

export const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

export function isRoad(v: number): boolean {
  return v === Build.Road;
}

export function isZone(v: number): boolean {
  return v === Build.ZoneR || v === Build.ZoneC || v === Build.ZoneI;
}

export function isAirfieldSurface(v: number): boolean {
  return v === Build.Runway || v === Build.Taxiway;
}

/** 도로 연결 마스크(0~15). */
export function roadMask(world: World, tx: number, ty: number): number {
  let mask = 0;
  for (let d = 0; d < 4; d++) {
    const dir = DIRS[d];
    if (world.roadsConnected(tx, ty, tx + dir[0], ty + dir[1])) mask |= 1 << d;
  }
  return mask;
}

/** Runway stays runway-only; taxiway may visually connect into runway. */
export function airfieldMask(world: World, tx: number, ty: number, value: number): number {
  let mask = 0;
  for (let d = 0; d < 4; d++) {
    const [dx, dy] = DIRS[d];
    const next = world.sampleBuild(tx + dx, ty + dy);
    const connected =
      value === Build.Runway
        ? next === Build.Runway
        : next === Build.Taxiway || next === Build.Runway;
    if (connected) mask |= 1 << d;
  }
  return mask;
}

export function hasRoadAccess(world: World, tx: number, ty: number): boolean {
  for (const dir of DIRS) {
    if (world.sampleBuild(tx + dir[0], ty + dir[1]) === Build.Road) return true;
  }
  return false;
}

export interface PlaceResult {
  ok: boolean;
  reason: string;
}

const OK: PlaceResult = { ok: true, reason: '' };
const SILENT: PlaceResult = { ok: false, reason: '' };

function exploredOk(world: World, tx: number, ty: number): boolean {
  return world.isExplored(chunkIndexOf(tx), chunkIndexOf(ty));
}

export function canPlaceRoad(world: World, tx: number, ty: number): PlaceResult {
  if (!exploredOk(world, tx, ty)) return { ok: false, reason: '아직 개척하지 않은 땅입니다' };
  if (isWater(world.getTile(tx, ty))) return { ok: false, reason: '물 위에는 도로를 놓을 수 없습니다' };
  if (world.getBuild(tx, ty) === Build.Road) return SILENT;
  return OK;
}

/**
 * 활주로/유도로는 도로처럼 드래그하지만 빈 육지에만 놓는다.
 * 기존 지구·시설을 자동으로 덮어쓰지 않아 공항 작업 중 도시가 지워지는 것을 막는다.
 */
export function canPlaceAirfieldSurface(
  world: World,
  tx: number,
  ty: number,
  value: number,
): PlaceResult {
  if (value !== Build.Runway && value !== Build.Taxiway) return SILENT;
  if (!exploredOk(world, tx, ty)) return { ok: false, reason: '아직 개척하지 않은 땅입니다' };
  if (isWater(world.getTile(tx, ty))) return { ok: false, reason: '물 위에는 공항 시설을 놓을 수 없습니다' };
  const cur = world.getBuild(tx, ty);
  if (cur === value) return SILENT;
  if (cur !== Build.None) return { ok: false, reason: '빈 땅에만 놓을 수 있습니다' };
  return OK;
}

/** 아직 빈 도착 칸도 가상 도로로 검사해 배치/과금 전에 거부한다. */
export function canConnectRoads(
  world: World,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): PlaceResult {
  if (Math.abs(ax - bx) + Math.abs(ay - by) !== 1 || world.getBuild(ax, ay) !== Build.Road)
    return SILENT;
  if (!exploredOk(world, ax, ay) || !exploredOk(world, bx, by))
    return { ok: false, reason: '아직 개척하지 않은 땅입니다' };
  if (Math.abs(world.sampleHeight(ax, ay) - world.sampleHeight(bx, by)) > 1)
    return { ok: false, reason: '고도 차가 너무 커서 연결할 수 없습니다' };
  for (const [x, y, nx, ny] of [
    [ax, ay, bx, by],
    [bx, by, ax, ay],
  ]) {
    const h = world.sampleHeight(x, y);
    let slopes = 0;
    for (let d = 0; d < 4; d++) {
      const dx = x + DIRS[d][0],
        dy = y + DIRS[d][1];
      if (
        ((dx === nx && dy === ny) || world.roadsConnected(x, y, dx, dy)) &&
        world.sampleHeight(dx, dy) !== h
      )
        slopes |= 1 << d;
    }
    if (slopes && slopes & (slopes - 1) && slopes !== 5 && slopes !== 10)
      return { ok: false, reason: '한 칸이 여러 방향으로 비탈질 수 없습니다' };
  }
  return OK;
}

export function canPlaceZone(world: World, tx: number, ty: number, zone: number): PlaceResult {
  if (!exploredOk(world, tx, ty)) return { ok: false, reason: '아직 개척하지 않은 땅입니다' };
  if (isWater(world.getTile(tx, ty))) return { ok: false, reason: '물 위에는 지구를 지정할 수 없습니다' };
  const cur = world.getBuild(tx, ty);
  if (cur === Build.Road || cur === Build.Runway || cur === Build.Taxiway || cur === Build.Civic)
    return { ok: false, reason: '기존 시설을 먼저 철거해야 합니다' };
  if (cur === zone) return SILENT;
  return OK;
}

export type TopResolver = (chunk: Chunk, index: number, tx: number, ty: number) => number;

export function makeTopResolver(world: World): TopResolver {
  return (chunk, index, tx, ty) => {
    const b = chunk.parcel.build ? chunk.parcel.build[index] : Build.None;
    if (b === Build.None) return chunk.tiles[index];
    if (b === Build.Road) return ROAD_CELL_BASE + roadMask(world, tx, ty);
    // 기존 terrain atlas 안에서 처리하므로 청크 draw-call 구조를 늘리지 않는다.
    if (b === Build.Runway || b === Build.Taxiway)
      return ROAD_CELL_BASE + airfieldMask(world, tx, ty, b);
    if (b >= Build.ZoneR && b <= Build.ZoneI) {
      return zoneCell(b - Build.ZoneR, hasRoadAccess(world, tx, ty));
    }
    if (b === Build.Civic) return civicCell(hasRoadAccess(world, tx, ty));
    return chunk.tiles[index];
  };
}

export function localIndex(lx: number, ly: number): number {
  return ly * CHUNK_SIZE + lx;
}
