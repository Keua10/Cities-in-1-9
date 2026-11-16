import type { MacroState } from '../net/types';
import type { World } from '../world/world';
import { Build } from '../world/build';
import { FACILITY_SPECS, canPlaceFacility } from './facilities';
import {
  CONSTRUCTION_FALLBACK_SECONDS,
  CONSTRUCTION_SECONDS,
  START_BOOST_BUILD,
} from './simConstants';
import { METRO_STATION_COST, type MetroNetwork } from './metro';

export interface ConstructionJob {
  tx: number;
  kind: number;
  ty: number;
  span: number;
  cost: number;
  /** 필요한 공사량(실제 ms). */
  workMs?: number;
  /** 지금까지 한 공사량(실제 ms). 스타트 버닝 중에는 10배로 쌓인다. */
  doneMs?: number;
  /** 예전 저장(생활 시계 기준). 불러올 때 workMs/doneMs 로 옮긴다. */
  started?: number;
  finishes?: number;
}

/** 시설 공사 기간(실제 초). 표는 config/pace.ts 에 있다. */
export function constructionSeconds(kind: number): number {
  return CONSTRUCTION_SECONDS[kind] ?? CONSTRUCTION_FALLBACK_SECONDS;
}

/** "40초", "2분 30초", "1시간 20분" */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return m ? `${h}시간 ${m}분` : `${h}시간`;
  if (m) return r ? `${m}분 ${r}초` : `${m}분`;
  return `${r}초`;
}

/**
 * 공사 중인 시설. 공사는 **실제 시계**로 진행되므로 접속하지 않아도 계속된다.
 * macro.constructionAt 에 마지막으로 공사를 진행시킨 실제 시각을 적어 두고,
 * 다음 update 때 그 사이 흐른 실제 시간만큼 모든 공사를 진행시킨다.
 */
export class ConstructionSystem {
  constructor(
    private world: World,
    private macro: MacroState,
    private metro: MetroNetwork,
    private changed: () => void,
  ) {}
  get jobs(): readonly ConstructionJob[] {
    const jobs = this.macro.construction ?? [];
    for (const j of jobs) migrateJob(j, this.macro.lifeElapsedMs ?? 0);
    return jobs;
  }
  /** 공사 진행률 0~1. */
  progress(job: ConstructionJob): number {
    migrateJob(job, this.macro.lifeElapsedMs ?? 0);
    return Math.min(1, job.doneMs! / Math.max(1, job.workMs!));
  }
  /** 완공까지 남은 실제 시간(ms). 버닝 중이면 그만큼 짧게 본다. */
  remainingMs(job: ConstructionJob): number {
    migrateJob(job, this.macro.lifeElapsedMs ?? 0);
    const left = Math.max(0, job.workMs! - job.doneMs!);
    const boost = Math.max(0, this.macro.startBoostMs ?? 0);
    // 버닝이 남은 동안은 10배, 그 뒤로는 1배로 진행한다.
    const boosted = Math.min(left, boost * START_BOOST_BUILD);
    return boosted / START_BOOST_BUILD + (left - boosted);
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
      workMs: constructionSeconds(kind) * 1000,
      doneMs: 0,
    };
    this.macro.money -= cost;
    (this.macro.construction ??= []).push(job);
    this.reserve(job, Build.Civic);
    this.changed();
    if (this.macro.constructionAt === undefined) this.macro.constructionAt = Date.now();
    return `${spec.name} 착공 · 약 ${formatDuration(this.remainingMs(job) / 1000)} 뒤 완공`;
  }
  cancel(tx: number, ty: number): boolean {
    const job = this.at(tx, ty);
    if (!job) return false;
    this.reserve(job, Build.None);
    this.macro.construction = this.jobs.filter((j) => j !== job);
    this.changed();
    return true;
  }
  /**
   * 실제 시각 now 까지 공사를 진행시킨다.
   * boostedMs: 이번 구간 중 스타트 버닝이 켜져 있던 실제 ms(그만큼 추가로 진행).
   */
  update(now = Date.now(), boostedMs = 0): void {
    const last = this.macro.constructionAt;
    this.macro.constructionAt = now;
    const jobs = this.jobs;
    if (!jobs.length) return;
    const dt = last === undefined ? 0 : Math.max(0, now - last);
    const extra = Math.min(dt, Math.max(0, boostedMs)) * (START_BOOST_BUILD - 1);
    for (const job of jobs) job.doneMs! += dt + extra;
    for (const job of [...jobs]) {
      if (job.doneMs! < job.workMs!) continue;
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

/** 예전 저장(생활 시계 started/finishes)을 실제 시간 공사량으로 옮긴다. */
function migrateJob(job: ConstructionJob, lifeElapsed: number): void {
  if (job.workMs !== undefined && job.doneMs !== undefined) return;
  const started = job.started ?? lifeElapsed;
  const finishes = job.finishes ?? started + constructionSeconds(job.kind) * 1000;
  job.workMs = Math.max(1, finishes - started);
  job.doneMs = Math.max(0, Math.min(job.workMs, lifeElapsed - started));
  delete job.started;
  delete job.finishes;
}
