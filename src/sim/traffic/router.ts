import { Build, DIRS } from '../../world/build';
import type { World } from '../../world/world';
import type { CongestionMap } from '../congestion';
import {
  BASE_TILE_COST,
  CONGESTION_WEIGHT,
  LANE_CHANGE_COST,
  ROUTE_MAX_NODES,
  SIGNAL_WAIT_COST,
  SLOPE_COST_MUL,
  TURN_COST_LEFT,
  TURN_COST_RIGHT,
  TURN_COST_STRAIGHT,
} from '../simConstants';
import type { JunctionIndex } from './junctions';

export interface Route {
  /** 도로 타일 나열. tx, ty 가 번갈아 들어간다. */
  tiles: Int32Array;
  /** 탐색 당시 경로의 혼잡 합. */
  costAtPlan: number;
}

interface Pending {
  fromTx: number;
  fromTy: number;
  toTx: number;
  toTy: number;
  tier: number;
  onDone: (route: Route | null) => void;
}

interface HeapNode {
  f: number;
  g: number;
  x: number;
  y: number;
  dir: number;
  key: string;
}

export class Router {
  private queue: (Pending | undefined)[] = [];
  private queueHead = 0;
  /** 신호 대기 비용을 교차로 단위로 매기기 위한 색인. 없으면 비용을 매기지 않는다. */
  private junctions: JunctionIndex | null = null;
  private cache = new Map<string, Route>();
  private roadRevision = -1;
  /** Route 인터페이스를 늘리지 않고 재탐색용 계획 당시 타일별 혼잡을 보관한다. */
  private planSamples = new WeakMap<Route, Float32Array>();

  constructor(
    private world: World,
    private congestion: CongestionMap,
  ) {}

  setJunctions(index: JunctionIndex): void {
    this.junctions = index;
  }

  update(budget: number): void {
    for (let i = 0; i < budget && this.queueHead < this.queue.length; i++) {
      const p = this.queue[this.queueHead]!;
      this.queue[this.queueHead++] = undefined;
      const route = this.find(p.fromTx, p.fromTy, p.toTx, p.toTy, p.tier);
      if (route) this.cache.set(this.key(p.fromTx, p.fromTy, p.toTx, p.toTy, p.tier), route);
      p.onDone(route ? this.cloneRoute(route) : null);
    }
    if (this.queueHead === this.queue.length) {
      this.queue.length = 0;
      this.queueHead = 0;
    } else if (this.queueHead > 1024 && this.queueHead * 2 >= this.queue.length) {
      this.queue = this.queue.slice(this.queueHead);
      this.queueHead = 0;
    }
  }

  request(
    fromTx: number,
    fromTy: number,
    toTx: number,
    toTy: number,
    tier: number,
    onDone: (route: Route | null) => void,
  ): void {
    if (this.roadRevision !== this.world.roadRevision) {
      this.invalidateCache();
      this.roadRevision = this.world.roadRevision;
    }
    const key = this.key(fromTx, fromTy, toTx, toTy, tier);
    const cached = this.cache.get(key);
    if (cached) {
      onDone(this.cloneRoute(cached));
      return;
    }
    this.queue.push({ fromTx, fromTy, toTx, toTy, tier, onDone });
  }

  invalidateCache(): void {
    this.cache.clear();
  }

  /** 탐색 당시의 같은 구간 혼잡 합. 재탐색 판정에 쓴다. */
  plannedCongestion(route: Route, startIndex: number, count: number): number {
    const samples = this.planSamples.get(route);
    if (!samples) {
      const points = Math.max(1, route.tiles.length / 2);
      return (route.costAtPlan / points) * Math.min(count, points - startIndex);
    }
    let sum = 0;
    const end = Math.min(samples.length, startIndex + count);
    for (let i = startIndex; i < end; i++) sum += samples[i];
    return sum;
  }

  /** 활성 영역 밖에서 들어오는 차가 경계부터 시작할 때 계획 표본도 같은 지점부터 자른다. */
  sliceRoute(route: Route, startIndex: number): Route {
    if (startIndex <= 0) return route;
    const tiles = route.tiles.slice(startIndex * 2);
    const oldSamples = this.planSamples.get(route);
    const samples = oldSamples
      ? oldSamples.slice(startIndex)
      : Float32Array.from({ length: tiles.length / 2 }, (_, i) =>
          this.congestion.at(tiles[i * 2], tiles[i * 2 + 1]),
        );
    const sliced: Route = { tiles, costAtPlan: sumSamples(samples) };
    this.planSamples.set(sliced, samples);
    return sliced;
  }

  private key(a: number, b: number, c: number, d: number, tier: number): string {
    return `${a},${b}|${c},${d}|${tier}`;
  }

  /** 방향까지 A* 상태에 넣어 회전 비용이 있어도 최적 경로를 보장한다. */
  private find(sx: number, sy: number, gx: number, gy: number, tier: number): Route | null {
    if (this.world.getBuild(sx, sy) !== Build.Road || this.world.getBuild(gx, gy) !== Build.Road) {
      return null;
    }
    if (sx === gx && sy === gy) {
      const route: Route = {
        tiles: Int32Array.from([sx, sy]),
        costAtPlan: this.congestion.at(sx, sy),
      };
      this.planSamples.set(route, Float32Array.from([route.costAtPlan]));
      return route;
    }

    const startKey = stateKey(sx, sy, 4);
    const heap = new MinHeap();
    heap.push({
      f: heuristic(sx, sy, gx, gy),
      g: 0,
      x: sx,
      y: sy,
      dir: 4,
      key: startKey,
    });
    const best = new Map<string, number>([[startKey, 0]]);
    const previous = new Map<string, string>();
    let goalKey: string | null = null;
    let expanded = 0;

    while (heap.size > 0 && expanded < ROUTE_MAX_NODES) {
      const cur = heap.pop()!;
      if (cur.g !== best.get(cur.key)) continue; // 더 좋은 중복 엔트리가 이미 들어갔다.
      expanded++;
      if (cur.x === gx && cur.y === gy) {
        goalKey = cur.key;
        break;
      }

      for (let nextDir = 0; nextDir < 4; nextDir++) {
        const [dx, dy] = DIRS[nextDir];
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        if (!this.world.roadsConnected(cur.x, cur.y, nx, ny)) continue;

        let step =
          BASE_TILE_COST * (1 + (CONGESTION_WEIGHT[tier - 1] ?? 1) * this.congestion.at(nx, ny));
        if (this.world.sampleHeight(nx, ny) !== this.world.sampleHeight(cur.x, cur.y)) {
          step *= SLOPE_COST_MUL;
        }
        step += turnCost(cur.dir, nextDir);
        // 신호 대기 비용은 **교차로에 들어갈 때 한 번만** 붙인다. 예전에는
        // "이웃 도로가 3개 이상인 타일" 마다 붙였는데, 폭 2타일 도로는 직선
        // 구간의 모든 타일이 여기 걸려서 넓은 도로일수록 경로 비용이 폭등했다.
        if (this.junctions) {
          const jid = this.junctions.idAt(nx, ny);
          if (jid >= 0 && jid !== this.junctions.idAt(cur.x, cur.y)) {
            if (this.junctions.byId(jid)?.signalized) step += SIGNAL_WAIT_COST;
          }
          // 교차로가 아닌 칸에서의 방향 전환 = 넓은 도로 위의 차선 변경이다.
          // (L자 코너는 교차로로 잡히므로 여기 걸리지 않는다.)
          // 값싸게 두면 A*가 넓은 도로에서 지그재그로 차선을 갈아타는 경로를
          // 만들고, 그 지그재그가 마주 오는 차선을 가로질러 겹침의 원인이 된다.
          if (jid < 0 && cur.dir !== 4 && cur.dir !== nextDir && this.junctions.covers(nx, ny)) {
            step += LANE_CHANGE_COST;
          }
        }

        const ng = cur.g + step;
        const nk = stateKey(nx, ny, nextDir);
        if (ng >= (best.get(nk) ?? Infinity)) continue;
        best.set(nk, ng);
        previous.set(nk, cur.key);
        heap.push({
          f: ng + heuristic(nx, ny, gx, gy),
          g: ng,
          x: nx,
          y: ny,
          dir: nextDir,
          key: nk,
        });
      }
    }

    if (!goalKey) return null;
    const reversed: number[] = [];
    let key: string | undefined = goalKey;
    while (key) {
      const [x, y] = parseState(key);
      reversed.push(x, y);
      if (key === startKey) break;
      key = previous.get(key);
    }
    if (key !== startKey) return null;

    const points: number[] = [];
    for (let i = reversed.length - 2; i >= 0; i -= 2) points.push(reversed[i], reversed[i + 1]);
    const samples = new Float32Array(points.length / 2);
    for (let i = 0; i < points.length; i += 2) {
      samples[i / 2] = this.congestion.at(points[i], points[i + 1]);
    }
    const route: Route = { tiles: Int32Array.from(points), costAtPlan: sumSamples(samples) };
    this.planSamples.set(route, samples);
    return route;
  }

  private cloneRoute(route: Route): Route {
    const clone: Route = { tiles: new Int32Array(route.tiles), costAtPlan: route.costAtPlan };
    const samples = this.planSamples.get(route);
    if (samples) this.planSamples.set(clone, new Float32Array(samples));
    return clone;
  }
}

class MinHeap {
  private data: HeapNode[] = [];
  get size(): number {
    return this.data.length;
  }
  push(node: HeapNode): void {
    const a = this.data;
    let i = a.length;
    a.push(node);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= node.f) break;
      a[i] = a[p];
      i = p;
    }
    a[i] = node;
  }
  pop(): HeapNode | undefined {
    const a = this.data;
    if (a.length === 0) return undefined;
    const root = a[0];
    const last = a.pop()!;
    if (a.length === 0) return root;
    let i = 0;
    while (true) {
      const l = i * 2 + 1;
      if (l >= a.length) break;
      const r = l + 1;
      const c = r < a.length && a[r].f < a[l].f ? r : l;
      if (a[c].f >= last.f) break;
      a[i] = a[c];
      i = c;
    }
    a[i] = last;
    return root;
  }
}

function heuristic(x: number, y: number, gx: number, gy: number): number {
  return (Math.abs(gx - x) + Math.abs(gy - y)) * BASE_TILE_COST;
}
function stateKey(x: number, y: number, dir: number): string {
  return `${x},${y},${dir}`;
}
function parseState(key: string): [number, number] {
  const a = key.indexOf(',');
  const b = key.indexOf(',', a + 1);
  return [Number(key.slice(0, a)), Number(key.slice(a + 1, b))];
}
function turnCost(prev: number, next: number): number {
  if (prev === 4 || prev === next) return TURN_COST_STRAIGHT;
  if ((prev + 2) % 4 === next) return TURN_COST_LEFT + TURN_COST_RIGHT;
  return (prev + 1) % 4 === next ? TURN_COST_RIGHT : TURN_COST_LEFT;
}
function sumSamples(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i];
  return sum;
}
