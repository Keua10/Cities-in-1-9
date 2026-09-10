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
import { FACILITY_SPECS, touchesRoadTiles } from './facilities';
import { facilityPowerDemand, POWER_REACH, POWER_SPECS, WIRE_UPKEEP } from './config/power';
import { rangeOffsets, utilityKey as key } from './utilityRange';

interface Entity {
  x: number;
  y: number;
  span: number;
  wire: boolean;
  demand: number;
  capacity: number;
  root: number;
}
interface Grid {
  capacity: number;
  demand: number;
}
const offsets = rangeOffsets(POWER_REACH);
export class PowerField {
  revision = -1;
  readonly coverage = new Map<string, number>();
  readonly wires = new Map<string, { x: number; y: number; supply: number }>();
  /** Actual relay links, also used by the installation overlay. */
  readonly links: Array<{ ax: number; ay: number; bx: number; by: number; supply: number }> = [];
  private entities: Entity[] = [];
  private buildings = new Map<string, number>();
  private grids = new Map<number, Grid>();
  summary = { capacity: 0, demand: 0, supply: 0, unpoweredBuildings: 0, wireCount: 0 };

  ensure(world: World): void {
    if (this.revision !== world.utilityRevision) this.rebuild(world);
  }

  rebuild(world: World): void {
    this.entities = [];
    this.buildings.clear();
    this.grids.clear();
    this.coverage.clear();
    this.wires.clear();
    this.links.length = 0;
    const tiles = new Map<string, number[]>();
    const add = (e: Omit<Entity, 'root'>) => {
      const id = this.entities.length;
      this.entities.push({ ...e, root: id });
      if (!e.wire) this.buildings.set(key(e.x, e.y), id);
      for (let dy = 0; dy < e.span; dy++)
        for (let dx = 0; dx < e.span; dx++) {
          const k = key(e.x + dx, e.y + dy);
          const ids = tiles.get(k) ?? [];
          ids.push(id);
          tiles.set(k, ids);
        }
    };
    for (const p of world.wireParcels())
      for (let i = 0; i < p.wires!.length; i++) {
        if (p.wires![i] === 1)
          add({
            x: p.cx * CHUNK_SIZE + (i % CHUNK_SIZE),
            y: p.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE),
            span: 1,
            wire: true,
            demand: 0,
            capacity: 0,
          });
      }
    for (const p of world.developedParcels()) {
      if (!p.bld) continue;
      for (let i = 0; i < p.bld.length; i++) {
        const code = p.bld[i],
          x = p.cx * CHUNK_SIZE + (i % CHUNK_SIZE),
          y = p.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
        if (isAnchor(code)) {
          const span = levelOfCode(code);
          add({ x, y, span, wire: false, demand: capacityOf(zoneOfCode(code), span), capacity: 0 });
        } else if (isFacilityAnchor(code)) {
          const kind = facilityKindOfCode(code);
          if (kind === 4 || kind === 5) continue;
          const span = FACILITY_SPECS[kind].span;
          add({
            x,
            y,
            span,
            wire: false,
            demand: facilityPowerDemand(kind),
            capacity: touchesRoadTiles(world, x, y, span) ? (POWER_SPECS[kind]?.capacity ?? 0) : 0,
          });
        }
      }
    }
    const find = (id: number): number => {
      let root = id;
      while (this.entities[root].root !== root) root = this.entities[root].root;
      while (id !== root) {
        const next = this.entities[id].root;
        this.entities[id].root = root;
        id = next;
      }
      return root;
    };
    const link = (a: number, b: number, ax: number, ay: number, bx: number, by: number) => {
      const ar = find(a),
        br = find(b);
      if (ar === br) return;
      this.entities[br].root = ar;
      if (!this.entities[a].wire || !this.entities[b].wire)
        this.links.push({ ax, ay, bx, by, supply: a });
    };
    // Wires must be continuous. Buildings bridge small gaps using the same radius as coverage.
    for (let id = 0; id < this.entities.length; id++) {
      const e = this.entities[id];
      const reach = e.wire ? [[0, 0], ...DIRS] : offsets;
      for (let dy = 0; dy < e.span; dy++)
        for (let dx = 0; dx < e.span; dx++)
          for (const [rx, ry] of reach) {
            const tx = e.x + dx + rx,
              ty = e.y + dy + ry;
            for (const other of tiles.get(key(tx, ty)) ?? []) {
              if (other === id) continue;
              link(id, other, e.x + dx, e.y + dy, tx, ty);
            }
          }
    }
    for (let id = 0; id < this.entities.length; id++) {
      const e = this.entities[id],
        root = find(id),
        g = this.grids.get(root) ?? { capacity: 0, demand: 0 };
      e.root = root;
      g.capacity += e.capacity;
      g.demand += e.demand;
      this.grids.set(root, g);
    }
    let demand = 0,
      supplied = 0,
      capacity = 0,
      unpoweredBuildings = 0;
    for (const g of this.grids.values()) {
      demand += g.demand;
      capacity += g.capacity;
      supplied += Math.min(g.capacity, g.demand);
    }
    for (const e of this.entities) {
      const supply = this.ratio(e.root);
      if (e.wire) this.wires.set(key(e.x, e.y), { x: e.x, y: e.y, supply });
      else if (e.demand > 0 && supply < 1) unpoweredBuildings++;
      // Unpowered islands never act as sources. Empty coverage tiles never relay power.
      if (supply <= 0) continue;
      for (let dy = 0; dy < e.span; dy++)
        for (let dx = 0; dx < e.span; dx++)
          for (const [rx, ry] of offsets) {
            const k = key(e.x + dx + rx, e.y + dy + ry);
            this.coverage.set(k, Math.max(supply, this.coverage.get(k) ?? 0));
          }
    }
    for (const l of this.links) l.supply = this.ratio(this.entities[l.supply].root);
    this.summary = {
      capacity,
      demand,
      supply: demand ? supplied / demand : 0,
      unpoweredBuildings,
      wireCount: this.wires.size,
    };
    this.revision = world.utilityRevision;
  }
  private ratio(root: number): number {
    const g = this.grids.get(root);
    return g ? Math.min(1, g.capacity / Math.max(1, g.demand)) : 0;
  }
  supplyAt(x: number, y: number): number {
    const id = this.buildings.get(key(x, y));
    return id === undefined ? 0 : this.ratio(this.entities[id].root);
  }
  get upkeep(): number {
    return this.wires.size * WIRE_UPKEEP;
  }
}
