import { fertilityAt } from '../world/continent';
import { isWater, Terrain } from '../world/terrain';
import type { World } from '../world/world';
import {
  FAC_FISHERY,
  FAC_FOOD_PLANT,
  FISHERY_RIVER_RATE,
  FOOD_BASE_STORAGE,
  FOOD_EXPORT_PRICE,
  FOOD_IMPORT_PRICE,
  FOOD_LOCAL_SUPPLY,
  FOOD_PER_PERSON,
  FOOD_PLANT_FIRST,
  FOOD_PLANT_MAX,
  FOOD_PLANT_NEXT,
  FOOD_SPECS,
} from './config/food';
import { edgeNeighbors } from './roadGraph';
import type { FacilityRecord } from './services';

/**
 * 식량 자급.
 *
 *   생산: 도로에 닿은 농장·목장·어업 기지의 하루 생산량 합.
 *   소비: 시민 수 × FOOD_PER_PERSON.
 *   남으면 창고에 쌓고, 창고가 차면 싼값에 내다 판다(수출 수입 +).
 *   모자라면 창고에서 꺼내 먹고, 창고가 비면 비싼 값에 사 온다(유지비 +).
 *
 * 그래서 하천 가까운 비옥한 땅을 고른 도시는 같은 농장으로 더 많이 거두고,
 * 수입 비용을 아껴 그만큼 돈이 남는다. 비축량은 저장되고, 나중에 전쟁에서
 * 포위당했을 때 버티는 힘이 된다.
 */

export interface FoodSummary {
  /** 농장 생산 + 근교 농가. */
  production: number;
  /** 그중 근교 농가 몫. */
  localSupply: number;
  consumption: number;
  /** 생산 / 소비. 시민이 없으면 1. */
  selfSufficiency: number;
  stock: number;
  capacity: number;
  /** 하루 수입량·수출량(식량 단위). */
  importPerDay: number;
  exportPerDay: number;
  /** 하루 수입 비용·수출 수익(돈). */
  importCost: number;
  exportIncome: number;
  /** 가동 중인 생산 시설 수 / 전체 생산 시설 수. */
  activeFarms: number;
  farms: number;
  /** 가공 공장 보너스 (0.2 = +20%). */
  processingBonus: number;
}

export interface FarmStatus {
  kind: number;
  /** 0~1.3. 땅에 의존하지 않는 시설은 1. */
  fertility: number;
  /** 지금 하루 생산량. 도로가 끊기면 0. */
  output: number;
  active: boolean;
}

export function emptyFoodSummary(): FoodSummary {
  return {
    production: 0,
    localSupply: 0,
    consumption: 0,
    selfSufficiency: 1,
    stock: 0,
    capacity: FOOD_BASE_STORAGE,
    importPerDay: 0,
    exportPerDay: 0,
    importCost: 0,
    exportIncome: 0,
    activeFarms: 0,
    farms: 0,
    processingBonus: 0,
  };
}

export class FoodSystem {
  summary: FoodSummary = emptyFoodSummary();
  private farms = new Map<string, FarmStatus>();
  /** 앵커별 비옥도(땅 성질이라 시설이 서 있는 동안 바뀌지 않는다). */
  private fertilityCache = new Map<string, number>();

  constructor(private world: World) {}

  /**
   * 시설 목록이 바뀌었을 때(매크로 평가마다) 부른다. 생산량만 다시 센다.
   * 비축량(stock)은 macro 에 있으므로 호출부가 넘겨준다.
   */
  refresh(facilities: readonly FacilityRecord[], population: number, stock: number): void {
    this.farms.clear();
    let plants = 0;
    let storage = FOOD_BASE_STORAGE;
    let farms = 0;
    let active = 0;
    for (const f of facilities) {
      const spec = FOOD_SPECS[f.kind];
      if (!spec) continue;
      if (f.kind === FAC_FOOD_PLANT && f.hasRoad) plants++;
      if (f.hasRoad) storage += spec.storage;
    }
    const bonus =
      plants === 0
        ? 0
        : Math.min(FOOD_PLANT_MAX, FOOD_PLANT_FIRST + (plants - 1) * FOOD_PLANT_NEXT);
    let production = 0;
    for (const f of facilities) {
      const spec = FOOD_SPECS[f.kind];
      if (!spec || spec.output <= 0) continue;
      farms++;
      const fertility = spec.fertilityWeight > 0 ? this.fertilityOf(f) : 1;
      let rate = 1 - spec.fertilityWeight + spec.fertilityWeight * fertility;
      if (f.kind === FAC_FISHERY) rate *= this.fisheryRate(f);
      const output = f.hasRoad ? Math.round(spec.output * rate * (1 + bonus)) : 0;
      if (f.hasRoad) active++;
      production += output;
      this.farms.set(`${f.tx},${f.ty}`, {
        kind: f.kind,
        fertility,
        output,
        active: f.hasRoad,
      });
    }
    const consumption = Math.round(population * FOOD_PER_PERSON);
    const local = Math.min(FOOD_LOCAL_SUPPLY, consumption);
    production += local;
    this.summary = {
      ...emptyFoodSummary(),
      production,
      localSupply: local,
      consumption,
      selfSufficiency: consumption > 0 ? production / consumption : 1,
      capacity: storage,
      activeFarms: active,
      farms,
      processingBonus: bonus,
    };
    this.applyStock(stock);
  }

  /** 비축량에 따라 오늘 사 오거나 내다 파는 양을 정한다. */
  applyStock(stock: number): void {
    const s = this.summary;
    s.stock = Math.max(0, Math.min(s.capacity, stock));
    const net = s.production - s.consumption;
    s.importPerDay = net < 0 && s.stock <= 0 ? -net : 0;
    s.exportPerDay = net > 0 && s.stock >= s.capacity ? net : 0;
    s.importCost = s.importPerDay * FOOD_IMPORT_PRICE;
    s.exportIncome = s.exportPerDay * FOOD_EXPORT_PRICE;
  }

  /**
   * dayFraction 만큼 시간이 흐른 뒤의 비축량. 창고를 넘치거나 바닥을 뚫는
   * 몫은 수출·수입으로 처리된 것이므로 버린다.
   */
  advanceStock(stock: number, dayFraction: number): number {
    const s = this.summary;
    const next = stock + (s.production - s.consumption) * dayFraction;
    return Math.max(0, Math.min(s.capacity, next));
  }

  farmAt(tx: number, ty: number): FarmStatus | undefined {
    return this.farms.get(`${tx},${ty}`);
  }

  /** 시설 발자국 전체의 평균 비옥도. */
  private fertilityOf(f: FacilityRecord): number {
    const key = `${f.kind}@${f.tx},${f.ty}`;
    let v = this.fertilityCache.get(key);
    if (v === undefined) {
      v = footprintFertility(f.tx, f.ty, f.span);
      if (this.fertilityCache.size > 2_000) this.fertilityCache.clear();
      this.fertilityCache.set(key, v);
    }
    return v;
  }

  /** 바다에 닿으면 1, 강·개울에만 닿으면 그보다 적게 잡는다. 물이 없으면 0. */
  private fisheryRate(f: FacilityRecord): number {
    let water = false;
    for (const [x, y] of edgeNeighbors(f.tx, f.ty, f.span)) {
      const t = this.world.getTile(x, y);
      if (t === Terrain.WaterDeep) return 1;
      if (isWater(t)) water = true;
    }
    return water ? FISHERY_RIVER_RATE : 0;
  }
}

/** 시설을 놓기 전 미리보기에도 쓴다. */
export function footprintFertility(tx: number, ty: number, span: number): number {
  let sum = 0;
  for (let dy = 0; dy < span; dy++)
    for (let dx = 0; dx < span; dx++) sum += fertilityAt(tx + dx, ty + dy);
  return sum / (span * span);
}
