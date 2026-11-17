import { chunkIndexOf, chunkKey } from '../core/iso';
import type { MacroState } from '../net/types';
import { depositAt, type Deposit } from '../world/deposits';
import {
  CONSUMER_SPECS,
  DIFFICULTY_NAMES,
  FAC_COAL_POWER,
  FAC_REFINERY,
  FAC_STEEL_MILL,
  INDUSTRY_BONUS_FIRST,
  INDUSTRY_BONUS_MAX,
  INDUSTRY_BONUS_NEXT,
  MINE_SPECS,
  RESOURCE_NAMES,
  RESOURCE_STORAGE,
  RESOURCES,
  FAC_LUMBER_CAMP,
  LUMBER_FOREST_SHARE,
  LUMBER_OUTPUT,
  type ResourceId,
} from './config/resources';
import type { FacilityRecord } from './services';
import { forestShare } from './military/terrain';

/**
 * 자원 채굴·가공 (군사 2단계).
 *
 *   채굴: 광산은 앵커 칸이 있는 청크의 매장지에서 캔다. 자원 종류가 맞고, 난이도가
 *         시설 단계로 캘 수 있고, 남은 매장량이 있어야 돈다. 캔 양은 macro.mined 에 청크별로.
 *   비축: macro.resources. 자원마다 RESOURCE_STORAGE 까지. 가득 차면 광산이 쉰다.
 *   소비: 제철소(철+석탄)·정유소(석유)·석탄 화력(석탄). 재료가 떨어지면 멈춘다.
 *   효과: 돌아가는 제철소·정유소 수만큼 공업 세수 +, 정유소가 있으면 가스 발전 유지비 -.
 */

export type MineState =
  | 'ok'
  | 'noRoad'
  | 'noDeposit'
  | 'wrongResource'
  | 'tooDeep'
  | 'depleted'
  | 'full';

export interface MineStatus {
  kind: number;
  resource: ResourceId;
  tier: number;
  chunk: string;
  state: MineState;
  /** 지금 하루 채굴량. */
  output: number;
  /** 이 청크에 남은 매장량. 매장지가 없으면 0. */
  remaining: number;
  deposit: Deposit | null;
}

export interface ConsumerStatus {
  kind: number;
  active: boolean;
  /** 멈춘 이유(돌면 빈 문자열). */
  reason: string;
}

export interface ResourceSummary {
  stock: Record<ResourceId, number>;
  production: Record<ResourceId, number>;
  consumption: Record<ResourceId, number>;
  mines: number;
  activeMines: number;
  steelMills: number;
  steelActive: number;
  refineries: number;
  refineryActive: number;
  coalPlants: number;
  coalActive: number;
  /** 공업 세수 보너스 (0.12 = +12%). */
  industryBonus: number;
  /** 정유소가 하나라도 돌면 true(가스 발전 유지비 할인). */
  gasDiscount: boolean;
}

const zero = (): Record<ResourceId, number> => ({ iron: 0, coal: 0, oil: 0, wood: 0, ammo: 0 });

export function emptyResourceSummary(): ResourceSummary {
  return {
    stock: zero(),
    production: zero(),
    consumption: zero(),
    mines: 0,
    activeMines: 0,
    steelMills: 0,
    steelActive: 0,
    refineries: 0,
    refineryActive: 0,
    coalPlants: 0,
    coalActive: 0,
    industryBonus: 0,
    gasDiscount: false,
  };
}

export function normalizeResourceStock(raw: unknown): Record<ResourceId, number> {
  const out = zero();
  if (raw && typeof raw === 'object')
    for (const r of RESOURCES) {
      const v = Number((raw as Record<string, unknown>)[r]);
      out[r] = Number.isFinite(v) ? Math.max(0, Math.min(RESOURCE_STORAGE, v)) : 0;
    }
  return out;
}

/** 청크에 남은 매장량. */
export function remainingAt(macro: MacroState, cx: number, cy: number): number {
  const d = depositAt(cx, cy);
  if (!d) return 0;
  return Math.max(0, d.reserve - (macro.mined?.[chunkKey(cx, cy)] ?? 0));
}

/**
 * 광산을 (tx,ty) 에 놓을 수 있는가(자원·난이도·매장량). 빈 문자열이면 된다.
 * 놓기 전 미리보기와 배치 검사에 같이 쓴다.
 */
export function mineSiteProblem(
  kind: number,
  tx: number,
  ty: number,
  macro: MacroState | null,
): string {
  const spec = MINE_SPECS[kind];
  if (!spec) return '';
  const cx = chunkIndexOf(tx);
  const cy = chunkIndexOf(ty);
  const d = depositAt(cx, cy);
  const name = RESOURCE_NAMES[spec.resource];
  if (!d) return `${name} 매장지가 아닙니다 · 지도 보기 → 자원 매장지에서 찾으세요`;
  if (d.resource !== spec.resource)
    return `여기는 ${RESOURCE_NAMES[d.resource]} 매장지입니다 (${name} 아님)`;
  if (d.difficulty > spec.tier - 1)
    return `${DIFFICULTY_NAMES[d.difficulty]} 매장지는 ${d.difficulty + 1}단계 시설이 필요합니다`;
  if (macro && remainingAt(macro, cx, cy) <= 0) return '이 매장지는 다 캤습니다';
  return '';
}

export class ResourceSystem {
  summary: ResourceSummary = emptyResourceSummary();
  private mines = new Map<string, MineStatus>();
  private consumers = new Map<string, ConsumerStatus>();
  /** 연료 상태가 바뀌면 불린다(전력망 다시 세기). */
  onCoalFuel: ((ok: boolean) => void) | null = null;
  private coalFuel = true;
  /** 벌목장 하루 생산(나무). */
  private lumber = 0;
  /** 공장이 하루에 만드는 자원(탄약 공장). */
  private made: Partial<Record<ResourceId, number>> = {};

  constructor(private macro: MacroState) {
    macro.resources = normalizeResourceStock(macro.resources);
  }

  private get stock(): Record<ResourceId, number> {
    if (!this.macro.resources) this.macro.resources = zero();
    return this.macro.resources as Record<ResourceId, number>;
  }

  /** 시설 목록이 바뀌거나 평가가 돌 때 부른다. 상태와 하루 생산·소비를 다시 센다. */
  refresh(facilities: readonly FacilityRecord[]): void {
    this.mines.clear();
    this.consumers.clear();
    const s = emptyResourceSummary();
    const stock = this.stock;
    s.stock = { ...stock };
    for (const f of facilities) {
      const spec = MINE_SPECS[f.kind];
      if (!spec) continue;
      s.mines++;
      const cx = chunkIndexOf(f.tx);
      const cy = chunkIndexOf(f.ty);
      const d = depositAt(cx, cy);
      const remaining = d ? remainingAt(this.macro, cx, cy) : 0;
      let state: MineState = 'ok';
      if (!f.hasRoad) state = 'noRoad';
      else if (!d) state = 'noDeposit';
      else if (d.resource !== spec.resource) state = 'wrongResource';
      else if (d.difficulty > spec.tier - 1) state = 'tooDeep';
      else if (remaining <= 0) state = 'depleted';
      else if (stock[spec.resource] >= RESOURCE_STORAGE) state = 'full';
      const output = state === 'ok' ? spec.output : 0;
      if (output > 0) s.activeMines++;
      s.production[spec.resource] += output;
      this.mines.set(`${f.tx},${f.ty}`, {
        kind: f.kind,
        resource: spec.resource,
        tier: spec.tier,
        chunk: chunkKey(cx, cy),
        state,
        output,
        remaining,
        deposit: d,
      });
    }
    // 벌목장: 숲 청크에서 나무를 벤다(숲은 다시 자란다).
    this.lumber = 0;
    for (const f of facilities) {
      if (f.kind !== FAC_LUMBER_CAMP) continue;
      let reason = f.hasRoad ? '' : '도로를 이어주세요';
      if (!reason && forestShare(chunkIndexOf(f.tx), chunkIndexOf(f.ty)) < LUMBER_FOREST_SHARE)
        reason = '숲이 아닙니다 · 숲 청크로 옮기세요';
      if (!reason && stock.wood >= RESOURCE_STORAGE)
        reason = '비축 창고가 가득 찼습니다 · 시장에 파세요';
      const active = !reason;
      if (active) {
        s.production.wood += LUMBER_OUTPUT;
        this.lumber += LUMBER_OUTPUT;
      }
      this.consumers.set(`${f.tx},${f.ty}`, { kind: f.kind, active, reason });
    }
    this.made = {};
    for (const f of facilities) {
      const spec = CONSUMER_SPECS[f.kind];
      if (!spec) continue;
      let reason = f.hasRoad ? '' : '도로를 이어주세요';
      if (!reason)
        for (const [r, need] of Object.entries(spec.input) as [ResourceId, number][])
          if (need > 0 && stock[r] <= 0) {
            reason = `${RESOURCE_NAMES[r]}이 없습니다`;
            break;
          }
      const active = !reason;
      if (active) {
        for (const [r, need] of Object.entries(spec.input) as [ResourceId, number][])
          s.consumption[r] += need;
        for (const [r, give] of Object.entries(spec.output ?? {}) as [ResourceId, number][]) {
          s.production[r] += give;
          this.made[r] = (this.made[r] ?? 0) + give;
        }
      }
      if (f.kind === FAC_STEEL_MILL) {
        s.steelMills++;
        if (active) s.steelActive++;
      } else if (f.kind === FAC_REFINERY) {
        s.refineries++;
        if (active) s.refineryActive++;
      } else if (f.kind === FAC_COAL_POWER) {
        s.coalPlants++;
        if (active) s.coalActive++;
      }
      this.consumers.set(`${f.tx},${f.ty}`, { kind: f.kind, active, reason });
    }
    const boosters = s.steelActive + s.refineryActive;
    s.industryBonus =
      boosters === 0
        ? 0
        : Math.min(INDUSTRY_BONUS_MAX, INDUSTRY_BONUS_FIRST + (boosters - 1) * INDUSTRY_BONUS_NEXT);
    s.gasDiscount = s.refineryActive > 0;
    this.summary = s;
    this.syncCoalFuel();
  }

  /** 석탄 화력 연료. 석탄이 하나도 없으면 발전소가 꺼진다. */
  private syncCoalFuel(): void {
    const ok = this.stock.coal > 0;
    if (ok === this.coalFuel) return;
    this.coalFuel = ok;
    this.onCoalFuel?.(ok);
  }

  /** dayFraction(게임 하루 비율)만큼 캐고 쓴다. */
  advance(dayFraction: number): void {
    if (!(dayFraction > 0)) return;
    const stock = this.stock;
    const mined = (this.macro.mined ??= {});
    for (const m of this.mines.values()) {
      if (m.output <= 0 || !m.deposit) continue;
      const room = RESOURCE_STORAGE - stock[m.resource];
      const left = m.deposit.reserve - (mined[m.chunk] ?? 0);
      const take = Math.max(0, Math.min(m.output * dayFraction, room, left));
      if (take <= 0) continue;
      stock[m.resource] += take;
      mined[m.chunk] = Math.round(((mined[m.chunk] ?? 0) + take) * 100) / 100;
      m.remaining = Math.max(0, left - take);
    }
    if (this.lumber > 0)
      stock.wood = Math.min(RESOURCE_STORAGE, stock.wood + this.lumber * dayFraction);
    for (const [r, give] of Object.entries(this.made) as [ResourceId, number][])
      stock[r] = Math.min(RESOURCE_STORAGE, stock[r] + give * dayFraction);
    for (const r of RESOURCES) {
      const use = this.summary.consumption[r] * dayFraction;
      stock[r] = Math.max(0, Math.round((stock[r] - use) * 100) / 100);
    }
    this.summary.stock = { ...stock };
    this.syncCoalFuel();
  }

  /** 시장에서 사거나 판 양을 비축에 더한다(음수 = 뺀다). 실제로 움직인 양을 돌려준다. */
  addStock(r: ResourceId, qty: number): number {
    const stock = this.stock;
    const next = Math.max(0, Math.min(RESOURCE_STORAGE, stock[r] + qty));
    const moved = next - stock[r];
    stock[r] = next;
    this.summary.stock = { ...stock };
    this.syncCoalFuel();
    return moved;
  }

  get stockNow(): Readonly<Record<ResourceId, number>> {
    return this.stock;
  }

  mineAt(tx: number, ty: number): MineStatus | undefined {
    return this.mines.get(`${tx},${ty}`);
  }

  consumerAt(tx: number, ty: number): ConsumerStatus | undefined {
    return this.consumers.get(`${tx},${ty}`);
  }

  /** 관리자 초기화. */
  reset(): void {
    this.macro.resources = zero();
    delete this.macro.mined;
    this.summary = emptyResourceSummary();
    this.syncCoalFuel();
  }

  /** 미리보기용: (tx,ty) 청크의 매장지와 남은 양. */
  depositInfo(tx: number, ty: number): { deposit: Deposit | null; remaining: number } {
    const cx = chunkIndexOf(tx);
    const cy = chunkIndexOf(ty);
    return { deposit: depositAt(cx, cy), remaining: remainingAt(this.macro, cx, cy) };
  }
}

export const MINE_STATE_TEXT: Record<MineState, string> = {
  ok: '채굴 중',
  noRoad: '도로를 이어주세요',
  noDeposit: '매장지가 아닙니다',
  wrongResource: '다른 자원 매장지입니다',
  tooDeep: '더 높은 단계 시설이 필요합니다',
  depleted: '매장량이 바닥났습니다 · 철거하고 새 매장지로 옮기세요',
  full: '비축 창고가 가득 찼습니다 · 시장에 파세요',
};
