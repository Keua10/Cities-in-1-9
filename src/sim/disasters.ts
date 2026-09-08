import { CHUNK_SIZE, WORLD_SEED } from '../core/constants';
import type { World } from '../world/world';
import { isAnchor, levelOfCode, simRandom } from './buildings';
import type { ServiceField } from './services';
import {
  DISASTER_DURATION,
  DISASTER_MAX_ACTIVE,
  DISASTER_PENALTY,
  DISASTER_PREVENTION,
  DISASTER_RATE_PER_TICK,
  DISASTER_RECOVERY,
  DISASTER_SERVICE_RECOVERY,
  FIRE_SPREAD_CHANCE,
} from './simConstants';

/** 시설 kind 0/1/2 와 같은 순서. 기존 건물/시설 ID와 별개의 사건 종류. */
import type { DisasterKind, DisasterState, Incident } from './disasterTypes';
export type { DisasterKind, DisasterState, Incident } from './disasterTypes';
export const DISASTER_NAMES = ['화재', '범죄', '질병'] as const;
const DISASTER_KINDS = [0, 1, 2] as const;
type QualitySource = Pick<ServiceField, 'serviceQualityAt'>;
const keyOf = (tx: number, ty: number): string => `${tx},${ty}`;
const order = (a: Incident, b: Incident): number => a.ty - b.ty || a.tx - b.tx;
const counter = (v: unknown): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;

/** 오래된 저장본은 사건 없음. 외부 저장 데이터의 잘못된 값/중복도 여기서 거른다. */
export function normalizeDisasters(raw: unknown, tick: number): DisasterState {
  const out: DisasterState = {
    version: 1,
    active: [],
    started: [0, 0, 0],
    extinguished: 0,
    burned: 0,
  };
  if (!raw || typeof raw !== 'object') return out;
  const s = raw as Partial<DisasterState>;
  if (s.version !== 1) return out;
  out.started = [0, 1, 2].map((k) => counter(s.started?.[k]));
  out.extinguished = counter(s.extinguished);
  out.burned = counter(s.burned);
  const seen = new Set<string>();
  if (Array.isArray(s.active))
    for (const e of s.active) {
      if (
        !e ||
        ![0, 1, 2].includes(e.kind) ||
        ![e.tx, e.ty, e.code, e.born, e.startedTick].every(Number.isSafeInteger) ||
        e.code < 0 ||
        !isAnchor(e.code) ||
        e.born < 0 ||
        e.born > 65535 ||
        e.startedTick < 0 ||
        e.startedTick > tick
      )
        continue;
      const key = keyOf(e.tx, e.ty);
      if (seen.has(key)) continue;
      seen.add(key);
      out.active.push({
        kind: e.kind,
        tx: e.tx,
        ty: e.ty,
        code: e.code,
        born: e.born,
        startedTick: e.startedTick,
      });
      if (out.active.length >= DISASTER_MAX_ACTIVE) break;
    }
  out.active.sort(order);
  return out;
}

/**
 * 작은 활성 사건 목록만 저장한다. 타일별 난수/위험도 배열은 만들거나 저장하지 않는다.
 * 확산은 틱 시작의 화재 목록만 읽어 같은 틱 연쇄 발화와 청크 순서 의존을 막는다.
 */
export class DisasterSim {
  private state: DisasterState;
  private byTile = new Map<string, Incident>();

  constructor(saved?: unknown, tick = 0) {
    this.state = normalizeDisasters(saved, tick);
    this.reindex();
  }

  get active(): readonly Incident[] {
    return this.state.active;
  }
  get counts(): number[] {
    const counts = [0, 0, 0];
    for (const e of this.active) counts[e.kind]++;
    return counts;
  }
  get burned(): number {
    return this.state.burned;
  }
  get extinguished(): number {
    return this.state.extinguished;
  }
  snapshot(): DisasterState {
    return {
      ...this.state,
      active: this.active.map((e) => ({ ...e })),
      started: [...this.state.started],
    };
  }

  at(tx: number, ty: number, world: World): Incident | null {
    const b = world.buildingCovering(tx, ty);
    if (!b || b.kind !== null) return null;
    const e = this.byTile.get(keyOf(b.tx, b.ty));
    return e && e.code === world.getBld(b.tx, b.ty) && e.born === b.born ? e : null;
  }
  penaltyAt(tx: number, ty: number): number {
    const e = this.byTile.get(keyOf(tx, ty));
    return e ? DISASTER_PENALTY[e.kind] : 0;
  }
  blocksRebuild(tx: number, ty: number, span: number, world: World): boolean {
    for (let dy = 0; dy < span; dy++)
      for (let dx = 0; dx < span; dx++) {
        if (this.at(tx + dx, ty + dy, world)) return true;
      }
    return false;
  }

  /** 제거/재건축된 건물에 옛 사건이 붙어 있지 않도록 로드 직후와 매 틱 검사한다. */
  reconcile(world: World): boolean {
    if (
      this.active.every(
        (e) => world.getBld(e.tx, e.ty) === e.code && world.bornDayAt(e.tx, e.ty) === e.born,
      )
    )
      return false;
    const before = this.active.length;
    this.state.active = this.state.active.filter(
      (e) => world.getBld(e.tx, e.ty) === e.code && world.bornDayAt(e.tx, e.ty) === e.born,
    );
    this.reindex();
    return before !== this.active.length;
  }

  step(world: World, services: QualitySource, tick: number, grace: number): boolean {
    let changed = this.reconcile(world);
    if (this.active.length === 0 && grace <= 0) return changed;
    const prior = [...this.active];
    const finished = new Set<Incident>();
    const spread = new Map<string, { tx: number; ty: number }>();
    // 전파는 건물 둘레의 바로 이웃한 건물만. 도로/빈 땅/시설은 방화 간격이 된다.
    for (const e of prior) {
      const q = quality(services, e.tx, e.ty, e.kind);
      const age = tick - e.startedTick;
      if (age <= 0) continue;
      if (
        roll(20 + e.kind, tick, e.tx, e.ty) <
        DISASTER_RECOVERY[e.kind] + q * DISASTER_SERVICE_RECOVERY[e.kind]
      ) {
        finished.add(e);
        if (e.kind === 0) this.state.extinguished++;
        continue;
      }
      if (age >= DISASTER_DURATION[e.kind]) {
        finished.add(e);
        if (e.kind === 0) {
          world.demolishAt(e.tx, e.ty);
          this.state.burned++;
        }
        continue;
      }
      if (e.kind !== 0) continue;
      const span = levelOfCode(e.code);
      for (let i = 0; i < span; i++) {
        for (const [x, y] of [
          [e.tx + i, e.ty - 1],
          [e.tx + i, e.ty + span],
          [e.tx - 1, e.ty + i],
          [e.tx + span, e.ty + i],
        ]) {
          const b = world.buildingCovering(x, y);
          if (!b || b.kind !== null || this.byTile.has(keyOf(b.tx, b.ty))) continue;
          const targetQ = quality(services, b.tx, b.ty, 0);
          if (roll(40, tick, b.tx, b.ty) < FIRE_SPREAD_CHANCE * (1 - q) * (1 - targetQ)) {
            spread.set(keyOf(b.tx, b.ty), { tx: b.tx, ty: b.ty });
          }
        }
      }
    }
    if (finished.size) {
      this.state.active = this.state.active.filter((e) => !finished.has(e));
      changed = true;
      this.reindex();
    }
    const touched = new Set(prior.map((e) => keyOf(e.tx, e.ty)));
    for (const b of [...spread.values()].sort((a, b) => a.ty - b.ty || a.tx - b.tx)) {
      if (this.start(world, 0, b.tx, b.ty, tick)) {
        changed = true;
        touched.add(keyOf(b.tx, b.ty));
      }
    }
    // 도시가 작은 동안 자연 발생만 유예. 이미 생긴 화재는 인구가 줄어도 해결해야 한다.
    if (grace > 0) {
      const parcels = [...world.developedParcels()].sort((a, b) => a.cy - b.cy || a.cx - b.cx);
      for (const p of parcels) {
        if (!p.bld || this.active.length >= DISASTER_MAX_ACTIVE) continue;
        for (let i = 0; i < p.bld.length; i++) {
          if (!isAnchor(p.bld[i])) continue;
          const tx = p.cx * CHUNK_SIZE + (i % CHUNK_SIZE);
          const ty = p.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
          if (touched.has(keyOf(tx, ty)) || this.byTile.has(keyOf(tx, ty))) continue;
          for (const kind of DISASTER_KINDS) {
            const q = quality(services, tx, ty, kind);
            if (
              roll(kind, tick, tx, ty) <
              DISASTER_RATE_PER_TICK[kind] * grace * (1 - q * DISASTER_PREVENTION[kind])
            ) {
              if (this.start(world, kind, tx, ty, tick)) changed = true;
              break;
            }
          }
        }
      }
    }
    if (changed) this.state.active.sort(order);
    return changed;
  }

  private start(world: World, kind: DisasterKind, tx: number, ty: number, tick: number): boolean {
    if (this.active.length >= DISASTER_MAX_ACTIVE || this.byTile.has(keyOf(tx, ty))) return false;
    const code = world.getBld(tx, ty);
    if (!isAnchor(code)) return false;
    const e: Incident = { kind, tx, ty, code, born: world.bornDayAt(tx, ty), startedTick: tick };
    this.state.active.push(e);
    this.byTile.set(keyOf(tx, ty), e);
    this.state.started[kind]++;
    return true;
  }
  private reindex(): void {
    this.byTile.clear();
    for (const e of this.active) this.byTile.set(keyOf(e.tx, e.ty), e);
  }
}
function quality(s: QualitySource, tx: number, ty: number, kind: number): number {
  const q = s.serviceQualityAt(tx, ty, kind);
  return Number.isFinite(q) ? Math.max(0, Math.min(1, q)) : 0;
}
function roll(channel: number, tick: number, tx: number, ty: number): number {
  return simRandom(WORLD_SEED ^ (0x51ed270b + channel * 0x9e3779b9), tick, tx, ty);
}
