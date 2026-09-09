import { CHUNK_SIZE } from '../core/constants';
import { chunkIndexOf } from '../core/iso';
import { Build, DIRS } from '../world/build';
import { isWater } from '../world/terrain';
import type { World } from '../world/world';
import { isAnchor, levelOfCode, ZONE_R, zoneOfCode } from './buildings';

export type WalkPoint = readonly [number, number];
export interface Pedestrian {
  x: number;
  y: number;
  color: number;
  path: WalkPoint[];
  progress: number;
}

/** 타일을 추가하지 않는다. 정수 격자 꼭짓점은 실제로 (x-.5,y-.5) 경계다. */
export function walkEdgeCost(world: World, x: number, y: number, nx: number, ny: number): number {
  if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) return Infinity;
  const a: WalkPoint = x !== nx ? [Math.min(x, nx), y - 1] : [x - 1, Math.min(y, ny)];
  const b: WalkPoint = x !== nx ? [a[0], y] : [x, a[1]];
  const land = ([tx, ty]: WalkPoint) =>
    world.isExplored(chunkIndexOf(tx), chunkIndexOf(ty)) && !isWater(world.getTile(tx, ty));
  const al = land(a),
    bl = land(b);
  if (!al && !bl) return Infinity;
  if (al && bl && Math.abs(world.sampleHeight(...a) - world.sampleHeight(...b)) > 1)
    return Infinity;
  const ab = world.buildingCovering(...a),
    bb = world.buildingCovering(...b);
  // 하나의 큰 건물을 가로지르는 내부 경계는 길이 아니다.
  if (ab && bb && ab.tx === bb.tx && ab.ty === bb.ty) return Infinity;
  const ar = world.getBuild(...a) === Build.Road,
    br = world.getBuild(...b) === Build.Road;
  if (ar !== br) return 1; // 도로 가장자리를 우선한다.
  return ar && br ? 2.5 : 1.35; // 도로 횡단보다 건물 사이 경계 통로를 선호한다.
}

/** 근거리 표시용 A*. 전 도시 통행 배정과 차량 수요에는 관여하지 않는다. */
export function findWalkPath(world: World, start: WalkPoint, goal: WalkPoint): WalkPoint[] {
  const x0 = Math.min(start[0], goal[0]) - 5,
    y0 = Math.min(start[1], goal[1]) - 5;
  const x1 = Math.max(start[0], goal[0]) + 5,
    y1 = Math.max(start[1], goal[1]) + 5;
  if (x1 - x0 + y1 - y0 > 70) return [];
  const key = (x: number, y: number) => `${x},${y}`;
  const h = (x: number, y: number) => Math.abs(x - goal[0]) + Math.abs(y - goal[1]);
  const first = key(...start);
  const open = [{ x: start[0], y: start[1], g: 0, f: h(...start) }];
  const best = new Map<string, number>([[first, 0]]);
  const prev = new Map<string, string>();
  for (let expanded = 0; open.length && expanded < 2048; expanded++) {
    let at = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[at].f) at = i;
    const cur = open.splice(at, 1)[0],
      ck = key(cur.x, cur.y);
    if (cur.g !== best.get(ck)) continue;
    if (cur.x === goal[0] && cur.y === goal[1]) {
      const path: WalkPoint[] = [];
      let k: string | undefined = ck;
      while (k !== undefined) {
        const [x, y] = k.split(',').map(Number);
        path.push([x - 0.5, y - 0.5]);
        k = prev.get(k);
      }
      return path.reverse();
    }
    for (const [dx, dy] of DIRS) {
      const x = cur.x + dx,
        y = cur.y + dy;
      if (x < x0 || y < y0 || x > x1 || y > y1) continue;
      const g = cur.g + walkEdgeCost(world, cur.x, cur.y, x, y),
        k = key(x, y);
      if (!Number.isFinite(g) || g >= (best.get(k) ?? Infinity)) continue;
      best.set(k, g);
      prev.set(k, ck);
      open.push({ x, y, g, f: g + h(x, y) });
    }
  }
  return [];
}

const COLORS = [0xe8b85a, 0x78b9d1, 0xdb8b85, 0xb8c994];

/** 시민의 근거리 보행을 대표하는 파생 데이터. 저장/입주율/차량 통행량을 바꾸지 않는다. */
export class PedestrianPool {
  readonly walkers: Pedestrian[] = [];
  private revision = -1;
  private region = '';
  private candidates: { start: WalkPoint; goal: WalkPoint }[] = [];
  constructor(private world: World) {}

  update(
    dtMs: number,
    cx: number,
    cy: number,
    radius: number,
    focusX = (cx + 0.5) * CHUNK_SIZE,
    focusY = (cy + 0.5) * CHUNK_SIZE,
  ): void {
    const region = `${cx},${cy},${radius},${Math.floor(focusX / 16)},${Math.floor(focusY / 16)}`;
    if (this.revision !== this.world.walkRevision || region !== this.region) {
      this.revision = this.world.walkRevision;
      this.region = region;
      this.walkers.length = 0;
      this.candidates = [];
      const homes: WalkPoint[] = [],
        destinations: WalkPoint[] = [];
      for (const p of this.world.developedParcels()) {
        if (Math.abs(p.cx - cx) > radius || Math.abs(p.cy - cy) > radius || !p.bld) continue;
        for (let i = 0; i < p.bld.length; i++) {
          const code = p.bld[i];
          if (!isAnchor(code)) continue;
          const x = p.cx * CHUNK_SIZE + (i % CHUNK_SIZE),
            y = p.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
          const point: WalkPoint = [x + levelOfCode(code), y];
          destinations.push(point);
          if (zoneOfCode(code) === ZONE_R) homes.push(point);
        }
      }
      homes.sort(
        (a, b) =>
          Math.abs(a[0] - focusX) +
          Math.abs(a[1] - focusY) -
          Math.abs(b[0] - focusX) -
          Math.abs(b[1] - focusY),
      );
      for (const home of homes) {
        let goal: WalkPoint | undefined,
          best = 25;
        for (const p of destinations) {
          const d = Math.abs(p[0] - home[0]) + Math.abs(p[1] - home[1]);
          if (d > 1 && d < best) {
            goal = p;
            best = d;
          }
        }
        if (goal) this.candidates.push({ start: home, goal });
        if (this.candidates.length >= 24) break;
      }
    }
    // 프레임당 경로 한 개. 빽빽한 도시에서도 표시용 탐색을 한꺼번에 하지 않는다.
    const candidate = this.candidates.shift();
    if (candidate) {
      const path = findWalkPath(this.world, candidate.start, candidate.goal);
      if (path.length > 1)
        for (let i = 0; i < 3; i++) {
          this.walkers.push({
            x: path[0][0],
            y: path[0][1],
            color: COLORS[this.walkers.length % COLORS.length],
            path,
            progress: ((path.length - 1) * i) / 3,
          });
        }
    }
    for (const p of this.walkers) {
      const length = p.path.length - 1;
      p.progress = (p.progress + (Math.min(dtMs, 100) / 1000) * 0.7) % (length * 2);
      const distance = p.progress <= length ? p.progress : length * 2 - p.progress;
      const i = Math.min(length - 1, Math.floor(distance)),
        t = distance - i;
      p.x = p.path[i][0] + (p.path[i + 1][0] - p.path[i][0]) * t;
      p.y = p.path[i][1] + (p.path[i + 1][1] - p.path[i][1]) * t;
    }
  }
}
