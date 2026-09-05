import { CHUNK_SIZE, CHUNK_TILES } from '../core/constants';
import { chunkIndexOf, chunkKey, localIndexOf } from '../core/iso';
import { Build, DIRS } from '../world/build';
import type { World } from '../world/world';
import type { AssignmentTable, DestLink } from './assignment';
import { edgeNeighbors, roadTileCapacity, type RoadField } from './roadGraph';
import {
  CONGESTION_ALPHA,
  CONGESTION_DECAY,
  CONGESTION_ESTIMATE_BIAS,
  ESTIMATE_CAPACITY,
  ROAD_FIELD_MAX_DIST,
  VEHICLES_PER_TILE,
} from './simConstants';

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

  at(tx: number, ty: number): number {
    const c = this.chunks.get(chunkKey(chunkIndexOf(tx), chunkIndexOf(ty)));
    return c ? c.value[idx(tx, ty)] / 255 : 0;
  }

  capacityAt(world: World, tx: number, ty: number): number {
    let cap = roadTileCapacity(world, tx, ty);
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
      ) continue;
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
          const measured = Math.min(1, (count / frames) / (cap * VEHICLES_PER_TILE));
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

  decayOutside(
    _world: World,
    activeCx: number,
    activeCy: number,
    radius: number,
  ): void {
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
    const flow = new Map<string, number>();
    const distanceCache = new Map<string, Map<string, number>>();
    const linkInfo: Array<{
      fromTx: number;
      fromTy: number;
      link: DestLink;
      start: [number, number];
      goal: [number, number];
      distances: Map<string, number>;
    }> = [];
    this.routeCache.clear();

    for (const { fromTx, fromTy, link } of table.allLinks()) {
      const start = entry(
        world,
        fromTx,
        fromTy,
        world.buildingCovering(fromTx, fromTy)?.span ?? 1,
      );
      const goal = entry(world, link.tx, link.ty, link.level);
      if (!start || !goal) continue;
      const goalKey = `${goal[0]},${goal[1]}`;
      let distances = distanceCache.get(goalKey);
      if (!distances) {
        distances = distanceField(world, goal[0], goal[1], ROAD_FIELD_MAX_DIST);
        distanceCache.set(goalKey, distances);
      }
      if (!distances.has(`${start[0]},${start[1]}`)) continue;
      accumulateSplitFlow(start, link.count, distances, flow);
      linkInfo.push({ fromTx, fromTy, link, start, goal, distances });
    }

    for (const [key, count] of flow) {
      const [tx, ty] = key.split(',').map(Number);
      const cap = this.capacityAt(world, tx, ty);
      if (cap <= 0) continue;
      const c = this.ensure(tx, ty);
      const i = idx(tx, ty);
      const estimate =
        Math.min(1, count / (cap * ESTIMATE_CAPACITY)) * CONGESTION_ESTIMATE_BIAS;
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
function distanceField(
  world: World,
  gx: number,
  gy: number,
  maxDist: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (world.getBuild(gx, gy) !== Build.Road) return out;
  const qx = [gx];
  const qy = [gy];
  const qd = [0];
  let head = 0;
  out.set(`${gx},${gy}`, 0);
  while (head < qx.length) {
    const x = qx[head];
    const y = qy[head];
    const d = qd[head++];
    if (d >= maxDist) continue;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      const key = `${nx},${ny}`;
      if (out.has(key) || world.getBuild(nx, ny) !== Build.Road) continue;
      out.set(key, d + 1);
      qx.push(nx);
      qy.push(ny);
      qd.push(d + 1);
    }
  }
  return out;
}
function pathFromField(
  start: [number, number],
  goal: [number, number],
  distances: Map<string, number>,
): [number, number][] {
  let x = start[0];
  let y = start[1];
  const out: [number, number][] = [[x, y]];
  let d = distances.get(`${x},${y}`);
  if (d === undefined) return [];
  while (d > 0) {
    let found = false;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (distances.get(`${nx},${ny}`) !== d - 1) continue;
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
  distances: Map<string, number>,
  flow: Map<string, number>,
): void {
  const startKey = `${start[0]},${start[1]}`;
  if (!distances.has(startKey)) return;
  let layer = new Map<string, number>([[startKey, count]]);
  while (layer.size > 0) {
    const next = new Map<string, number>();
    for (const [key, amount] of layer) {
      const [x, y] = key.split(',').map(Number);
      const d = distances.get(key)!;
      flow.set(key, (flow.get(key) ?? 0) + amount);
      if (d === 0) continue;
      const down: string[] = [];
      for (const [dx, dy] of DIRS) {
        const nextKey = `${x + dx},${y + dy}`;
        if (distances.get(nextKey) === d - 1) down.push(nextKey);
      }
      if (down.length === 0) continue;
      const share = amount / down.length;
      for (const nextKey of down) next.set(nextKey, (next.get(nextKey) ?? 0) + share);
    }
    layer = next;
  }
}
