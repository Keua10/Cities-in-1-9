import { sharedNow } from './sharedClock';
import { worldDaytimeAt, type DaytimeSnapshot } from './time';
import { FoodSystem } from './food';
import { mineSiteProblem, ResourceSystem } from './resources';
import { ArmySystem } from './military/armySystem';
import { CONSUMER_SPECS, isMineKind, REFINERY_GAS_DISCOUNT } from './config/resources';
import { NatureSystem } from './nature';
import { ConstructionSystem } from './construction';
import { SHOP_VISITORS_PER_JOB, TerritorySystem, type ChunkPeople } from './territory';
import { groundPollutionFor, type GroundPollution } from './groundPollution';
import { CHUNK_SIZE } from '../core/constants';
import { MetroNetwork } from './metro';
import { Build } from '../world/build';
import { JunctionIndex } from './traffic/junctions';
import { chunkIndexOf, chunkKey, localIndexOf } from '../core/iso';
import { FAC_OCC_TOWER } from './config/military';
/** 항구(여객·화물·복합). 봉쇄 판정. */
const PORT_KINDS: ReadonlySet<number> = new Set([19, 21, 22, 23]);
import {
  POSTWAR_MS,
  REBUILD_MUL,
  REBUILD_MUL_LOSER,
  VICTORY_MOOD,
  WAR_FATIGUE_MAX,
  WAR_FATIGUE_PER_HOUR,
  WAR_FOOD_IMPORT_MUL,
  BLOCKADE_IMPORT,
  HUNGER_PENALTY,
} from './config/war';
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
import { essentialCeiling, essentialGate } from './config/essentials';
import { normalizePolicies, taxRate, taxSatisfactionPenalty, type CityPolicies } from './policies';
import { FAC_INCINERATOR, FAC_CREMATORIUM } from './config/sanitation';
import {
  FAC_GROUNDWATER,
  FAC_OUTFALL,
  FAC_RIVER_PUMP,
  FAC_TREATMENT,
  WATER_GRACE_DAYS,
  WATER_RAMP_DAYS,
} from './config/water';
import { FAC_COAL_POWER, FAC_GAS, FAC_SOLAR, FAC_WIND } from './config/power';
import {
  CITY_LEVELS,
  cityLevelFor,
  dailyProsperity,
  initializeProsperity,
  normalizeProsperity,
} from './progression';
import {
  ENVIRONMENT_WARNING,
  EMPTY_ENVIRONMENT,
  environmentParts,
  environmentScore,
  environmentCeiling,
  pollutionCeiling,
  type BuildingAlert,
  type EnvironmentParts,
} from './environment';
import { FAC_FIRE, FAC_HOSPITAL, FAC_POLICE } from './facilities';
import { graceFactor, satisfaction } from './satisfaction';
import { SERVICE_KIND_COUNT, ServiceField } from './services';
import {
  AMENITY_GAP_MAX,
  AMENITY_HALF,
  AMENITY_NEED_BY_TIER,
  AMENITY_SURPLUS_MAX,
  DEMAND_SCALE,
  GRACE_SMOOTH,
  DEMAND_SMOOTH,
  EXPORT_PER_SQRT_POP,
  GROWTH_PRESSURE,
  INDUSTRY_EXPORT_BASE,
  INDUSTRY_NUISANCE_MAX,
  INDUSTRY_PER_SHOP,
  MAX_CATCHUP_TICKS,
  MS_PER_TICK,
  DAYTIME_DAY_MS,
  NEEDS_PENALTY_MAX,
  OCCUPANCY_HEALTHY,
  OFFLINE_SPEED,
  START_BOOST_INCOME,
  START_BOOST_MS,
  GRANT_BASE,
  GRANT_UPKEEP_SHARE,
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

export interface FinanceEstimate {
  /** 하루 세입(세금 + 식량 수출 + 정부 지원금). */
  income: number;
  /** 하루 지출(도로·시설 운영비·배관·전선·식량 수입). */
  upkeep: number;
  /** 정부 지원금(income 에 포함). */
  grant?: number;
  /** 세금만. */
  taxes?: number;
}

export class MacroSim {
  readonly metro: MetroNetwork;
  readonly construction: ConstructionSystem;
  readonly nature: NatureSystem;
  /** 영토·수도 (군사 1단계). 도시 레벨이 영토 청크 수를 본다. */
  readonly territory: TerritorySystem;
  /** 지금 시각(대륙 공통 시계, 모든 도시가 같다). */
  daytime(now = sharedNow()): DaytimeSnapshot {
    return worldDaytimeAt(now);
  }

  get lifeElapsedMs(): number {
    return this.macro.lifeElapsedMs ?? 0;
  }
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
    utilityStarvedBuildings: 0,
    environment: 0,
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
  /** 식량 자급(농업·목축·어업). 비축량만 macro.food 로 저장한다. */
  readonly food: FoodSystem;
  /** 자원 채굴·가공 (군사 2단계). 비축은 macro.resources, 캔 양은 macro.mined. */
  readonly resources: ResourceSystem;
  /** 군대 (군사 4단계). 저장은 macro.army. */
  readonly army: ArmySystem;
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
    this.world.signalOverrides = this.macro.signalOverrides ?? {};
    this.metro = new MetroNetwork(world, macro, () => this.onMacroChange?.());
    this.nature = new NatureSystem(world, macro, () => this.onMacroChange?.());
    this.construction = new ConstructionSystem(world, macro, this.metro, () =>
      this.onMacroChange?.(),
    );
    this.disasters = new DisasterSim(macro.disasters, macro.tick);
    this.territory = new TerritorySystem(world, macro, () => this.onMacroChange?.());
    this.food = new FoodSystem(world);
    this.resources = new ResourceSystem(macro);
    this.resources.onCoalFuel = (ok) => {
      this.power.coalFuel = ok;
      this.world.utilityRevision++;
    };
    this.services.kindUpkeepMul = (kind) =>
      kind === FAC_GAS && this.resources.summary.gasDiscount ? 1 - REFINERY_GAS_DISCOUNT : 1;
    world.mineRule = (kind, tx, ty) => mineSiteProblem(kind, tx, ty, this.macro);
    this.army = new ArmySystem(
      macro,
      this.territory,
      this.resources,
      () => this.services.facilityList(),
      () => this.cityLevel,
      () => this.onMacroChange?.(),
    );
    // 폭격·미사일에 맞은 시설을 헌다.
    this.army.destroyFacility = (f) => {
      const ok = world.removeFacilityAt(f.tx, f.ty);
      if (ok) world.onStructureEvent?.({ kind: 'explode', tx: f.tx, ty: f.ty, span: f.span });
      return ok;
    };
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

  /**
   * 하루 예상 재정. income 에는 정부 지원금이 들어 있다(grant 로 따로도 준다).
   * incomeMul: 스타트 버닝 같은 세수 배수. 세금에만 곱한다.
   */
  financeEstimate(incomeMul = 1): FinanceEstimate {
    let taxes = 0;
    const policies = this.policies;
    for (let t = 0; t < LEVEL_COUNT; t++) {
      taxes +=
        this.stats.tiers[ZONE_R][t].filled * TAX_PER_RESIDENT[t] * (taxRate(policies, ZONE_R) / 9);
      taxes +=
        this.stats.tiers[ZONE_C][t].filled * TAX_PER_JOB[t] * (taxRate(policies, ZONE_C) / 9);
      taxes +=
        this.stats.tiers[ZONE_I][t].filled *
        TAX_PER_JOB[t] *
        (taxRate(policies, ZONE_I) / 9) *
        (1 + this.resources.summary.industryBonus);
    }
    taxes *= incomeMul;
    // 식량: 남아서 내다 판 몫은 수입, 모자라 사 온 몫은 지출이다.
    const food = this.food.summary;
    const upkeep =
      this.stats.roads * UPKEEP_ROAD_PER_DAY +
      this.services.operatingUpkeep((kind) => this.utilityUse(kind)) +
      this.water.upkeep +
      this.power.upkeep +
      food.importCost +
      this.army.upkeepMoney;
    const earned = taxes + food.exportIncome;
    // 중앙정부 지원금: 모자란 만큼 메워 준다. 단, 한도가 있어 터무니없이 과하게 지으면 적자.
    const grant = this.grantsEnabled
      ? Math.max(0, Math.min(upkeep - earned, upkeep * GRANT_UPKEEP_SHARE + GRANT_BASE))
      : 0;
    return { income: earned + grant, upkeep, grant, taxes };
  }

  /** 전쟁 같은 특수 상황에서 끈다(전쟁 단계에서 연결). */
  grantsEnabled = true;
  /** 전쟁 중이면 1배속(공유 시계와 맞춘다). net/warSession.ts 가 켠다. */
  atWar = false;

  /** 식량 봉쇄 중(적이 내 항구나 국경 청크를 점령). */
  blockaded = false;

  /**
   * 봉쇄: 적이 점령한 내 땅 중에 항구가 있거나 국경(내 땅이 아닌 곳과 맞닿은) 청크가 있으면.
   * 국경 도로 = 바깥과 이어지는 길목이라 국경 청크면 끊긴 것으로 본다.
   */
  private checkBlockade(): boolean {
    const war = this.army.war;
    if (!war) return false;
    const ports = new Set<string>();
    for (const f of this.services.facilityList())
      if (PORT_KINDS.has(f.kind)) ports.add(chunkKey(chunkIndexOf(f.tx), chunkIndexOf(f.ty)));
    const t = this.territory;
    for (const [key, who] of war.occupied) {
      if (who === this.army.uid) continue;
      const [cx, cy] = key.split(',').map(Number);
      if (!t.isOwned(cx, cy)) continue;
      if (ports.has(key)) return true;
      if (
        !t.isOwned(cx + 1, cy) ||
        !t.isOwned(cx - 1, cy) ||
        !t.isOwned(cx, cy + 1) ||
        !t.isOwned(cx, cy - 1)
      )
        return true;
    }
    return false;
  }

  /** 전후 복구: 종전 뒤 6시간 공사 속도 ×2(패전국 ×3). */
  rebuildMul(now = Date.now()): number {
    const end = this.macro.warEndedAt;
    if (this.atWar || end === undefined || now - end >= POSTWAR_MS) return 1;
    return this.macro.warOutcome === 'lose' ? REBUILD_MUL_LOSER : REBUILD_MUL;
  }

  /** 전쟁이 만족도에 주는 값: 전쟁 피로(−, 길수록 커짐), 승전 뒤 6시간 +. */
  warMood(now = Date.now()): number {
    if (this.atWar && this.macro.warSince !== undefined)
      return -Math.min(
        WAR_FATIGUE_MAX,
        (Math.max(0, now - this.macro.warSince) / 3_600_000) * WAR_FATIGUE_PER_HOUR,
      );
    const end = this.macro.warEndedAt;
    if (this.macro.warOutcome === 'win' && end !== undefined && now - end < POSTWAR_MS)
      return VICTORY_MOOD;
    return 0;
  }

  /** 저장되는 도시 상태(전쟁 정산 기록 등 다른 모듈이 읽고 쓴다). */
  get state(): MacroState {
    return this.macro;
  }

  /** 상하수도·발전 시설의 연결망 사용률 0~1. 다른 시설은 null. */
  private utilityUse(kind: number): number | null {
    const ratio = (demand: number, capacity: number) =>
      capacity > 0 ? Math.min(1, demand / capacity) : 0;
    const w = this.water.summary;
    if (kind === FAC_GROUNDWATER || kind === FAC_RIVER_PUMP)
      return ratio(w.demand, w.waterCapacity);
    if (kind === FAC_OUTFALL || kind === FAC_TREATMENT) return ratio(w.demand, w.sewerCapacity);
    if (kind === FAC_WIND || kind === FAC_GAS || kind === FAC_SOLAR || kind === FAC_COAL_POWER)
      return ratio(this.power.summary.demand, this.power.summary.capacity);
    // 자원 시설: 돌면 전부, 멈추면 대기 유지비만.
    if (isMineKind(kind) || CONSUMER_SPECS[kind]) return 1;
    return null;
  }

  /** grace 의 완만한 이동 평균. 인구 <-> 감점 되먹임의 진동을 막는다(수정사항 7). */
  private graceLevel = 0;

  /** 필지별 환경도 0~255. 입주율과 같은 파생값이라 저장하지 않는다(수정사항 4). */
  private env = new Map<string, Uint8Array>();
  /** 필지별 환경도 항목. 건물을 눌렀을 때 "왜 낮은지" 를 보여주기 위한 것이다. */
  private envParts = new Map<string, EnvironmentParts>();

  get prosperity(): number {
    return normalizeProsperity(this.macro.prosperity);
  }

  get cityLevel(): number {
    return cityLevelFor(this.prosperity, this.territory.count);
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
   * 필수 인프라 게이트 강도 0~1 (수정사항 1 · 13).
   * 상수도와 전기 중 **늦게 열린 쪽** 을 기준으로 유예를 잰다.
   */
  private get essentialGateFactor(): number {
    const start = Math.max(
      this.macro.waterStartTick ?? this.tick,
      this.macro.powerStartTick ?? this.tick,
    );
    return essentialGate((this.tick - start) / TICKS_PER_DAY);
  }

  /**
   * 빈 부지의 필수 인프라 준비도 0~1. 신축·재개발 판정에 쓴다.
   * 건물이 아직 없으므로 배관·전선 커버리지로 본다.
   */
  private plotEssentials(
    tx: number,
    ty: number,
    span: number,
    gate: number,
    ground: GroundPollution,
  ): number {
    let pollution = 0;
    for (let dy = 0; dy < span; dy++)
      for (let dx = 0; dx < span; dx++)
        pollution = Math.max(
          pollution,
          ground.at(tx + dx, ty + dy)?.value ?? 0,
          this.water.statusAt(tx + dx, ty + dy).contamination,
        );
    const build = this.world.getBuild(tx, ty);
    const zone = build === Build.ZoneR ? ZONE_R : build === Build.ZoneC ? ZONE_C : ZONE_I;
    const environmental = pollutionCeiling(zone, pollution);
    if (gate <= 0) return environmental;
    /*
     * 전기는 **도시 전체의 발전 여유** 로 본다. 타일별 전력 커버리지로 막으면
     * 도시가 자기 발밑에서만 자란다 — 전력은 건물을 타고 전달되므로, 아직
     * 건물이 없는 땅에는 전력 커버리지가 영영 생기지 않고, 전선을 손으로 깔지
     * 않은 구역은 통째로 죽는다. 실제로 이 판정을 타일별로 걸었을 때 같은
     * 시나리오의 인구가 8,000 에서 3,600 으로 반토막 났다.
     *
     * 대신 지어진 뒤에도 전기가 안 닿으면 **입주 상한이 0** 이라 사람이 안 들어온다
     * (evaluate 의 essentialCeiling). 플레이어는 그때 전선을 잇는다 — 테오타운과
     * 시티즈가 똑같이 하는 방식이고, 화면에 경고가 뜨므로 원인도 바로 읽힌다.
     */
    const cap = this.power.summary.capacity;
    const load = this.power.summary.demand;
    let power = load <= 0 ? (cap > 0 ? 1 : 0) : Math.min(1, cap / load);
    let supply = 0;
    let drainage = 0;
    for (let dy = 0; dy < span; dy++) {
      for (let dx = 0; dx < span; dx++) {
        const k = `${tx + dx},${ty + dy}`;
        const w = this.water.coverage.get(k);
        if (w) {
          supply = Math.max(supply, w.supply);
          drainage = Math.max(drainage, w.drainage);
        }
      }
    }
    return Math.min(environmental, essentialCeiling({ supply, drainage }, power, gate));
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

  /**
   * 건물 한 채에 지금 떠야 할 경고들 (수정사항 14).
   *
   * 테오타운·시티즈는 문제가 있는 건물 위에 아이콘을 띄운다. 그게 없으면
   * 플레이어는 도시 전체 통계만 보고 **어느 건물이** 문제인지 찾지 못한다.
   * 판정은 전부 이미 돌고 있는 값에서 읽는다 — 화면용 근사치를 만들지 않는다.
   *
   * 급한 것부터 돌려준다. 화면에서는 한 자리에서 차례로 보여준다.
   */
  buildingAlerts(tx: number, ty: number): BuildingAlert[] {
    const info = this.world.buildingCovering(tx, ty);
    if (!info || info.kind !== null) return [];
    const out: BuildingAlert[] = [];
    if (this.roadField.commuteFor(tx, ty, info.level, info.zone) >= ROAD_DIST_UNREACHABLE)
      out.push('road');
    if (this.power.supplyAt(info.tx, info.ty) <= 0) out.push('power');
    const water = this.water.statusAt(info.tx, info.ty);
    if (water.supply <= 0) out.push('water');
    if (water.drainage <= 0) out.push('sewer');
    if (
      (water.contamination > 0 && water.supply > 0) ||
      (this.environmentPartsAt(tx, ty)?.pollution ?? 0) >= 0.08
    )
      out.push('pollution');
    for (const kind of [FAC_FIRE, FAC_POLICE, FAC_HOSPITAL]) {
      if (this.services.qualityAt(info.tx, info.ty, info.level, kind) < 0.75) {
        out.push(kind === FAC_FIRE ? 'fire' : kind === FAC_POLICE ? 'police' : 'health');
      }
    }
    const env = this.environmentAt(tx, ty);
    if (env !== null && env < ENVIRONMENT_WARNING) out.push('environment');
    return out;
  }

  /** 해당 타일을 덮는 건물의 환경도 0~1. 건물이 없으면 null. */
  environmentAt(tx: number, ty: number): number | null {
    const info = this.world.buildingCovering(tx, ty);
    if (!info) return null;
    const p = this.world.peekParcel(chunkIndexOf(info.tx), chunkIndexOf(info.ty));
    if (!p) return 0;
    const values = this.env.get(p.key);
    if (!values) return 0;
    return values[localIndexOf(info.ty) * CHUNK_SIZE + localIndexOf(info.tx)] / 255;
  }

  /** 해당 타일을 덮는 건물의 환경도 항목. 화면에 이유를 적기 위한 것이다. */
  environmentPartsAt(tx: number, ty: number): EnvironmentParts | null {
    const info = this.world.buildingCovering(tx, ty);
    if (!info) return null;
    return this.envParts.get(`${info.tx},${info.ty}`) ?? EMPTY_ENVIRONMENT;
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

  /** 일시정지 중에는 접속 시각과 공급망만 갱신하고 시간은 진행하지 않는다. */
  holdClock(now = Date.now()): void {
    // A live pause must not become offline catch-up time after saving and reopening.
    this.macro.tickedAt = now;
    this.power.ensure(this.world);
    this.water.ensure(this.world);
    this.territory.update(now);
  }

  /* ---------------- 스타트 버닝 ---------------- */

  /** 도시마다 한 번, 처음 시작할 때 스타트 버닝을 준다. 준 경우 true. */
  grantStartBoost(): boolean {
    if (this.macro.startBoostGiven) return false;
    this.macro.startBoostGiven = true;
    this.macro.startBoostMs = START_BOOST_MS;
    this.onMacroChange?.();
    return true;
  }
  /** 남은 스타트 버닝(플레이 시간 ms). */
  get startBoostLeftMs(): number {
    return Math.max(0, this.macro.startBoostMs ?? 0);
  }
  /** 지금 수입 배수. 버닝 중이면 10, 아니면 1. 유지비에는 붙지 않는다. */
  get incomeMultiplier(): number {
    return this.startBoostLeftMs > 0 ? START_BOOST_INCOME : 1;
  }
  /** 플레이 시간 realMs 만큼 버닝을 쓰고, 실제로 버닝이 켜져 있던 ms 를 돌려준다. */
  private consumeBoost(realMs: number): number {
    const left = this.startBoostLeftMs;
    if (!(left > 0) || !(realMs > 0)) return 0;
    const used = Math.min(left, realMs);
    const rest = left - used;
    if (rest > 0) this.macro.startBoostMs = rest;
    else {
      delete this.macro.startBoostMs;
      this.onMacroChange?.();
    }
    return used;
  }

  /**
   * 실시간 프레임에서 부른다. deltaMs 는 게임 시간(배속 적용), boostedMs 는 이번 프레임에
   * 스타트 버닝이 켜져 있던 실제 ms. 공사는 배속과 상관없이 실제 시계로 진행된다.
   */
  advanceLifeClock(deltaMs: number, boostedMs = 0): void {
    this.macro.lifeElapsedMs = this.lifeElapsedMs + Math.max(0, deltaMs);
    this.construction.update(Date.now(), boostedMs, this.rebuildMul());
    this.nature.update();
  }

  /** 서 있는 점령타워 청크를 영토 계산에 넘긴다(실제 1시간 뒤 영토). */
  private updateTowers(): void {
    const chunks = new Set<string>();
    for (const f of this.services.facilityList())
      if (f.kind === FAC_OCC_TOWER) chunks.add(chunkKey(chunkIndexOf(f.tx), chunkIndexOf(f.ty)));
    this.territory.updateTowers(chunks);
  }

  /**
   * deltaMs: 게임 시간(배속 적용). realMs: 실제로 흐른 플레이 시간(버닝을 여기서 쓴다).
   * realMs 를 주지 않으면 deltaMs 와 같다고 본다(점검 도구).
   */
  update(deltaMs: number, budget: number, realMs = deltaMs): void {
    const boosted = this.consumeBoost(realMs);
    this.advanceLifeClock(deltaMs, boosted);
    this.territory.update();
    this.updateTowers();
    this.food.importPriceMul = this.atWar ? WAR_FOOD_IMPORT_MUL : 1;
    this.blockaded = this.atWar && this.checkBlockade();
    this.food.importLimit = this.blockaded ? BLOCKADE_IMPORT : 1;
    this.army.update();
    this.power.ensure(this.world);
    this.water.ensure(this.world);
    if (this.catchupLeft > 0) {
      const n = Math.min(this.catchupLeft, budget);
      for (let i = 0; i < n; i++) {
        this.accrueFinance(MS_PER_TICK);
        this.step();
      }
      this.catchupLeft -= n;
      return;
    }

    this.accrueFinance(deltaMs, boosted > 0 ? START_BOOST_INCOME : 1);
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

    this.power.ensure(this.world);
    this.water.ensure(this.world);
    const gate = this.essentialGateFactor;
    const ground = groundPollutionFor(this.world);
    const ctx: GrowthContext = {
      maxBuildingTier: this.maxBuildingTier,
      demand: this.demand,
      field: this.roadField,
      today: this.day,
      tick: this.macro.tick,
      money: this.macro.money,
      blocksRebuild: (tx, ty, span) => this.disasters.blocksRebuild(tx, ty, span, this.world),
      essentialsAt: (tx, ty, span) => this.plotEssentials(tx, ty, span, gate, ground),
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
    const groundPollution = groundPollutionFor(this.world);

    const tiers = emptyTiers();
    let buildings = 0;
    let roads = 0;
    let stranded = 0;
    let starved = 0;
    let environmentSum = 0;
    let capacityTotal = 0;
    let filledTotal = 0;
    let wasteServed = 0,
      wasteDemand = 0,
      funeralServed = 0,
      funeralDemand = 0;
    const policies = this.policies;
    const essentialGateNow = this.essentialGateFactor;
    const warMood = this.warMood();
    const hungerPenalty = this.food.summary.hunger * HUNGER_PENALTY;
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
    this.graceLevel += (graceFactor(this.stats.population) - this.graceLevel) * GRACE_SMOOTH;
    const grace = this.graceLevel;
    const coveredByKind = new Array<number>(SERVICE_KIND_COUNT).fill(0);
    let homesCounted = 0;
    let homesFulfilled = 0;
    const people = new Map<string, ChunkPeople>();

    for (const p of parcels) {
      roads += p.roadCount;
      if (!p.bld) continue;
      const here: ChunkPeople = { residents: 0, floating: 0, raw: 0 };
      people.set(p.key, here);
      const drafted = this.army.army.drafted[p.key] ?? 0;
      const prevRaw = this.territory.people.get(p.key)?.raw ?? 0;
      // 전쟁으로 빼앗긴 청크의 시민은 사라진다(건물은 남는다).
      const draftKeep = this.territory.isCeded(p.key)
        ? 0
        : drafted > 0 && prevRaw > 0
          ? Math.max(0, 1 - drafted / prevRaw)
          : 1;

      let occArr = this.occ.get(p.key);
      if (!occArr || occArr.length !== p.bld.length) {
        occArr = new Uint8Array(p.bld.length);
        this.occ.set(p.key, occArr);
      }
      let envArr = this.env.get(p.key);
      if (!envArr || envArr.length !== p.bld.length) {
        envArr = new Uint8Array(p.bld.length);
        this.env.set(p.key, envArr);
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

          /* ---------- 수정사항 4: 환경도 ---------- */
          // 표시와 입주 상한은 같은 환경 수치를 공유한다.
          let localPollution = 0;
          for (let dy = 0; dy < level; dy++)
            for (let dx = 0; dx < level; dx++)
              localPollution = Math.max(
                localPollution,
                groundPollution.at(tx + dx, ty + dy)?.value ?? 0,
              );
          const parts = environmentParts(dist, nui, congestion, fulfil, water.contamination);
          parts.pollution = Math.max(water.contamination, localPollution);
          const env = environmentScore(parts);
          envArr[i] = Math.round(env * 255);
          this.envParts.set(`${tx},${ty}`, parts);
          environmentSum += env;

          const incidentPenalty = this.disasters.penaltyAt(tx, ty);
          const sat =
            incidentPenalty >= 1
              ? 0
              : Math.max(
                  0,
                  Math.min(
                    1,
                    satisfaction(zone, dist, nui, congestion, needsGap, amenityBonus) +
                      warMood -
                      hungerPenalty -
                      incidentPenalty -
                      taxSatisfactionPenalty(policies, zone),
                  ),
                );
          const floor = SATISFACTION_FLOOR[level - 1];
          let target = sat <= floor ? 0 : Math.min(1, (sat - floor) / Math.max(0.05, 1 - floor));

          // 필수 인프라 게이트(수정사항 1 · 13). 만족도와 **곱해지는 상한** 이다.
          // 전기나 상수가 아예 안 닿으면 상한이 0 이라 살던 사람도 빠져나간다.
          const ceiling = Math.min(
            environmentCeiling(zone, parts),
            essentialCeiling(water, this.power.supplyAt(tx, ty), essentialGateNow),
          );
          if (ceiling < 1) {
            if (target > ceiling) starved++;
            target = Math.min(target, ceiling);
          }

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
          if (zone === ZONE_R) here.raw += cap * (occArr[i] / 255);
          // 징병: 군대에 간 인원만큼 이 청크의 거주·일자리가 준다(직전 평가 기준 비율).
          const filled = cap * (occArr[i] / 255) * draftKeep;
          // 입주율이 확정된 뒤 이번 부하를 적립한다. **다음 평가가 쓸 값** 이다.
          this.services.accrueLoad(tx, ty, level, filled);
          tiers[zone][level - 1].capacity += cap;
          tiers[zone][level - 1].filled += filled;
          if (zone === ZONE_R) here.residents += filled;
          else here.floating += filled * (zone === ZONE_C ? 1 + SHOP_VISITORS_PER_JOB : 1);
          capacityTotal += cap;
          filledTotal += filled;
        }
      }
    }

    // 적립된 부하로 품질을 확정하고 카운터를 비운다. 도시를 두 바퀴 도는 것보다
    // 싸고, 결정론은 깨지지 않는다 — 부하 초기값은 항상 0 이고 저장하지 않는다.
    this.services.settleLoads();
    this.territory.people = people;
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
      utilityStarvedBuildings: starved,
      environment: buildings === 0 ? 0 : environmentSum / buildings,
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
    // 군인도 먹는다(1명 = 시민 1명분).
    this.food.refresh(
      this.services.facilityList(),
      population + this.army.soldiers,
      this.macro.food ?? 0,
    );
    this.resources.refresh(this.services.facilityList());

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
      // 32칸 청크라 둘레 2청크(약 64칸)까지 섞는다. 예전 64칸 청크의 둘레 1청크와 같은 거리다.
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (dx === 0 && dy === 0) continue;
          sum += (raw.get(`${p.cx + dx},${p.cy + dy}`) ?? 0) * 0.4;
        }
      }
      // 예전 기준(64칸 청크를 공업이 가득 채우면 대략 4096, 그 절반에서 최대치)을
      // 섞는 넓이 비율(10.6 / 16.8 청크 면적)로 환산했다.
      const v = Math.min(1, sum / 1260) * INDUSTRY_NUISANCE_MAX;
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

  private financeRemainder = 0;

  private accrueFinance(deltaMs: number, incomeMul = 1): void {
    if (!(deltaMs > 0)) return;
    // 비축량을 먼저 움직이고, 창고가 차거나 빈 상태로 오늘의 수출·수입을 정한다.
    const stock = this.food.advanceStock(this.macro.food ?? 0, deltaMs / DAYTIME_DAY_MS);
    this.macro.food = Math.round(stock * 100) / 100;
    this.food.applyStock(this.macro.food);
    this.resources.advance(deltaMs / DAYTIME_DAY_MS);
    // 기계 부대 연료(석유). 모자라면 비축이 0 에서 멈춘다(설계안: 유지비에 석유).
    const fuel = this.army.fuelPerDay * (deltaMs / DAYTIME_DAY_MS);
    if (fuel > 0) this.resources.addStock('oil', -Math.min(fuel, this.resources.stockNow.oil));
    const { income, upkeep } = this.financeEstimate(incomeMul);
    this.stats.dailyIncome = income;
    this.stats.dailyUpkeep = upkeep;
    this.stats.facilityUpkeep = this.services.operatingUpkeep((kind) => this.utilityUse(kind));
    // One displayed life day earns exactly one quoted daily net amount.
    this.financeRemainder += ((income - upkeep) * deltaMs) / DAYTIME_DAY_MS;
    const won = Math.trunc(
      this.financeRemainder * 10_000 + Math.sign(this.financeRemainder) * 1e-7,
    );
    if (won !== 0) {
      this.macro.money = Math.round(this.macro.money * 10_000 + won) / 10_000;
      this.financeRemainder -= won / 10_000;
      this.onMacroChange?.();
    }
  }

  private settleFinance(): void {
    const { income, upkeep } = this.financeEstimate();
    // 3.3단계: 시설 유지비가 붙는다. **도로가 끊겨 죽은 시설도 유지비를 낸다.**
    // 실제로 그렇고, 학생에게 도로 철거의 대가를 알려주는 신호이기도 하다.
    const facilityUpkeep = this.services.operatingUpkeep((kind) => this.utilityUse(kind));
    this.stats.dailyIncome = income;
    this.stats.dailyUpkeep = upkeep;
    this.stats.facilityUpkeep = facilityUpkeep;
    // Cash is integrated continuously in accrueFinance, never awarded again here.
    this.macro.prosperity = normalizeProsperity(
      this.prosperity +
        dailyProsperity(this.stats.population, this.stats.occupancy, income - upkeep),
    );
    this.onMacroChange?.();
  }

  /**
   * 관리자 도구의 초기화가 부른다. 저장에 실리는 도시 상태를 새 도시의 것으로
   * 되돌린다.
   *
   * macro 객체는 CityDoc 의 것을 그대로 들고 있으므로, 여기서 고치면 다음
   * 저장에 그대로 실린다(saveManager 가 city.macro 를 복사해 보낸다).
   * 선택 필드는 전부 **키째로 지운다** — `= undefined` 로 두면 Firestore 가
   * 그 저장을 통째로 거부한다(ignoreUndefinedProperties 를 켜지 않았다).
   * 그러면 초기화가 서버에 안 실리고, 새로고침하면 예전 도시가 그대로 돌아온다.
   */
  resetState(money: number, nowMs: number): void {
    this.financeRemainder = 0;
    delete this.macro.lifeElapsedMs;
    delete this.macro.construction;
    delete this.macro.constructionAt;
    delete this.macro.startBoostMs;
    delete this.macro.startBoostGiven;
    delete this.macro.nature;
    this.metro.reset();
    delete this.macro.signalOverrides;
    this.world.signalOverrides = {};
    this.world.signalRevision++;
    this.macro.money = money;
    this.macro.population = 0;
    this.macro.tick = 0;
    this.macro.tickedAt = nowMs;
    delete this.macro.disasters;
    delete this.macro.food;
    this.resources.reset();
    this.army.army.units = [];
    this.army.army.drafted = {};
    delete this.macro.prosperity;
    delete this.macro.waterStartTick;
    delete this.macro.powerStartTick;
    delete this.macro.sanitationStartTick;
    delete this.macro.policies;
    delete this.macro.transport;
    // 생성 관련 필드도 여기서 비운다. 초기화된 도시는 "아직 아무것도 만들지
    // 않은 도시" 이고, 대도시를 원하면 호출부가 이 뒤에 다시 적는다.
    delete this.macro.genSeed;
    delete this.macro.metropolisRequest;
    // 군사: 부대·탐사 기록·폭격 기록·전쟁 피로/복구 상태를 비운다. 정산 기록(warsSettled·
    // alliancesSettled)과 배신·기습 기록은 남긴다(같은 배상을 두 번 받거나 벌칙을 피하지 않게).
    delete this.macro.scouted;
    delete this.macro.warSince;
    delete this.macro.warEndedAt;
    delete this.macro.warOutcome;
    this.army.army.strikes = [];
    this.army.army.struckBy = {};
    this.army.army.lossValue = 0;
    this.territory.reset();
    this.services.budget = 1;
    this.onMacroChange?.();
  }

  /** 시장 거래처럼 정해진 돈을 더하거나 뺀다(음수 = 지출). */
  adjustMoney(delta: number): void {
    if (!Number.isFinite(delta)) return;
    this.macro.money = Math.round((this.macro.money + delta) * 100) / 100;
    this.onMacroChange?.();
  }

  /** 학생이 도로·지구를 놓을 때 부른다. 돈이 모자라면 false. */
  spend(amount: number): boolean {
    if (this.macro.money < amount) return false;
    this.macro.money -= amount;
    return true;
  }

  setRoadSignal(tx: number, ty: number, enabled: boolean): boolean {
    if (this.world.getBuild(tx, ty) !== Build.Road) return false;
    const index = new JunctionIndex();
    index.build(this.world, tx - 24, ty - 24, tx + 24, ty + 24);
    const junction = index.at(tx, ty);
    if (junction)
      for (let i = 0; i < junction.cells.length; i += 2) {
        delete this.world.signalOverrides[`${junction.cells[i]},${junction.cells[i + 1]}`];
      }
    this.world.signalOverrides[`${tx},${ty}`] = enabled;
    this.macro.signalOverrides = this.world.signalOverrides;
    this.world.signalRevision++;
    this.onMacroChange?.();
    return true;
  }
}
