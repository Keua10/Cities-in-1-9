import type { World } from '../../world/world';
import type { Junction } from './junctions';
import type { Vehicle } from './vehicles';
import {
  SIGNAL_GREEN_MS,
  SIGNAL_ALL_RED_MS,
  SIGNAL_YELLOW_MS,
  VEHICLE_SPEED_TILES_PER_SEC,
} from '../simConstants';

const PERIOD = 2 * (SIGNAL_GREEN_MS + SIGNAL_YELLOW_MS + SIGNAL_ALL_RED_MS);
export const AUTO_SIGNAL_SPACING = 14;
const mod = (n: number) => ((n % PERIOD) + PERIOD) % PERIOD;

export function configureSignals(world: World, junctions: Junction[]): void {
  const chosen: Junction[] = [];
  const candidates: Junction[] = [];
  for (const j of junctions) {
    let manual: boolean | undefined;
    for (let i = 0; i < j.cells.length; i += 2) {
      const value = world.signalOverrides[`${j.cells[i]},${j.cells[i + 1]}`];
      if (value === false) {
        manual = false;
        break;
      }
      if (value === true) manual = true;
    }
    const eligible =
      j.signalized && (j.maxLegWidth >= 2 || j.legs.filter((l) => l.length >= 10).length >= 3);
    j.signalized = manual === true;
    if (manual === true) chosen.push(j);
    else if (manual !== false && eligible) candidates.push(j);
    // Sequential progression along the tx corridor, never a random per-junction phase.
    j.offsetMs = mod((-j.minX * 1000) / VEHICLE_SPEED_TILES_PER_SEC);
    j.green0Ms = SIGNAL_GREEN_MS;
  }
  candidates.sort(
    (a, b) =>
      b.maxLegWidth - a.maxLegWidth ||
      b.legs.length - a.legs.length ||
      a.minY - b.minY ||
      a.minX - b.minX,
  );
  for (const j of candidates) {
    if (
      chosen.some(
        (c) => Math.abs(c.minX - j.minX) + Math.abs(c.minY - j.minY) < AUTO_SIGNAL_SPACING,
      )
    )
      continue;
    j.signalized = true;
    chosen.push(j);
  }
}

/** Bounded adaptation. Observe for a minute; alter plans only at the end of an all-red interval. */
export class SignalCoordinator {
  private lastSample = 0;
  private lastObservation = -1000;
  private observed = [0, 0, 0, 0];
  private localObserved = new Map<string, [number, number]>();
  private observations = 0;
  private direction = 0;
  private targetDirection = 0;
  private demand = [0, 0, 0, 0];
  private targets = new Map<string, number>();
  private previous = new Map<Junction, number>();
  private adjusted = new Map<Junction, number>();

  update(junctions: readonly Junction[], vehicles: readonly Vehicle[], time: number): void {
    if (time - this.lastObservation >= 1000) {
      this.lastObservation = time;
      this.observations++;
      for (const v of vehicles) this.observed[v.dir & 3] += v.speed < 0.5 ? 2 : 1;
      for (const j of junctions) {
        if (!j.signalized) continue;
        const key = `${j.minX},${j.minY}`;
        const counts = this.localObserved.get(key) ?? [0, 0];
        for (const v of vehicles) {
          const at = v.routeIdx * 2;
          if (Math.abs(v.route.tiles[at] - j.minX) + Math.abs(v.route.tiles[at + 1] - j.minY) > 8)
            continue;
          counts[v.dir & 1] += v.speed < 0.5 ? 2 : 1;
        }
        this.localObserved.set(key, counts);
      }
    }
    if (time - this.lastSample >= 60_000) {
      this.lastSample = time;
      const counts = this.observed.map((n) => n / Math.max(1, this.observations));
      this.demand = this.demand.map((n, i) => n * 0.6 + counts[i] * 0.4);
      const best = this.demand.indexOf(Math.max(...this.demand));
      if (this.demand[best] > this.demand[this.direction] * 1.5 + 5) this.targetDirection = best;
      this.targets.clear();
      for (const j of junctions) {
        const key = `${j.minX},${j.minY}`;
        const [x, y] = (this.localObserved.get(key) ?? [0, 0]).map(
          (n) => n / Math.max(1, this.observations),
        );
        this.targets.set(
          key,
          x + y > 3 ? Math.max(4500, Math.min(9500, (14000 * (x + 2)) / (x + y + 4))) : 7000,
        );
      }
      this.observed = [0, 0, 0, 0];
      this.observations = 0;
      this.localObserved.clear();
      this.direction = this.targetDirection;
    }
    const alive = new Set(junctions);
    for (const j of this.previous.keys()) if (!alive.has(j)) this.previous.delete(j);
    for (const j of this.adjusted.keys()) if (!alive.has(j)) this.adjusted.delete(j);
    for (const j of junctions) {
      if (!j.signalized) continue;
      const t = mod(time + j.offsetMs);
      const last = this.previous.get(j);
      if (
        last !== undefined &&
        t < last &&
        t < 500 &&
        time - (this.adjusted.get(j) ?? -Infinity) >= PERIOD - 500
      ) {
        this.adjusted.set(j, time);
        const coordinate = this.direction & 1 ? j.minY : j.minX;
        const sign = this.direction < 2 ? 1 : -1;
        const targetOffset = mod((-sign * coordinate * 1000) / VEHICLE_SPEED_TILES_PER_SEC);
        const diff = mod(targetOffset - j.offsetMs + PERIOD / 2) - PERIOD / 2;
        // < all-red duration: never jump across another axis' live green/yellow.
        j.offsetMs = mod(j.offsetMs + Math.max(-200, Math.min(200, diff)));
        const target = this.targets.get(`${j.minX},${j.minY}`) ?? 7000;
        j.green0Ms =
          (j.green0Ms ?? 7000) + Math.max(-500, Math.min(500, target - (j.green0Ms ?? 7000)));
      }
      this.previous.set(j, mod(time + j.offsetMs));
    }
  }
}
