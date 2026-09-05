import { CHUNK_SIZE } from '../core/constants';
import { chunkIndexOf, localIndexOf } from '../core/iso';
import type { MacroState } from '../net/types';
import type { Parcel, World } from '../world/world';
import {
  capacityOf,
  isAnchor,
  LEVEL_COUNT,
  levelOfCode,
  ZONE_C,
  ZONE_COUNT,
  ZONE_I,
  ZONE_R,
  zoneOfCode,
} from './buildings';
import { growParcel, type GrowthContext } from './growth';
import { AssignmentTable } from './assignment';
import { CongestionMap } from './congestion';
import { RoadField } from './roadGraph';
import {
  COMMUTE_BAD_DIST,
  COMMUTE_GOOD_DIST,
  CONGESTION_PENALTY_R,
  CONGESTION_PENALTY_W,
  DEMAND_SCALE,
  DEMAND_SMOOTH,
  EXPORT_PER_SQRT_POP,
  INDUSTRY_EXPORT_BASE,
  INDUSTRY_NUISANCE_MAX,
  GROWTH_PRESSURE,
  INDUSTRY_PER_SHOP,
  MAX_CATCHUP_TICKS,
  MS_PER_TICK,
  OCCUPANCY_HEALTHY,
  OFFLINE_SPEED,
  PROSPERITY_FULL,
  RESIDENTS_PER_JOB,
  ROAD_DIST_UNREACHABLE,
  ROAD_FIELD_INTERVAL,
  ROAD_FIELD_MIN_INTERVAL,
  SATISFACTION_FLOOR,
  SEED_DEMAND_C,
  SEED_DEMAND_I,
  SEED_DEMAND_R,
  SHOP_JOBS_PER_RESIDENT,
  STATS_INTERVAL,
  TAX_PER_JOB,
  TAX_PER_RESIDENT,
  TICKS_PER_DAY,
  UPKEEP_ROAD_PER_DAY,
} from './simConstants';

/**
 * 3.1단계 매크로 시뮬레이션.
 *
 * 이 클래스가 도시의 유일한 진실이다. 차량도 보행자도 여기 없다 — 3.2단계에서
 * 이 매크로가 만들어내는 통근 흐름 위에 얹는다.
 *
 * 지켜야 할 성질이 하나 있다: **결정론.**
 * 오프라인 따라잡기가 몇백 틱을 한 번에 몰아 돌리고, 나중에는 Vercel 함수가
 * 같은 계산을 재현해 검증할 수도 있어야 한다. 그래서 Math.random 도,
 * Date.now() 도 틱 안에서 쓰지 않는다. 난수가 필요하면 좌표와 틱 번호로 만든다
 * (buildings.ts 의 simRandom).
 */

export interface TierStats {
  /** 정원(건물이 수용할 수 있는 최대). */
  capacity: number;
  /** 실제로 들어와 있는 인원. 만족도가 낮으면 정원보다 적다 = 공실. */
  filled: number;
}

export interface CityStats {
  /** [zone][tier] */
  tiers: TierStats[][];
  population: number;
  jobs: number;
  buildings: number;
  roads: number;
  /** 전체 입주율 0~1. 공실이 늘면 떨어진다. */
  occupancy: number;
  /** 도로에 닿지 않아 아무도 못 들어오는 건물 수. */
  strandedBuildings: number;
  /** 하루 수지. 표시용. */
  dailyIncome: number;
  dailyUpkeep: number;
}

function emptyTiers(): TierStats[][] {
  const out: TierStats[][] = [];
  for (let z = 0; z < ZONE_COUNT; z++) {
    const row: TierStats[] = [];
    for (let t = 0; t < LEVEL_COUNT; t++) row.push({ capacity: 0, filled: 0 });
    out.push(row);
  }
  return out;
}

function zeroDemand(): number[][] {
  return [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
}

export class MacroSim {
  /** [zone][tier] 수요. -1 ~ +1. */
  demand: number[][] = zeroDemand();
  stats: CityStats = {
    tiers: emptyTiers(),
    population: 0,
    jobs: 0,
    buildings: 0,
    roads: 0,
    occupancy: 0,
    strandedBuildings: 0,
    dailyIncome: 0,
    dailyUpkeep: 0,
  };
  readonly roadField = new RoadField();
  private assignment: AssignmentTable | null = null;
  private congestion: CongestionMap | null = null;

  /** 이번 접속에서 따라잡아야 할 남은 틱. 0 이면 실시간으로 돈다. */
  catchupLeft = 0;

  /**
   * 돈·틱이 바뀌었을 때 불린다. SaveManager 가 여기에 물린다.
   * 청크가 하나도 안 바뀌어도 도시 문서는 갱신돼야 하기 때문이다.
   */
  onMacroChange: (() => void) | null = null;

  /**
   * 건물별 입주율(0~255). 저장하지 않는다.
   * 매 틱 바뀌는 값이라 저장하면 도시의 모든 청크가 매 틱 저장 대상이 된다.
   * 만족도와 도로망에서 언제든 다시 수렴하므로 재접속 때 잠깐 채워지면 그만이다.
   */
  private occ = new Map<string, Uint8Array>();
  /** 청크별 공업 밀도. 주거 만족도를 깎는 값. evaluate 에서 갱신한다. */
  private nuisance = new Map<string, number>();

  private accumulatorMs = 0;
  private lastFieldTick = 0;
  /** 최소 갱신 간격 안에 들어온 도로 변경 신호를 잃지 않게 보관한다. */
  private roadChangePending = false;

  constructor(
    private world: World,
    private macro: MacroState,
  ) {}

  /** STEP 3.2 파생 레이어를 연결한다. 저장 상태에는 포함하지 않는다. */
  attachTraffic(congestion: CongestionMap, assignment: AssignmentTable): void {
    this.congestion = congestion;
    this.assignment = assignment;
  }

  get tick(): number {
    return this.macro.tick;
  }

  get day(): number {
    return Math.floor(this.macro.tick / TICKS_PER_DAY);
  }

  get money(): number {
    return this.macro.money;
  }

  /**
   * 해당 타일을 덮는 건물의 현재 입주율. 물리 건물과 달리 저장하지 않는 파생값이다.
   * 건물이 없으면 null, 건물은 있지만 만족도 기준 미달이면 0을 돌려준다.
   */
  occupancyAt(tx: number, ty: number): number | null {
    const info = this.world.buildingCovering(tx, ty);
    if (!info) return null;
    const p = this.world.peekParcel(chunkIndexOf(info.tx), chunkIndexOf(info.ty));
    if (!p) return 0;
    const values = this.occ.get(p.key);
    if (!values) return 0;
    const i = localIndexOf(info.ty) * CHUNK_SIZE + localIndexOf(info.tx);
    return values[i] / 255;
  }

  /** 시간대(0~23). 3.2단계에서 출퇴근 러시를 만들 때 쓴다. */
  get hourOfDay(): number {
    return this.macro.tick % TICKS_PER_DAY;
  }

  /**
   * 접속 공백을 틱으로 환산해 따라잡기 예약을 건다.
   *
   * 오프라인 시간은 OFFLINE_SPEED 만큼만 흐르고 MAX_CATCHUP_TICKS 에서 멈춘다.
   * "아무도 없으면 시간이 느려지다가 멈춘다" 는 설계가 이 두 줄이다.
   */
  primeCatchup(nowMs: number): void {
    const gap = Math.max(0, nowMs - (this.macro.tickedAt || nowMs));
    const ticks = Math.floor((gap / MS_PER_TICK) * OFFLINE_SPEED);
    this.catchupLeft = Math.min(ticks, MAX_CATCHUP_TICKS);
    this.macro.tickedAt = nowMs;
    // 불러온 직후에는 통계가 비어 있다. 한 번 채워야 수요가 0 에서 시작하지 않는다.
    this.evaluate(true);
    this.roadField.rebuild(this.world);
    // 거리장이 생긴 뒤 입주율을 한 번 더 계산해야 첫 배정이 0명으로 굳지 않는다.
    this.evaluate(false);
    this.rebuildTrafficFields();
  }

  /** 실시간 프레임에서 부른다. 지나간 만큼 틱을 돌린다. */
  update(deltaMs: number, budget: number): void {
    if (this.catchupLeft > 0) {
      const n = Math.min(this.catchupLeft, budget);
      for (let i = 0; i < n; i++) this.step();
      this.catchupLeft -= n;
      return;
    }

    this.accumulatorMs += deltaMs;
    // 탭이 뒤로 갔다 오면 deltaMs 가 크게 튄다. 한 프레임에 도는 틱을 제한한다.
    let guard = 0;
    while (this.accumulatorMs >= MS_PER_TICK && guard < 8) {
      this.accumulatorMs -= MS_PER_TICK;
      this.step();
      guard++;
    }
    if (this.accumulatorMs > MS_PER_TICK * 8) this.accumulatorMs = 0;
    this.macro.tickedAt = Date.now();
  }

  /* ---------------- 틱 하나 ---------------- */

  private step(): void {
    this.macro.tick++;

    this.evaluate(this.macro.tick % STATS_INTERVAL === 0);
    if (this.catchupLeft > 0) this.congestion?.decayAll();
    // 도로가 바뀌면 개발 가능 범위가 바뀐다. 하루를 기다리면 학생이 도로를 깔고도
    // 한참 아무 일이 없어 보이므로, 바뀐 걸 봤을 때는 몇 틱 안에 다시 만든다.
    // 최소 간격 전에 들어온 신호도 pending 에 남겨 다음 틱에 다시 확인한다.
    this.roadChangePending = this.world.consumeRoadDirty() || this.roadChangePending;
    const periodicRebuild = this.macro.tick % ROAD_FIELD_INTERVAL === 0;
    const changedAndReady =
      this.roadChangePending &&
      this.macro.tick - this.lastFieldTick >= ROAD_FIELD_MIN_INTERVAL;
    if (periodicRebuild || changedAndReady) {
      this.roadField.rebuild(this.world);
      // 새 도로망을 배정표가 읽기 전에 입주율/통근 상태도 같은 거리장으로 맞춘다.
      this.evaluate(false);
      this.rebuildTrafficFields();
      this.lastFieldTick = this.macro.tick;
      this.roadChangePending = false;
    }
    if (this.macro.tick % TICKS_PER_DAY === 0) this.settleFinance();

    this.grow();
  }

  /**
   * 성장. 돈이 마이너스면 아예 건너뛴다.
   *
   * 파산으로 도시를 초기화하지는 않는다. 학생 도시가 통째로 날아가면 수업이
   * 안 된다. 대신 새 건물이 안 들어서고 유지비는 계속 나가므로, 도로를 헐거나
   * 세수가 회복될 때까지 도시가 멈춘다.
   */
  private grow(): void {
    if (this.macro.money <= 0) return;

    const ctx: GrowthContext = {
      demand: this.demand,
      field: this.roadField,
      today: this.day,
      tick: this.macro.tick,
      money: this.macro.money,
    };

    for (const p of this.world.developedParcels()) {
      if (ctx.money <= 0) break;
      const r = growParcel(this.world, p, ctx);
      if (r.spent > 0) {
        this.macro.money -= r.spent;
        ctx.money = this.macro.money;
      }
    }
  }

  private rebuildTrafficFields(): void {
    if (!this.assignment || !this.congestion) return;
    this.assignment.rebuild(this.world, this.roadField, this.stats);
    this.congestion.rebuildEstimate(this.world, this.roadField, this.assignment);
  }

  /* ---------------- 통계 · 만족도 · 수요 ---------------- */

  /**
   * 도시 전체를 한 바퀴 돌면서
   *   1) 건물마다 만족도를 계산하고 입주율을 그쪽으로 움직인 뒤
   *   2) 계층별 정원·실인원을 집계하고
   *   3) 그걸로 수요를 다시 잡는다.
   *
   * STATS_INTERVAL 틱에 한 번만 돌기 때문에 매 프레임 부담이 되지 않는다.
   */
  private evaluate(updateDemand: boolean): void {
    const parcels = this.world.developedParcels();
    this.updateNuisance(parcels);

    const tiers = emptyTiers();
    let buildings = 0;
    let roads = 0;
    let stranded = 0;
    let capacityTotal = 0;
    let filledTotal = 0;

    for (const p of parcels) {
      roads += p.roadCount;
      if (!p.bld) continue;

      let occArr = this.occ.get(p.key);
      if (!occArr || occArr.length !== p.bld.length) {
        occArr = new Uint8Array(p.bld.length);
        this.occ.set(p.key, occArr);
      }
      const nui = this.nuisance.get(p.key) ?? 0;
      const baseX = p.cx * CHUNK_SIZE;
      const baseY = p.cy * CHUNK_SIZE;

      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const i = ly * CHUNK_SIZE + lx;
          const code = p.bld[i];
          if (!isAnchor(code)) continue;

          buildings++;
          const zone = zoneOfCode(code);
          const level = levelOfCode(code);
          const tx = baseX + lx;
          const ty = baseY + ly;

          const dist = this.roadField.commuteFor(tx, ty, level, zone);
          if (dist >= ROAD_DIST_UNREACHABLE) stranded++;

          const congestion = this.congestion?.routeCongestionFor(tx, ty) ?? 0;
          const sat = satisfaction(zone, dist, nui, congestion);
          const floor = SATISFACTION_FLOOR[level - 1];
          const target =
            sat <= floor ? 0 : Math.min(1, (sat - floor) / Math.max(0.05, 1 - floor));

          // 입주율은 저장된 과거값에 의존하지 않는 완전한 파생값이다. 같은 물리 상태,
          // 도로망, 수요 입력이면 재접속·오프라인 계산에서도 항상 같은 결과가 나온다.
          occArr[i] = Math.round(Math.max(0, Math.min(1, target)) * 255);

          const cap = capacityOf(zone, level);
          const filled = cap * (occArr[i] / 255);
          tiers[zone][level - 1].capacity += cap;
          tiers[zone][level - 1].filled += filled;
          capacityTotal += cap;
          filledTotal += filled;
        }
      }
    }

    let population = 0;
    let jobs = 0;
    for (let t = 0; t < LEVEL_COUNT; t++) {
      population += tiers[ZONE_R][t].filled;
      jobs += tiers[ZONE_C][t].filled + tiers[ZONE_I][t].filled;
    }

    this.stats = {
      tiers,
      population,
      jobs,
      buildings,
      roads,
      occupancy: capacityTotal === 0 ? 0 : filledTotal / capacityTotal,
      strandedBuildings: stranded,
      dailyIncome: this.stats.dailyIncome,
      dailyUpkeep: this.stats.dailyUpkeep,
    };
    this.macro.population = Math.round(population);

    if (updateDemand) this.updateDemand(tiers, population, this.stats.occupancy);
  }

  /**
   * 청크별 공업 밀도. 주거 만족도에서 빼는 값이다.
   *
   * 건물마다 반경을 훑으면 O(건물수 x 반경^2) 이라 도시가 커지면 감당이 안 된다.
   * 대신 청크 단위 밀도를 만들고 이웃 청크까지 섞는다. 실제 화면에서는
   * "공장 지대 옆 주택은 사람이 잘 안 든다" 로 충분히 읽힌다.
   * 정밀한 오염은 4단계(오염 시스템)에서 격자로 다시 계산한다.
   */
  private updateNuisance(parcels: readonly Parcel[]): void {
    this.nuisance.clear();
    const raw = new Map<string, number>();
    for (const p of parcels) {
      if (!p.bld) continue;
      let industry = 0;
      for (let i = 0; i < p.bld.length; i++) {
        const code = p.bld[i];
        if (isAnchor(code) && zoneOfCode(code) === ZONE_I) {
          industry += levelOfCode(code) * levelOfCode(code);
        }
      }
      raw.set(p.key, industry);
    }
    for (const p of parcels) {
      let sum = raw.get(p.key) ?? 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          sum += (raw.get(`${p.cx + dx},${p.cy + dy}`) ?? 0) * 0.4;
        }
      }
      // 청크 하나를 공업이 가득 채우면 대략 4096. 그 절반에서 최대치에 닿게 잡는다.
      const v = Math.min(1, sum / 2000) * INDUSTRY_NUISANCE_MAX;
      this.nuisance.set(p.key, v);
    }
  }

  /**
   * 수요.
   *
   * 계층별로 따로 목표를 잡지 않고, **도시 전체 목표를 계층 구성비로 나눈다.**
   * 이렇게 해야 사다리가 끊기지 않는다. 계층별로 독립 계산하면
   * "중산층 일자리가 있어야 중산층 수요가 생기는데, 중산층 주거가 없어서
   *  중산층 일자리가 안 생긴다" 는 교착이 생긴다.
   *
   * 구성비는 도시 규모(prosperity)에 따라 위쪽으로 옮겨간다. 작은 도시는
   * 저소득 위주고, 커질수록 중산층·고소득 비중이 늘어난다.
   */
  private updateDemand(
    tiers: TierStats[][],
    population: number,
    occupancy: number,
  ): void {
    const p = Math.min(1, population / PROSPERITY_FULL);
    const shareLive = [0.7 - 0.45 * p, 0.25 + 0.2 * p, 0.05 + 0.25 * p];
    const shareWork = [0.65 - 0.35 * p, 0.27 + 0.13 * p, 0.08 + 0.22 * p];
    const shareInd = [0.55 - 0.2 * p, 0.3, 0.15 + 0.2 * p];

    let capC = 0;
    let capI = 0;
    let jobsAll = 0;
    for (let t = 0; t < LEVEL_COUNT; t++) {
      capC += tiers[ZONE_C][t].capacity;
      capI += tiers[ZONE_I][t].capacity;
      jobsAll += tiers[ZONE_C][t].capacity + tiers[ZONE_I][t].capacity;
    }

    // 도시가 비어 있을 때 밀어주는 값. 인구가 늘면 사라진다.
    const seed = 1 / (1 + population / 150);

    /*
     * 성장 압력.
     *
     * 집 대 일자리 비율만 맞추면 도시는 금세 균형에 갇혀 멈춘다. 실제로는
     * "살 만한 도시면 사람이 더 온다". 그래서 입주율이 건강할 때만 수요를
     * 위로 밀어준다.
     *
     * 이 항이 학생이 설계한 공실 규칙과 정확히 맞물린다. 과잉 건설을 하면
     * 공실이 늘고, 입주율이 떨어지고, 압력이 사라져 성장이 멈춘다.
     * 건물을 헐지 않고도 과잉 건설이 저절로 벌을 받는 구조다.
     */
    const pressure =
      this.stats.buildings === 0
        ? GROWTH_PRESSURE
        : GROWTH_PRESSURE *
          Math.max(0, Math.min(1, (occupancy - OCCUPANCY_HEALTHY) / (1 - OCCUPANCY_HEALTHY)));

    const targetHomes = jobsAll * RESIDENTS_PER_JOB + SEED_DEMAND_R * DEMAND_SCALE * seed;
    const targetShops =
      population * SHOP_JOBS_PER_RESIDENT + SEED_DEMAND_C * DEMAND_SCALE * seed;
    // 수출 수요. 도시 밖에서 오는 유일한 동력이고, 이게 도시 성장의 원동력이다.
    const exports = INDUSTRY_EXPORT_BASE + EXPORT_PER_SQRT_POP * Math.sqrt(population);
    const targetInd =
      capC * INDUSTRY_PER_SHOP + exports + SEED_DEMAND_I * DEMAND_SCALE * seed;

    for (let t = 0; t < LEVEL_COUNT; t++) {
      const r = (targetHomes * shareLive[t] - tiers[ZONE_R][t].capacity) / DEMAND_SCALE;
      const c = (targetShops * shareWork[t] - tiers[ZONE_C][t].capacity) / DEMAND_SCALE;
      const i = (targetInd * shareInd[t] - tiers[ZONE_I][t].capacity) / DEMAND_SCALE;
      this.approach(ZONE_R, t, r + pressure * shareLive[t]);
      this.approach(ZONE_C, t, c + pressure * shareWork[t]);
      this.approach(ZONE_I, t, i + pressure * shareInd[t]);
    }
  }

  /** 수요는 한 번에 튀지 않고 목표로 서서히 간다. 재건축이 계속 뒤집히는 걸 막는다. */
  private approach(zone: number, tier: number, target: number): void {
    const clamped = Math.max(-1, Math.min(1, target));
    const cur = this.demand[zone][tier];
    this.demand[zone][tier] = cur + (clamped - cur) * DEMAND_SMOOTH;
  }

  /* ---------------- 돈 ---------------- */

  private settleFinance(): void {
    let income = 0;
    for (let t = 0; t < LEVEL_COUNT; t++) {
      income += this.stats.tiers[ZONE_R][t].filled * TAX_PER_RESIDENT[t];
      income += (this.stats.tiers[ZONE_C][t].filled + this.stats.tiers[ZONE_I][t].filled) * TAX_PER_JOB[t];
    }
    const upkeep = this.stats.roads * UPKEEP_ROAD_PER_DAY;
    this.stats.dailyIncome = income;
    this.stats.dailyUpkeep = upkeep;
    this.macro.money = Math.round((this.macro.money + income - upkeep) * 100) / 100;
    this.onMacroChange?.();
  }

  /** 학생이 도로·지구를 놓을 때 부른다. 돈이 모자라면 false. */
  spend(amount: number): boolean {
    if (this.macro.money < amount) return false;
    this.macro.money -= amount;
    return true;
  }
}

/**
 * 만족도.
 *
 * 3.1단계에서는 통근과 공업 혐오 두 가지만 본다.
 * 오염·상하수도·서비스는 4단계에서 이 함수에 항을 더 붙이는 방식으로 들어온다.
 * 계층별 기준선(SATISFACTION_FLOOR)은 호출한 쪽에서 적용한다 —
 * 같은 자리라도 고소득 건물이 더 까다롭게 군다.
 */
function satisfaction(zone: number, commuteDist: number, nuisance: number, congestion: number): number {
  if (commuteDist >= ROAD_DIST_UNREACHABLE) return 0;

  let commute: number;
  if (commuteDist <= COMMUTE_GOOD_DIST) commute = 1;
  else if (commuteDist >= COMMUTE_BAD_DIST) commute = 0;
  else {
    commute = 1 - (commuteDist - COMMUTE_GOOD_DIST) / (COMMUTE_BAD_DIST - COMMUTE_GOOD_DIST);
  }

  if (zone === ZONE_R) return Math.max(0, 0.35 + 0.65 * commute - nuisance - CONGESTION_PENALTY_R * congestion);
  if (zone === ZONE_C) return Math.max(0, 0.3 + 0.7 * commute - CONGESTION_PENALTY_W * congestion);
  return Math.max(0, 0.45 + 0.55 * commute - CONGESTION_PENALTY_W * congestion);
}
