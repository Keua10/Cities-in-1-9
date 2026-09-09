import { CHUNK_SIZE } from '../core/constants';
import type { World } from '../world/world';
import { DIRS } from '../world/build';
import {
  capacityOf,
  facilityKindOfCode,
  isAnchor,
  isFacilityAnchor,
  levelOfCode,
  zoneOfCode,
} from './buildings';
import {
  DISCHARGE_RADIUS,
  FAC_RIVER_PUMP,
  PIPE_SEWER,
  PIPE_UPKEEP,
  PIPE_WATER,
  WATER_SPECS,
} from './config/water';
import { FACILITY_SPECS, touchesRoadTiles, touchesWater } from './facilities';
import { edgeNeighbors } from './roadGraph';

const key = (x: number, y: number) => `${x},${y}`;
interface PipeNode {
  x: number;
  y: number;
  mask: number;
  water: number;
  sewer: number;
}
interface Network {
  capacity: number;
  load: number;
  pollution: number;
}
interface Consumer {
  x: number;
  y: number;
  span: number;
  demand: number;
  water: number;
  sewer: number;
}
interface Plant {
  x: number;
  y: number;
  kind: number;
  networks: number[];
  active: boolean;
}
export interface WaterStatus {
  supply: number;
  drainage: number;
  contamination: number;
}
const EMPTY: WaterStatus = { supply: 0, drainage: 0, contamination: 0 };

/** 배관 연결과 건물 정원만으로 재구성한다. 입주율 감소로 수요까지 줄어드는 순환을 피한다. */
export class WaterField {
  revision = -1;
  readonly nodes = new Map<string, PipeNode>();
  private water: Network[] = [];
  private sewer: Network[] = [];
  private consumers = new Map<string, Consumer>();
  private plants: Plant[] = [];
  summary = {
    supply: 0,
    drainage: 0,
    contaminatedBuildings: 0,
    demand: 0,
    waterCapacity: 0,
    sewerCapacity: 0,
    pipeCount: 0,
  };

  ensure(world: World): void {
    if (this.revision === world.utilityRevision) return;
    this.rebuild(world);
  }

  rebuild(world: World): void {
    this.nodes.clear();
    this.consumers.clear();
    this.plants = [];
    const parcels = world.pipeParcels().sort((a, b) => a.cy - b.cy || a.cx - b.cx);
    let pipeCount = 0;
    for (const p of parcels)
      for (let i = 0; i < p.pipes!.length; i++) {
        const mask = p.pipes![i];
        if (mask < 1 || mask > 3) continue;
        const x = p.cx * CHUNK_SIZE + (i % CHUNK_SIZE),
          y = p.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
        this.nodes.set(key(x, y), { x, y, mask, water: -1, sewer: -1 });
        pipeCount += mask === 3 ? 2 : 1;
      }
    this.water = this.flood(PIPE_WATER, 'water');
    this.sewer = this.flood(PIPE_SEWER, 'sewer');
    for (const p of world.developedParcels().sort((a, b) => a.cy - b.cy || a.cx - b.cx)) {
      if (!p.bld) continue;
      for (let i = 0; i < p.bld.length; i++) {
        const code = p.bld[i];
        const x = p.cx * CHUNK_SIZE + (i % CHUNK_SIZE),
          y = p.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
        if (isAnchor(code)) {
          const span = levelOfCode(code);
          this.consumers.set(key(x, y), {
            x,
            y,
            span,
            demand: capacityOf(zoneOfCode(code), span),
            water: -1,
            sewer: -1,
          });
        } else if (isFacilityAnchor(code)) {
          const kind = facilityKindOfCode(code),
            spec = WATER_SPECS[kind];
          if (!spec) continue;
          const span = FACILITY_SPECS[kind].span;
          const networks = this.touching(x, y, span, spec.pipe === PIPE_WATER ? 'water' : 'sewer');
          const active =
            touchesRoadTiles(world, x, y, span) &&
            (!spec.needsWater || touchesWater(world, x, y, span)) &&
            networks.length > 0;
          this.plants.push({ x, y, kind, networks, active });
          if (!active) continue;
          // 여러 독립 관망에 닿으면 용량을 나눠 연결한다. 용량을 중복 지급하지 않는다.
          const groups = spec.pipe === PIPE_WATER ? this.water : this.sewer;
          for (const id of networks) groups[id].capacity += spec.capacity / networks.length;
        }
      }
    }
    let demand = 0;
    for (const c of this.consumers.values()) {
      for (const type of ['water', 'sewer'] as const) {
        const groups = type === 'water' ? this.water : this.sewer;
        const ids = this.touching(c.x, c.y, c.span, type);
        ids.sort((a, b) => groups[b].capacity - groups[a].capacity || a - b);
        c[type] = ids[0] ?? -1;
        if (c[type] >= 0) groups[c[type]].load += c.demand;
      }
      demand += c.demand;
    }
    // 같은 지하 레벨: 겹치거나 4방향으로 맞닿은 상·하수도는 즉시 혼합된다.
    for (const node of this.nodes.values()) {
      if (node.water < 0) continue;
      if (
        node.mask & PIPE_SEWER ||
        DIRS.some(
          ([dx, dy]) => (this.nodes.get(key(node.x + dx, node.y + dy))?.mask ?? 0) & PIPE_SEWER,
        )
      ) {
        this.water[node.water].pollution = 1;
      }
    }
    for (const pump of this.plants) {
      if (!pump.active || pump.kind !== FAC_RIVER_PUMP) continue;
      let pollution = 0;
      for (const outlet of this.plants) {
        const spec = WATER_SPECS[outlet.kind];
        if (
          !outlet.active ||
          spec.pipe !== PIPE_SEWER ||
          !outlet.networks.some((id) => this.sewer[id].load > 0)
        )
          continue;
        const distance = Math.hypot(pump.x - outlet.x, pump.y - outlet.y);
        pollution += spec.pollution * Math.max(0, 1 - distance / DISCHARGE_RADIUS);
      }
      for (const id of pump.networks) {
        const contribution = WATER_SPECS[pump.kind].capacity / pump.networks.length;
        this.water[id].pollution = Math.min(
          1,
          this.water[id].pollution +
            (Math.min(1, pollution) * contribution) / this.water[id].capacity,
        );
      }
    }
    let supplied = 0,
      drained = 0,
      contaminatedBuildings = 0;
    for (const c of this.consumers.values()) {
      const s = this.statusAt(c.x, c.y);
      supplied += c.demand * s.supply;
      drained += c.demand * s.drainage;
      if (s.contamination > 0 && s.supply > 0) contaminatedBuildings++;
    }
    this.summary = {
      supply: demand ? supplied / demand : 0,
      drainage: demand ? drained / demand : 0,
      contaminatedBuildings,
      demand,
      waterCapacity: this.water.reduce((sum, n) => sum + n.capacity, 0),
      sewerCapacity: this.sewer.reduce((sum, n) => sum + n.capacity, 0),
      pipeCount,
    };
    this.revision = world.utilityRevision;
  }

  private flood(mask: number, type: 'water' | 'sewer'): Network[] {
    const groups: Network[] = [];
    for (const node of this.nodes.values()) {
      if (!(node.mask & mask) || node[type] >= 0) continue;
      const id = groups.length;
      groups.push({ capacity: 0, load: 0, pollution: 0 });
      node[type] = id;
      const queue = [node];
      for (let head = 0; head < queue.length; head++) {
        const current = queue[head];
        for (const [dx, dy] of DIRS) {
          const next = this.nodes.get(key(current.x + dx, current.y + dy));
          if (!next || !(next.mask & mask) || next[type] >= 0) continue;
          next[type] = id;
          queue.push(next);
        }
      }
    }
    return groups;
  }

  private touching(x: number, y: number, span: number, type: 'water' | 'sewer'): number[] {
    const ids = new Set<number>();
    const add = (tx: number, ty: number) => {
      const id = this.nodes.get(key(tx, ty))?.[type] ?? -1;
      if (id >= 0) ids.add(id);
    };
    for (let dy = 0; dy < span; dy++) for (let dx = 0; dx < span; dx++) add(x + dx, y + dy);
    for (const [tx, ty] of edgeNeighbors(x, y, span)) add(tx, ty);
    return [...ids].sort((a, b) => a - b);
  }

  statusAt(tx: number, ty: number): WaterStatus {
    const c = this.consumers.get(key(tx, ty));
    if (!c) return EMPTY;
    const w = this.water[c.water],
      s = this.sewer[c.sewer];
    return {
      supply: w ? Math.min(1, w.capacity / Math.max(1, w.load)) : 0,
      drainage: s ? Math.min(1, s.capacity / Math.max(1, s.load)) : 0,
      contamination: w?.pollution ?? 0,
    };
  }

  contaminationAt(tx: number, ty: number): number {
    const s = this.statusAt(tx, ty);
    return s.contamination * s.supply;
  }

  pipePollution(tx: number, ty: number): number {
    const node = this.nodes.get(key(tx, ty));
    return node ? (this.water[node.water]?.pollution ?? 0) : 0;
  }

  facilityStatus(tx: number, ty: number): string {
    const plant = this.plants.find((p) => p.x === tx && p.y === ty);
    if (!plant || !plant.active) return '가동 중지: 도로·해당 배관·하천 연결 확인';
    const spec = WATER_SPECS[plant.kind];
    const groups = spec.pipe === PIPE_WATER ? this.water : this.sewer;
    const load = plant.networks.reduce((sum, id) => sum + groups[id].load, 0);
    const capacity = plant.networks.reduce((sum, id) => sum + groups[id].capacity, 0);
    return `가동 · 연결망 수요 ${Math.round(load).toLocaleString('ko-KR')} / 용량 ${Math.round(capacity).toLocaleString('ko-KR')}${load > capacity ? ' · 용량 부족' : ''}`;
  }

  get upkeep(): number {
    return this.summary.pipeCount * PIPE_UPKEEP;
  }
}
