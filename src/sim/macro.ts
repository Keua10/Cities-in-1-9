import { CHUNK_SIZE } from '../core/constants';
import { chunkIndexOf, localIndexOf } from '../core/iso';
import type { MacroState } from '../net/types';
import type { Parcel, World } from '../world/world';
import { AssignmentTable } from './assignment';
import {
  capacityOf,
  isAnchor,
  LEVEL_COUNT,
  levelOfCode,
  ZONE_C,
  ZONE_I,
  ZONE_R,
  zoneOfCode,
} from './buildings';
import {
  emptyFacilityStats,
  emptyTiers,
  zeroDemand,
  type CityStats,
  type TierStats,
} from './cityStats';
import { CongestionMap } from './congestion';
import { DisasterSim } from './disasters';
import { growParcel, type GrowthContext } from './growth';
import { RoadField } from './roadGraph';
import { WaterField } from './water';
import { PowerField } from './power';
import { utilityPenalty } from './config/infrastructure';
import { normalizePolicies, taxRate, taxSatisfactionPenalty, type CityPolicies } from './policies';
import { FAC_INCINERATOR, FAC_CREMATORIUM } from './config/sanitation';
import { WATER_GRACE_DAYS, WATER_RAMP_DAYS } from './config/water';
import {
  CITY_LEVELS,
  cityLevelFor,
  dailyProsperity,
  initializeProsperity,
  normalizeProsperity,
} from './progression';
import { graceFactor, satisfaction } from './satisfaction';
import { SERVICE_KIND_COUNT, ServiceField } from './services';
import {
  AMENITY_GAP_MAX,
  AMENITY_HALF,
  AMENITY_NEED_BY_TIER,
  AMENITY_SURPLUS_MAX,
  DEMAND_SCALE,
  DEMAND_SMOOTH,
  EXPORT_PER_SQRT_POP,
  GROWTH_PRESSURE,
  INDUSTRY_EXPORT_BASE,
  INDUSTRY_NUISANCE_MAX,
  INDUSTRY_PER_SHOP,
  MAX_CATCHUP_TICKS,
  MS_PER_TICK,
  NEEDS_PENALTY_MAX,
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
  SERVICE_PENALTY_MAX,
  SERVICE_WEIGHT,
  SHOP_JOBS_PER_RESIDENT,
  STATS_INTERVAL,
  TAX_PER_JOB,
  TAX_PER_RESIDENT,
  TICKS_PER_DAY,
  TIER_SERVICE_MUL,
  UPKEEP_ROAD_PER_DAY,
  ZONE_AMENITY_MUL,
} from './simConstants';
export type { CityStats, TierStats } from './cityStats';
export { graceFactor } from './satisfaction';

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

export class MacroSim {
  sanitation = { waste: 1, funeral: 1 };
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
    ...emptyFacilityStats(),
  };
  readonly roadField = new RoadField();
  /**
   * 3.3단계 서비스 품질장. 필수 서비스 커버리지와 복지 점수를 함께 들고 있다.
   * roadField 와 **같은 타이밍에** 다시 만든다 — 도로가 바뀌면 커버리지도
   * 반드시 같이 바뀌기 때문이다. 별도 주기를 만들지 마라.
   */
  readonly services = new ServiceField();
  readonly water = new WaterField();
  readonly power = new PowerField();
  readonly disasters: DisasterSim;
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
  /** 거리장을 다시 만든 뒤 남은 후속 작업. 1 = 배정표, 2 = 혼잡 추정. */
  private pendingStage = 0;

  constructor(
    private world: World,
    private macro: MacroState,
  ) {
    this.disasters = new DisasterSim(macro.disasters, macro.tick);
    this.water.power = this.power;
    this.services.power = this.power;
    this.macro.policies = normalizePolicies(macro.policies);
    this.services.budget = this.macro.policies.serviceBudget / 100;
  }

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

  get policies(): CityPolicies {
    return normalizePolicies(this.macro.policies);
  }

  setPolicies(patch: Partial<CityPolicies>): void {
    this.macro.policies = normalizePolicies({ ...this.policies, ...patch });
    this.services.budget = this.macro.policies.serviceBudget / 100;
    this.onMacroChange?.();
  }

  get sanitationGraceDaysLeft(): number {
    return Math.max(
      0,
      30 - Math.floor((this.tick - (this.macro.sanitationStartTick ?? this.tick)) / TICKS_PER_DAY),
    );
  }

  financeEstimate(): { income: number; upkeep: number } {
    let income = 0;
    const policies = this.policies;
    for (let t = 0; t < LEVEL_COUNT; t++) {
      income +=
        this.stats.tiers[ZONE_R][t].filled * TAX_PER_RESIDENT[t] * (taxRate(policies, ZONE_R) / 9);
      income +=
        this.stats.tiers[ZONE_C][t].filled * TAX_PER_JOB[t] * (taxRate(policies, ZONE_C) / 9);
      income +=
        this.stats.tiers[ZONE_I][t].filled * TAX_PER_JOB[t] * (taxRate(policies, ZONE_I) / 9);
    }
    return {
      income,
      upkeep:
        this.stats.roads * UPKEEP_ROAD_PER_DAY +
        this.services.dailyUpkeep() +
        this.water.upkeep +
        this.power.upkeep,
    };
  }

  get prosperity(): number {
    return normalizeProsperity(this.macro.prosperity);
  }

  get cityLevel(): number {
    return cityLevelFor(this.prosperity);
  }

  get maxBuildingTier(): number {
    return CITY_LEVELS[this.cityLevel - 1].maxBuildingTier;
  }

  get waterGraceDaysLeft(): number {
    return Math.max(
      0,
      WATER_GRACE_DAYS -
        Math.floor((this.tick - (this.macro.waterStartTick ?? this.tick)) / TICKS_PER_DAY),
    );
  }

  private get waterPenaltyFactor(): number {
    const days = (this.tick - (this.macro.waterStartTick ?? this.tick)) / TICKS_PER_DAY;
    return Math.max(0, Math.min(1, (days - WATER_GRACE_DAYS) / WATER_RAMP_DAYS));
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
    if (
      !Number.isFinite(this.macro.sanitationStartTick) ||
      this.macro.sanitationStartTick! < 0 ||
      this.macro.sanitationStartTick! > this.tick
    ) {
      this.macro.sanitationStartTick = this.tick;
      this.onMacroChange?.();
    }
    if (
      !Number.isFinite(this.macro.powerStartTick) ||
      this.macro.powerStartTick! < 0 ||
      this.macro.powerStartTick! > this.tick
    ) {
      this.macro.powerStartTick = this.tick;
      this.onMacroChange?.();
    }
    this.power.ensure(this.world);
    if (
      !Number.isFinite(this.macro.waterStartTick) ||
      this.macro.waterStartTick! < 0 ||
      this.macro.waterStartTick! > this.tick
    ) {
      this.macro.waterStartTick = this.tick;
      this.onMacroChange?.();
    }
    this.water.ensure(this.world);
    const previousProsperity = this.macro.prosperity;
    initializeProsperity(this.macro, this.world);
    if (previousProsperity !== this.macro.prosperity) this.onMacroChange?.();
    this.disasters.reconcile(this.world);
    this.macro.disasters = this.disasters.snapshot();
    const gap = Math.max(0, nowMs - (this.macro.tickedAt || nowMs));
    const ticks = Math.floor((gap / MS_PER_TICK) * OFFLINE_SPEED);
    this.catchupLeft = Math.min(ticks, MAX_CATCHUP_TICKS);
    this.macro.tickedAt = nowMs;
    // 불러온 직후에는 통계가 비어 있다. 한 번 채워야 수요가 0 에서 시작하지 않는다.
    this.evaluate(true);
    this.roadField.rebuild(this.world);
    this.services.rebuild(this.world);
    // 거리장이 생긴 뒤 입주율을 한 번 더 계산해야 첫 배정이 0명으로 굳지 않는다.
    // 서비스 부하도 이 두 번째 호출에서 채워지므로(5.4 한 틱 지연) 첫 틱이
    // 돌기 전에 품질이 이미 확정돼 있다.
    this.evaluate(false);
    this.rebuildTrafficFields();
  }

  /** 실시간 프레임에서 부른다. 지나간 만큼 틱을 돌린다. */
  update(deltaMs: number, budget: number): void {
    this.power.ensure(this.world);
    this.water.ensure(this.world);
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
    this.power.ensure(this.world);
    this.water.ensure(this.world);

    if (
      this.disasters.step(
        this.world,
        this.services,
        this.tick,
        graceFactor(this.stats.population),
        this.water,
      )
    ) {
      this.macro.disasters = this.disasters.snapshot();
      this.onMacroChange?.();
    }

    this.evaluate(this.macro.tick % STATS_INTERVAL === 0);
    if (this.catchupLeft > 0) this.congestion?.decayAll();
    // 도로가 바뀌면 개발 가능 범위가 바뀐다. 하루를 기다리면 학생이 도로를 깔고도
    // 한참 아무 일이 없어 보이므로, 바뀐 걸 봤을 때는 몇 틱 안에 다시 만든다.
    // 최소 간격 전에 들어온 신호도 pending 에 남겨 다음 틱에 다시 확인한다.
    this.roadChangePending = this.world.consumeRoadDirty() || this.roadChangePending;
    const periodicRebuild = this.macro.tick % ROAD_FIELD_INTERVAL === 0;
    const changedAndReady =
      this.roadChangePending && this.macro.tick - this.lastFieldTick >= ROAD_FIELD_MIN_INTERVAL;
    if (periodicRebuild || changedAndReady) {
      this.roadField.rebuild(this.world);
      this.services.rebuild(this.world);
      // 새 도로망을 배정표가 읽기 전에 입주율/통근 상태도 같은 거리장으로 맞춘다.
      this.evaluate(false);
      // 배정표와 혼잡 추정은 **다음 틱들로 미룬다.** 도시가 커지면 셋을 한 틱에
      // 돌릴 때 0.9초씩 화면이 멈춘다(집·직장마다 도로망 BFS 라 도시 크기에
      // 비례한다). 틱 간격이 2.5초이므로 한 단계씩 나눠 돌리면 체감 정지가
      // 3분의 1로 줄고, 하루에 한 번 하는 일이라 한두 틱 늦어도 아무 차이가 없다.
      this.pendingStage = 1;
      this.lastFieldTick = this.macro.tick;
      this.roadChangePending = false;
    } else if (this.pendingStage === 1) {
      this.assignment?.rebuild(this.world, this.roadField, this.stats);
      this.pendingStage = 2;
    } else if (this.pendingStage === 2) {
      if (this.assignment) {
        this.congestion?.rebuildEstimate(this.world, this.roadField, this.assignment);
      }
      this.pendingStage = 0;
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
      maxBuildingTier: this.maxBuildingTier,
      demand: this.demand,
      field: this.roadField,
      today: this.day,
      tick: this.macro.tick,
      money: this.macro.money,
      blocksRebuild: (tx, ty, span) => this.disasters.blocksRebuild(tx, ty, span, this.world),
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
    let wasteServed = 0,
      wasteDemand = 0,
      funeralServed = 0,
      funeralDemand = 0;
    const policies = this.policies;
    const sanitationAge =
      (this.tick - (this.macro.sanitationStartTick ?? this.tick)) / TICKS_PER_DAY;
    const sanitationRamp = Math.max(0, Math.min(1, (sanitationAge - 30) / 30));

    /*
     * 3.3단계 유예.
     *
     * grace 는 **직전 평가의 인구** 로 잡는다. 이게 없으면 이번 패치를 올리는
     * 순간 학생들의 기존 도시가 전부 공실이 된다(시설이 하나도 없으므로 모든
     * 건물의 gap 이 최대치가 된다). 게임 디자인 측면에서도 맞다 — 100명짜리
     * 마을에 소방서를 요구하지 않는다.
     *
     * 이 값이 **하강 나선의 바닥** 이기도 하다. 감점이 인구를 줄이고, 줄어든
     * 인구가 grace 를 낮춰 감점을 줄인다. 음의 되먹임이라 어딘가에서 평형에
     * 닿고, 도시는 작아질 뿐 사라지지 않는다.
     */
    const grace = graceFactor(this.stats.population);
    const coveredByKind = new Array<number>(SERVICE_KIND_COUNT).fill(0);
    let homesCounted = 0;
    let homesFulfilled = 0;

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

          /* ---------- 3.3단계: 필수 서비스 감점 ---------- */
          // 품질은 **직전 평가에서 적립된 부하** 로 계산된 값이다(services.ts 5.4).
          let serviceGap = 0;
          for (let kind = 0; kind < SERVICE_KIND_COUNT; kind++) {
            const owner = this.services.ownerFor(tx, ty, level, kind);
            if (owner >= 0) coveredByKind[kind]++;
            const quality = owner < 0 ? 0 : this.services.qualityOf(owner);
            // 용도마다 필요한 서비스가 다르다. 공업지구에 학교는 필요 없다.
            serviceGap += SERVICE_WEIGHT[kind][zone] * (1 - quality);
          }
          // 고소득이 더 까다롭다. 학생이 3단계 건물을 원하면 서비스를 깔아야
          // 한다는 압력이 여기서 나온다.
          serviceGap *= TIER_SERVICE_MUL[level - 1] * grace;
          // 상한이 없으면 서비스가 통근·혼잡을 압도해서 3.1/3.2 에서 맞춰놓은
          // 밸런스가 무너진다.
          serviceGap = Math.min(serviceGap, SERVICE_PENALTY_MAX);

          /* ---------- 3.3단계: 복지 ---------- */
          const score = this.services.amenityForBuilding(tx, ty, level);
          const need = AMENITY_NEED_BY_TIER[level - 1];
          // **분자가 아니라 분모가 계층에 따라 움직인다.** 같은 자리, 같은
          // 공원인데 저소득 건물은 충족되고 고소득 건물은 미달인 상황이
          // 자연스럽게 나온다 — 그게 "얼마나 필요하냐" 다.
          const fulfil = Math.min(1, score / need);
          const amenityGap = AMENITY_GAP_MAX * (1 - fulfil) * ZONE_AMENITY_MUL[zone] * grace;

          // 요구를 채운 뒤에도 공원을 더 지을 이유가 있어야 한다. 초과분에만
          // 소폭 보너스를 주되 **포화 곡선** 을 씌운다. 아무리 쌓아도 상한을
          // 넘지 못하고 늘어나는 폭이 계속 줄어들므로, 공원 도배는 유지비만
          // 나가는 손해가 되고 "여기 말고 저기" 가 항상 이긴다.
          const surplus = Math.max(0, score - need);
          const amenityBonus =
            AMENITY_SURPLUS_MAX * (surplus / (surplus + AMENITY_HALF)) * ZONE_AMENITY_MUL[zone];

          if (zone === ZONE_R) {
            homesCounted++;
            if (fulfil >= 1) homesFulfilled++;
          }

          // **감점 인자를 둘로 나누지 않는다.** 서비스와 복지는 각자 계산하지만
          // 만족도에는 합쳐서 한 번 들어간다. 총합 상한이 하강 나선을 막는
          // 유일한 바닥이기 때문이다.
          const water = this.water.statusAt(tx, ty);
          const powerAge = (this.tick - (this.macro.powerStartTick ?? this.tick)) / TICKS_PER_DAY;
          const utilitiesGap = utilityPenalty(
            level,
            water,
            this.power.supplyAt(tx, ty),
            grace,
            this.waterPenaltyFactor,
            Math.max(0, Math.min(1, (powerAge - 30) / 30)),
          );
          const needsGap = Math.min(
            NEEDS_PENALTY_MAX,
            serviceGap +
              amenityGap +
              utilitiesGap +
              (0.15 * (1 - this.services.qualityAt(tx, ty, level, FAC_INCINERATOR)) +
                (zone === ZONE_R
                  ? 0.1 * (1 - this.services.qualityAt(tx, ty, level, FAC_CREMATORIUM))
                  : 0)) *
                grace *
                sanitationRamp,
          );

          const incidentPenalty = this.disasters.penaltyAt(tx, ty);
          const sat =
            incidentPenalty >= 1
              ? 0
              : Math.max(
                  0,
                  Math.min(
                    1,
                    satisfaction(zone, dist, nui, congestion, needsGap, amenityBonus) -
                      incidentPenalty -
                      taxSatisfactionPenalty(policies, zone),
                  ),
                );
          const floor = SATISFACTION_FLOOR[level - 1];
          const target = sat <= floor ? 0 : Math.min(1, (sat - floor) / Math.max(0.05, 1 - floor));

          // 입주율은 저장된 과거값에 의존하지 않는 완전한 파생값이다. 같은 물리 상태,
          // 도로망, 수요 입력이면 재접속·오프라인 계산에서도 항상 같은 결과가 나온다.
          occArr[i] = Math.round(Math.max(0, Math.min(1, target)) * 255);

          const cap = capacityOf(zone, level);
          wasteDemand += cap;
          wasteServed += cap * this.services.qualityAt(tx, ty, level, FAC_INCINERATOR);
          if (zone === ZONE_R) {
            funeralDemand += cap;
            funeralServed += cap * this.services.qualityAt(tx, ty, level, FAC_CREMATORIUM);
          }
          this.services.accrueSanitation(tx, ty, level, cap, zone === ZONE_R);
          const filled = cap * (occArr[i] / 255);
          // 입주율이 확정된 뒤 이번 부하를 적립한다. **다음 평가가 쓸 값** 이다.
          this.services.accrueLoad(tx, ty, level, filled);
          tiers[zone][level - 1].capacity += cap;
          tiers[zone][level - 1].filled += filled;
          capacityTotal += cap;
          filledTotal += filled;
        }
      }
    }

    // 적립된 부하로 품질을 확정하고 카운터를 비운다. 도시를 두 바퀴 도는 것보다
    // 싸고, 결정론은 깨지지 않는다 — 부하 초기값은 항상 0 이고 저장하지 않는다.
    this.services.settleLoads();
    this.sanitation = {
      waste: wasteDemand ? wasteServed / wasteDemand : 1,
      funeral: funeralDemand ? funeralServed / funeralDemand : 1,
    };

    let population = 0;
    let jobs = 0;
    for (let t = 0; t < LEVEL_COUNT; t++) {
      population += tiers[ZONE_R][t].filled;
      jobs += tiers[ZONE_C][t].filled + tiers[ZONE_I][t].filled;
    }

    const coverage = coveredByKind.map((n) => (buildings === 0 ? 0 : n / buildings));

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
      facilityUpkeep: this.services.dailyUpkeep(),
      facilityCounts: this.services.countsByKind(),
      serviceCoverage: coverage,
      overloadedFacilities: this.services.overloadedCount(),
      deadFacilities: this.services.deadCount(),
      amenityFulfilled: homesCounted === 0 ? 0 : homesFulfilled / homesCounted,
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
  private updateDemand(tiers: TierStats[][], population: number, occupancy: number): void {
    const p = Math.min(1, population / PROSPERITY_FULL);
    const shareLive = [0.7 - 0.45 * p, 0.25 + 0.2 * p, 0.05 + 0.25 * p];
    const shareWork = [0.65 - 0.35 * p, 0.27 + 0.13 * p, 0.08 + 0.22 * p];
    const shareInd = [0.55 - 0.2 * p, 0.3, 0.15 + 0.2 * p];
    // 잠긴 계층의 몫을 열린 계층으로 배분해 초기 도시의 수요가 사라지지 않게 한다.
    for (const shares of [shareLive, shareWork, shareInd]) {
      const total = shares.slice(0, this.maxBuildingTier).reduce((sum, v) => sum + v, 0);
      for (let t = 0; t < LEVEL_COUNT; t++)
        shares[t] = t < this.maxBuildingTier ? shares[t] / total : 0;
    }

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
    const targetShops = population * SHOP_JOBS_PER_RESIDENT + SEED_DEMAND_C * DEMAND_SCALE * seed;
    // 수출 수요. 도시 밖에서 오는 유일한 동력이고, 이게 도시 성장의 원동력이다.
    const exports = INDUSTRY_EXPORT_BASE + EXPORT_PER_SQRT_POP * Math.sqrt(population);
    const targetInd = capC * INDUSTRY_PER_SHOP + exports + SEED_DEMAND_I * DEMAND_SCALE * seed;

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
    if (tier >= this.maxBuildingTier) {
      this.demand[zone][tier] = 0;
      return;
    }
    const clamped = Math.max(-1, Math.min(1, target));
    const cur = this.demand[zone][tier];
    this.demand[zone][tier] = cur + (clamped - cur) * DEMAND_SMOOTH;
  }

  /* ---------------- 돈 ---------------- */

  private settleFinance(): void {
    const { income, upkeep } = this.financeEstimate();
    // 3.3단계: 시설 유지비가 붙는다. **도로가 끊겨 죽은 시설도 유지비를 낸다.**
    // 실제로 그렇고, 학생에게 도로 철거의 대가를 알려주는 신호이기도 하다.
    const facilityUpkeep = this.services.dailyUpkeep();
    this.stats.dailyIncome = income;
    this.stats.dailyUpkeep = upkeep;
    this.stats.facilityUpkeep = facilityUpkeep;
    this.macro.money = Math.round((this.macro.money + income - upkeep) * 100) / 100;
    this.macro.prosperity = normalizeProsperity(
      this.prosperity +
        dailyProsperity(this.stats.population, this.stats.occupancy, income - upkeep),
    );
    this.onMacroChange?.();
  }

  /**
   * "맵 초기화" 가 부른다. 저장에 실리는 도시 상태를 새 도시의 것으로 되돌린다.
   *
   * macro 객체는 CityDoc 의 것을 그대로 들고 있으므로, 여기서 고치면 다음
   * 저장에 그대로 실린다(saveManager 가 city.macro 를 복사해 보낸다).
   * 선택 필드는 전부 **키째로 지운다** — `= undefined` 로 두면 Firestore 가
   * 그 저장을 통째로 거부한다(ignoreUndefinedProperties 를 켜지 않았다).
   * 그러면 초기화가 서버에 안 실리고, 새로고침하면 예전 도시가 그대로 돌아온다.
   */
  resetState(money: number, nowMs: number): void {
    this.macro.money = money;
    this.macro.population = 0;
    this.macro.tick = 0;
    this.macro.tickedAt = nowMs;
    delete this.macro.disasters;
    delete this.macro.prosperity;
    delete this.macro.waterStartTick;
    delete this.macro.powerStartTick;
    delete this.macro.sanitationStartTick;
    delete this.macro.policies;
    delete this.macro.transport;
    this.services.budget = 1;
    this.onMacroChange?.();
  }

  /** 학생이 도로·지구를 놓을 때 부른다. 돈이 모자라면 false. */
  spend(amount: number): boolean {
    if (this.macro.money < amount) return false;
    this.macro.money -= amount;
    return true;
  }
}
