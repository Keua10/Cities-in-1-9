import { CHUNK_SIZE, CHUNK_TILES } from '../core/constants';
import { chunkIndexOf, chunkKey, localIndexOf } from '../core/iso';
import { Build, DIRS } from '../world/build';
import type { World } from '../world/world';
import type { AssignmentTable, DestLink } from './assignment';
import {
  edgeNeighbors,
  keyTx,
  keyTy,
  roadDistancesFrom,
  roadTileCapacity,
  tileKey,
  type JunctionLookup,
  type RoadField,
} from './roadGraph';
import {
  COMMUTE_RANGE_BY_TIER,
  CONGESTION_ALPHA,
  CONGESTION_DECAY,
  CONGESTION_ESTIMATE_BIAS,
  ESTIMATE_CAPACITY,
  SHOP_RANGE_BY_TIER,
  VEHICLES_PER_TILE,
} from './simConstants';

/**
 * 혼잡 추정에 쓰는 거리장의 상한.
 *
 * 예전에는 ROAD_FIELD_MAX_DIST(200) 로 도시 전체를 훑었다. 그런데 여기서 쓰는
 * 링크는 배정표가 이미 통근·쇼핑 반경 안에서만 만든 것이라, 그보다 먼 거리는
 * 계산해도 아무도 안 읽는다. 도시가 커질수록 이 낭비가 그대로 정지 시간이 된다.
 */
const ROUTE_MAX_DIST = Math.max(...COMMUTE_RANGE_BY_TIER, ...SHOP_RANGE_BY_TIER);

/** 거리장 캐시 상한(개). 넘으면 가장 오래된 것부터 버린다. */
const DISTANCE_CACHE_MAX = 256;

interface CChunk {
  value: Uint8Array;
  observed: Uint8Array;
  estimate: Uint8Array;
}

export class CongestionMap {
  private chunks = new Map<string, CChunk>();
  private samples = new Map<string, number>();
  private sampleFrames = 0;
  private routeCache = new Map<string, number>();
  private activeCx = 0;
  private activeCy = 0;
  private activeRadius = 1;
  /** 넓은 도로의 직선 구간을 교차로로 오인하지 않기 위한 색인. */
  private junctions: JunctionLookup | null = null;

  setJunctions(index: JunctionLookup): void {
    this.junctions = index;
  }

  at(tx: number, ty: number): number {
    const c = this.chunks.get(chunkKey(chunkIndexOf(tx), chunkIndexOf(ty)));
    return c ? c.value[idx(tx, ty)] / 255 : 0;
  }

  capacityAt(world: World, tx: number, ty: number): number {
    let cap = roadTileCapacity(world, tx, ty, this.junctions);
    if (cap <= 0) return 0;
    const h = world.sampleHeight(tx, ty);
    for (const [dx, dy] of DIRS) {
      if (
        world.getBuild(tx + dx, ty + dy) === Build.Road &&
        world.sampleHeight(tx + dx, ty + dy) !== h
      ) {
        cap *= 0.8;
        break;
      }
    }
    return cap;
  }

  setActiveRegion(cx: number, cy: number, radius: number): void {
    this.activeCx = cx;
    this.activeCy = cy;
    this.activeRadius = radius;
  }

  sample(tx: number, ty: number): void {
    const key = `${tx},${ty}`;
    this.samples.set(key, (this.samples.get(key) ?? 0) + 1);
  }

  /** 한 렌더 프레임의 밀도 표본이 끝났음을 기록한다. */
  finishSampleFrame(): void {
    this.sampleFrames++;
  }

  commitSamples(world: World): void {
    const frames = Math.max(1, this.sampleFrames);
    for (const p of world.developedParcels()) {
      if (
        Math.abs(p.cx - this.activeCx) > this.activeRadius ||
        Math.abs(p.cy - this.activeCy) > this.activeRadius ||
        !p.build
      )
        continue;
      const bx = p.cx * CHUNK_SIZE;
      const by = p.cy * CHUNK_SIZE;
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          if (p.build[ly * CHUNK_SIZE + lx] !== Build.Road) continue;
          const tx = bx + lx;
          const ty = by + ly;
          const cap = this.capacityAt(world, tx, ty);
          if (cap <= 0) continue;
          const count = this.samples.get(`${tx},${ty}`) ?? 0;
          const measured = Math.min(1, count / frames / (cap * VEHICLES_PER_TILE));
          const c = this.ensure(tx, ty);
          const i = idx(tx, ty);
          const old = c.value[i] / 255;
          c.value[i] = u8(old * (1 - CONGESTION_ALPHA) + measured * CONGESTION_ALPHA);
          c.observed[i] = 1;
        }
      }
    }
    this.samples.clear();
    this.sampleFrames = 0;
  }

  decayOutside(_world: World, activeCx: number, activeCy: number, radius: number): void {
    for (const [key, c] of this.chunks) {
      const [cx, cy] = key.split(',').map(Number);
      if (Math.abs(cx - activeCx) <= radius && Math.abs(cy - activeCy) <= radius) continue;
      for (let i = 0; i < CHUNK_TILES; i++) {
        if (!c.observed[i]) continue;
        const cur = c.value[i] / 255;
        const estimate = c.estimate[i] / 255;
        c.value[i] = u8(cur + (estimate - cur) * CONGESTION_DECAY);
      }
    }
  }

  /** 오프라인 캐치업처럼 실측 차량이 없는 구간에서는 전 도시가 추정치로 수렴한다. */
  decayAll(): void {
    for (const c of this.chunks.values()) {
      for (let i = 0; i < CHUNK_TILES; i++) {
        if (!c.observed[i]) continue;
        const cur = c.value[i] / 255;
        const estimate = c.estimate[i] / 255;
        c.value[i] = u8(cur + (estimate - cur) * CONGESTION_DECAY);
      }
    }
  }

  rebuildEstimate(world: World, _field: RoadField, table: AssignmentTable): void {
    // 도로/직장이 바뀐 뒤 예전 추정치가 유령 혼잡으로 남지 않게 먼저 비운다.
    for (const chunk of this.chunks.values()) chunk.estimate.fill(0);
    const flow = new Map<number, number>();
    const distanceCache = new Map<number, Map<number, number>>();
    const linkInfo: Array<{
      fromTx: number;
      fromTy: number;
      link: DestLink;
      start: [number, number];
      goal: [number, number];
      distances: Map<number, number>;
    }> = [];
    this.routeCache.clear();

    for (const { fromTx, fromTy, link } of table.allLinks()) {
      const start = entry(world, fromTx, fromTy, world.buildingCovering(fromTx, fromTy)?.span ?? 1);
      const goal = entry(world, link.tx, link.ty, link.level);
      if (!start || !goal) continue;
      const goalKey = tileKey(goal[0], goal[1]);
      let distances = distanceCache.get(goalKey);
      if (!distances) {
        distances = roadDistancesFrom(world, goal[0], goal[1], ROUTE_MAX_DIST);
        // 도시 전체를 담아두면 거리장 수백 개가 메모리에 남는다. 링크는 집
        // 순서로 들어오고 이웃한 집들은 같은 직장을 보므로, 최근 것 몇 개만
        // 들고 있어도 재사용률이 높다.
        if (distanceCache.size >= DISTANCE_CACHE_MAX) {
          const oldest = distanceCache.keys().next();
          if (!oldest.done) distanceCache.delete(oldest.value);
        }
        distanceCache.set(goalKey, distances);
      }
      if (!distances.has(tileKey(start[0], start[1]))) continue;
      accumulateSplitFlow(start, link.count, distances, flow);
      linkInfo.push({ fromTx, fromTy, link, start, goal, distances });
    }

    for (const [key, count] of flow) {
      const tx = keyTx(key);
      const ty = keyTy(key);
      const cap = this.capacityAt(world, tx, ty);
      if (cap <= 0) continue;
      const c = this.ensure(tx, ty);
      const i = idx(tx, ty);
      const estimate = Math.min(1, count / (cap * ESTIMATE_CAPACITY)) * CONGESTION_ESTIMATE_BIAS;
      c.estimate[i] = u8(estimate);
      if (!c.observed[i]) c.value[i] = c.estimate[i];
    }

    const weights = new Map<string, number>();
    for (const info of linkInfo) {
      const path = pathFromField(info.start, info.goal, info.distances);
      if (path.length === 0) continue;
      let sum = 0;
      for (const [x, y] of path) sum += this.at(x, y);
      const average = sum / path.length;
      for (const key of [`${info.fromTx},${info.fromTy}`, `${info.link.tx},${info.link.ty}`]) {
        this.routeCache.set(key, (this.routeCache.get(key) ?? 0) + average * info.link.count);
        weights.set(key, (weights.get(key) ?? 0) + info.link.count);
      }
    }
    for (const [key, weight] of weights) {
      if (weight > 0) this.routeCache.set(key, (this.routeCache.get(key) ?? 0) / weight);
    }
  }

  routeCongestionFor(anchorTx: number, anchorTy: number): number {
    return Math.max(0, Math.min(1, this.routeCache.get(`${anchorTx},${anchorTy}`) ?? 0));
  }

  average(): number {
    let sum = 0;
    let count = 0;
    for (const c of this.chunks.values()) {
      for (let i = 0; i < c.value.length; i++) {
        if (!c.observed[i] && c.estimate[i] === 0) continue;
        sum += c.value[i] / 255;
        count++;
      }
    }
    return count > 0 ? sum / count : 0;
  }

  private ensure(tx: number, ty: number): CChunk {
    const key = chunkKey(chunkIndexOf(tx), chunkIndexOf(ty));
    let c = this.chunks.get(key);
    if (!c) {
      c = {
        value: new Uint8Array(CHUNK_TILES),
        observed: new Uint8Array(CHUNK_TILES),
        estimate: new Uint8Array(CHUNK_TILES),
      };
      this.chunks.set(key, c);
    }
    return c;
  }
}

function idx(tx: number, ty: number): number {
  return localIndexOf(ty) * CHUNK_SIZE + localIndexOf(tx);
}
function u8(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}
function entry(world: World, tx: number, ty: number, span: number): [number, number] | null {
  for (const point of edgeNeighbors(tx, ty, span)) {
    if (world.getBuild(point[0], point[1]) === Build.Road) return point;
  }
  return null;
}
function pathFromField(
  start: [number, number],
  goal: [number, number],
  distances: Map<number, number>,
): [number, number][] {
  let x = start[0];
  let y = start[1];
  const out: [number, number][] = [[x, y]];
  let d = distances.get(tileKey(x, y));
  if (d === undefined) return [];
  while (d > 0) {
    let found = false;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (distances.get(tileKey(nx, ny)) !== d - 1) continue;
      x = nx;
      y = ny;
      d--;
      out.push([x, y]);
      found = true;
      break;
    }
    if (!found) return [];
  }
  return x === goal[0] && y === goal[1] ? out : [];
}
function accumulateSplitFlow(
  start: [number, number],
  count: number,
  distances: Map<number, number>,
  flow: Map<number, number>,
): void {
  const startKey = tileKey(start[0], start[1]);
  if (!distances.has(startKey)) return;
  let layer = new Map<number, number>([[startKey, count]]);
  while (layer.size > 0) {
    const next = new Map<number, number>();
    for (const [key, amount] of layer) {
      const x = keyTx(key);
      const y = keyTy(key);
      const d = distances.get(key)!;
      flow.set(key, (flow.get(key) ?? 0) + amount);
      if (d === 0) continue;
      const down: number[] = [];
      for (const [dx, dy] of DIRS) {
        const nextKey = tileKey(x + dx, y + dy);
        if (distances.get(nextKey) === d - 1) down.push(nextKey);
      }
      if (down.length === 0) continue;
      const share = amount / down.length;
      for (const nextKey of down) next.set(nextKey, (next.get(nextKey) ?? 0) + share);
    }
    layer = next;
  }
}
