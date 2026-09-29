import type { MacroState } from '../net/types';
import type { World } from '../world/world';
import { Build } from '../world/build';
import { FACILITY_SPECS, canPlaceFacility } from './facilities';
import { DAYTIME_DAY_MS } from './simConstants';
import { METRO_STATION_COST, type MetroNetwork } from './metro';
import { sessionDaytimeAt } from './time';

export interface ConstructionJob {
  tx: number;
  ty: number;
  kind: number;
  span: number;
  started: number;
  finishes: number;
  cost: number;
}
export function constructionMinutes(kind: number): number {
  const spec = FACILITY_SPECS[kind];
  return Math.min(1440 * 3, 120 + spec.span * spec.span * 90);
}
export function completionLabel(elapsed: number): string {
  const t = sessionDaytimeAt(elapsed, 0);
  return `${t.absoluteDay + 1}일 ${String(t.hourOfDay).padStart(2, '0')}:${String(t.minuteOfDay % 60).padStart(2, '0')}`;
}

/** Reserved civic ground has no building/service until the life-clock deadline. */
export class ConstructionSystem {
  constructor(
    private world: World,
    private macro: MacroState,
    private metro: MetroNetwork,
    private changed: () => void,
  ) {}
  get jobs(): readonly ConstructionJob[] {
    return this.macro.construction ?? [];
  }
  get elapsed(): number {
    return this.macro.lifeElapsedMs ?? 0;
  }
  at(tx: number, ty: number): ConstructionJob | undefined {
    return this.jobs.find(
      (j) => tx >= j.tx && ty >= j.ty && tx < j.tx + j.span && ty < j.ty + j.span,
    );
  }
  start(tx: number, ty: number, kind: number, cityLevel: number): string {
    const spec = FACILITY_SPECS[kind];
    if (!spec) return '없는 시설입니다';
    const check =
      kind === 26
        ? this.metro.canPlaceStation(tx, ty)
        : canPlaceFacility(this.world, tx, ty, kind, cityLevel);
    if (!check.ok) return check.reason;
    const cost = kind === 26 ? METRO_STATION_COST : spec.cost;
    if (this.macro.money < cost) return '돈이 모자랍니다';
    const job: ConstructionJob = {
      tx,
      ty,
      kind,
      span: spec.span,
      cost,
      started: this.elapsed,
      finishes: this.elapsed + (constructionMinutes(kind) / 1440) * DAYTIME_DAY_MS,
    };
    this.macro.money -= cost;
    (this.macro.construction ??= []).push(job);
    this.reserve(job, Build.Civic);
    this.changed();
    return `${spec.name} 착공 · 완공 예정 ${completionLabel(job.finishes)}`;
  }
  cancel(tx: number, ty: number): boolean {
    const job = this.at(tx, ty);
    if (!job) return false;
    this.reserve(job, Build.None);
    this.macro.construction = this.jobs.filter((j) => j !== job);
    this.changed();
    return true;
  }
  update(): void {
    for (const job of [...this.jobs]) {
      if (this.elapsed < job.finishes) continue;
      this.reserve(job, Build.None);
      if (job.kind === 26) {
        const result = this.metro.edit(job.tx, job.ty, 'station', true);
        if (!result.ok) {
          this.reserve(job, Build.Civic);
          continue;
        }
      } else this.world.placeFacility(job.tx, job.ty, job.kind, Math.floor(this.macro.tick / 24));
      this.macro.construction = this.jobs.filter((j) => j !== job);
      this.changed();
    }
  }
  private reserve(j: ConstructionJob, value: number): void {
    for (let y = 0; y < j.span; y++)
      for (let x = 0; x < j.span; x++) this.world.setBuild(j.tx + x, j.ty + y, value);
  }
}
