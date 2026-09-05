import { CHUNK_SIZE, WORLD_SEED } from '../core/constants';
import { chunkIndexOf } from '../core/iso';
import type { World } from '../world/world';
import {
  isAnchor,
  levelOfCode,
  simHash,
  simRandom,
  ZONE_C,
  ZONE_I,
  ZONE_R,
  zoneOfCode,
} from './buildings';
import type { AssignmentTable, DestLink } from './assignment';
import {
  AFTER_WORK_COMMERCIAL_SHARE,
  AFTER_WORK_STAY_MAX_MINUTES,
  AFTER_WORK_STAY_MINUTES,
  COMMUTE_BUFFER_MINUTES,
  COMMUTE_EARLY_SPREAD_MINUTES,
  DAYTIME_DAY_MS,
  FREIGHT_CURVE,
  FRIDAY_AFTER_WORK_COMMERCIAL_SHARE,
  LIFE_SLOT_MINUTES,
  SATURDAY_WORK_SHARE_C,
  SATURDAY_WORK_SHARE_I,
  SHOP_SUPPLY_TRIGGER,
  SUNDAY_WORK_SHARE_C,
  SUNDAY_WORK_SHARE_I,
  SUPPLY_START,
  SUPPLY_USE_PER_HOUR,
  VEHICLE_SPEED_TILES_PER_SEC,
  WEEKEND_AFTER_WORK_COMMERCIAL_SHARE,
  WEEKEND_FREIGHT_MUL,
  WORK_START_0830_SHARE,
  WORKPLACE_PRESENCE_MINUTES,
  WORK_EXIT_SPREAD_MINUTES,
} from './simConstants';
import type { DaytimeSnapshot } from './time';

export const enum TripPurpose {
  Commute = 0,
  Home = 1,
  Shop = 2,
  Freight = 3,
  /** 퇴근 뒤 상업지대 방문. STEP 3.2에서는 상업 건물 전체가 술집/식당/여가를 대리한다. */
  Leisure = 4,
}

export interface Trip {
  purpose: TripPurpose;
  tier: number;
  fromTx: number;
  fromTy: number;
  toTx: number;
  toTy: number;
}

interface HomeState {
  tx: number;
  ty: number;
  tier: number;
  supply: Uint8Array;
  inTransit: Uint8Array;
  lastScanSlot: number;
  lastConsumedHour: number;
  scanCursor: number;
}

interface ScheduledTrip {
  homeTx: number;
  homeTy: number;
  slot: number;
  tier: number;
  purpose: TripPurpose.Home | TripPurpose.Leisure;
  fromTx: number;
  fromTy: number;
  toTx: number;
  toTy: number;
  dueLifeSlot: number;
}

interface BoundaryJob {
  homeTx: number;
  homeTy: number;
  tier: number;
  baseSlot: number;
  link: DestLink;
}

interface Business {
  tx: number;
  ty: number;
  tier: number;
  zone: number;
}

interface TripOwner {
  homeKey: string;
  slot: number;
}

const SLOTS_PER_DAY = 1440 / LIFE_SLOT_MINUTES;

export class CitizenPool {
  private homes = new Map<string, HomeState>();
  /** 출근 완료 뒤 퇴근/상업지대 방문을 예약한다. 저장 데이터는 아니다. */
  private schedules = new Map<string, ScheduledTrip>();
  /** Trip 객체 자체에 활성 시민 슬롯을 연결한다. Trip 공개 인터페이스는 바꾸지 않는다. */
  private tripOwners = new WeakMap<Trip, TripOwner>();
  private boundaryJobs: BoundaryJob[] = [];
  private businesses: Business[] = [];
  private cx = 0;
  private cy = 0;
  private radius = 1;
  private boundaryScanSlot = -1;
  private boundaryLinkCursor = 0;
  private boundarySlotCursor = 0;
  private freightScanSlot = -1;
  private freightCursor = 0;
  private life: DaytimeSnapshot | null = null;

  constructor(
    private world: World,
    private assignment: AssignmentTable,
  ) {}

  setActiveRegion(cx: number, cy: number, radius: number): void {
    if (cx === this.cx && cy === this.cy && radius === this.radius && this.homes.size > 0) return;
    this.cx = cx;
    this.cy = cy;
    this.radius = radius;
    this.boundaryScanSlot = -1;
    this.boundaryLinkCursor = 0;
    this.boundarySlotCursor = 0;
    this.freightScanSlot = -1;
    this.freightCursor = 0;

    const next = new Map<string, HomeState>();
    const businesses: Business[] = [];
    for (const p of this.world.developedParcels()) {
      if (Math.abs(p.cx - cx) > radius || Math.abs(p.cy - cy) > radius || !p.bld) continue;
      const bx = p.cx * CHUNK_SIZE;
      const by = p.cy * CHUNK_SIZE;
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const code = p.bld[ly * CHUNK_SIZE + lx];
          if (!isAnchor(code)) continue;
          const zone = zoneOfCode(code);
          const tier = levelOfCode(code);
          const tx = bx + lx;
          const ty = by + ly;
          if (zone === ZONE_R) {
            const a = this.assignment.get(tx, ty);
            const count =
              (a?.jobs.reduce((n, link) => n + link.count, 0) ?? 0) + (a?.unemployed ?? 0);
            const key = `${tx},${ty}`;
            let state = this.homes.get(key);
            if (!state || state.supply.length !== count) {
              state = {
                tx,
                ty,
                tier,
                supply: new Uint8Array(count).fill(SUPPLY_START),
                inTransit: new Uint8Array(count),
                lastScanSlot: -1,
                lastConsumedHour: -1,
                scanCursor: 0,
              };
            }
            next.set(key, state);
          } else {
            businesses.push({ tx, ty, tier, zone });
          }
        }
      }
    }
    this.homes = next;
    this.businesses = businesses;

    for (const [key, scheduled] of this.schedules) {
      if (!this.homes.has(`${scheduled.homeTx},${scheduled.homeTy}`)) this.schedules.delete(key);
    }
    this.rebuildBoundaryJobs();
  }

  /** 호환용. 실제 소비는 daytime의 absoluteHour 변화에서 한 번만 처리한다. */
  consumeSupplies(tier: number): void {
    for (const home of this.homes.values()) {
      if (home.tier === tier) this.consumeHomeHour(home);
    }
  }

  collectTrips(life: DaytimeSnapshot, _dtMs: number, budget: number): Trip[] {
    this.life = life;
    const out: Trip[] = [];

    this.collectScheduled(life, budget, out);

    for (const home of this.homes.values()) {
      if (out.length >= budget) break;
      if (home.lastConsumedHour !== life.absoluteHour) {
        home.lastConsumedHour = life.absoluteHour;
        this.consumeHomeHour(home);
      }
      if (home.lastScanSlot !== life.absoluteLifeSlot) {
        home.lastScanSlot = life.absoluteLifeSlot;
        home.scanCursor = 0;
      }

      while (home.scanCursor < home.supply.length && out.length < budget) {
        const slot = home.scanCursor++;
        if (home.inTransit[slot]) continue;
        const scheduleKey = citizenKey(home.tx, home.ty, slot);
        if (this.schedules.has(scheduleKey)) continue;

        const job = this.assignment.jobForSlot(home.tx, home.ty, slot);
        if (job && this.worksToday(home, slot, job, life)) {
          const departMinute = commuteDepartureMinute(home, slot, job);
          if (life.lifeSlotOfDay === minuteToLifeSlot(departMinute)) {
            const trip = this.makeCitizenTrip(home, slot, TripPurpose.Commute, home.tx, home.ty, job.tx, job.ty);
            home.inTransit[slot] = 1;
            out.push(trip);
            continue;
          }
        }

        if (home.supply[slot] <= SHOP_SUPPLY_TRIGGER) {
          const shopMinute = this.shoppingMinute(home, slot, Boolean(job), life);
          if (life.lifeSlotOfDay === minuteToLifeSlot(shopMinute)) {
            const shop = this.assignment.shopForSlot(home.tx, home.ty, slot, life.absoluteDay);
            if (shop) {
              const trip = this.makeCitizenTrip(home, slot, TripPurpose.Shop, home.tx, home.ty, shop.tx, shop.ty);
              home.inTransit[slot] = 1;
              out.push(trip);
            }
          }
        }
      }
    }

    if (out.length < budget) this.collectBoundary(life, budget, out);
    if (out.length < budget) this.collectFreight(life, budget, out);
    return out;
  }

  onTripComplete(trip: Trip): void {
    const owner = this.tripOwners.get(trip);
    if (!owner) return; // 외부 시민/화물은 활성 개인 상태가 없다.
    const home = this.homes.get(owner.homeKey);
    if (!home || owner.slot >= home.inTransit.length) return;
    const slot = owner.slot;
    home.inTransit[slot] = 0;
    this.tripOwners.delete(trip);

    if (trip.purpose === TripPurpose.Commute) {
      this.scheduleAfterWork(home, slot, trip);
    } else if (trip.purpose === TripPurpose.Leisure) {
      this.scheduleHomeAfterLeisure(home, slot, trip);
    } else if (trip.purpose === TripPurpose.Home) {
      this.schedules.delete(citizenKey(home.tx, home.ty, slot));
    } else if (trip.purpose === TripPurpose.Shop) {
      home.supply[slot] = 255;
    }
  }

  onTripFailed(trip: Trip): void {
    const owner = this.tripOwners.get(trip);
    if (!owner) return;
    const home = this.homes.get(owner.homeKey);
    this.tripOwners.delete(trip);
    if (!home || owner.slot >= home.inTransit.length) return;
    const slot = owner.slot;
    home.inTransit[slot] = 0;

    if (trip.purpose === TripPurpose.Shop) {
      home.supply[slot] = Math.max(home.supply[slot], 64);
    } else if (trip.purpose === TripPurpose.Leisure) {
      // 상업지대 경로가 없으면 여가를 포기하고 바로 귀가 예약으로 바꾼다.
      const now = this.life?.absoluteLifeSlot ?? 0;
      this.schedules.set(citizenKey(home.tx, home.ty, slot), {
        homeTx: home.tx,
        homeTy: home.ty,
        slot,
        tier: home.tier,
        purpose: TripPurpose.Home,
        fromTx: trip.fromTx,
        fromTy: trip.fromTy,
        toTx: home.tx,
        toTy: home.ty,
        dueLifeSlot: now,
      });
    } else if (trip.purpose === TripPurpose.Home) {
      this.schedules.delete(citizenKey(home.tx, home.ty, slot));
    }
  }

  private collectScheduled(life: DaytimeSnapshot, budget: number, out: Trip[]): void {
    for (const [key, scheduled] of this.schedules) {
      if (out.length >= budget) break;
      if (scheduled.dueLifeSlot > life.absoluteLifeSlot) continue;
      const home = this.homes.get(`${scheduled.homeTx},${scheduled.homeTy}`);
      if (!home) {
        this.schedules.delete(key);
        continue;
      }
      if (home.inTransit[scheduled.slot]) continue;
      home.inTransit[scheduled.slot] = 1;
      out.push(
        this.makeCitizenTrip(
          home,
          scheduled.slot,
          scheduled.purpose,
          scheduled.fromTx,
          scheduled.fromTy,
          scheduled.toTx,
          scheduled.toTy,
        ),
      );
    }
  }

  private scheduleAfterWork(home: HomeState, slot: number, commute: Trip): void {
    const life = this.life;
    if (!life) return;
    const job = this.assignment.jobForSlot(home.tx, home.ty, slot);
    if (!job) return;
    const startMinute = workStartMinute(home.tx, home.ty, slot);
    const endMinute =
      startMinute +
      WORKPLACE_PRESENCE_MINUTES +
      workExitSpreadMinutes(home.tx, home.ty, slot, life.absoluteDay);
    let dueLifeSlot = life.absoluteDay * SLOTS_PER_DAY + minuteToLifeSlot(endMinute);
    // 정상 범위에서는 여기에 걸리지 않는다. 심한 정체에서도 다음날까지 직장에 묶지 않는다.
    if (dueLifeSlot < life.absoluteLifeSlot) dueLifeSlot = life.absoluteLifeSlot;

    const key = citizenKey(home.tx, home.ty, slot);
    const shop = this.assignment.shopForSlot(home.tx, home.ty, slot, life.absoluteDay);
    if (shop && this.goesOutAfterWork(home, slot, life)) {
      this.schedules.set(key, {
        homeTx: home.tx,
        homeTy: home.ty,
        slot,
        tier: home.tier,
        purpose: TripPurpose.Leisure,
        fromTx: commute.toTx,
        fromTy: commute.toTy,
        toTx: shop.tx,
        toTy: shop.ty,
        dueLifeSlot,
      });
    } else {
      this.schedules.set(key, {
        homeTx: home.tx,
        homeTy: home.ty,
        slot,
        tier: home.tier,
        purpose: TripPurpose.Home,
        fromTx: commute.toTx,
        fromTy: commute.toTy,
        toTx: home.tx,
        toTy: home.ty,
        dueLifeSlot,
      });
    }
  }

  private scheduleHomeAfterLeisure(home: HomeState, slot: number, leisure: Trip): void {
    const life = this.life;
    if (!life) return;
    const r = simRandom(WORLD_SEED, home.tx, home.ty, slot ^ life.absoluteDay ^ 0x5a5a);
    const stayMinutes =
      AFTER_WORK_STAY_MINUTES +
      Math.floor(r * (AFTER_WORK_STAY_MAX_MINUTES - AFTER_WORK_STAY_MINUTES + 1));
    const staySlots = Math.max(1, Math.ceil(stayMinutes / LIFE_SLOT_MINUTES));
    this.schedules.set(citizenKey(home.tx, home.ty, slot), {
      homeTx: home.tx,
      homeTy: home.ty,
      slot,
      tier: home.tier,
      purpose: TripPurpose.Home,
      fromTx: leisure.toTx,
      fromTy: leisure.toTy,
      toTx: home.tx,
      toTy: home.ty,
      dueLifeSlot: life.absoluteLifeSlot + staySlots,
    });
  }

  private goesOutAfterWork(home: HomeState, slot: number, life: DaytimeSnapshot): boolean {
    const share =
      life.weekday === 4
        ? FRIDAY_AFTER_WORK_COMMERCIAL_SHARE
        : life.isWeekend
          ? WEEKEND_AFTER_WORK_COMMERCIAL_SHARE
          : AFTER_WORK_COMMERCIAL_SHARE;
    return simRandom(WORLD_SEED, home.tx, home.ty, slot ^ life.absoluteDay ^ 0x3311) < share;
  }

  private worksToday(home: HomeState, slot: number, job: DestLink, life: DaytimeSnapshot): boolean {
    if (!life.isWeekend) return true;
    const share =
      life.weekday === 5
        ? job.zone === ZONE_I
          ? SATURDAY_WORK_SHARE_I
          : SATURDAY_WORK_SHARE_C
        : job.zone === ZONE_I
          ? SUNDAY_WORK_SHARE_I
          : SUNDAY_WORK_SHARE_C;
    return simRandom(WORLD_SEED, home.tx, home.ty, slot ^ life.absoluteDay ^ 0x7721) < share;
  }

  private shoppingMinute(home: HomeState, slot: number, employed: boolean, life: DaytimeSnapshot): number {
    let start: number;
    let end: number;
    if (life.isWeekend) {
      start = 11 * 60;
      end = 19 * 60;
    } else if (employed) {
      start = 19 * 60;
      end = 21 * 60;
    } else {
      start = 10 * 60;
      end = 17 * 60;
    }
    const r = simRandom(WORLD_SEED, home.tx, home.ty, slot ^ life.absoluteDay ^ 0x2244);
    const slots = Math.max(1, Math.floor((end - start) / LIFE_SLOT_MINUTES) + 1);
    return start + Math.floor(r * slots) * LIFE_SLOT_MINUTES;
  }

  private makeCitizenTrip(
    home: HomeState,
    slot: number,
    purpose: TripPurpose,
    fromTx: number,
    fromTy: number,
    toTx: number,
    toTy: number,
  ): Trip {
    const trip: Trip = { purpose, tier: home.tier, fromTx, fromTy, toTx, toTy };
    this.tripOwners.set(trip, { homeKey: `${home.tx},${home.ty}`, slot });
    return trip;
  }

  private rebuildBoundaryJobs(): void {
    const out: BoundaryJob[] = [];
    const slotBase = new Map<string, number>();
    for (const { fromTx, fromTy, link } of this.assignment.allLinks()) {
      const a = this.assignment.get(fromTx, fromTy);
      if (!a || !a.jobs.includes(link)) continue;
      const homeKey = `${fromTx},${fromTy}`;
      const baseSlot = slotBase.get(homeKey) ?? 0;
      slotBase.set(homeKey, baseSlot + link.count);
      if (this.tileInside(fromTx, fromTy) || !this.tileInside(link.tx, link.ty)) continue;
      const tier = this.world.buildingCovering(fromTx, fromTy)?.level ?? 1;
      out.push({ homeTx: fromTx, homeTy: fromTy, tier, baseSlot, link });
    }
    this.boundaryJobs = out;
  }

  private collectBoundary(life: DaytimeSnapshot, budget: number, out: Trip[]): void {
    if (this.boundaryScanSlot !== life.absoluteLifeSlot) {
      this.boundaryScanSlot = life.absoluteLifeSlot;
      this.boundaryLinkCursor = 0;
      this.boundarySlotCursor = 0;
    }
    while (this.boundaryLinkCursor < this.boundaryJobs.length && out.length < budget) {
      const flow = this.boundaryJobs[this.boundaryLinkCursor];
      while (this.boundarySlotCursor < flow.link.count && out.length < budget) {
        const slot = flow.baseSlot + this.boundarySlotCursor++;
        if (!boundaryWorksToday(flow, slot, life)) continue;
        const departMinute = commuteDepartureMinute(
          { tx: flow.homeTx, ty: flow.homeTy } as HomeState,
          slot,
          flow.link,
        );
        const endMinute =
          workStartMinute(flow.homeTx, flow.homeTy, slot) +
          WORKPLACE_PRESENCE_MINUTES +
          workExitSpreadMinutes(flow.homeTx, flow.homeTy, slot, life.absoluteDay);
        if (life.lifeSlotOfDay === minuteToLifeSlot(departMinute)) {
          out.push({
            purpose: TripPurpose.Commute,
            tier: flow.tier,
            fromTx: flow.homeTx,
            fromTy: flow.homeTy,
            toTx: flow.link.tx,
            toTy: flow.link.ty,
          });
        } else if (life.lifeSlotOfDay === minuteToLifeSlot(endMinute)) {
          out.push({
            purpose: TripPurpose.Home,
            tier: flow.tier,
            fromTx: flow.link.tx,
            fromTy: flow.link.ty,
            toTx: flow.homeTx,
            toTy: flow.homeTy,
          });
        }
      }
      if (this.boundarySlotCursor >= flow.link.count) {
        this.boundaryLinkCursor++;
        this.boundarySlotCursor = 0;
      }
    }
  }

  private collectFreight(life: DaytimeSnapshot, budget: number, out: Trip[]): void {
    if (this.freightScanSlot !== life.absoluteLifeSlot) {
      this.freightScanSlot = life.absoluteLifeSlot;
      this.freightCursor = 0;
    }
    const industries = this.businesses.filter((b) => b.zone === ZONE_I);
    const destinations = this.businesses.filter((b) => b.zone === ZONE_C || b.zone === ZONE_I);
    if (destinations.length === 0) return;
    const weekendMul = life.isWeekend ? WEEKEND_FREIGHT_MUL : 1;

    while (this.freightCursor < industries.length && out.length < budget) {
      const business = industries[this.freightCursor++];
      const gate = simRandom(WORLD_SEED, business.tx, business.ty, life.absoluteLifeSlot);
      // LIFE_SLOT_MINUTES를 15->5로 낮춰도 시간당 화물 총량은 늘지 않게 확률을 보정한다.
      const slotRateScale = LIFE_SLOT_MINUTES / 15;
      if (
        gate >
        (FREIGHT_CURVE[life.hourOfDay] ?? 0) * 0.03 * slotRateScale * weekendMul
      ) continue;
      const dest =
        destinations[
          simHash(WORLD_SEED, business.tx, business.ty, life.absoluteDay) % destinations.length
        ];
      if (dest.tx === business.tx && dest.ty === business.ty) continue;
      out.push({
        purpose: TripPurpose.Freight,
        tier: business.tier,
        fromTx: business.tx,
        fromTy: business.ty,
        toTx: dest.tx,
        toTy: dest.ty,
      });
    }
  }

  private consumeHomeHour(home: HomeState): void {
    const use = SUPPLY_USE_PER_HOUR[home.tier - 1] ?? 0;
    for (let i = 0; i < home.supply.length; i++) {
      home.supply[i] = Math.max(0, home.supply[i] - use);
    }
  }

  private tileInside(tx: number, ty: number): boolean {
    return (
      Math.abs(chunkIndexOf(tx) - this.cx) <= this.radius &&
      Math.abs(chunkIndexOf(ty) - this.cy) <= this.radius
    );
  }
}

function citizenKey(tx: number, ty: number, slot: number): string {
  return `${tx},${ty},${slot}`;
}

function workStartMinute(tx: number, ty: number, slot: number): number {
  const r = simRandom(WORLD_SEED, tx, ty, slot ^ 0x1830);
  return r < WORK_START_0830_SHARE ? 8 * 60 + 30 : 9 * 60;
}

function commuteDepartureMinute(
  home: Pick<HomeState, 'tx' | 'ty'>,
  slot: number,
  job: DestLink,
): number {
  const start = workStartMinute(home.tx, home.ty, slot);
  const realSeconds = job.dist / VEHICLE_SPEED_TILES_PER_SEC;
  const daytimeMinutes = realSeconds * (1440 / (DAYTIME_DAY_MS / 1000));
  const estimate = Math.ceil(daytimeMinutes + COMMUTE_BUFFER_MINUTES);
  // 08:30/09:00은 "도착 목표"로 유지하고, 출발만 0~20분 더 일찍 흩는다.
  // 같은 집/직장/시민이면 매번 같은 값이라 재현 가능하다.
  const earlySpread = Math.floor(
    simRandom(WORLD_SEED, home.tx ^ job.tx, home.ty ^ job.ty, slot ^ 0x6c31) *
      (COMMUTE_EARLY_SPREAD_MINUTES + 1),
  );
  return Math.max(0, start - estimate - earlySpread);
}

function workExitSpreadMinutes(tx: number, ty: number, slot: number, day: number): number {
  return Math.floor(
    simRandom(WORLD_SEED, tx, ty, slot ^ day ^ 0x5e17) * (WORK_EXIT_SPREAD_MINUTES + 1),
  );
}

function minuteToLifeSlot(minute: number): number {
  return Math.max(0, Math.min(SLOTS_PER_DAY - 1, Math.floor(minute / LIFE_SLOT_MINUTES)));
}

function boundaryWorksToday(flow: BoundaryJob, slot: number, life: DaytimeSnapshot): boolean {
  if (!life.isWeekend) return true;
  const share =
    life.weekday === 5
      ? flow.link.zone === ZONE_I
        ? SATURDAY_WORK_SHARE_I
        : SATURDAY_WORK_SHARE_C
      : flow.link.zone === ZONE_I
        ? SUNDAY_WORK_SHARE_I
        : SUNDAY_WORK_SHARE_C;
  return simRandom(WORLD_SEED, flow.homeTx, flow.homeTy, slot ^ life.absoluteDay ^ 0x7721) < share;
}
